import { describe, expect, it } from "vite-plus/test";

import { makeMcpAppHost, McpAppHostRefusal, type McpAppHostContext } from "./host.ts";

const app = {
  attachmentId: "thread-1-app",
  server: "weather",
  tool: "get_weather",
  resourceUri: "ui://weather/dashboard",
  csp: { connectDomains: ["https://api.weather.test"] },
};

const context = (theme: "light" | "dark" = "dark"): McpAppHostContext => ({
  theme,
  styles: { variables: { "--color-background-primary": theme === "dark" ? "#000" : "#fff" } },
  displayMode: "inline",
  availableDisplayModes: ["inline"],
  containerDimensions: { width: 600, maxHeight: 2000 },
  platform: "web",
});

// Lets the host settle the promises its callbacks return.
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => undefined);

function setup(overrides: Partial<Parameters<typeof makeMcpAppHost>[0]> = {}) {
  const sent: Array<Record<string, unknown>> = [];
  let theme: "light" | "dark" = "dark";
  const host = makeMcpAppHost({
    app,
    hostVersion: "1.0.0",
    post: (message) => sent.push(message as Record<string, unknown>),
    hostContext: () => context(theme),
    callTool: async (input) => ({ content: [{ type: "text", text: `called ${input.name}` }] }),
    readResource: async () => ({ contents: [] }),
    openLink: async () => undefined,
    sendMessage: async () => undefined,
    onSizeChanged: () => undefined,
    ...overrides,
  });
  return {
    host,
    sent,
    setTheme: (next: "light" | "dark") => {
      theme = next;
    },
  };
}

describe("makeMcpAppHost", () => {
  it("initializes, then replays the tool input and result after initialized", () => {
    const { host, sent } = setup();
    host.setToolCall({
      arguments: { city: "Oslo" },
      result: { content: [{ type: "text", text: "Sunny" }] },
    });
    host.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: { protocolVersion: "2026-01-26", appInfo: { name: "a", version: "1" } },
    });
    expect(sent[0]).toMatchObject({
      id: 1,
      result: {
        protocolVersion: "2026-01-26",
        hostCapabilities: { serverTools: {}, sandbox: { csp: app.csp } },
        hostContext: { theme: "dark", displayMode: "inline" },
      },
    });
    expect(sent).toHaveLength(1);

    host.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    expect(sent.slice(1)).toEqual([
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: { city: "Oslo" } },
      },
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { content: [{ type: "text", text: "Sunny" }] },
      },
    ]);
  });

  it("replays a tool call that arrives after initialization, once", () => {
    const { host, sent } = setup();
    host.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
    host.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    sent.length = 0;
    host.setToolCall({ arguments: { city: "Oslo" }, result: undefined });
    host.setToolCall({ arguments: { city: "Bergen" }, result: undefined });
    expect(sent).toEqual([
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: { city: "Oslo" } },
      },
    ]);
  });

  it("drops null fields providers report, which the MCP Apps SDK rejects", async () => {
    const { host, sent } = setup({
      callTool: async () => ({ content: [], structuredContent: null, _meta: null }),
    });
    host.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
    host.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    host.setToolCall({
      arguments: {},
      result: {
        content: [{ type: "text", text: "t" }],
        structuredContent: { time: "t" },
        _meta: null,
      },
    });
    host.receive({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get-time" } });
    await flush();
    expect(sent.find((m) => m.method === "ui/notifications/tool-result")?.params).toEqual({
      content: [{ type: "text", text: "t" }],
      structuredContent: { time: "t" },
    });
    expect(sent.find((m) => m.id === 2)?.result).toEqual({ content: [] });
  });

  it("accepts ui/message as one text block or the SDK's block array", async () => {
    const messages: Array<string> = [];
    const { host, sent } = setup({ sendMessage: async (text) => void messages.push(text) });
    host.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/message",
      params: { role: "user", content: { type: "text", text: "one" } },
    });
    host.receive({
      jsonrpc: "2.0",
      id: 2,
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: "two" }] },
    });
    host.receive({
      jsonrpc: "2.0",
      id: 3,
      method: "ui/message",
      params: { role: "user", content: [{ type: "image", data: "x" }] },
    });
    await flush();
    expect(messages).toEqual(["one", "two"]);
    expect(sent.find((m) => m.id === 3)?.error).toMatchObject({ code: -32602 });
  });

  it("sends only changed context fields, and nothing before initialization", () => {
    const { host, sent, setTheme } = setup();
    setTheme("light");
    host.updateHostContext();
    expect(sent).toHaveLength(0);

    host.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
    host.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    sent.length = 0;
    setTheme("dark");
    host.updateHostContext();
    expect(sent).toEqual([
      {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { theme: "dark", styles: context("dark").styles },
      },
    ]);
    host.updateHostContext();
    expect(sent).toHaveLength(1);
  });

  it("proxies tools/call and reports a refusal as a JSON-RPC error", async () => {
    const { host, sent } = setup({
      callTool: async (input) => {
        if (input.name === "delete_everything")
          throw new McpAppHostRefusal("Declined by the user.");
        return { content: [], structuredContent: { ok: true } };
      },
    });
    host.receive({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "refresh" } });
    host.receive({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "delete_everything", arguments: {} },
    });
    await flush();
    expect(sent).toContainEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [], structuredContent: { ok: true } },
    });
    expect(sent).toContainEqual({
      jsonrpc: "2.0",
      id: 8,
      error: { code: -32000, message: "Declined by the user." },
    });
  });

  it("rejects malformed requests and unsupported methods", () => {
    const { host, sent } = setup();
    host.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/open-link",
      params: { url: "javascript:x" },
    });
    host.receive({ jsonrpc: "2.0", id: 2, method: "ui/update-model-context", params: {} });
    host.receive({ jsonrpc: "2.0", id: 3, method: "sampling/createMessage", params: {} });
    host.receive({ jsonrpc: "2.0", id: 4, method: "ui/message", params: { role: "assistant" } });
    expect(sent.map((message) => (message.error as { code: number }).code)).toEqual([
      -32602, -32601, -32601, -32602,
    ]);
  });

  it("refuses requests past the in-flight limit and posts nothing after dispose", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { host, sent } = setup({
      callTool: async () => {
        await gate;
        return { content: [] };
      },
    });
    for (let id = 0; id < 17; id++) {
      host.receive({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "slow" } });
    }
    expect(sent).toEqual([
      { jsonrpc: "2.0", id: 16, error: { code: -32000, message: "Too many requests in flight." } },
    ]);
    host.dispose();
    release();
    await flush();
    expect(sent).toHaveLength(1);
  });
});
