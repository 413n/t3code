import type { ProviderInteractionMode, RuntimeMode, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "./OrchestratorMcpService.ts";
import {
  assertFullAccess,
  assertLiveCaller,
  assertTargetWithinLimits,
  loadCaller,
  unavailable,
} from "./threadAccess.ts";

/**
 * Who may call a T3 MCP tool. Every handler is built by one of the
 * declarations below, which say what the tool does. `toLayer` accepts only
 * declared handlers and `/mcp` registers only layers `toLayer` built, so a
 * tool without a decision here does not compile.
 *
 * Parameters choose the target; the caller sets the limits: a thread caller
 * its own runtime and interaction modes, an outside client the ceiling it was
 * approved with. Nothing a caller starts or changes may run with broader
 * modes, and a thread caller changes things only while its own run is live.
 * A refusal is an `OrchestratorMcpFailure`, so the compiler requires it in the
 * tool's failure schema, and `ThreadManagementService` in its dependencies.
 *
 * The declaration checks the caller before the handler runs. Handlers still
 * check what only they can see, such as a queued run belonging to its thread.
 */
const AccessDeclared: unique symbol = Symbol.for("t3/mcp/McpToolAccess/AccessDeclared");

/** Marks a handler, or a layer of handlers, whose access was declared here. */
export interface Declared {
  readonly [AccessDeclared]: true;
}

const declared = { [AccessDeclared]: true } as const;

const declare = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  Object.assign(handle, declared);

/** The caller of a tool that changes something. */
const writingCaller = loadCaller().pipe(Effect.tap(assertLiveCaller));

const requireThreadCaller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "This tool")),
);

/** Changes nothing, so every caller may call it. */
export const reads = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => handle(params));

/** Reads what belongs to the calling T3 thread, such as its preview tabs or devices. */
export const readsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => requireThreadCaller.pipe(Effect.flatMap(() => handle(params))));

/**
 * Acts as the calling T3 thread (its subagents, preview tabs, devices,
 * worktree) while that thread's run is live. Only an agent running inside a
 * T3 thread has one.
 */
export const actsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) =>
    requireThreadCaller.pipe(
      Effect.flatMap(() => writingCaller),
      Effect.flatMap(() => handle(params)),
    ),
  );

/** Changes something that belongs to no thread, such as a pending upload or a scheduled task. */
export const writes = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => writingCaller.pipe(Effect.flatMap(() => handle(params))));

/**
 * Changes the threads `threads` names. An omitted id is the caller's own
 * thread; any other thread must run within the caller's modes. A thread that
 * does not exist is the handler's to report.
 */
export const writesThreads = <P, A, E, R>(
  threads: (params: P) => ReadonlyArray<ThreadId | undefined>,
  handle: (params: P) => Effect.Effect<A, E, R>,
) =>
  declare((params: P) =>
    Effect.gen(function* () {
      const caller = yield* writingCaller;
      for (const threadId of threads(params)) {
        if (threadId === undefined || threadId === caller.scope.thread?.threadId) continue;
        const target = yield* caller.threads
          .getThreadShell(threadId)
          .pipe(Effect.mapError(unavailable));
        if (target !== null && target.deletedAt === null) {
          yield* assertTargetWithinLimits(caller.limits, target);
        }
      }
      return yield* handle(params);
    }),
  );

/** The modes a started thread runs with: those requested, else the caller's own. */
export interface StartedModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** Starts threads with the modes `modes` requests, which may not be broader than the caller's. */
export const startsThreads = <P, A, E, R>(
  modes: (params: P) => {
    readonly runtimeMode?: RuntimeMode | undefined;
    readonly interactionMode?: ProviderInteractionMode | undefined;
  },
  handle: (params: P, modes: StartedModes) => Effect.Effect<A, E, R>,
) =>
  declare((params: P) =>
    Effect.gen(function* () {
      const { limits } = yield* writingCaller;
      const requested = modes(params);
      const started: StartedModes = {
        runtimeMode: yield* resolveRuntimeMode(limits.runtimeMode, requested.runtimeMode),
        interactionMode: yield* resolveInteractionMode(
          limits.interactionMode,
          requested.interactionMode,
        ),
      };
      return yield* handle(params, started);
    }),
  );

/** Changes projects or environment settings, which needs a full-access/default caller. */
export const writesEnvironment = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) =>
    writingCaller.pipe(
      Effect.flatMap((caller) =>
        assertFullAccess(
          caller,
          "Changing projects or environment settings needs a live full-access/default calling thread or a full-access client.",
        ),
      ),
      Effect.flatMap(() => handle(params)),
    ),
  );

/** A toolkit's handlers, each built by one of the declarations above. */
export type Handlers<Tools extends Record<string, Tool.Any>> = Toolkit.HandlersFrom<Tools> & {
  readonly [Name in keyof Toolkit.HandlersFrom<Tools>]: Declared;
};

/** A toolkit's handler layer built by `toLayer`, the only kind `/mcp` registers. */
export type HandlersLayer<
  Tools extends Record<string, Tool.Any>,
  EX = never,
  RX = never,
> = Layer.Layer<Tool.HandlersFor<Tools>, EX, RX> & Declared;

/** `Toolkit.toLayer` for handlers that all declare their access. */
export const toLayer = <Tools extends Record<string, Tool.Any>, EX = never, RX = never>(
  toolkit: Toolkit.Toolkit<Tools>,
  build: Handlers<Tools> | Effect.Effect<Handlers<Tools>, EX, RX>,
): HandlersLayer<Tools, EX, Exclude<RX, Scope.Scope>> =>
  Object.assign(toolkit.toLayer<Handlers<Tools>, EX, RX>(build), declared);
