import SwiftUI
import Testing
import UIKit
@testable import T3Code

@MainActor
@Suite("Transcript layout and updates", .serialized)
struct TranscriptCollectionViewTests {
    @Test
    func backKeepsTheMostRecentlyOpenedThreadHighlighted() {
        var selection = WorkspaceThreadSelection()
        selection.open("first")
        selection.close()
        #expect(selection.selectedID == nil)
        #expect(selection.highlightedID == "first")

        selection.open("second")
        #expect(selection.selectedID == "second")
        #expect(selection.highlightedID == "second")
        selection.close()
        #expect(selection.highlightedID == "second")
    }

    @Test
    func longMarkdownRemainsInsideItsCellAfterScrolling() async {
        let coordinator = FeatureTranscriptCollectionView.Coordinator()
        let collectionView = collection()
        let controller = UIViewController()
        let window = UIWindow(frame: collectionView.frame)
        window.overrideUserInterfaceStyle = .dark
        window.rootViewController = controller
        controller.view.addSubview(collectionView)
        window.makeKeyAndVisible()
        coordinator.connect(to: collectionView)
        defer {
            coordinator.cancelPendingWork()
            window.isHidden = true
        }
        let messages = (0..<30).map { item in
            FeatureMessage(
                id: "long-\(item)", role: .assistant,
                text: """
                I am checking the real provider data in the app, including the model list and configuration for message \(item).

                \(String(repeating: "This paragraph must keep every line visible while the collection recycles its cells. ", count: item % 5 + 1))

                - Keep the model and configuration frame heights stable.
                - Fix the footer divider and test the rendered result.
                - All checks pass on `example-commit`.
                """
            )
        }
        await update(transcript(count: 0, messages: messages), coordinator: coordinator, in: collectionView)
        for item in [24, 0, 15, 29] {
            collectionView.scrollToItem(at: index(item), at: .top, animated: false)
            collectionView.layoutIfNeeded()
            #expect(!collectionView.visibleCells.isEmpty)
            for cell in collectionView.visibleCells {
                // Correct row frames do not prove the text fits. Check the
                // rendered descendants after cells have been reused.
                let renderedText = textViews(in: cell.contentView).filter { !$0.text.isEmpty }
                #expect(!renderedText.isEmpty)
                for textView in renderedText {
                    let frame = textView.convert(textView.bounds, to: cell.contentView)
                    #expect(frame.minY >= -1, "Text starts above its cell: \(cell.accessibilityIdentifier ?? "unknown")")
                    #expect(frame.maxY <= cell.contentView.bounds.height + 1,
                            "Text extends below its cell: \(cell.accessibilityIdentifier ?? "unknown")")
                }
            }
        }
    }

    private func textViews(in view: UIView) -> [UITextView] {
        if let textView = view as? UITextView { return [textView] }
        return view.subviews.flatMap(textViews(in:))
    }

    @Test
    func prefetchUsesSnapshotPositionsIncludingThePaginationButton() {
        let coordinator = FeatureTranscriptCollectionView.Coordinator()
        let collectionView = collection()
        coordinator.connect(to: collectionView)
        defer { coordinator.cancelPendingWork() }
        coordinator.update(transcript(count: 3, canLoadEarlier: true, isWorking: true), in: collectionView)

        #expect(coordinator.messageIDs(at: [index(0)]).isEmpty)
        #expect(coordinator.messageIDs(at: [index(1)]) == ["message-0"])
        #expect(coordinator.messageIDs(at: [index(3)]) == ["message-2"])
        #expect(coordinator.messageIDs(at: [index(4)]).isEmpty)
    }

    @Test
    func updatesWaitForTheDragToEndAndApplyOnlyTheLatestState() {
        let coordinator = FeatureTranscriptCollectionView.Coordinator()
        let collectionView = DraggingTranscriptCollectionView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 700),
            collectionViewLayout: FeatureTranscriptCollectionView.makeLayout()
        )
        coordinator.connect(to: collectionView)
        defer { coordinator.cancelPendingWork() }
        coordinator.update(transcript(count: 2), in: collectionView)
        #expect(collectionView.numberOfItems(inSection: 0) == 2)

        collectionView.dragActive = true
        coordinator.scrollViewWillBeginDragging(collectionView)
        coordinator.update(transcript(count: 3, revision: 2), in: collectionView)
        coordinator.update(transcript(count: 4, revision: 3), in: collectionView)
        #expect(collectionView.numberOfItems(inSection: 0) == 2)

        collectionView.dragActive = false
        coordinator.scrollViewDidEndDragging(collectionView, willDecelerate: false)
        #expect(collectionView.numberOfItems(inSection: 0) == 4)
    }

    @Test
    func hostedMessagesUseTheirFullHeightAndLogsCollapseBackToTheirHeader() throws {
        let coordinator = FeatureTranscriptCollectionView.Coordinator()
        let collectionView = collection()
        coordinator.connect(to: collectionView)
        defer { coordinator.cancelPendingWork() }
        let log = FeatureMessage(
            id: "log", role: .tool,
            text: (0..<30).map { "Completed work item \($0)" }.joined(separator: "\n"),
            toolName: "Work log"
        )
        coordinator.update(transcript(count: 0, messages: [log]), in: collectionView)
        collectionView.layoutIfNeeded()
        let collapsed = try #require(collectionView.layoutAttributesForItem(at: index(0))).size.height
        #expect(collapsed < 100)

        coordinator.toggleWorkLog("log", in: collectionView)
        collectionView.layoutIfNeeded()
        let expanded = try #require(collectionView.layoutAttributesForItem(at: index(0))).size.height
        #expect(expanded > 500)

        coordinator.toggleWorkLog("log", in: collectionView)
        collectionView.layoutIfNeeded()
        #expect(collectionView.layoutAttributesForItem(at: index(0))?.size.height == collapsed)
    }

    @Test
    func loadingEarlierTurnsKeepsTheSameMessageAtTheSameOffset() async throws {
        let coordinator = FeatureTranscriptCollectionView.Coordinator()
        let collectionView = collection()
        coordinator.connect(to: collectionView)
        defer { coordinator.cancelPendingWork() }
        let initial = transcript(count: 80, canLoadEarlier: true)
        await update(initial, coordinator: coordinator, in: collectionView)
        collectionView.layoutIfNeeded()
        let target = try #require(collectionView.layoutAttributesForItem(at: index(40)))
        collectionView.contentOffset.y = target.frame.minY + 10
        collectionView.layoutIfNeeded()
        let before = try #require(collectionView.layoutAttributesForItem(at: index(40))).frame.minY
            - collectionView.contentOffset.y

        let earlier = (0..<20).map {
            FeatureMessage(id: "earlier-\($0)", role: .user, text: "Earlier message \($0)")
        }
        await update(
            transcript(count: 0, messages: earlier + initial.messages, revision: 2, canLoadEarlier: true),
            coordinator: coordinator,
            in: collectionView
        )
        collectionView.layoutIfNeeded()
        let after = try #require(collectionView.layoutAttributesForItem(at: index(60))).frame.minY
            - collectionView.contentOffset.y
        #expect(abs(after - before) < 1)
        #expect(collectionView.visibleCells.count < 30)
    }

    @Test
    func aReaderJustAboveTheBottomIsNotPulledDownByIncomingMessages() async {
        let coordinator = FeatureTranscriptCollectionView.Coordinator()
        let collectionView = BottomAnchoredTranscriptCollectionView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 700),
            collectionViewLayout: FeatureTranscriptCollectionView.makeLayout()
        )
        coordinator.connect(to: collectionView)
        defer { coordinator.cancelPendingWork() }
        await update(transcript(count: 50), coordinator: coordinator, in: collectionView)
        collectionView.layoutIfNeeded()
        coordinator.scrollViewWillBeginDragging(collectionView)
        collectionView.contentOffset.y -= 80
        collectionView.layoutIfNeeded()
        coordinator.scrollViewDidEndDragging(collectionView, willDecelerate: false)
        #expect(!collectionView.maintainsBottomAnchor)
        let before = collectionView.contentOffset.y

        await update(transcript(count: 51, revision: 2), coordinator: coordinator, in: collectionView)
        collectionView.layoutIfNeeded()
        #expect(abs(collectionView.contentOffset.y - before) < 1)
        #expect(!collectionView.maintainsBottomAnchor)
    }

    private func collection() -> UICollectionView {
        UICollectionView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 700),
            collectionViewLayout: FeatureTranscriptCollectionView.makeLayout()
        )
    }

    private func update(
        _ transcript: FeatureTranscriptCollectionView,
        coordinator: FeatureTranscriptCollectionView.Coordinator,
        in collectionView: UICollectionView
    ) async {
        await withCheckedContinuation { continuation in
            coordinator.update(transcript, in: collectionView) {
                continuation.resume()
            }
        }
    }

    private func index(_ item: Int) -> IndexPath {
        IndexPath(item: item, section: 0)
    }

    private func transcript(
        count: Int, messages: [FeatureMessage]? = nil, revision: UInt64 = 1,
        canLoadEarlier: Bool = false, isWorking: Bool = false
    ) -> FeatureTranscriptCollectionView {
        FeatureTranscriptCollectionView(
            threadID: "thread",
            messages: messages ?? (0..<count).map {
                FeatureMessage(id: "message-\($0)", role: .assistant, text: "Message \($0)")
            },
            imageContext: nil,
            renderUpdate: FeatureDetailRenderUpdate(baseRevision: revision - 1, revision: revision, change: .full),
            dynamicTypeSize: .large,
            isWorking: isWorking, activeSubagentCount: 0,
            backgroundWorkIsActive: false, isMonitoring: false,
            canLoadEarlier: canLoadEarlier, isLoadingEarlier: false,
            onLoadEarlier: {}, onDismissKeyboard: {}
        )
    }
}

@MainActor
private final class DraggingTranscriptCollectionView: UICollectionView {
    var dragActive = false
    override var isDragging: Bool { dragActive || super.isDragging }
}
