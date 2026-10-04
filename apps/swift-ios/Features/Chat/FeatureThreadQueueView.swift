import SwiftUI

/// A live queue view with a separate text editor, leaving the composer draft intact.
struct FeatureThreadQueueView: View {
    let execution: FeatureThreadExecution
    let controlsAvailable: Bool
    let isUpdating: Bool
    let error: String?
    let performAction: @MainActor (FeatureThreadQueueAction) async -> Bool

    @State private var editingRunID: String?
    @State private var editedText = ""

    private var controlsDisabled: Bool { !controlsAvailable || isUpdating }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if !controlsAvailable {
                    Text("Queue controls unavailable")
                        .font(T3Typography.supporting)
                        .padding(.vertical, 8)
                }
                if let error {
                    Text(error)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.danger)
                        .padding(.vertical, 8)
                        .accessibilityIdentifier("thread-queue-error")
                }
                if isUpdating {
                    Text("Updating queue…")
                        .font(T3Typography.supporting)
                        .padding(.vertical, 8)
                }
                if execution.isQueueHeld {
                    HStack {
                        Text("Queue paused")
                        Spacer()
                        Button("Resume queue") { submit(.resume) }
                            .disabled(controlsDisabled || !execution.allows(.resume))
                            .frame(minHeight: T3Metrics.minimumTapTarget)
                    }
                    .font(T3Typography.control)
                    .accessibilityIdentifier("thread-queue-resume")
                }
                if editingRunID != nil {
                    editor
                }
                if execution.queuedEntries.isEmpty {
                    Text("No queued messages")
                        .font(T3Typography.supporting)
                        .padding(.vertical, 16)
                }
                ForEach(Array(execution.queuedEntries.enumerated()), id: \.element.id) { index, entry in
                    queueRow(entry, index: index)
                    Divider().overlay(Color.white.opacity(0.18))
                }
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 16)
        }
        .background(Color.black)
        .foregroundStyle(Color.white)
        .tint(.white)
        .buttonStyle(.plain)
        .navigationTitle("Queued")
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
        .transaction {
            $0.animation = nil
            $0.disablesAnimations = true
        }
    }

    private func queueRow(_ entry: FeatureThreadExecution.QueuedEntry, index: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Attachments" : entry.text)
                .font(T3Typography.threadBody)
                .lineLimit(3)
                .textSelection(.enabled)
            if !entry.attachments.isEmpty {
                Label(entry.attachments.map(\.name).joined(separator: ", "), systemImage: "paperclip")
                    .font(T3Typography.supporting)
                    .lineLimit(2)
            }
            HStack(spacing: 20) {
                Button(editingRunID == entry.id ? "Editing" : "Edit") {
                    editingRunID = entry.id
                    editedText = entry.text
                }
                .disabled(controlsDisabled || !execution.canManageQueue || !entry.hasMessage || editingRunID != nil)
                .accessibilityLabel("Edit queued message \(index + 1)")

                if execution.canPromoteToSteer, let activeRun = execution.activeRun {
                    Button("Send now") {
                        submit(.promoteToSteer(queuedRunID: entry.id, targetRunID: activeRun.id))
                    }
                    .disabled(controlsDisabled || editingRunID != nil || !entry.hasMessage)
                    .accessibilityHint("Sends this message into the current run")
                }

                Spacer(minLength: 0)

                Menu {
                    Button("Move up", systemImage: "arrow.up") {
                        guard index > 0 else { return }
                        submit(.reorder(runID: entry.id, beforeRunID: execution.queuedEntries[index - 1].id))
                    }
                    .disabled(!execution.canReorder || index == 0)
                    Button("Move down", systemImage: "arrow.down") {
                        let nextIndex = index + 2
                        let before = nextIndex < execution.queuedEntries.count
                            ? execution.queuedEntries[nextIndex].id : nil
                        submit(.reorder(runID: entry.id, beforeRunID: before))
                    }
                    .disabled(!execution.canReorder || index == execution.queuedEntries.count - 1)
                    Button(role: .destructive) {
                        submit(.cancel(runID: entry.id))
                    } label: {
                        Label("Remove", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                }
                .disabled(controlsDisabled || !execution.canManageQueue || editingRunID != nil)
                .accessibilityLabel("Actions for queued message \(index + 1)")
            }
            .font(T3Typography.control)
            .frame(minHeight: T3Metrics.minimumTapTarget)
        }
        .padding(.top, 12)
        .accessibilityIdentifier("thread-queue-entry-\(entry.id)")
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Editing queued message")
                Spacer()
                Button("Cancel") { editingRunID = nil }
                    .disabled(isUpdating)
                    .frame(minHeight: T3Metrics.minimumTapTarget)
            }
            .font(T3Typography.control)
            TextField("Queued message", text: $editedText, axis: .vertical)
                .font(T3Typography.threadBody)
                .lineLimit(3...8)
                .disabled(isUpdating)
                .accessibilityIdentifier("thread-queue-edit-text")
            if let runID = editingRunID {
                let entry = execution.queuedEntries.first { $0.id == runID }
                if entry == nil {
                    Text("This message is no longer queued.")
                        .font(T3Typography.supporting)
                }
                Button("Save message") {
                    Task {
                        if await performAction(.edit(runID: runID, text: editedText)) {
                            editingRunID = nil
                        }
                    }
                }
                .font(T3Typography.control)
                .frame(minHeight: T3Metrics.minimumTapTarget)
                .disabled(controlsDisabled || entry?.text == editedText
                    || !execution.allows(.edit(runID: runID, text: editedText)))
            }
            Divider().overlay(Color.white.opacity(0.18))
        }
        .padding(.vertical, 8)
    }

    private func submit(_ action: FeatureThreadQueueAction) {
        guard !controlsDisabled, execution.allows(action) else { return }
        Task { _ = await performAction(action) }
    }
}
