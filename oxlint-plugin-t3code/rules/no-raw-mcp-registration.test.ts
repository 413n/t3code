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
});
