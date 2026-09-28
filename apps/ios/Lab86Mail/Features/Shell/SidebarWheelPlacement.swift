#if os(iOS)
import Foundation

// MARK: - Where the surface sits

// The layout and the model share these rules so they cannot drift apart: the
// layout uses them to place the stack, and the model uses them to work out
// where the picked row ended up so the fan can open on it.
//
// Two offsets are in play. While the wheel is held, `shift` puts the picked row
// at the slot, clamped like a scroll view. Once it lets go, the surface stays
// where the scroll left it — `restOffset`, clamped so it never shows empty
// rail — and `surface` blends between the two as the wheel engages and relaxes.
enum SidebarWheelPlacement {
    // The most empty rail the surface shows past either end, however hard it
    // is pulled or flung. The engine already bands the pull in items; this is
    // the ceiling in points.
    static let overscroll: CGFloat = 88

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

    // Where a surface may rest: anywhere that shows no empty rail. A hierarchy
    // that fits rests exactly where it stacks.
    static func resting(_ offset: CGFloat, viewport: CGFloat, total: CGFloat) -> CGFloat {
        guard viewport > 0 else { return 0 }
        return max(min(0, viewport - total), min(0, offset))
    }

    // The wheel wants the picked row at the slot, but a fixed slot cannot work
    // on a bounded list: no single slot avoids a void at both ends at once.
    // So inside the list the surface is clamped like a scroll view and the
    // slot is allowed to migrate — near the top the list simply stops moving
    // and the pick walks up the rows that are already on screen. Only a wheel
    // pulled or flung past an end takes the surface into the band, and it
    // gives up ground on a curve as it goes.
    static func shift(
        position: Double,
        centers: [CGFloat],
        slotY: CGFloat,
        viewport: CGFloat,
        total: CGFloat
    ) -> CGFloat {
        guard !centers.isEmpty, viewport > 0 else { return 0 }
        let inside = min(Double(centers.count - 1), max(0, position))
        let insideCenter = detentCenter(position: inside, centers: centers)
        let clamped = resting(slotY - insideCenter, viewport: viewport, total: total)
        let past = insideCenter - detentCenter(position: position, centers: centers)
        return clamped + band(past)
    }

    // Past either end: follows the wheel at first, then stiffens so the
    // surface never shows more than `overscroll` of empty rail.
    static func band(_ points: CGFloat) -> CGFloat {
        overscroll * CGFloat(tanh(Double(points / overscroll)))
    }

    // The surface as it is drawn: where it rests, blended toward where the
    // wheel puts it by how engaged the wheel is.
    static func surface(
        position: Double,
        centers: [CGFloat],
        slotY: CGFloat,
        viewport: CGFloat,
        total: CGFloat,
        engagement: Double,
        restOffset: CGFloat
    ) -> CGFloat {
        let rest = resting(restOffset, viewport: viewport, total: total)
        let blend = CGFloat(min(1, max(0, engagement)))
        guard blend > 0, !centers.isEmpty else { return rest }
        let wheel = shift(
            position: position,
            centers: centers,
            slotY: slotY,
            viewport: viewport,
            total: total
        )
        return rest + (wheel - rest) * blend
    }

    // Where the picked row actually is once the clamp has had its say. This is
    // the fan's focus, not the slot.
    static func focus(
        position: Double,
        centers: [CGFloat],
        slotY: CGFloat,
        viewport: CGFloat,
        total: CGFloat,
        engagement: Double,
        restOffset: CGFloat = 0
    ) -> CGFloat {
        detentCenter(position: position, centers: centers) + surface(
            position: position,
            centers: centers,
            slotY: slotY,
            viewport: viewport,
            total: total,
            engagement: engagement,
            restOffset: restOffset
        )
    }
}
#endif
