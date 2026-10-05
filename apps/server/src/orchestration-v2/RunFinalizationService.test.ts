import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

// observerLive's construction resolves ProjectService even when a scenario
// only exercises refresh/followBranchDrift, not followWorktreeMove.
const unusedProjectService = Layer.mock(ProjectService.ProjectService)({
  getById: () => Effect.die("not exercised by this scenario"),
});

it.effect("refreshes workspace after checkpoint capture without reading history", () => {
  const threadId = ThreadId.make("thread_finalize");
  const runId = RunId.make("run_finalize");
  const scopeId = CheckpointScopeId.make("scope_finalize");
  const capture = vi.fn(() => Effect.void);
  const refresh = vi.fn(() => Effect.void);
  const followWorktreeMove = vi.fn(() => Effect.void);
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
          followWorktreeMove,
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId, scopeId });
    assert.equal(capture.mock.calls.length, 1);
    assert.deepEqual(followWorktreeMove.mock.calls[0], [{ threadId, runId }]);
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
        unusedProjectService,
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
        unusedProjectService,
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
        unusedProjectService,
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

// #11078: Claude's EnterWorktree/ExitWorktree moves the provider session's
// own cwd without going through any T3 command. The adapter live-tracks
// that cwd on the provider session (provider_session.updated); followWorktreeMove
// compares it against the thread's recorded location and, on a turn,
// follows it — the move is always worth tracking, even into a worktree this
// thread doesn't own exclusively (only adopting its branch is conditional).
it.effect.each(
  (
    [
      {
        label: "follows the session into a new dedicated worktree, adopting its branch",
        liveCwd: "/repo/.claude/worktrees/feature",
        checkedOut: "feature",
        expectDispatch: {
          worktreePath: "/repo/.claude/worktrees/feature",
          branch: "feature",
          expectedWorktreePath: null,
          preserveProviderSession: true,
          requireExclusiveWorktree: true,
        },
      },
      {
        label: "follows the session back to the main checkout, dropping the branch",
        liveCwd: "/repo",
        checkedOut: "main",
        expectDispatch: {
          worktreePath: null,
          branch: null,
          expectedWorktreePath: "/repo/.claude/worktrees/feature",
          preserveProviderSession: true,
        },
      },
      {
        label: "tracks a move into a worktree with a detached HEAD, without a branch",
        liveCwd: "/repo/.claude/worktrees/feature",
        checkedOut: null,
        expectDispatch: {
          worktreePath: "/repo/.claude/worktrees/feature",
          branch: null,
          expectedWorktreePath: null,
          preserveProviderSession: true,
        },
      },
      {
        label: "tracks a move into a worktree still on its temporary setup branch",
        liveCwd: "/repo/.claude/worktrees/feature",
        checkedOut: "t3code/0a1b2c3d",
        expectDispatch: {
          worktreePath: "/repo/.claude/worktrees/feature",
          branch: null,
          expectedWorktreePath: null,
          preserveProviderSession: true,
        },
      },
      {
        label: "does nothing when the session never left its recorded location",
        liveCwd: null,
        checkedOut: "feature",
        expectDispatch: null,
      },
    ] as const
  ).map((scenario) => [scenario.label, scenario] as const),
)("%s", ([, scenario]) => {
  const threadId = ThreadId.make("thread-worktree-move");
  const runId = RunId.make("completed-run");
  const projectId = ProjectId.make("project-worktree-move");
  // The two "moved" scenarios differ on whether the thread started in a
  // worktree (returning to main) or the main checkout (entering one); the
  // detached/temporary scenarios only exercise entering, so either stamp
  // works — null keeps them closest to a fresh thread's starting point.
  const recordedWorktreePath =
    scenario.liveCwd === "/repo" ? "/repo/.claude/worktrees/feature" : null;
  // providerSessions.at(-1).cwd is what the adapter's live cwd tracking
  // reports; null simulates no session attached, so there is nothing to compare.
  const providerSessions = scenario.liveCwd === null ? [] : [{ cwd: scenario.liveCwd } as never];
  const dispatch = vi.fn(
    (_command: Parameters<ThreadManagementService.ThreadManagementServiceShape["dispatch"]>[0]) =>
      Effect.succeed({ sequence: 1, storedEvents: [] }),
  );
  const layer = RunFinalization.observerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({
          refresh: () => Effect.die("followWorktreeMove must not touch the workspace entry index"),
        }),
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
          refreshPullRequestStatus: () => Effect.die("not exercised by this scenario"),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              projectId,
              branch: "original",
              worktreePath: recordedWorktreePath,
              activeRunId: null,
            } as OrchestrationV2ThreadShell),
          getThreadProviderContext: () =>
            Effect.succeed({ thread: undefined, providerSessions, providerThreads: [] } as never),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({ dispatch }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(Option.some({ projectId, workspaceRoot: "/repo" } as never)),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.followWorktreeMove({ threadId, runId });
    assert.equal(dispatch.mock.calls.length, scenario.expectDispatch === null ? 0 : 1);
    const dispatched = dispatch.mock.calls[0]?.[0];
    if (scenario.expectDispatch !== null && dispatched !== undefined) {
      assert.deepEqual(dispatched, {
        type: "thread.metadata.update",
        commandId: dispatched.commandId,
        threadId,
        ...scenario.expectDispatch,
      });
    }
  }).pipe(Effect.provide(layer));
});

it.effect(
  "picks the most recently updated provider session, not the last one in array order",
  () => {
    const threadId = ThreadId.make("thread-worktree-move-session-order");
    const runId = RunId.make("completed-run");
    const projectId = ProjectId.make("project-worktree-move-session-order");
    // ProjectionStoreV2's SQL path orders providerSessions by updated_at, but
    // layerMemory does not (#11078 review); this mock mirrors the unordered
    // case deliberately, with the stale session listed last.
    const providerSessions = [
      {
        cwd: "/repo/.claude/worktrees/current",
        updatedAt: DateTime.makeUnsafe("2026-01-01T00:01:00Z"),
      },
      {
        cwd: "/repo/.claude/worktrees/stale",
        updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
      },
    ] as never;
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
                refName: "feature",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: () =>
              Effect.succeed({
                id: threadId,
                projectId,
                branch: "original",
                worktreePath: null,
                activeRunId: null,
              } as OrchestrationV2ThreadShell),
            getThreadProviderContext: () =>
              Effect.succeed({ thread: undefined, providerSessions, providerThreads: [] } as never),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({ dispatch }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeed(Option.some({ projectId, workspaceRoot: "/repo" } as never)),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const observer = yield* RunFinalization.RunFinalizationObserver;
      yield* observer.followWorktreeMove({ threadId, runId });
      assert.equal(
        (dispatch.mock.calls[0]?.[0] as { readonly worktreePath?: string } | undefined)
          ?.worktreePath,
        "/repo/.claude/worktrees/current",
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("does not follow a worktree move for a stale, no-longer-active run", () => {
  const threadId = ThreadId.make("thread-worktree-move-stale-run");
  const runId = RunId.make("old-run");
  const dispatch = vi.fn(() => Effect.die("a stale run must not dispatch a location update"));
  const layer = RunFinalization.observerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () => Effect.die("not exercised by this scenario"),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              branch: "original",
              worktreePath: null,
              activeRunId: RunId.make("newer-run"),
            } as OrchestrationV2ThreadShell),
          getThreadProviderContext: () => Effect.die("not exercised by this scenario"),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({ dispatch }),
        unusedProjectService,
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.followWorktreeMove({ threadId, runId });
    assert.equal(dispatch.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});
