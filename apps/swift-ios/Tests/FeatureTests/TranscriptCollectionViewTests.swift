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
    func heightsFollowMessageIDsWhenEarlierTurnsArrive() throws {
        let layout = TranscriptCollectionViewLayout()
        let collectionView = collection(layout: layout)
        layout.setItems(["first", "second"])
        layout.prepare()
        try measure(item: 0, height: 680, in: layout)
        layout.prepare()
        #expect(layout.layoutAttributesForItem(at: index(0))?.size.height == 680)

        layout.setItems(["earlier", "first", "second"])
        layout.prepare()
        #expect(layout.layoutAttributesForItem(at: index(1))?.size.height == 680)
        #expect(layout.layoutAttributesForItem(at: index(2))?.frame.minY == 862)

        #expect(!layout.shouldInvalidateLayout(
            forBoundsChange: CGRect(x: 0, y: 500, width: 390, height: 700)
        ))
        collectionView.bounds.size.width = 430
        layout.prepare()
        #expect(layout.layoutAttributesForItem(at: index(1))?.size.height == 120)
    }

    @Test
    func aResizeAboveTheReaderAdjustsTheOffsetButOneBelowDoesNot() throws {
        let layout = TranscriptCollectionViewLayout()
        let collectionView = collection(layout: layout)
        layout.setItems((0..<20).map(String.init))
        layout.prepare()
        collectionView.contentOffset.y = 500

        let above = try measure(item: 0, height: 220, in: layout)
        #expect(above.contentOffsetAdjustment.y == 100)
        layout.prepare()
        let below = try measure(item: 10, height: 240, in: layout)
        #expect(below.contentOffsetAdjustment.y == 0)
    }

    @Test
    func largeHistoryOnlyReturnsVisibleFramesAndReusesMeasuredHeights() throws {
        let layout = TranscriptCollectionViewLayout()
        let collectionView = collection(layout: layout)
        layout.setItems((0..<5_000).map(String.init))
        layout.prepare()
        try measure(item: 2_500, height: 480, in: layout)
        layout.prepare()
        let anchor = try #require(layout.layoutAttributesForItem(at: index(2_500)))
        let viewport = CGRect(x: 0, y: anchor.frame.minY, width: 390, height: 700)
        let visible = try #require(layout.layoutAttributesForElements(in: viewport))
        #expect(visible.count < 10)
        #expect(visible.first?.indexPath.item == 2_500)
        #expect(visible.first?.size.height == 480)
        layout.prepare()
        #expect(layout.layoutAttributesForItem(at: index(2_500))?.frame == anchor.frame)
        #expect(collectionView.bounds.width == 390)
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
            collectionViewLayout: TranscriptCollectionViewLayout()
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
            collectionViewLayout: TranscriptCollectionViewLayout()
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

    private func collection(layout: UICollectionViewLayout = TranscriptCollectionViewLayout()) -> UICollectionView {
        UICollectionView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 700),
            collectionViewLayout: layout
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

    @discardableResult
    private func measure(
        item: Int, height: CGFloat, in layout: TranscriptCollectionViewLayout
    ) throws -> UICollectionViewLayoutInvalidationContext {
        let original = try #require(layout.layoutAttributesForItem(at: index(item)))
        let preferred = try #require(original.copy() as? UICollectionViewLayoutAttributes)
        preferred.size.height = height
        let context = layout.invalidationContext(
            forPreferredLayoutAttributes: preferred, withOriginalAttributes: original
        )
        layout.invalidateLayout(with: context)
        return context
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
