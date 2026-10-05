import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import {
  CheckpointScopeId,
  CommandId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

export class RunFinalizationError extends Schema.TaggedError<RunFinalizationError>()(
  "RunFinalizationError",
  {
    threadId: ThreadId,
    runId: RunId,
    scopeId: CheckpointScopeId,
    operation: Schema.Literals(["capture-checkpoint", "refresh-workspace"]),
    cause: Schema.Defect(),
  },
) {}

export class RunFinalizationRefreshError extends Schema.TaggedError<RunFinalizationRefreshError>()(
  "RunFinalizationRefreshError",
  { cwd: Schema.String, cause: Schema.Defect() },
) {}

export class RunFinalizationObserver extends Context.Reference<{
  readonly refreshAfterTurn: (projectId: ProjectId) => Effect.Effect<void>;
  readonly refresh: (input: {
    readonly cwd: string;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void, RunFinalizationRefreshError>;
}>("t3/orchestration-v2/RunFinalizationObserver", {
  defaultValue: () => ({ refresh: () => Effect.void, refreshAfterTurn: () => Effect.void }),
}) {}

export class RunFinalizationService extends Context.Service<
  RunFinalizationService,
  {
    readonly finalize: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly scopeId: CheckpointScopeId;
    }) => Effect.Effect<void, RunFinalizationError>;
  }
>()("t3/orchestration-v2/RunFinalizationService") {}

const make = Effect.gen(function* () {
  const checkpointCapture = yield* CheckpointCapture.CheckpointCaptureServiceV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const observer = yield* RunFinalizationObserver;

  const finalize: RunFinalizationService["Service"]["finalize"] = Effect.fn(
    "RunFinalizationService.finalize",
  )(function* (input) {
    yield* checkpointCapture
      .execute(input)
      .pipe(
        Effect.mapError(
          (cause) => new RunFinalizationError({ ...input, operation: "capture-checkpoint", cause }),
        ),
      );
    const projection = yield* projections
      .getCheckpointContext(input.threadId)
      .pipe(
        Effect.mapError(
          (cause) => new RunFinalizationError({ ...input, operation: "refresh-workspace", cause }),
        ),
      );
    const cwd = projection.checkpointScopes.find((scope) => scope.id === input.scopeId)?.cwd;
    if (cwd !== undefined) {
      yield* observer
        .refresh({ cwd, threadId: input.threadId, runId: input.runId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RunFinalizationError({ ...input, operation: "refresh-workspace", cause }),
          ),
        );
    }
  });
  return RunFinalizationService.of({ finalize });
});

export const layer = Layer.effect(RunFinalizationService, make);

export const observerLive = Layer.effect(
  RunFinalizationObserver,
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const threads = yield* ThreadManagementService.ThreadManagementService;

    // A `git checkout`/`git switch` run inside a thread's dedicated worktree
    // (by the agent or the user) bypasses T3's own commands, so the stamped
    // branch goes stale (#11078). Follow it here: adopt the checked-out
    // branch as the thread's branch, but only while the worktree still
    // belongs to exactly this thread. For a shared worktree, whose branch it
    // is would be ambiguous, so leave the stamp alone.
    const followBranchDrift = Effect.fn("RunFinalizationService.followBranchDrift")(function* (
      thread: OrchestrationV2ThreadShell,
      refName: string,
      runId: RunId,
    ) {
      // No branch to compare-and-swap against, no dedicated worktree to own
      // exclusively, or the first-turn auto-rename is still in flight.
      if (
        thread.branch === null ||
        thread.worktreePath === null ||
        isTemporaryWorktreeBranch(refName)
      ) {
        return;
      }
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          // Keyed by the run being finalized, not the branch: a retry of the
          // same at-least-once effect must reuse this id (see
          // checkpoint.capture below), but a later run drifting back to an
          // earlier branch is a fresh occurrence, not a duplicate.
          commandId: CommandId.make(`command:effect:worktree-branch-drift:${runId}`),
          threadId: thread.id,
          branch: refName,
          expectedBranch: thread.branch,
          expectedWorktreePath: thread.worktreePath,
          requireExclusiveWorktree: true,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to follow worktree branch drift after run completion", {
              threadId: thread.id,
              previousBranch: thread.branch,
              branch: refName,
              detail: error.message,
            }),
          ),
        );
    });

    return {
      refreshAfterTurn: pullRequests.refreshAfterTurn,
      refresh: ({ cwd, threadId, runId }) =>
        Effect.gen(function* () {
          const [, local] = yield* Effect.all(
            [workspaceEntries.refresh(cwd), vcsStatus.refreshLocalStatus(cwd)],
            { concurrency: "unbounded" },
          );
          if (local.refName === null || local.isDefaultRef) return;
          const thread = yield* projections.getThreadShell(threadId);
          if (!thread) return;
          if (thread.activeRunId !== null && thread.activeRunId !== runId) return;
          if (thread.branch !== local.refName) {
            yield* followBranchDrift(thread, local.refName, runId);
            return;
          }
          yield* vcsStatus.refreshPullRequestStatus(cwd).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to refresh pull request status after run completion", {
                threadId,
                cwd,
                detail: error.message,
              }),
            ),
          );
        }).pipe(Effect.mapError((cause) => new RunFinalizationRefreshError({ cwd, cause }))),
    };
  }),
);
