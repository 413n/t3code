import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  ProviderAdapterSteerRunError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const capabilities = {
  ...CodexProviderCapabilitiesV2,
  turns: { ...CodexProviderCapabilitiesV2.turns, supportsActiveSteering: true },
};

// A parent delegated two tasks with completion wakes. Child A's result was
// reserved as a steer into the parent's running turn; child B finished while
// that reservation was outstanding, so it waits behind it. The provider stops
// accepting steers just before its turn ends (seen with Pi), so the steer
// never lands while the parent still looks running.
for (const resultRead of [false, true]) {
  it.effect(
    resultRead
      ? "releases a steered delegated delivery the parent already read when it settles"
      : "re-offers a steered delegated delivery whose steer never landed when the parent settles",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const name = `delegated-steer-settlement-${resultRead ? "read" : "unaccepted"}`;
          const cwd = yield* checkpointWorkspace(name);
          const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
          const started: ProviderAdapterV2TurnInput[] = [];
          let steerCalls = 0;
          const adapter: ProviderAdapterV2Shape = {
            instanceId,
            driver,
            getCapabilities: () => Effect.succeed(capabilities),
            planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
            openSession: (input) =>
              Effect.gen(function* () {
                const now = yield* DateTime.now;
                return {
                  instanceId,
                  driver,
                  providerSessionId: input.providerSessionId,
                  providerSession: {
                    id: input.providerSessionId,
                    driver,
                    providerInstanceId: instanceId,
                    status: "ready",
                    cwd,
                    model: modelSelection.model,
                    capabilities,
                    createdAt: now,
                    updatedAt: now,
                    lastError: null,
                  },
                  events: Stream.fromQueue(events),
                  ensureThread: ({ threadId }) =>
                    Effect.succeed({
                      id: ProviderThreadId.make(`provider-thread:${threadId}`),
                      driver,
                      providerInstanceId: instanceId,
                      providerSessionId: input.providerSessionId,
                      appThreadId: threadId,
                      ownerNodeId: null,
                      nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                      nativeConversationHeadRef: null,
                      status: "idle",
                      firstRunOrdinal: null,
                      lastRunOrdinal: null,
                      handoffIds: [],
                      forkedFrom: null,
                      createdAt: now,
                      updatedAt: now,
                    }),
                  resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
                  startTurn: (turn) =>
                    Effect.gen(function* () {
                      started.push(turn);
                      yield* Queue.offer(events, {
                        type: "provider_turn.updated",
                        driver,
                        providerTurn: {
                          id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                          providerThreadId: turn.providerThread.id,
                          nodeId: turn.rootNodeId,
                          runAttemptId: turn.attemptId,
                          nativeTurnRef: {
                            driver,
                            nativeId: `native:${turn.attemptId}`,
                            strength: "strong",
                          },
                          ordinal: turn.providerTurnOrdinal,
                          status: "running",
                          startedAt: now,
                          completedAt: null,
                        },
                      });
                    }),
                  steerTurn: (turn) =>
                    Effect.gen(function* () {
                      steerCalls += 1;
                      return yield* new ProviderAdapterSteerRunError({
                        driver,
                        providerThreadId: turn.providerThread.id,
                        providerTurnId: turn.providerTurnId,
                        cause: "turn is not active",
                      });
                    }),
                  interruptTurn: () => Effect.void,
                  respondToRuntimeRequest: () => Effect.void,
                  readThreadSnapshot: () => Effect.die("unused"),
                  rollbackThread: () => Effect.die("unused"),
                  forkThread: () => Effect.die("unused"),
                };
              }),
          };
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const sink = yield* EventSink.EventSinkV2;
            const threadId = ThreadId.make(`thread:${name}`);
            const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
              orchestrator.streamDomainEvents.pipe(
                Stream.filter(predicate),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
            // Ends the run's provider turn and waits for the run to settle.
            const settle = (runId: RunId, runOrdinal: number) =>
              Effect.gen(function* () {
                const waiting = yield* watch(
                  (event) =>
                    event.type === "run.updated" &&
                    event.payload.id === runId &&
                    event.payload.status === "waiting",
                );
                const completed = yield* watch(
                  (event) =>
                    event.type === "run.updated" &&
                    event.payload.id === runId &&
                    event.payload.status === "completed",
                );
                const projection = yield* orchestrator.getThreadProjection(threadId);
                const run = projection.runs.find((candidate) => candidate.id === runId)!;
                const turn = projection.providerTurns.find(
                  (candidate) => candidate.runAttemptId === run.activeAttemptId,
                )!;
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
                });
                yield* Queue.offer(events, {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turn.providerThreadId,
                  providerTurnId: turn.id,
                  runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                });
                yield* Fiber.join(waiting);
                yield* worker.drain();
                yield* Fiber.join(completed);
              });
            // Subscribes, before the settlement that triggers it, to the wake run
            // the continuation worker starts; joining it runs that wake's turn.
            const watchWake = (startedCount: number) =>
              Effect.gen(function* () {
                const wake = yield* watch(
                  (event) =>
                    event.type === "run.updated" &&
                    event.payload.ordinal === startedCount + 1 &&
                    event.payload.status !== "queued",
                );
                return Effect.gen(function* () {
                  yield* Fiber.join(wake);
                  yield* worker.drain();
                  assert.equal(started.length, startedCount + 1);
                  return started[startedCount]!;
                });
              });

            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("create"),
              threadId,
              projectId: ProjectId.make(`project:${name}`),
              title: "Delegated steer settlement",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
              createdBy: "user",
              creationSource: "web",
            });
            const running = yield* watch(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            );
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("first"),
              threadId,
              messageId: MessageId.make("message:first"),
              text: "delegate two tasks",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            yield* worker.drain();
            yield* Fiber.join(running);
            const parent = started[0]!;

            const steerMessageId = MessageId.make("message:delegated-steer");
            const taskA = NodeId.make("task:a");
            const taskB = NodeId.make("task:b");
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const parentRun = projection.runs.find((run) => run.id === parent.runId)!;
            const now = yield* DateTime.now;
            const task = (
              id: NodeId,
              completionDelivery: OrchestrationV2Subagent["completionDelivery"],
            ): OrchestrationV2Subagent => ({
              id,
              threadId,
              runId: parent.runId,
              parentNodeId: parent.rootNodeId,
              origin: "app_owned",
              createdBy: "agent",
              driver,
              providerInstanceId: instanceId,
              providerThreadId: null,
              childThreadId: null,
              nativeTaskRef: null,
              prompt: `Do ${id}`,
              title: null,
              model: null,
              completionWake: "always",
              completionDelivery,
              status: "completed",
              result: `${id} done`,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            });
            yield* sink.write({
              events: [
                {
                  id: EventId.make("seed:cohort"),
                  type: "run.updated",
                  threadId,
                  runId: parent.runId,
                  occurredAt: now,
                  payload: {
                    ...parentRun,
                    delegatedCompletion: {
                      disposition: "open",
                      nextGeneration: 2,
                      delivery: { generation: 1, messageId: steerMessageId, taskIds: [taskA] },
                    },
                  },
                },
                ...[
                  task(taskA, { state: "claimed", observedByRunId: null }),
                  task(taskB, { state: "pending", observedByRunId: null }),
                ].map((payload) => ({
                  id: EventId.make(`seed:${payload.id}`),
                  type: "subagent.updated" as const,
                  threadId,
                  runId: parent.runId,
                  nodeId: payload.id,
                  occurredAt: now,
                  payload,
                })),
              ],
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("delegated-steer"),
              threadId,
              messageId: steerMessageId,
              text: "Delegated task finished",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "agent",
              creationSource: "server",
              delegatedCompletion: { parentRunId: parent.runId, generation: 1, taskIds: [taskA] },
            });
            // Every retry is rejected while the parent turn still looks running.
            while (steerCalls < 5) {
              yield* worker.drain();
              yield* TestClock.adjust("1 minute");
            }
            yield* worker.drain();
            assert.equal(steerCalls, 5);
            if (resultRead) {
              // task_status read A's result during the turn, emptying A's reservation.
              yield* orchestrator.dispatch({
                type: "delegated_task.completion-delivery.acknowledge",
                commandId: CommandId.make("read-a"),
                parentThreadId: threadId,
                taskId: taskA,
                observedByRunId: parent.runId,
              });
            }
            const runWakeB = (wakeB: ProviderAdapterV2TurnInput) =>
              Effect.gen(function* () {
                assert.include(wakeB.message.text, String(taskB));
                assert.notInclude(wakeB.message.text, String(taskA));
                yield* settle(wakeB.runId, wakeB.runOrdinal);
              });
            const beforeSettle = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(beforeSettle.runs[0]?.status, "running");
            assert.equal(
              beforeSettle.runs[0]?.delegatedCompletion?.delivery?.messageId,
              steerMessageId,
            );

            const firstWake = yield* watchWake(1);
            yield* settle(parent.runId, parent.runOrdinal);
            const wakeA = resultRead ? undefined : yield* firstWake;
            if (wakeA !== undefined) {
              assert.equal(wakeA.message.messageId, steerMessageId);
              assert.include(wakeA.message.text, String(taskA));
              assert.notInclude(wakeA.message.text, String(taskB));
              const secondWake = yield* watchWake(2);
              yield* settle(wakeA.runId, wakeA.runOrdinal);
              yield* runWakeB(yield* secondWake);
            } else {
              yield* runWakeB(yield* firstWake);
            }

            const final = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(final.runs[0]?.delegatedCompletion?.delivery, null);
            assert.deepEqual(
              final.subagents.map((row) => [row.id, row.completionDelivery?.state]),
              [
                [taskA, resultRead ? "acknowledged" : "delivered"],
                [taskB, "delivered"],
              ],
            );
            assert.equal(steerCalls, 5);
          }).pipe(
            Effect.provide(
              makeOrchestratorV2ReplayLayerWithRegistry(
                { name },
                ProviderAdapterRegistry.makeSingleLayer(adapter),
                { runEffectWorker: false, runContinuationWorker: true },
              ),
            ),
          );
        }),
      ),
  );
}
