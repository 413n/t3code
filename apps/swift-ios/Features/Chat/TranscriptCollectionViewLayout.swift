import UIKit

/// A single column with measured heights keyed by message ID. Scrolling only
/// looks up visible frames. It does not rebuild the layout or reset estimates.
final class TranscriptCollectionViewLayout: UICollectionViewLayout {
    var itemIDsProvider: (() -> [String])?
    private var itemIDs: [String] = []
    private var heights: [String: CGFloat] = [:]
    private var frames: [CGRect] = []
    private var measuredWidth: CGFloat = 0
    private var contentHeight: CGFloat = 0
    private var needsRebuild = true
    private var needsItemRefresh = true

    func setItems(_ ids: [String]) {
        guard itemIDs != ids else { return }
        let retained = Set(ids)
        heights = heights.filter { retained.contains($0.key) }
        itemIDs = ids
        needsRebuild = true
    }

    override func prepare() {
        super.prepare()
        guard let collectionView, collectionView.bounds.width > 0 else { return }
        if needsItemRefresh, let itemIDsProvider {
            let ids = itemIDsProvider()
            let count = collectionView.numberOfSections > 0 ? collectionView.numberOfItems(inSection: 0) : 0
            if ids.count == count {
                needsItemRefresh = false
                setItems(ids)
            }
        }
        let width = collectionView.bounds.width
        if abs(width - measuredWidth) > 0.5 {
            heights.removeAll(keepingCapacity: true)
            measuredWidth = width
            needsRebuild = true
        }
        guard needsRebuild else { return }
        needsRebuild = false

        let inset = max(18, (width - T3Metrics.readingWidth) / 2)
        let cellWidth = max(1, width - inset * 2)
        var nextY: CGFloat = 18
        frames = itemIDs.map { id in
            let frame = CGRect(
                x: inset,
                y: nextY,
                width: cellWidth,
                height: heights[id] ?? 120
            )
            nextY = frame.maxY + 22
            return frame
        }
        contentHeight = itemIDs.isEmpty ? 0 : nextY - 22 + 14
    }

    override var collectionViewContentSize: CGSize {
        CGSize(width: collectionView?.bounds.width ?? 0, height: contentHeight)
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        var lower = 0
        var upper = frames.count
        while lower < upper {
            let middle = (lower + upper) / 2
            if frames[middle].maxY < rect.minY {
                lower = middle + 1
            } else {
                upper = middle
            }
        }
        var visible: [UICollectionViewLayoutAttributes] = []
        for index in lower..<frames.count {
            let frame = frames[index]
            guard frame.minY <= rect.maxY else { break }
            if frame.intersects(rect),
               let attributes = layoutAttributesForItem(at: IndexPath(item: index, section: 0)) {
                visible.append(attributes)
            }
        }
        return visible
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        guard indexPath.section == 0, frames.indices.contains(indexPath.item) else { return nil }
        let attributes = UICollectionViewLayoutAttributes(forCellWith: indexPath)
        attributes.frame = frames[indexPath.item]
        return attributes
    }

    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
        abs(newBounds.width - measuredWidth) > 0.5
    }

    override func shouldInvalidateLayout(
        forPreferredLayoutAttributes preferredAttributes: UICollectionViewLayoutAttributes,
        withOriginalAttributes originalAttributes: UICollectionViewLayoutAttributes
    ) -> Bool {
        preferredAttributes.size.height.isFinite
            && preferredAttributes.size.height > 0
            && abs(ceil(preferredAttributes.size.height) - originalAttributes.size.height) > 0.5
    }

    override func invalidationContext(
        forPreferredLayoutAttributes preferredAttributes: UICollectionViewLayoutAttributes,
        withOriginalAttributes originalAttributes: UICollectionViewLayoutAttributes
    ) -> UICollectionViewLayoutInvalidationContext {
        let context = super.invalidationContext(
            forPreferredLayoutAttributes: preferredAttributes,
            withOriginalAttributes: originalAttributes
        )
        let indexPath = preferredAttributes.indexPath
        guard itemIDs.indices.contains(indexPath.item) else { return context }

        let height = max(1, ceil(preferredAttributes.size.height))
        let delta = height - originalAttributes.size.height
        heights[itemIDs[indexPath.item]] = height
        needsRebuild = true
        context.invalidateItems(at: [indexPath])
        context.contentSizeAdjustment.height = delta

        // UIKit applies this correction during layout, including deceleration.
        // Moving the offset later with setContentOffset would stop the gesture.
        if let collectionView,
           (collectionView as? BottomAnchoredTranscriptCollectionView)?.maintainsBottomAnchor != true,
           min(originalAttributes.frame.maxY, originalAttributes.frame.minY + height)
                <= collectionView.contentOffset.y + collectionView.adjustedContentInset.top {
            context.contentOffsetAdjustment.y = delta
        }
        return context
    }

    override func invalidateLayout(with context: UICollectionViewLayoutInvalidationContext) {
        needsRebuild = true
        if context.invalidateEverything || context.invalidateDataSourceCounts {
            needsItemRefresh = true
        }
        super.invalidateLayout(with: context)
    }

    func resetMeasurements() {
        heights.removeAll(keepingCapacity: true)
        invalidateLayout()
    }
}
