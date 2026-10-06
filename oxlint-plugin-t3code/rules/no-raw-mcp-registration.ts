import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

// Registering tools straight on the MCP server skips McpToolAccess, where every
// T3 MCP tool declares who may call it.
const RAW_REGISTRATIONS = new Set(["toolkit", "registerToolkit"]);

const message = (method: string) =>
  `McpServer.${method} registers tools without the access checks McpToolAccess declares. Build the handlers with McpToolAccess.toLayer and register them through McpHttpServer's toolkitRegistration.`;

/**
 * Reports `McpServer.toolkit(...)` and `McpServer.registerToolkit(...)`. The
 * registration helpers in McpHttpServer are the only allowed call sites, and
 * the lint config exempts that file.
 */
export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow registering MCP toolkits without McpToolAccess; tools must declare who may call them.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (Option.isNone(callee) || callee.value.type !== "MemberExpression") return;
        if (!isIdentifier(unwrapExpression(callee.value.object), "McpServer")) return;
        const method = getPropertyName(callee.value.property);
        if (Option.isNone(method) || !RAW_REGISTRATIONS.has(method.value)) return;
        context.report({ node, message: message(method.value) });
      },
    };
  },
});
