import Foundation

/// The shell owns list lifecycle state. Do not reconstruct this from V1 session/turn labels.
public struct OrchestrationV2ThreadLifecycle: Codable, Equatable, Sendable {
    public let runtimeStatus: String?
    public let runtimeUpdatedAt: String
    public let activeRunID: String?
    public let latestRunID: String?
    public let latestRunStatus: String?
    public let latestRunRequestedAt: String?
    public let latestRunStartedAt: String?
    public let latestRunCompletedAt: String?
    public let lastErrorClass: String?
    public let usageLimitResetAt: String?
    public let lastVisitedAt: String?
    public let lastVisitedAtIsPresent: Bool
    public let latestUserMessageAt: String?
    public let latestUserAuthoredMessageAt: String?
    public let latestUserAuthoredMessageAtIsPresent: Bool
    public let hasPendingApprovals: Bool
    public let hasPendingUserInput: Bool
    public let hasActionableProposedPlan: Bool

    public init(shell: OrchestrationV2ThreadShell) {
        // Match client-runtime shellRuntime: commands do not hold completion,
        // but background tasks, monitors and subagents do. Failure wins over both.
        let holdsCompletion = shell.pendingBackgroundTasks.contains {
            ["subagent", "monitor", "background_task"].contains($0["kind"]?.stringValue ?? "")
        }
        runtimeStatus = shell.latestRunId == nil && shell.thread.activeProviderThreadId == nil
            ? nil : (holdsCompletion && shell.status != "failed" ? "idle" : shell.activityRunStatus ?? shell.status)
        runtimeUpdatedAt = shell.thread.updatedAt
        activeRunID = shell.activeRunId
        latestRunID = shell.latestRunId
        latestRunStatus = shell.latestRunId == nil ? nil : (shell.status == "idle" ? "completed" : shell.status)
        latestRunRequestedAt = shell.latestRunRequestedAt
        latestRunStartedAt = shell.latestRunStartedAt
        // Older shells omit this field. Explicit null still means no completion.
        if shell.latestRunId == nil {
            latestRunCompletedAt = nil
        } else if shell.raw["latestRunCompletedAt"] == nil,
                  ["idle", "completed", "interrupted", "failed", "cancelled", "rolled_back"].contains(shell.status) {
            latestRunCompletedAt = shell.thread.updatedAt
        } else {
            latestRunCompletedAt = shell.latestRunCompletedAt
        }
        lastErrorClass = shell.raw["lastErrorClass"]?.stringValue
        usageLimitResetAt = shell.raw["usageLimitResetAt"]?.stringValue
        lastVisitedAt = shell.thread.lastVisitedAt
        lastVisitedAtIsPresent = shell.raw["lastVisitedAt"] != nil
        latestUserMessageAt = shell.latestUserMessageAt
        latestUserAuthoredMessageAt = shell.raw["latestUserAuthoredMessageAt"]?.stringValue
        latestUserAuthoredMessageAtIsPresent = shell.raw["latestUserAuthoredMessageAt"] != nil
        hasPendingApprovals = shell.pendingRuntimeRequest?.isApproval == true
        hasPendingUserInput = shell.pendingRuntimeRequest?.isUserInput == true
        hasActionableProposedPlan = shell.hasActionableProposedPlan
    }

    /// Full-detail fallback for archived/related threads without a shell. Encode
    /// this small record in native controls before discarding the full projection.
    public init(projection p: OrchestrationV2ThreadProjection) {
        let session = p.providerSessions.filter { $0.providerInstanceId == p.thread.providerInstanceId }
            .max { Self.timestamp($0.updatedAt) < Self.timestamp($1.updatedAt) }
        let executed = p.runs.filter { $0.status != "queued" && !($0.status == "cancelled" && $0.startedAt == nil) }
            .max {
                let leftEnd = $0.completedAt.map(Self.timestamp) ?? .infinity
                let rightEnd = $1.completedAt.map(Self.timestamp) ?? .infinity
                return leftEnd == rightEnd ? $0.ordinal < $1.ordinal : leftEnd < rightEnd
            }
        let executedFailure = Self.rootFailure(executed, in: p)
        let limitOwnsLatest = executedFailure?.class == "usage_limit"
            && (session?.lastError == nil || session?.lastError == executedFailure?.message)
            && executed.map { run in p.runs.contains { $0.ordinal > run.ordinal } } == true
        let latest = limitOwnsLatest ? executed : p.runs.filter { !($0.status == "queued" && $0.queueHeld == true) }
            .max { $0.ordinal < $1.ordinal }
        let active = p.runs.filter { ["preparing", "starting", "running"].contains($0.status) }
            .max { $0.ordinal < $1.ordinal }
        let activity = p.runs.filter { ["preparing", "starting", "running", "waiting"].contains($0.status) }
            .max { $0.ordinal < $1.ordinal }
        let holdsCompletion = active == nil && Self.backgroundWorkHoldsCompletion(after: latest, in: p)
        runtimeStatus = latest == nil && p.thread.activeProviderThreadId == nil ? nil
            : limitOwnsLatest ? "failed"
            : holdsCompletion && latest?.status != "failed" ? "idle"
            : activity?.status ?? latest?.status ?? "idle"
        runtimeUpdatedAt = p.updatedAt
        activeRunID = active?.id
        latestRunID = latest?.id
        latestRunStatus = latest?.status
        latestRunRequestedAt = latest?.requestedAt
        latestRunStartedAt = latest?.startedAt
        latestRunCompletedAt = latest?.completedAt
        let failure = Self.rootFailure(latest, in: p)
        let currentFailure = session?.lastError == nil || session?.lastError == failure?.message ? failure : nil
        lastErrorClass = currentFailure?.class
        usageLimitResetAt = currentFailure?.class == "usage_limit" ? currentFailure?.resetAt : nil
        lastVisitedAt = p.thread.lastVisitedAt
        lastVisitedAtIsPresent = p.thread.raw["lastVisitedAt"] != nil
        let userMessages = p.messages.filter { $0.role == "user" }
        latestUserMessageAt = userMessages.max { Self.timestamp($0.updatedAt) < Self.timestamp($1.updatedAt) }?.updatedAt
        latestUserAuthoredMessageAt = userMessages.filter { $0.createdBy == "user" }
            .max { Self.timestamp($0.updatedAt) < Self.timestamp($1.updatedAt) }?.updatedAt
        latestUserAuthoredMessageAtIsPresent = true
        let request = p.runtimeRequests.filter { $0.status == "pending" }
            .max { Self.timestamp($0.createdAt) < Self.timestamp($1.createdAt) }
        hasPendingUserInput = request?.kind == "user_input"
        hasPendingApprovals = request.map { !["user_input", "auth_refresh", "dynamic_tool_call"].contains($0.kind) } ?? false
        hasActionableProposedPlan = p.plans.contains { $0.kind == "proposed_plan" && $0.status == "active" }
    }

    private static func rootFailure(
        _ run: OrchestrationV2Run?, in projection: OrchestrationV2ThreadProjection
    ) -> OrchestrationV2ProviderFailure? {
        guard let run, run.status == "failed" else { return nil }
        let item = projection.turnItems.filter {
            $0.type == "error" && $0.status == "failed" && $0.runId == run.id && $0.nodeId == run.rootNodeId
        }.max {
            let leftTime = timestamp($0.updatedAt), rightTime = timestamp($1.updatedAt)
            if leftTime != rightTime { return leftTime < rightTime }
            return $0.ordinal == $1.ordinal ? $0.id < $1.id : $0.ordinal < $1.ordinal
        }
        guard let item, case let .failure(failure) = item.content else { return nil }
        return failure
    }

    private static func backgroundWorkHoldsCompletion(
        after latest: OrchestrationV2Run?, in projection: OrchestrationV2ThreadProjection
    ) -> Bool {
        guard let latest, ["cancelled", "completed", "failed", "interrupted", "waiting"].contains(latest.status) else {
            return false
        }
        var holdsByTaskID: [String: Bool] = [:]
        for thread in projection.providerThreads
        where projection.thread.activeProviderThreadId == nil || projection.thread.activeProviderThreadId == thread.id {
            for task in thread.pendingBackgroundTasks {
                guard let id = task["taskId"]?.stringValue, !id.isEmpty, holdsByTaskID[id] == nil else { continue }
                holdsByTaskID[id] = ["subagent", "monitor", "background_task"].contains(task["kind"]?.stringValue ?? "")
            }
        }
        let rolledBack = Set(projection.runs.filter { $0.status == "rolled_back" }.map(\.id))
        for item in projection.turnItems {
            // Commands never hold completion; persistent tools are monitors the
            // provider intentionally leaves alive, not work that wakes the agent.
            guard ["command_execution", "dynamic_tool", "subagent"].contains(item.type),
                  ["pending", "running", "waiting"].contains(item.status),
                  !(item.type == "dynamic_tool" && item.raw["input"]?["persistent"]?.boolValue == true),
                  !(item.runId.map { rolledBack.contains($0) } ?? false) else { continue }
            let nativeID = item.raw["nativeItemRef"]?["nativeId"]?.stringValue
            let id = nativeID.flatMap { $0.isEmpty ? nil : $0 } ?? item.id
            if holdsByTaskID[id] == nil { holdsByTaskID[id] = item.type != "command_execution" }
        }
        return holdsByTaskID.values.contains(true)
    }

    private static func timestamp(_ value: String) -> TimeInterval {
        ((try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value))
            ?? (try? Date.ISO8601FormatStyle().parse(value)))?.timeIntervalSince1970 ?? -.infinity
    }
}
