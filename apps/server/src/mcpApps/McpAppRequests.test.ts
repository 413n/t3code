import {
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
  type McpAppRequestError,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type {
  ProviderAdapterV2McpApps,
  ProviderAdapterV2SessionRuntime,
} from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as McpAppRequests from "./McpAppRequests.ts";

const threadId = ThreadId.make("thread-app");
const itemId = TurnItemId.make("item-app");
const providerThreadId = ProviderThreadId.make("provider-thread-app");
const providerSessionId = ProviderSessionId.make("provider-session-app");

const appItem = (output: unknown): OrchestrationV2TurnItem => ({
  id: itemId,
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe(0),
  type: "dynamic_tool",
  toolName: "weather.get_weather",
  input: {},
  output,
});

const app = {
  attachmentId: "thread-app-00000000-0000-0000-0000-000000000000-html",
  server: "weather",
  tool: "get_weather",
  resourceUri: "ui://weather/dashboard",
};

function makeLayer(input: {
  readonly item: OrchestrationV2TurnItem | null;
  readonly mcpApps?: ProviderAdapterV2McpApps;
  readonly live?: boolean;
}) {
  return McpAppRequests.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getTurnItem: () => Effect.succeed(input.item),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({
              providerThreads: [
                { id: providerThreadId, providerSessionId } as OrchestrationV2ProviderThread,
              ],
            } as never),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: () =>
            Effect.succeed(
              input.live === false
                ? Option.none()
                : Option.some({
                    ...(input.mcpApps === undefined ? {} : { mcpApps: input.mcpApps }),
                  } as ProviderAdapterV2SessionRuntime),
            ),
        }),
      ),
    ),
  );
}

const reason = (
  effect: Effect.Effect<unknown, McpAppRequestError, McpAppRequests.McpAppRequests>,
) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

describe("McpAppRequests", () => {
  const calls: Array<{ server: string; tool: string }> = [];
  const mcpApps: ProviderAdapterV2McpApps = {
    listTools: () =>
      Effect.succeed([
        { name: "refresh", annotations: { readOnlyHint: true } },
        { name: "model_only", _meta: { ui: { visibility: ["model"] } } },
      ]),
    callTool: (input) =>
      Effect.sync(() => {
        calls.push({ server: input.server, tool: input.tool });
        return { content: [{ type: "text", text: "ok" }] };
      }),
    readResource: () => Effect.succeed({ contents: [] }),
  };

  it.effect("calls tools on the app's own server and reports their read-only hint", () =>
    Effect.gen(function* () {
      const requests = yield* McpAppRequests.McpAppRequests;
      const result = yield* requests.callTool({
        threadId,
        itemId,
        name: "refresh",
        arguments: {},
      });
      assert.deepEqual(result, { content: [{ type: "text", text: "ok" }] });
      assert.deepEqual(calls.at(-1), { server: "weather", tool: "refresh" });
      assert.deepEqual(yield* requests.toolInfo({ threadId, itemId, name: "refresh" }), {
        callable: true,
        readOnly: true,
      });
    }).pipe(Effect.provide(makeLayer({ item: appItem({ t3McpApp: app }), mcpApps }))),
  );

  it.effect("refuses tools hidden from apps or missing from the server", () =>
    Effect.gen(function* () {
      const requests = yield* McpAppRequests.McpAppRequests;
      const before = calls.length;
      for (const name of ["model_only", "unknown"]) {
        assert.equal(
          yield* reason(requests.callTool({ threadId, itemId, name, arguments: {} })),
          "tool-not-callable",
        );
      }
      assert.equal(calls.length, before);
    }).pipe(Effect.provide(makeLayer({ item: appItem({ t3McpApp: app }), mcpApps }))),
  );

  it.effect("reports why a request cannot run", () =>
    Effect.gen(function* () {
      const run = (layer: ReturnType<typeof makeLayer>) =>
        Effect.gen(function* () {
          const requests = yield* McpAppRequests.McpAppRequests;
          return yield* reason(requests.readResource({ threadId, itemId, uri: "ui://weather/x" }));
        }).pipe(Effect.provide(layer));
      assert.equal(
        yield* run(makeLayer({ item: appItem({ result: "plain" }), mcpApps })),
        "not-an-app",
      );
      assert.equal(
        yield* run(makeLayer({ item: appItem({ t3McpApp: app }), mcpApps, live: false })),
        "session-stopped",
      );
      assert.equal(
        yield* run(makeLayer({ item: appItem({ t3McpApp: app }) })),
        "provider-unsupported",
      );
    }),
  );
});
