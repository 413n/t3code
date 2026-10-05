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
import { MCP_APP_MAX_HEIGHT, mcpAppFileName, type McpAppReference } from "@t3tools/shared/mcpApp";
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

// In a WebView the app is the top document, so `window.parent` is itself. This
// routes the app's posts to React Native and is how host replies, injected as
// `window.__t3McpAppReceive(...)`, arrive as `message` events from the "parent".
const BRIDGE_SCRIPT = `(function(){
var post=function(message){window.ReactNativeWebView.postMessage(JSON.stringify(message));};
try{Object.defineProperty(window,"parent",{value:{postMessage:post},configurable:false});}catch(e){}
window.__t3McpAppReceive=function(message){window.dispatchEvent(new MessageEvent("message",{data:message,source:window.parent}));};
})();true;`;

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
  const latest = useRef({ theme, props, callTool, toolInfo, readResource });
  latest.current = { theme, props, callTool, toolInfo, readResource };
  const webView = useRef<WebView<object>>(null);
  const hostRef = useRef<McpAppHost | null>(null);

  const host = useMemo(() => {
    hostRef.current?.dispose();
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
    return next;
    // One host per document; current values are read through `latest`.
  }, [uri, app]);
  useEffect(() => () => hostRef.current?.dispose(), []);

  useEffect(() => {
    host.updateHostContext();
  }, [host, theme, props.width]);
  useEffect(() => {
    if (toolCall !== undefined) host.setToolCall(toolCall);
  }, [host, toolCall]);

  const withoutFragment = (url: string) => url.split("#", 1)[0];

  return (
    <View style={{ height: MCP_APP_ROW_HEIGHT, marginBottom: ROW_BOTTOM_MARGIN }}>
      {uri !== null ? (
        <WebView<object>
          ref={webView}
          source={{ uri }}
          accessibilityLabel={`${app.server} app`}
          style={{ flex: 1, backgroundColor: "transparent" }}
          injectedJavaScriptBeforeContentLoaded={BRIDGE_SCRIPT}
          nestedScrollEnabled
          // Only the app's own document loads here; it opens links through the bridge.
          onShouldStartLoadWithRequest={(request) =>
            request.isTopFrame === false || withoutFragment(request.url) === withoutFragment(uri)
          }
          setSupportMultipleWindows={false}
          onLoadEnd={() => setLoaded(true)}
          onMessage={(event: WebViewMessageEvent) => {
            try {
              host.receive(JSON.parse(event.nativeEvent.data));
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
