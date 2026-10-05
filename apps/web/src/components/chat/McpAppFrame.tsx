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
import {
  clampMcpAppHeight,
  MCP_APP_DEFAULT_HEIGHT,
  MCP_APP_MAX_HEIGHT,
  mcpAppAllowAttribute,
  mcpAppFileName,
  type McpAppReference,
} from "@t3tools/shared/mcpApp";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { APP_VERSION } from "~/branding";
import { requestConfirmDialog } from "~/confirmDialog";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { cn } from "~/lib/utils";
import { useTurnItemDetail } from "~/state/queries";
import { mcpAppEnvironment } from "~/state/mcpApps";
import { useAtomCommand } from "~/state/use-atom-command";

const commandFailure = (result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) => {
  const error = squashAtomCommandFailure(result);
  return new McpAppHostRefusal(
    error instanceof Error && error.message.trim() !== "" ? error.message : "Request failed.",
  );
};

/**
 * An MCP App inline in the thread: the captured document in an opaque-origin
 * frame, speaking the MCP Apps bridge. Its tool calls and resource reads reach
 * its own MCP server through the environment; calls to tools the server does
 * not mark read-only, and chat messages, ask first.
 */
export function McpAppFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  /** The item's revision, so its stored call is fetched once per version. */
  readonly revision: string;
  readonly app: McpAppReference;
  readonly onSendMessage: ((text: string) => Promise<void>) | undefined;
}) {
  const { app } = props;
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(MCP_APP_DEFAULT_HEIGHT);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setWidth(box.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

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
  // The frame keeps its first URL: a re-minted one would reload the app.
  const [src, setSrc] = useState<string | null>(null);
  if (src === null && asset._tag === "Success") setSrc(asset.url);

  // The wire timeline omits tool input and output; the app needs both.
  const detail = useTurnItemDetail({
    environmentId: props.environmentId,
    threadId: props.threadId,
    itemId: props.itemId,
    revision: props.revision,
  });
  const storedItem = detail.data?.item;
  const toolCall = useMemo(() => {
    if (storedItem?.type !== "dynamic_tool") return undefined;
    const output = storedItem.output as { readonly result?: unknown } | undefined;
    const result = output?.result as McpAppCallToolResult | undefined;
    return { arguments: storedItem.input, result };
  }, [storedItem]);

  const callTool = useAtomCommand(mcpAppEnvironment.callTool, { reportFailure: false });
  const toolInfo = useAtomCommand(mcpAppEnvironment.toolInfo, { reportFailure: false });
  const readResource = useAtomCommand(mcpAppEnvironment.readResource, { reportFailure: false });

  // Read by the host on every message, so it always sees current values
  // without being rebuilt (which would drop the app's session).
  const latest = useRef({ theme, width, props, callTool, toolInfo, readResource });
  latest.current = { theme, width, props, callTool, toolInfo, readResource };
  const hostRef = useRef<McpAppHost | null>(null);

  const hostContext = (): McpAppHostContext => ({
    theme: latest.current.theme.appearance,
    styles: { variables: mcpAppStyleVariables(latest.current.theme.variables) },
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    containerDimensions: { width: latest.current.width, maxHeight: MCP_APP_MAX_HEIGHT },
    platform: "web",
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  useEffect(() => {
    if (src === null) return;
    const target = () => frameRef.current?.contentWindow ?? null;
    const scope = () => {
      const { environmentId, threadId, itemId } = latest.current.props;
      return { environmentId, input: { threadId, itemId } };
    };
    const host = makeMcpAppHost({
      app,
      hostVersion: APP_VERSION,
      // The document's origin is opaque, so "*" is the only target that reaches it;
      // the window reference itself is what scopes delivery to this frame.
      post: (message) => target()?.postMessage(message, "*"),
      hostContext,
      callTool: async ({ name, arguments: args }) => {
        const { environmentId, input } = scope();
        const info = await latest.current.toolInfo({ environmentId, input: { ...input, name } });
        if (info._tag !== "Success") throw commandFailure(info);
        if (!info.value.callable) throw new McpAppHostRefusal("This app cannot call that tool.");
        if (!info.value.readOnly) {
          const approved = await requestConfirmDialog(
            `Allow ${app.server} to run ${info.value.title ?? name}?\n${JSON.stringify(args, null, 2)}`,
          );
          if (approved !== true) throw new McpAppHostRefusal("Declined by the user.");
        }
        const result = await latest.current.callTool({
          environmentId,
          input: { ...input, name, arguments: args },
        });
        if (result._tag !== "Success") throw commandFailure(result);
        return result.value;
      },
      readResource: async ({ uri }) => {
        const { environmentId, input } = scope();
        const result = await latest.current.readResource({
          environmentId,
          input: { ...input, uri },
        });
        if (result._tag !== "Success") throw commandFailure(result);
        return result.value;
      },
      openLink: async (url) => {
        // Only right after the reader used this frame, as with HTML renders.
        if (document.activeElement !== frameRef.current || !navigator.userActivation?.isActive) {
          throw new McpAppHostRefusal("Links open only from a click in the app.");
        }
        window.open(url, "_blank", "noopener,noreferrer");
      },
      sendMessage: async (text) => {
        const send = latest.current.props.onSendMessage;
        if (send === undefined) throw new McpAppHostRefusal("Messages are not available here.");
        const approved = await requestConfirmDialog(
          `Send this message from ${app.server}?\n${text}`,
        );
        if (approved !== true) throw new McpAppHostRefusal("Declined by the user.");
        await send(text);
      },
      onSizeChanged: (size) => {
        if (size.height !== undefined) setHeight(clampMcpAppHeight(size.height));
      },
    });
    hostRef.current = host;
    const receive = (event: MessageEvent) => {
      // Only messages from this frame's own window reach its host.
      if (event.source !== null && event.source === target()) host.receive(event.data);
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      host.dispose();
      hostRef.current = null;
    };
    // The host lives as long as the document; everything else is read through `latest`.
  }, [src, app]);

  useEffect(() => {
    hostRef.current?.updateHostContext();
  }, [theme, width]);

  useEffect(() => {
    if (toolCall !== undefined) hostRef.current?.setToolCall(toolCall);
  }, [toolCall, src]);

  return (
    <div
      ref={boxRef}
      className={cn(
        "relative overflow-hidden",
        app.prefersBorder === true && "rounded-lg border border-border",
      )}
      style={{ height }}
    >
      {src !== null ? (
        <iframe
          ref={frameRef}
          src={src}
          title={`${app.server} app`}
          // Never allow-same-origin: the opaque origin keeps the app out of the session.
          sandbox="allow-scripts allow-forms"
          allow={mcpAppAllowAttribute(app.permissions)}
          className="block size-full border-0"
          style={{ colorScheme: theme.appearance }}
        />
      ) : asset._tag === "Failure" ? (
        <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
          Unable to load the {app.server} app
        </p>
      ) : null}
    </div>
  );
}
