import {
  McpAppRequestError,
  type McpAppCallToolInput,
  type McpAppCallToolResult,
  type McpAppReadResourceInput,
  type McpAppReadResourceResult,
  type McpAppToolInfo,
  type McpAppToolInfoInput,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import { mcpAppToolCallableByApp, type McpAppReference } from "@t3tools/shared/mcpApp";
import { mcpAppFromToolItem } from "@t3tools/shared/toolOutput";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type {
  ProviderAdapterV2McpApps,
  ProviderAdapterV2McpTool,
} from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/**
 * Requests an MCP App makes of its own MCP server. The app is resolved from the
 * tool call that produced it, so it reaches only that server, and each request
 * runs through the thread's live provider session, whose MCP client owns the
 * connection and its credentials. A stopped session is reported, never
 * started: an app view must not spend a provider turn.
 */
export class McpAppRequests extends Context.Service<
  McpAppRequests,
  {
    readonly callTool: (
      input: McpAppCallToolInput,
    ) => Effect.Effect<McpAppCallToolResult, McpAppRequestError>;
    readonly toolInfo: (
      input: McpAppToolInfoInput,
    ) => Effect.Effect<McpAppToolInfo, McpAppRequestError>;
    readonly readResource: (
      input: McpAppReadResourceInput,
    ) => Effect.Effect<McpAppReadResourceResult, McpAppRequestError>;
  }
>()("t3/mcpApps/McpAppRequests") {}

const readOnlyHint = (tool: ProviderAdapterV2McpTool) =>
  Predicate.isObject(tool.annotations) && tool.annotations.readOnlyHint === true;

const toolTitle = (tool: ProviderAdapterV2McpTool) =>
  Predicate.isObject(tool.annotations) && typeof tool.annotations.title === "string"
    ? tool.annotations.title
    : undefined;

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  const fail = (threadId: ThreadId, reason: McpAppRequestError["reason"], cause?: unknown) =>
    new McpAppRequestError({ threadId, reason, ...(cause === undefined ? {} : { cause }) });

  /** The app, its provider thread, and the live session's MCP Apps operations. */
  const resolve = Effect.fn("McpAppRequests.resolve")(function* (input: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) {
    // The stored item, not the wire projection, so the reference is intact.
    const item = yield* orchestrator
      .getTurnItem({ threadId: input.threadId, itemId: input.itemId })
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
    const app: McpAppReference | undefined =
      item?.type === "dynamic_tool" ? mcpAppFromToolItem(item) : undefined;
    if (item === null || app === undefined || item.providerThreadId === null) {
      return yield* fail(input.threadId, "not-an-app");
    }
    const projection = yield* threadManagement
      .getThreadRecords(input.threadId, ["providerThreads"])
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === item.providerThreadId,
    );
    if (providerThread?.providerSessionId == null) {
      return yield* fail(input.threadId, "session-stopped");
    }
    const runtime = Option.getOrUndefined(
      yield* providerSessions
        .get(providerThread.providerSessionId)
        .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause))),
    );
    if (runtime === undefined) return yield* fail(input.threadId, "session-stopped");
    const mcpApps: ProviderAdapterV2McpApps | undefined = runtime.mcpApps;
    if (mcpApps === undefined) return yield* fail(input.threadId, "provider-unsupported");
    return { app, providerThread, mcpApps };
  });

  const findTool = Effect.fn("McpAppRequests.findTool")(function* (
    threadId: ThreadId,
    resolved: Effect.Success<ReturnType<typeof resolve>>,
    name: string,
  ) {
    const tools = yield* resolved.mcpApps
      .listTools({ providerThread: resolved.providerThread, server: resolved.app.server })
      .pipe(Effect.mapError((cause) => fail(threadId, "request-failed", cause)));
    return tools.find((tool) => tool.name === name);
  });

  const toolInfo = Effect.fn("McpAppRequests.toolInfo")(function* (input: McpAppToolInfoInput) {
    const resolved = yield* resolve(input);
    const tool = yield* findTool(input.threadId, resolved, input.name);
    const title = tool === undefined ? undefined : toolTitle(tool);
    return {
      callable: tool !== undefined && mcpAppToolCallableByApp(tool._meta),
      readOnly: tool !== undefined && readOnlyHint(tool),
      ...(title === undefined ? {} : { title }),
    } satisfies McpAppToolInfo;
  });

  const callTool = Effect.fn("McpAppRequests.callTool")(function* (input: McpAppCallToolInput) {
    const resolved = yield* resolve(input);
    // The spec forbids apps calling tools hidden from them; checked here too,
    // since a client's own check is only a courtesy to its user.
    const tool = yield* findTool(input.threadId, resolved, input.name);
    if (tool === undefined || !mcpAppToolCallableByApp(tool._meta)) {
      return yield* fail(input.threadId, "tool-not-callable");
    }
    return yield* resolved.mcpApps
      .callTool({
        providerThread: resolved.providerThread,
        server: resolved.app.server,
        tool: input.name,
        arguments: input.arguments,
      })
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
  });

  const readResource = Effect.fn("McpAppRequests.readResource")(function* (
    input: McpAppReadResourceInput,
  ) {
    const resolved = yield* resolve(input);
    return yield* resolved.mcpApps
      .readResource({
        providerThread: resolved.providerThread,
        server: resolved.app.server,
        uri: input.uri,
      })
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
  });

  return McpAppRequests.of({ callTool, toolInfo, readResource });
});

export const layer = Layer.effect(McpAppRequests, make);
