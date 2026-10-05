import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

it.effect("refreshes workspace after checkpoint capture without reading history", () => {
  const threadId = ThreadId.make("thread_finalize");
  const runId = RunId.make("run_finalize");
  const scopeId = CheckpointScopeId.make("scope_finalize");
  const capture = vi.fn(() => Effect.void);
  const refresh = vi.fn(() => Effect.void);
  const checkpointContext = {
    runs: [],
    checkpointScopes: [{ id: scopeId, runId, kind: "root_run" as const, cwd: "/repo" }],
    checkpoints: [],
  };
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({ execute: capture }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () =>
            Effect.die("workspace refresh must not load transcript history"),
          getCheckpointContext: () => Effect.succeed(checkpointContext),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh,
          refreshAfterTurn: () => Effect.void,
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId, scopeId });
    assert.equal(capture.mock.calls.length, 1);
    assert.deepEqual(refresh.mock.calls[0], [{ cwd: "/repo", threadId, runId }]);
  }).pipe(Effect.provide(layer));
});

it.effect.each(
  (
    [
      {
        label: "discovers a new PR for the completed run's branch",
        branch: "feature",
        checkedOut: "feature",
        activeRun: null,
        expected: ["/repo"],
      },
      {
        label: "leaves the default branch's PR cache alone",
        branch: "main",
        checkedOut: "main",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh another thread's checkout",
        branch: "feature",
        checkedOut: "other",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh during a newer active run",
        branch: "feature",
        checkedOut: "feature",
        activeRun: "newer-run",
        expected: [],
      },
    ] as const
  ).map((scenario) => [scenario.label, scenario] as const),
)("%s", ([, scenario]) => {
  const refreshed: string[] = [];
  const threadId = ThreadId.make("thread-pr-refresh");
  const runId = RunId.make("completed-run");
  const layer = RunFinalization.observerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: scenario.checkedOut === "main",
              refName: scenario.checkedOut,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshStatus: () =>
            Effect.die("turn completion must preserve known PRs and lookup backoff"),
          refreshPullRequestStatus: (cwd) =>
            Effect.sync(() => {
              refreshed.push(cwd);
              return null;
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              branch: scenario.branch,
              // None of these scenarios are about a dedicated-worktree
              // thread, so worktreePath stays null: the branch-drift follow
              // added for #11078 must not engage here either.
              worktreePath: null,
              activeRunId: scenario.activeRun === null ? null : RunId.make(scenario.activeRun),
            } as OrchestrationV2ThreadShell),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: () => Effect.die("not exercised by this scenario"),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({ cwd: "/repo", threadId, runId });
    assert.deepEqual(refreshed, [...scenario.expected]);
  }).pipe(Effect.provide(layer));
});

// #11078: a `git checkout`/`git switch` run inside a thread's dedicated
// worktree bypasses T3's own commands, so the stamped branch goes stale.
// `observerLive.refresh` must follow that drift instead of only comparing it
// against the stamp and giving up.
it.effect.each(
  (
    [
      {
        label: "follows the drift for a dedicated worktree thread",
        branch: "main",
        worktreePath: "/repo",
        checkedOut: "feature",
        expectDispatch: true,
      },
      {
        label: "does not follow drift for a main-checkout thread (no worktree to own exclusively)",
        branch: "main",
        worktreePath: null,
        checkedOut: "feature",
        expectDispatch: false,
      },
      {
        label: "does not invent a branch for a thread that never had one recorded",
        branch: null,
        worktreePath: "/repo",
        checkedOut: "feature",
        expectDispatch: false,
      },
      {
        label: "does not adopt a temporary worktree-setup branch name",
        branch: "main",
        worktreePath: "/repo",
        checkedOut: "t3code/0a1b2c3d",
        expectDispatch: false,
      },
    ] as const
  ).map((scenario) => [scenario.label, scenario] as const),
)("%s", ([, scenario]) => {
  const threadId = ThreadId.make("thread-branch-drift");
  const runId = RunId.make("completed-run");
  const dispatch = vi.fn(
    (_command: Parameters<ThreadManagementService.ThreadManagementServiceShape["dispatch"]>[0]) =>
      Effect.succeed({ sequence: 1, storedEvents: [] }),
  );
  const layer = RunFinalization.observerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: false,
              refName: scenario.checkedOut,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshPullRequestStatus: () =>
            Effect.die("a drifted branch must not refresh the stale branch's PR"),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              branch: scenario.branch,
              worktreePath: scenario.worktreePath,
              activeRunId: null,
            } as OrchestrationV2ThreadShell),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({ dispatch }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({ cwd: "/repo", threadId, runId });
    assert.equal(dispatch.mock.calls.length, scenario.expectDispatch ? 1 : 0);
    const dispatched = dispatch.mock.calls[0]?.[0];
    if (scenario.expectDispatch && dispatched !== undefined) {
      assert.deepEqual(dispatched, {
        type: "thread.metadata.update",
        commandId: dispatched.commandId,
        threadId,
        branch: scenario.checkedOut,
        expectedBranch: scenario.branch,
        expectedWorktreePath: scenario.worktreePath,
        requireExclusiveWorktree: true,
      });
    }
  }).pipe(Effect.provide(layer));
});

it.effect("logs and continues when the branch-drift follow is rejected", () => {
  const threadId = ThreadId.make("thread-branch-drift-rejected");
  const runId = RunId.make("completed-run");
  const layer = RunFinalization.observerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: false,
              refName: "feature",
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              branch: "main",
              worktreePath: "/repo",
              activeRunId: null,
            } as OrchestrationV2ThreadShell),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: () =>
            Effect.fail({ _tag: "OrchestratorDispatchError", message: "worktree shared" } as never),
        }),
      ),
    ),
  );
  // A rejected drift-follow (e.g. the exclusivity guard) must not fail the
  // whole run-finalization refresh.
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({ cwd: "/repo", threadId, runId });
  }).pipe(Effect.provide(layer));
});
