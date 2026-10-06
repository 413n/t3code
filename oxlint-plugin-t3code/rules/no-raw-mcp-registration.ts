import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

// Registering anything straight on the MCP server skips McpToolAccess, where
// every T3 MCP tool declares who may call it. These are the module functions...
const MODULE_REGISTRATIONS = new Set([
  "toolkit",
  "registerToolkit",
  "resource",
  "registerResource",
  "prompt",
  "registerPrompt",
]);
// ...and the methods on the McpServer service itself.
const SERVICE_REGISTRATIONS = new Set([
  "addTool",
  "addResource",
  "addResourceTemplate",
  "addPrompt",
]);

const message = (method: string) =>
  `${method} registers on /mcp without the access checks McpToolAccess declares. Build the handlers with McpToolAccess.toLayer and register them through McpHttpServer's toolkitRegistration.`;

/**
 * Reports `McpServer.toolkit(...)` and the module's other registration
 * functions, and `.addTool(...)` and the other registration methods on any
 * object. The registration helpers in McpHttpServer are the only allowed call
 * sites, and the lint config exempts that file.
 */
export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow registering on the MCP server without McpToolAccess; tools must declare who may call them.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (Option.isNone(callee) || callee.value.type !== "MemberExpression") return;
        const method = getPropertyName(callee.value.property);
        if (Option.isNone(method)) return;
        if (SERVICE_REGISTRATIONS.has(method.value)) {
          context.report({ node, message: message(`.${method.value}`) });
          return;
        }
        if (
          MODULE_REGISTRATIONS.has(method.value) &&
          isIdentifier(unwrapExpression(callee.value.object), "McpServer")
        ) {
          context.report({ node, message: message(`McpServer.${method.value}`) });
        }
      },
    };
  },
});
