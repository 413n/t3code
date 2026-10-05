import { describe, expect, it } from "vite-plus/test";

import {
  injectMcpAppCsp,
  mcpAppContentSecurityPolicy,
  mcpAppToolCallableByApp,
  readMcpAppCsp,
  readMcpAppReference,
  readMcpAppResourceUri,
} from "./mcpApp.ts";

describe("mcpAppContentSecurityPolicy", () => {
  it("blocks the network and T3's own origin when the app declares nothing", () => {
    const policy = mcpAppContentSecurityPolicy(undefined);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).not.toContain("'self'");
  });

  it("allows exactly the declared origins", () => {
    const policy = mcpAppContentSecurityPolicy({
      connectDomains: ["https://api.weather.test"],
      resourceDomains: ["https://*.cdn.test"],
    });
    expect(policy).toContain("connect-src https://api.weather.test");
    expect(policy).toContain("script-src 'unsafe-inline' https://*.cdn.test");
    expect(policy).toContain("img-src data: blob: https://*.cdn.test");
  });
});

describe("injectMcpAppCsp", () => {
  it("puts the policy after the doctype and ahead of every script", () => {
    const html = "<!DOCTYPE html><html><head><script>x()</script></head></html>";
    const injected = injectMcpAppCsp(html, undefined);
    expect(injected.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"')).toBe(
      true,
    );
    expect(injected.indexOf("connect-src 'none'")).toBeLessThan(injected.indexOf("<script>"));
    expect(injectMcpAppCsp("<p>hi</p>", undefined).startsWith("<!doctype html><meta")).toBe(true);
  });
});

describe("readMcpAppCsp", () => {
  it("drops entries that could widen or break the policy", () => {
    expect(
      readMcpAppCsp({
        connectDomains: [
          "https://ok.test",
          "*",
          "'self'",
          "https://evil.test; script-src *",
          "http://localhost:3000",
          "javascript:alert(1)",
        ],
        resourceDomains: "https://not-an-array.test",
      }),
    ).toEqual({ connectDomains: ["https://ok.test", "http://localhost:3000"] });
    expect(readMcpAppCsp({ connectDomains: ["*"] })).toBeUndefined();
  });
});

describe("readMcpAppReference", () => {
  it("requires a ui:// resource and the owning server and tool", () => {
    const reference = {
      attachmentId: "thread-1-abc-html",
      server: "weather",
      tool: "get_weather",
      resourceUri: "ui://weather/dashboard",
    };
    expect(readMcpAppReference(reference)).toEqual(reference);
    expect(readMcpAppReference({ ...reference, resourceUri: "https://x.test" })).toBeUndefined();
    expect(readMcpAppReference({ ...reference, server: "" })).toBeUndefined();
  });
});

describe("tool metadata", () => {
  it("reads the resource URI from either spelling and honors app visibility", () => {
    expect(readMcpAppResourceUri({ ui: { resourceUri: "ui://a/b" } })).toBe("ui://a/b");
    expect(readMcpAppResourceUri({ "ui/resourceUri": "ui://a/c" })).toBe("ui://a/c");
    expect(readMcpAppResourceUri({ ui: { resourceUri: "https://a" } })).toBeUndefined();
    expect(mcpAppToolCallableByApp(undefined)).toBe(true);
    expect(mcpAppToolCallableByApp({ ui: { visibility: ["model"] } })).toBe(false);
    expect(mcpAppToolCallableByApp({ ui: { visibility: ["model", "app"] } })).toBe(true);
  });
});
