import { MCP_APP_PROTOCOL_VERSION, type McpAppReference } from "@t3tools/shared/mcpApp";
import * as Predicate from "effect/Predicate";

/**
 * The host side of the MCP Apps bridge (spec 2026-01-26): JSON-RPC 2.0 over
 * postMessage between a client and one app document. It is transport-free so
 * web (an iframe) and mobile (a WebView) share every protocol rule; each
 * platform supplies how to post a message and how to reach the environment.
 */

const MAX_MESSAGE_BYTES = 256 * 1024;
/** Requests an app may have in flight at once; more are refused, not queued. */
const MAX_PENDING_REQUESTS = 16;
const encoder = new TextEncoder();

type JsonRpcId = string | number;

export interface McpAppHostContext {
  readonly theme: "light" | "dark";
  readonly styles: { readonly variables: Readonly<Record<string, string>> };
  readonly displayMode: "inline";
  readonly availableDisplayModes: ReadonlyArray<"inline">;
  readonly containerDimensions: { readonly width: number; readonly maxHeight: number };
  readonly platform: "web" | "desktop" | "mobile";
  readonly locale?: string;
  readonly timeZone?: string;
}

export interface McpAppCallToolResult {
  readonly content: ReadonlyArray<unknown>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
  readonly _meta?: unknown;
}

/** Thrown by host callbacks to refuse a request with a message the app can show. */
export class McpAppHostRefusal extends Error {}

export interface McpAppHostOptions {
  readonly app: McpAppReference;
  readonly hostVersion: string;
  /** Posts one JSON-RPC message to the app document. */
  readonly post: (message: unknown) => void;
  readonly hostContext: () => McpAppHostContext;
  /** The original tool call's arguments and result, replayed after initialization. */
  readonly toolInput: () => unknown;
  readonly toolResult: () => McpAppCallToolResult | undefined;
  readonly callTool: (input: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }) => Promise<McpAppCallToolResult>;
  readonly readResource: (input: { readonly uri: string }) => Promise<unknown>;
  readonly openLink: (url: string) => Promise<void>;
  readonly sendMessage: (text: string) => Promise<void>;
  readonly onSizeChanged: (size: { readonly width?: number; readonly height?: number }) => void;
}

export interface McpAppHost {
  /** Handles one message the app posted; the caller has already checked its source. */
  readonly receive: (data: unknown) => void;
  /** Sends `host-context-changed` with the fields that differ from what the app last saw. */
  readonly updateHostContext: () => void;
  readonly dispose: () => void;
}

function jsonBytes(value: unknown): number {
  try {
    return encoder.encode(JSON.stringify(value) ?? "").byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

const errorMessage = (error: unknown) =>
  error instanceof McpAppHostRefusal
    ? error.message
    : error instanceof Error && error.message.trim() !== ""
      ? error.message
      : "Request failed.";

export function makeMcpAppHost(options: McpAppHostOptions): McpAppHost {
  let initialized = false;
  let disposed = false;
  let pending = 0;
  let sentContext: McpAppHostContext | undefined;

  const post = (message: unknown) => {
    if (!disposed) options.post(message);
  };
  const notify = (method: string, params: unknown) => post({ jsonrpc: "2.0", method, params });
  const respond = (id: JsonRpcId, result: unknown) => post({ jsonrpc: "2.0", id, result });
  const fail = (id: JsonRpcId, code: number, message: string) =>
    post({ jsonrpc: "2.0", id, error: { code, message } });

  const answer = (id: JsonRpcId, run: () => Promise<unknown>) => {
    if (pending >= MAX_PENDING_REQUESTS) {
      fail(id, -32000, "Too many requests in flight.");
      return;
    }
    pending += 1;
    void run().then(
      (result) => {
        pending -= 1;
        respond(id, result);
      },
      (error: unknown) => {
        pending -= 1;
        fail(id, -32000, errorMessage(error));
      },
    );
  };

  const handleRequest = (id: JsonRpcId, method: string, params: Record<PropertyKey, unknown>) => {
    switch (method) {
      case "ui/initialize": {
        const requested = params.protocolVersion;
        sentContext = options.hostContext();
        respond(id, {
          protocolVersion:
            requested === MCP_APP_PROTOCOL_VERSION ? requested : MCP_APP_PROTOCOL_VERSION,
          hostInfo: { name: "t3-code", version: options.hostVersion },
          hostCapabilities: {
            openLinks: {},
            serverTools: {},
            serverResources: {},
            logging: {},
            message: { text: {} },
            sandbox: {
              ...(options.app.csp === undefined ? {} : { csp: options.app.csp }),
              ...(options.app.permissions === undefined
                ? {}
                : { permissions: options.app.permissions }),
            },
          },
          hostContext: sentContext,
        });
        return;
      }
      case "ping":
        respond(id, {});
        return;
      case "tools/call": {
        const name = params.name;
        const args = params.arguments ?? {};
        if (typeof name !== "string" || name.trim() === "" || !Predicate.isObject(args)) {
          fail(id, -32602, "tools/call needs a tool name and object arguments.");
          return;
        }
        answer(id, () => options.callTool({ name, arguments: args as Record<string, unknown> }));
        return;
      }
      case "resources/read": {
        const uri = params.uri;
        if (typeof uri !== "string" || uri.trim() === "") {
          fail(id, -32602, "resources/read needs a uri.");
          return;
        }
        answer(id, () => options.readResource({ uri }));
        return;
      }
      case "ui/open-link": {
        const url = params.url;
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
          fail(id, -32602, "Only http(s) links can be opened.");
          return;
        }
        answer(id, () => options.openLink(url).then(() => ({})));
        return;
      }
      case "ui/message": {
        const content = Predicate.isObject(params.content) ? params.content : undefined;
        if (
          params.role !== "user" ||
          content?.type !== "text" ||
          typeof content.text !== "string"
        ) {
          fail(id, -32602, "Only text messages from the user role are supported.");
          return;
        }
        const text = content.text;
        answer(id, () => options.sendMessage(text).then(() => ({})));
        return;
      }
      case "ui/request-display-mode":
        // Inline is the only mode this host offers, so every request resolves to it.
        respond(id, { mode: "inline" });
        return;
      case "ui/update-model-context":
        fail(id, -32601, "This host does not accept model context updates.");
        return;
      default:
        fail(id, -32601, `Method not found: ${method}`);
    }
  };

  const handleNotification = (method: string, params: Record<PropertyKey, unknown>) => {
    switch (method) {
      case "ui/notifications/initialized": {
        if (initialized) return;
        initialized = true;
        const args = options.toolInput();
        notify("ui/notifications/tool-input", {
          arguments: Predicate.isObject(args) ? args : {},
        });
        const result = options.toolResult();
        if (result !== undefined) notify("ui/notifications/tool-result", result);
        return;
      }
      case "ui/notifications/size-changed": {
        const width = typeof params.width === "number" ? params.width : undefined;
        const height = typeof params.height === "number" ? params.height : undefined;
        if (width !== undefined || height !== undefined) {
          options.onSizeChanged({
            ...(width === undefined ? {} : { width }),
            ...(height === undefined ? {} : { height }),
          });
        }
        return;
      }
      default:
      // notifications/message (logging) and unknown notifications are ignored.
    }
  };

  return {
    receive: (data) => {
      if (disposed || !Predicate.isObject(data) || data.jsonrpc !== "2.0") return;
      if (jsonBytes(data) > MAX_MESSAGE_BYTES) {
        if (isId(data.id) && typeof data.method === "string") {
          fail(data.id, -32600, "Message too large.");
        }
        return;
      }
      const method = data.method;
      if (typeof method !== "string") return;
      const params = Predicate.isObject(data.params) ? data.params : {};
      if (isId(data.id)) handleRequest(data.id, method, params);
      else handleNotification(method, params);
    },
    updateHostContext: () => {
      // The spec forbids messages before the app finishes initializing; it
      // reads the then-current context from the initialize response anyway.
      if (!initialized || sentContext === undefined) return;
      const next = options.hostContext();
      const changes: Record<string, unknown> = {};
      for (const key of Object.keys(next) as Array<keyof McpAppHostContext>) {
        if (JSON.stringify(next[key]) !== JSON.stringify(sentContext[key])) {
          changes[key] = next[key];
        }
      }
      sentContext = next;
      if (Object.keys(changes).length > 0) {
        notify("ui/notifications/host-context-changed", changes);
      }
    },
    dispose: () => {
      disposed = true;
    },
  };
}

/**
 * Maps T3's resolved theme variables to the spec's standardized style names, so
 * apps written for any MCP Apps host pick up the thread's colors and fonts.
 */
export function mcpAppStyleVariables(
  theme: Readonly<Record<string, string>>,
): Record<string, string> {
  const pick = (name: string) => theme[name];
  const pairs: ReadonlyArray<readonly [string, string | undefined]> = [
    ["--color-background-primary", pick("--background")],
    ["--color-background-secondary", pick("--card")],
    ["--color-background-tertiary", pick("--muted")],
    ["--color-background-inverse", pick("--foreground")],
    ["--color-background-info", pick("--info")],
    ["--color-background-danger", pick("--destructive-surface")],
    ["--color-background-warning", pick("--warning-surface")],
    ["--color-text-primary", pick("--foreground")],
    ["--color-text-secondary", pick("--muted-foreground")],
    ["--color-text-tertiary", pick("--muted-foreground")],
    ["--color-text-inverse", pick("--background")],
    ["--color-text-info", pick("--info-foreground")],
    ["--color-text-danger", pick("--destructive-foreground")],
    ["--color-text-success", pick("--success-foreground")],
    ["--color-text-warning", pick("--warning-foreground")],
    ["--color-border-primary", pick("--border")],
    ["--color-border-secondary", pick("--input")],
    ["--color-border-danger", pick("--destructive")],
    ["--color-ring-primary", pick("--ring")],
    ["--font-sans", pick("--font-sans")],
    ["--font-mono", pick("--font-mono")],
    ["--border-radius-md", pick("--radius")],
  ];
  const variables: Record<string, string> = {};
  for (const [name, value] of pairs) {
    if (value !== undefined && value !== "") variables[name] = value;
  }
  return variables;
}
