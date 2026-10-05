import type { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import {
  makeMcpAppHost,
  McpAppHostRefusal,
  mcpAppStyleVariables,
  type McpAppCallToolResult,
  type McpAppHost,
  type McpAppHostContext,
} from "@t3tools/client-runtime/mcp-apps";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CommandId, MessageId } from "@t3tools/contracts";
import {
  MCP_APP_MAX_HEIGHT,
  mcpAppAllowAttribute,
  mcpAppFileName,
  type McpAppReference,
} from "@t3tools/shared/mcpApp";
import Constants from "expo-constants";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { AppText as Text } from "../../components/AppText";
import { mobileHtmlRenderTheme } from "../../lib/htmlRenderTheme";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { uuidv4 } from "../../lib/uuid";
import { useAssetUrlState } from "../../state/assets";
import { mcpAppEnvironment } from "../../state/mcpApps";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/** The feed reserves a fixed box for an app; a taller app scrolls inside it. */
const MCP_APP_ROW_HEIGHT = 420;
const ROW_BOTTOM_MARGIN = 8;

export function mcpAppRowHeight() {
  return MCP_APP_ROW_HEIGHT + ROW_BOTTOM_MARGIN;
}

// The WebView loads a tiny outer page that hosts the app in a real
// opaque-origin iframe, as web does, so the app's `window.parent` and the
// `event.source` of host replies are a real window, which the MCP Apps SDK
// requires. The outer page only relays: app → React Native, and host
// replies (injected as `__t3McpAppReceive(...)`) → app.
function outerDocument(src: string, allow: string) {
  const attribute = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%;background:transparent}iframe{border:0;display:block;width:100%;height:100%}</style></head>
<body><iframe id="app" sandbox="allow-scripts allow-forms" allow="${attribute(allow)}" src="${attribute(src)}"></iframe>
<script>(function(){var frame=document.getElementById("app");
window.addEventListener("message",function(e){if(e.source===frame.contentWindow)window.ReactNativeWebView.postMessage(JSON.stringify(e.data));});
window.__t3McpAppReceive=function(m){frame.contentWindow&&frame.contentWindow.postMessage(m,"*");};})();</script></body></html>`;
}

const commandFailure = (result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) => {
  const error = squashAtomCommandFailure(result);
  return new McpAppHostRefusal(
    error instanceof Error && error.message.trim() !== "" ? error.message : "Request failed.",
  );
};

const confirm = (title: string, message: string, action: string) =>
  new Promise<boolean>((resolve) => {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: action, onPress: () => resolve(true) },
    ]);
  });

/** A captured MCP App in the thread feed, hosted in a WebView over the MCP Apps bridge. */
export function ThreadMcpApp(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly revision: string;
  readonly app: McpAppReference;
  readonly width: number;
}) {
  const { app } = props;
  const { themeId, themeAppearance, themeVariables, systemColorsActive } =
    useAppearancePreferences();
  const theme = useMemo(
    () =>
      mobileHtmlRenderTheme({
        themeId,
        appearance: themeAppearance,
        variables: themeVariables,
        systemColors: systemColorsActive,
        platform: Platform.OS,
      }),
    [themeId, themeAppearance, themeVariables, systemColorsActive],
  );
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId: app.attachmentId,
      fileName: mcpAppFileName(app),
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [app],
  );
  const asset = useAssetUrlState(props.environmentId, resource);
  // The view keeps its first URL: a re-minted one would reload the app.
  const [uri, setUri] = useState<string | null>(null);
  if (uri === null && asset._tag === "Success") setUri(asset.url);
  const [loaded, setLoaded] = useState(false);

  // The feed omits tool input and output; the app needs both.
  const detail = useEnvironmentQuery(
    orchestrationEnvironment.turnItem({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, itemId: props.itemId, revision: props.revision },
    }),
  );
  const storedItem = detail.data?.item;
  const toolCall = useMemo(() => {
    if (storedItem?.type !== "dynamic_tool") return undefined;
    const output = storedItem.output as { readonly result?: unknown } | undefined;
    return {
      arguments: storedItem.input,
      result: output?.result as McpAppCallToolResult | undefined,
    };
  }, [storedItem]);

  const callTool = useAtomCommand(mcpAppEnvironment.callTool, { reportFailure: false });
  const toolInfo = useAtomCommand(mcpAppEnvironment.toolInfo, { reportFailure: false });
  const readResource = useAtomCommand(mcpAppEnvironment.readResource, { reportFailure: false });
  // Read by the host on every message, so it always sees current values
  // without being rebuilt (which would drop the app's session).
  const latest = useRef({ theme, props, callTool, toolInfo, readResource });
  useEffect(() => {
    latest.current = { theme, props, callTool, toolInfo, readResource };
  });
  const webView = useRef<WebView<object>>(null);
  const hostRef = useRef<McpAppHost | null>(null);

  // One host per loaded document.
  useEffect(() => {
    if (uri === null) return;
    const scope = () => {
      const { environmentId, threadId, itemId } = latest.current.props;
      return { environmentId, input: { threadId, itemId } };
    };
    const hostContext = (): McpAppHostContext => ({
      theme: latest.current.theme.appearance,
      styles: { variables: mcpAppStyleVariables(latest.current.theme.variables) },
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      containerDimensions: { width: latest.current.props.width, maxHeight: MCP_APP_MAX_HEIGHT },
      platform: "mobile",
    });
    const next = makeMcpAppHost({
      app,
      hostVersion: Constants.expoConfig?.version ?? "0.0.0",
      post: (message) =>
        webView.current?.injectJavaScript(
          `window.__t3McpAppReceive&&window.__t3McpAppReceive(${JSON.stringify(message)});true;`,
        ),
      hostContext,
      callTool: async ({ name, arguments: args }) => {
        const { environmentId, input } = scope();
        const info = await latest.current.toolInfo({ environmentId, input: { ...input, name } });
        if (info._tag !== "Success") throw commandFailure(info);
        if (!info.value.callable) throw new McpAppHostRefusal("This app cannot call that tool.");
        if (
          !info.value.readOnly &&
          !(await confirm(
            `Allow ${app.server} to run ${info.value.title ?? name}?`,
            JSON.stringify(args, null, 2),
            "Allow",
          ))
        ) {
          throw new McpAppHostRefusal("Declined by the user.");
        }
        const result = await latest.current.callTool({
          environmentId,
          input: { ...input, name, arguments: args },
        });
        if (result._tag !== "Success") throw commandFailure(result);
        return result.value;
      },
      readResource: async ({ uri: resourceUri }) => {
        const { environmentId, input } = scope();
        const result = await latest.current.readResource({
          environmentId,
          input: { ...input, uri: resourceUri },
        });
        if (result._tag !== "Success") throw commandFailure(result);
        return result.value;
      },
      openLink: async (url) => {
        if (!(await tryOpenExternalUrl(url, "mcp-app"))) {
          throw new McpAppHostRefusal("The link could not be opened.");
        }
      },
      sendMessage: async (text) => {
        if (!(await confirm(`Send this message from ${app.server}?`, text, "Send"))) {
          throw new McpAppHostRefusal("Declined by the user.");
        }
        // Through the outbox like a typed message, so it survives a dropped
        // connection; the thread's own settings fill in when it sends.
        await enqueueThreadOutboxMessage({
          environmentId: latest.current.props.environmentId,
          threadId: latest.current.props.threadId,
          messageId: MessageId.make(uuidv4()),
          commandId: CommandId.make(uuidv4()),
          text,
          attachments: [],
          dispatchMode: "queue",
          createdAt: new Date().toISOString(),
        });
      },
      // The feed row is a fixed box, so the app's own height only decides
      // whether it scrolls inside it.
      onSizeChanged: () => undefined,
    });
    hostRef.current = next;
    return () => {
      next.dispose();
      hostRef.current = null;
    };
  }, [uri, app]);

  // The host reads the context through `latest`; these only say when to resend.
  useEffect(() => {
    hostRef.current?.updateHostContext();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Context changes trigger a resend.
  }, [theme, props.width]);
  // A new document gets a new host, which needs the call again.
  useEffect(() => {
    if (toolCall !== undefined) hostRef.current?.setToolCall(toolCall);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each new document needs the call.
  }, [toolCall, uri]);

  const source = useMemo(
    () =>
      uri === null ? null : { html: outerDocument(uri, mcpAppAllowAttribute(app.permissions)) },
    [uri, app.permissions],
  );

  return (
    <View style={{ height: MCP_APP_ROW_HEIGHT, marginBottom: ROW_BOTTOM_MARGIN }}>
      {uri !== null ? (
        <WebView<object>
          ref={webView}
          source={source!}
          accessibilityLabel={`${app.server} app`}
          style={{ flex: 1, backgroundColor: "transparent" }}
          nestedScrollEnabled
          originWhitelist={["*"]}
          // Only the outer page loads at the top; the app opens links through the bridge.
          onShouldStartLoadWithRequest={(request) =>
            request.isTopFrame === false || request.url === "about:blank"
          }
          setSupportMultipleWindows={false}
          onLoadEnd={() => setLoaded(true)}
          onMessage={(event: WebViewMessageEvent) => {
            try {
              hostRef.current?.receive(JSON.parse(event.nativeEvent.data));
            } catch {
              // Not JSON: not a bridge message.
            }
          }}
        />
      ) : asset._tag === "Failure" ? (
        <View className="flex-1 items-center justify-center">
          <Text className="text-sm text-foreground-muted">Unable to load the {app.server} app</Text>
        </View>
      ) : null}
      {uri !== null && !loaded ? (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : null}
    </View>
  );
}
