import Foundation
import Testing
@testable import Lab86Mail

// Stage 4 iOS 0.8 parity: the sidebar scrub's pure rules — hit-testing, hold
// state transitions and haptic triggers, cancellation, commit/restore, and
// edge autoscroll targeting. The gesture glue is SwiftUI; everything it
// decides with is here.
struct SidebarScrubTests {
    private let rows: [SidebarDestination: CGRect] = [
        .primary(.today): CGRect(x: 0, y: 0, width: 300, height: 44),
        .primary(.tasks): CGRect(x: 0, y: 44, width: 300, height: 44),
        .mail(.main): CGRect(x: 0, y: 100, width: 300, height: 38),
        .area(id: "area_1", name: "House"): CGRect(x: 0, y: 150, width: 300, height: 50),
        .settings: CGRect(x: 0, y: 560, width: 300, height: 44),
    ]

    private let bounds = CGRect(x: 0, y: 0, width: 300, height: 620)

    // MARK: - Hit testing

    @Test
    func destinationHitTestFindsRowsAndIgnoresGaps() {
        #expect(SidebarScrubLogic.destination(at: CGPoint(x: 150, y: 20), rows: rows) == .primary(.today))
        #expect(SidebarScrubLogic.destination(at: CGPoint(x: 150, y: 120), rows: rows) == .mail(.main))
        // The gap between mail rows and areas (y 138–150) is not a stop.
        #expect(SidebarScrubLogic.destination(at: CGPoint(x: 150, y: 144), rows: rows) == nil)
        #expect(SidebarScrubLogic.destination(at: CGPoint(x: 150, y: 580), rows: rows) == .settings)
    }

    // MARK: - Session state and haptic triggers

    @Test
    func moveReportsEachRowCrossingExactlyOnce() {
        var state = SidebarScrubState()
        state.activate(over: .primary(.today), committed: .primary(.calendar))
        #expect(state.isActive)
        #expect(state.previewed == .primary(.today))
        // Same row again → no haptic.
        let sameRow = state.move(to: .primary(.today))
        #expect(!sameRow)
        // Crossing into a new row → one haptic.
        let crossed = state.move(to: .primary(.tasks))
        #expect(crossed)
        let repeated = state.move(to: .primary(.tasks))
        #expect(!repeated)
        // Gaps keep the current highlight instead of clearing it.
        let intoGap = state.move(to: nil)
        #expect(!intoGap)
        #expect(state.previewed == .primary(.tasks))
    }

    @Test
    func commitReturnsThePreviewAndEndsTheSession() {
        var state = SidebarScrubState()
        state.activate(over: .mail(.codes), committed: .primary(.today))
        _ = state.move(to: .mail(.orders))
        let committed = state.commit()
        #expect(committed == .mail(.orders))
        #expect(!state.isActive)
        #expect(state.previewed == nil)
        // A dead session commits nothing.
        let deadCommit = state.commit()
        #expect(deadCommit == nil)
    }

    @Test
    func cancelEndsTheSessionWithoutADestination() {
        var state = SidebarScrubState()
        state.activate(over: .settings, committed: .primary(.work))
        state.cancel()
        #expect(!state.isActive)
        let afterCancel = state.commit()
        #expect(afterCancel == nil)
        // Preview state never touched real navigation, so the prior committed
        // selection simply stands — there is nothing to restore.
    }

    // MARK: - Cancellation rules

    @Test
    func leavingTheSidebarByMoreThanTheSlopCancels() {
        #expect(!SidebarScrubLogic.isOutside(location: CGPoint(x: 320, y: 100), sidebarBounds: bounds))
        #expect(!SidebarScrubLogic.isOutside(location: CGPoint(x: 344, y: 100), sidebarBounds: bounds))
        #expect(SidebarScrubLogic.isOutside(location: CGPoint(x: 345, y: 100), sidebarBounds: bounds))
        #expect(SidebarScrubLogic.isOutside(location: CGPoint(x: 150, y: -60), sidebarBounds: bounds))
    }

    @Test
    func dominantHorizontalMovementReadsAsDismissalNotScrub() {
        #expect(SidebarScrubLogic.isHorizontalDismissal(translation: CGSize(width: -80, height: 10)))
        #expect(SidebarScrubLogic.isHorizontalDismissal(translation: CGSize(width: 80, height: -20)))
        // Vertical scrubbing with incidental horizontal drift is fine.
        #expect(!SidebarScrubLogic.isHorizontalDismissal(translation: CGSize(width: 30, height: 200)))
        #expect(!SidebarScrubLogic.isHorizontalDismissal(translation: CGSize(width: 80, height: 60)))
    }

    // MARK: - Edge autoscroll

    @Test
    func edgeZonesAreThe36PointBands() {
        #expect(SidebarScrubLogic.autoscrollZone(forY: 10, in: bounds) == .top)
        #expect(SidebarScrubLogic.autoscrollZone(forY: 35, in: bounds) == .top)
        #expect(SidebarScrubLogic.autoscrollZone(forY: 300, in: bounds) == nil)
        #expect(SidebarScrubLogic.autoscrollZone(forY: 590, in: bounds) == .bottom)
        // Degenerate short sidebars never autoscroll.
        #expect(SidebarScrubLogic.autoscrollZone(forY: 10, in: CGRect(x: 0, y: 0, width: 300, height: 60)) == nil)
    }

    @Test
    func autoscrollTargetsTheNeighborInVisualOrder() {
        let ordered: [SidebarDestination] = [
            .primary(.today), .primary(.tasks), .mail(.main), .settings,
        ]
        #expect(
            SidebarScrubLogic.autoscrollTarget(from: .primary(.tasks), in: ordered, zone: .top)
                == .primary(.today)
        )
        #expect(
            SidebarScrubLogic.autoscrollTarget(from: .primary(.tasks), in: ordered, zone: .bottom)
                == .mail(.main)
        )
        // The ends stop cleanly.
        #expect(SidebarScrubLogic.autoscrollTarget(from: .primary(.today), in: ordered, zone: .top) == nil)
        #expect(SidebarScrubLogic.autoscrollTarget(from: .settings, in: ordered, zone: .bottom) == nil)
        #expect(SidebarScrubLogic.autoscrollTarget(from: nil, in: ordered, zone: .top) == nil)
    }
}
