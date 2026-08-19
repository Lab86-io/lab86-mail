#if os(iOS)
import SwiftUI

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

// MARK: - Where the surface sits

// The clamp and the focus share these rules so they cannot drift apart: the
// layout uses them to place the stack, and the model uses them to work out
// where the picked row ended up so the fan can open on it.
enum SidebarWheelPlacement {
    // How much empty rail the surface may show past either edge before it
    // stops. Small: this is the rubber band, not a scroll range.
    static let overscroll: CGFloat = 44

    // Where the open page may sit. A row that rests below the fold cannot be
    // the slot as it stands, or the fan would open off-screen.
    static func slot(resting: CGFloat, viewport: CGFloat) -> CGFloat {
        guard viewport > 0 else { return resting }
        let inset = min(72, viewport * 0.22)
        return max(inset, min(viewport - inset, resting))
    }

    // Resting centre of a fractional position. Past either end it keeps
    // extrapolating on the outermost gap so overscroll has something to move.
    static func detentCenter(position: Double, centers: [CGFloat]) -> CGFloat {
        guard let first = centers.first, let last = centers.last else { return 0 }
        guard centers.count > 1 else { return first }
        if position <= 0 {
            return first + CGFloat(position) * (centers[1] - centers[0])
        }
        let lastIndex = centers.count - 1
        if position >= Double(lastIndex) {
            let gap = centers[lastIndex] - centers[lastIndex - 1]
            return last + CGFloat(position - Double(lastIndex)) * gap
        }
        let lower = Int(position)
        let fraction = CGFloat(position - Double(lower))
        return centers[lower] + (centers[lower + 1] - centers[lower]) * fraction
    }

    // The wheel wants the picked row at the slot, but a fixed slot cannot work
    // on a bounded list: no single slot avoids a void at both ends at once.
    // So the surface is clamped like a scroll view and the slot is allowed to
    // migrate — near the top the list simply stops moving and the pick walks
    // up the rows that are already on screen.
    static func shift(
        position: Double,
        centers: [CGFloat],
        slotY: CGFloat,
        viewport: CGFloat,
        total: CGFloat
    ) -> CGFloat {
        guard !centers.isEmpty, viewport > 0 else { return 0 }
        let desired = slotY - detentCenter(position: position, centers: centers)
        guard total > viewport else {
            // The whole hierarchy fits: it stays put and only the pick moves.
            return max(-overscroll, min(overscroll, desired))
        }
        return max(viewport - total - overscroll, min(overscroll, desired))
    }

    // Where the picked row actually is once the clamp has had its say. This is
    // the fan's focus, not the slot.
    static func focus(
        position: Double,
        centers: [CGFloat],
        slotY: CGFloat,
        viewport: CGFloat,
        total: CGFloat,
        engagement: Double
    ) -> CGFloat {
        let center = detentCenter(position: position, centers: centers)
        let applied = shift(
            position: position,
            centers: centers,
            slotY: slotY,
            viewport: viewport,
            total: total
        ) * CGFloat(engagement)
        return center + applied
    }
}

// MARK: - Placement

// Stacks the sidebar naturally, then slides the whole stack so the wheel's
// current position sits under the thumb.
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
    var spacing: CGFloat
    // Reports each detent's resting centre and the hierarchy's full height, so
    // a grab can put the slot where the current row already is and the model
    // can work out the same clamp the layout applies. Fires only when the
    // measurement actually changes, never per frame.
    var onMeasure: ([CGFloat], CGFloat) -> Void = { _, _ in }

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
        guard engagement > 0, !cache.detentCenters.isEmpty else { return 0 }
        return SidebarWheelPlacement.shift(
            position: position,
            centers: cache.detentCenters,
            slotY: slotY,
            viewport: bounds.height,
            total: cache.total
        ) * CGFloat(engagement)
    }
}
#endif
