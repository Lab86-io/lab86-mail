#if os(iOS)
import os
import SwiftUI

// Numbers each measurement the layout publishes, from whatever thread the
// layout runs on, so the model can tell a late old one from the newest.
final class SidebarMeasurementSequence: Sendable {
    private let counter = OSAllocatedUnfairLock(initialState: 0)

    func next() -> Int {
        counter.withLock { value in
            value += 1
            return value
        }
    }
}

// MARK: - Detent tagging

// Marks a subview as a real wheel stop. Everything untagged — section headers,
// dividers, empty states — simply rides along on the same surface.
private struct SidebarWheelDetentKey: LayoutValueKey {
    static let defaultValue: Int? = nil
}

extension View {
    func sidebarWheelDetent(_ index: Int) -> some View {
        layoutValue(key: SidebarWheelDetentKey.self, value: index)
    }
}

// MARK: - Placement

// Stacks the sidebar naturally, then slides the whole stack: under the thumb
// while the wheel is held, and wherever the scroll left it once it lets go.
//
// This is the load-bearing decision in the whole gesture. Placement is the only
// thing that changes as the wheel turns, so no row's body depends on the wheel
// position and no row ever rebuilds mid-drag. Because the movement is real
// layout rather than a render-time offset, every row's `GeometryProxy` reports
// where it actually is — which is what lets each row derive its own page
// transform from geometry instead of from shared state.
struct SidebarWheelLayout: Layout {
    // In items. Fractional positions interpolate between detent centres.
    var position: Double
    // Where in the container the picked row should sit, in the container's own
    // coordinates.
    var slotY: CGFloat
    // 0 rests as a plain stack, 1 is fully wheeled.
    var engagement: Double
    // Where the surface rests between gestures. The riffle is a scroll, so the
    // list stays where the last fling or drag left it.
    var restOffset: CGFloat = 0
    var spacing: CGFloat
    // Reports each detent's resting centre and the hierarchy's full height, so
    // a grab can put the slot where the current row already is and the model
    // can work out the same clamp the layout applies. Fires only when the
    // measurement actually changes, never per frame.
    // `Layout` is Sendable, so the callback must be too; SwiftUI still calls
    // it during layout on the main thread, which the caller relies on.
    var onMeasure: @Sendable ([CGFloat], CGFloat) -> Void = { _, _ in }

    struct Cache {
        var width: CGFloat = -1
        var heights: [CGFloat] = []
        var centers: [CGFloat] = []
        var detentCenters: [CGFloat] = []
        var total: CGFloat = 0
    }

    func makeCache(subviews: Subviews) -> Cache { Cache() }

    func updateCache(_ cache: inout Cache, subviews: Subviews) {
        // Force a re-measure when the row set changes; placement itself never
        // invalidates this.
        cache.width = -1
    }

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout Cache
    ) -> CGSize {
        let width = proposal.width ?? 0
        measure(&cache, subviews: subviews, width: width)
        // The wheel is a viewport, not scroll content: it takes exactly the
        // height it is offered and clips, however tall the hierarchy is.
        // Reporting the content height instead made the sidebar taller than the
        // screen, which pushed Settings off the bottom and — because a ZStack
        // centres vertically — shoved the page down inside its own shell.
        let height: CGFloat = if let proposed = proposal.height, proposed.isFinite {
            proposed
        } else {
            cache.total
        }
        return CGSize(width: width, height: height)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout Cache
    ) {
        measure(&cache, subviews: subviews, width: bounds.width)
        guard cache.centers.count == subviews.count else { return }
        let shift = wheelShift(cache: cache, in: bounds)
        for index in subviews.indices {
            subviews[index].place(
                at: CGPoint(x: bounds.minX, y: bounds.minY + cache.centers[index] + shift),
                anchor: .leading,
                proposal: ProposedViewSize(width: bounds.width, height: cache.heights[index])
            )
        }
    }

    // MARK: - Geometry

    private func measure(_ cache: inout Cache, subviews: Subviews, width: CGFloat) {
        guard cache.width != width || cache.heights.count != subviews.count else { return }
        cache.width = width
        cache.heights = subviews.map {
            $0.sizeThatFits(ProposedViewSize(width: width, height: nil)).height
        }
        var y: CGFloat = 0
        var centers: [CGFloat] = []
        var detents: [(index: Int, center: CGFloat)] = []
        for index in subviews.indices {
            let center = y + cache.heights[index] / 2
            centers.append(center)
            if let detent = subviews[index][SidebarWheelDetentKey.self] {
                detents.append((detent, center))
            }
            y += cache.heights[index] + spacing
        }
        cache.centers = centers
        cache.total = max(0, y - spacing)
        cache.detentCenters = detents.sorted { $0.index < $1.index }.map(\.center)
        onMeasure(cache.detentCenters, cache.total)
    }

    private func wheelShift(cache: Cache, in bounds: CGRect) -> CGFloat {
        SidebarWheelPlacement.surface(
            position: position,
            centers: cache.detentCenters,
            slotY: slotY,
            viewport: bounds.height,
            total: cache.total,
            engagement: engagement,
            restOffset: restOffset
        )
    }
}
#endif
