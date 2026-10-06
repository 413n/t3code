import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

// Effect's MCP server, and the modules that re-export it.
const MCP_SERVER_MODULE = "effect/ai/McpServer";
const AI_MODULES = new Set(["effect/ai", "effect/ai/index"]);
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
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

const HOW =
  "Build the handlers with McpToolAccess.toLayer and register them through McpHttpServer's toolkitRegistration.";
const registrationMessage = (name: string) =>
  `${name} registers on /mcp without the access checks McpToolAccess declares. ${HOW}`;
const importMessage = `Only McpHttpServer may use Effect's McpServer: a registration anywhere else skips the access checks McpToolAccess declares. ${HOW}`;

const literalString = (node: unknown): Option.Option<string> =>
  Option.flatMap(unwrapExpression(node), (expression) =>
    expression.type === "Literal" && typeof expression.value === "string"
      ? Option.some(expression.value)
      : Option.none(),
  );

const namesMcpServer = (node: unknown) =>
  Option.getOrUndefined(getPropertyName(node)) === "McpServer";

const exposesMcpServer = (source: Option.Option<string>) =>
  Option.isSome(source) && (source.value === MCP_SERVER_MODULE || AI_MODULES.has(source.value));

/**
 * Keeps every registration on `/mcp` inside McpHttpServer, whose helpers
 * accept only handlers McpToolAccess built; the lint config exempts that file.
 * Elsewhere it reports runtime imports of Effect's McpServer, under any name
 * or path, and reading a registration method or function in any form. Tests
 * may import McpServer to build a server, so there only the registration
 * reads are reported. It guards against a registration that skips the checks
 * by accident; deliberately working around it needs a reviewed change here.
 */
export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow registering on the MCP server without McpToolAccess; tools must declare who may call them.",
    },
  },
  create(context) {
    const checksImports = !TEST_FILE_PATTERN.test(context.filename);
    return {
      ImportDeclaration(node) {
        if (!checksImports || node.importKind === "type") return;
        const source = literalString(node.source);
        if (Option.isNone(source)) return;
        const exposes = node.specifiers.some((specifier) => {
          if (specifier.type !== "ImportSpecifier") return exposesMcpServer(source);
          if (specifier.importKind === "type") return false;
          return (
            source.value === MCP_SERVER_MODULE ||
            (AI_MODULES.has(source.value) && namesMcpServer(specifier.imported))
          );
        });
        if (exposes) context.report({ node, message: importMessage });
      },
      ExportNamedDeclaration(node) {
        if (!checksImports || node.source === null || node.exportKind === "type") return;
        const source = literalString(node.source);
        if (Option.isNone(source)) return;
        const exposes = node.specifiers.some(
          (specifier) =>
            specifier.exportKind !== "type" &&
            (source.value === MCP_SERVER_MODULE ||
              (AI_MODULES.has(source.value) && namesMcpServer(specifier.local))),
        );
        if (exposes) context.report({ node, message: importMessage });
      },
      ExportAllDeclaration(node) {
        if (!checksImports || node.exportKind === "type") return;
        if (exposesMcpServer(literalString(node.source))) {
          context.report({ node, message: importMessage });
        }
      },
      ImportExpression(node) {
        if (checksImports && exposesMcpServer(literalString(node.source))) {
          context.report({ node, message: importMessage });
        }
      },
      MemberExpression(node) {
        const name = getPropertyName(node.property);
        if (Option.isNone(name)) return;
        if (SERVICE_REGISTRATIONS.has(name.value)) {
          context.report({ node, message: registrationMessage(`.${name.value}`) });
        } else if (
          MODULE_REGISTRATIONS.has(name.value) &&
          isIdentifier(unwrapExpression(node.object), "McpServer")
        ) {
          context.report({ node, message: registrationMessage(`McpServer.${name.value}`) });
        }
      },
      // `const { addTool } = server`
      ObjectPattern(node) {
        for (const property of node.properties) {
          if (property.type !== "Property") continue;
          const name = getPropertyName(property.key);
          if (Option.isSome(name) && SERVICE_REGISTRATIONS.has(name.value)) {
            context.report({ node: property, message: registrationMessage(`.${name.value}`) });
          }
        }
      },
    };
  },
});
