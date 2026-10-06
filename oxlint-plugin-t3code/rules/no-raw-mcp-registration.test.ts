import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-raw-mcp-registration");

describe("t3code/no-raw-mcp-registration", () => {
  rule.valid(
    "allows other McpServer members",
    `
      import { McpServer } from "effect/ai";
      export const server = McpServer.McpServer;
    `,
  );

  rule.invalid(
    "reports McpServer.toolkit",
    `
      import { McpServer } from "effect/ai";
      export const registration = McpServer.toolkit(SomeToolkit);
    `,
    (output) => {
      assert.match(output, /McpToolAccess/);
    },
  );

  rule.invalid(
    "reports McpServer.registerToolkit",
    `
      import { McpServer } from "effect/ai";
      export const registration = McpServer.registerToolkit(SomeToolkit);
    `,
  );

  rule.invalid(
    "reports McpServer.resource and McpServer.prompt",
    `
      import { McpServer } from "effect/ai";
      export const resource = McpServer.resource({ uri: "t3://x", name: "x", content: "x" });
      export const prompt = McpServer.prompt({ name: "x", content: () => "x" });
    `,
  );

  rule.invalid(
    "reports addTool on the McpServer service",
    `
      import * as Effect from "effect/Effect";
      import { McpServer } from "effect/ai";
      export const register = Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        yield* server.addTool({ tool, annotations, handle: () => Effect.die("unchecked") });
      });
    `,
    (output) => {
      assert.match(output, /\.addTool registers on \/mcp/);
    },
  );
});
