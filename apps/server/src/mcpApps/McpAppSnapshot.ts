import type { ThreadId } from "@t3tools/contracts";
import {
  injectMcpAppCsp,
  MCP_APP_MAX_HTML_BYTES,
  MCP_APP_MIME_TYPE,
  MCP_APP_RESOURCE_SCHEME,
  readMcpAppCsp,
  readMcpAppPermissions,
  type McpAppReference,
} from "@t3tools/shared/mcpApp";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Predicate from "effect/Predicate";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { createAttachmentId } from "../attachmentStore.ts";

const encoder = new TextEncoder();

/**
 * The HTML document in a `resources/read` result, with the `_meta.ui` the
 * resource declared. Only `text/html;profile=mcp-app` content counts; a blob is
 * base64 per MCP.
 */
export function readMcpAppDocument(
  contents: ReadonlyArray<unknown>,
  uri: string,
): { readonly html: string; readonly meta: unknown } | undefined {
  for (const content of contents) {
    if (!Predicate.isObject(content)) continue;
    if (content.uri !== undefined && content.uri !== uri) continue;
    const mimeType = typeof content.mimeType === "string" ? content.mimeType : "";
    if (mimeType.replace(/\s+/g, "").toLowerCase() !== MCP_APP_MIME_TYPE) continue;
    const html =
      typeof content.text === "string"
        ? content.text
        : typeof content.blob === "string"
          ? Buffer.from(content.blob, "base64").toString("utf8")
          : undefined;
    if (html === undefined || html.trim() === "") continue;
    const meta = Predicate.isObject(content._meta) ? content._meta.ui : undefined;
    return { html, meta };
  }
  return undefined;
}

/**
 * Stores an app's document as a thread attachment and returns the reference
 * clients host it from. Saving a snapshot keeps the app viewable after the
 * provider exits; interaction still goes through a live provider session.
 * Undefined when the resource is not an MCP App document or is too large.
 */
export const snapshotMcpApp = Effect.fn("McpAppSnapshot.snapshot")(function* (input: {
  readonly attachmentsDir: string;
  readonly threadId: ThreadId;
  readonly server: string;
  readonly tool: string;
  readonly resourceUri: string;
  readonly contents: ReadonlyArray<unknown>;
}) {
  if (!input.resourceUri.startsWith(MCP_APP_RESOURCE_SCHEME)) return undefined;
  const document = readMcpAppDocument(input.contents, input.resourceUri);
  if (document === undefined) return undefined;
  if (encoder.encode(document.html).byteLength > MCP_APP_MAX_HTML_BYTES) {
    yield* Effect.logWarning("MCP app document exceeds the size limit.", {
      server: input.server,
      resourceUri: input.resourceUri,
    });
    return undefined;
  }
  // The `-html` suffix makes the asset route serve it as a sandboxed document.
  const attachmentId = createAttachmentId(input.threadId, "html");
  const filePath =
    attachmentId === null
      ? null
      : resolveAttachmentRelativePath({
          attachmentsDir: input.attachmentsDir,
          relativePath: `${attachmentId}.html`,
        });
  if (attachmentId === null || filePath === null) return undefined;
  const ui = Predicate.isObject(document.meta) ? document.meta : {};
  const csp = readMcpAppCsp(ui.csp);
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.writeFileString(filePath, injectMcpAppCsp(document.html, csp));
  const permissions = readMcpAppPermissions(ui.permissions);
  return {
    attachmentId,
    server: input.server,
    tool: input.tool,
    resourceUri: input.resourceUri,
    ...(csp === undefined ? {} : { csp }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(typeof ui.prefersBorder === "boolean" ? { prefersBorder: ui.prefersBorder } : {}),
  } satisfies McpAppReference;
});
