#if os(iOS)
import Foundation
import Testing
@testable import Lab86Mail

// The sidebar wheel's physics. The engine deliberately has no clock, no UIKit,
// and no SwiftUI, so a whole gesture can be played through it here — grab,
// drag, fling, coast, bounce, settle — and asserted on frame by frame.
//
// The wheel is a scroll: letting go never chooses a row. These tests are about
// where it comes to rest and how it gets there; the model's tests prove that
// nothing but a tap navigates.
struct SidebarWheelEngineTests {
    private func engine(count: Int, tuning: SidebarWheelEngine.Tuning = .standard) -> SidebarWheelEngine {
        var engine = SidebarWheelEngine()
        engine.tuning = tuning
        engine.setCount(count)
        return engine
    }

    // Runs the simulation to rest at a fixed frame rate, returning the frames
    // taken. Fails loudly rather than looping forever if it never settles.
    @discardableResult
    private func settle(
        _ engine: inout SidebarWheelEngine,
        fps: Double = 120,
        limit: Int = 1_200,
        observe: (SidebarWheelEngine) -> Void = { _ in }
    ) -> Int {
        var frames = 0
        while engine.isRunning, frames < limit {
            engine.step(dt: 1 / fps)
            observe(engine)
            frames += 1
        }
        return frames
    }

    // MARK: - Grabbing

    @Test
    func aWheelAtRestIsGrabbedAtTheRowTheCallerChooses() {
        var engine = engine(count: 12)
        engine.grab(at: 7)
        #expect(engine.position == 7)
        #expect(engine.detent == 7)
        #expect(engine.origin == 7)
        #expect(engine.velocity == 0)
        #expect(engine.isAtOrigin)
        // Out-of-range grabs clamp instead of trapping the wheel outside itself.
        engine.grab(at: 99)
        #expect(engine.origin == 11)
        engine.grab(at: -4)
        #expect(engine.origin == 0)
    }

    @Test
    func draggingIsAssignedNotIntegratedSoThereIsNoLagBehindTheThumb() {
        var engine = engine(count: 12)
        engine.grab(at: 5)
        // Position follows the delta exactly — the finger is the authority.
        engine.drag(byItems: 2.25)
        #expect(abs(engine.position - 7.25) < 1e-9)
        #expect(engine.detent == 7)
        engine.drag(byItems: -0.75)
        #expect(abs(engine.position - 4.25) < 1e-9)
        #expect(engine.detent == 4)
        // Deltas are absolute against the grab, not cumulative, so a jittery
        // frame cannot accumulate drift.
        engine.drag(byItems: 0)
        #expect(engine.position == 5)
    }

    @Test
    func rollingIntoADetentIsReportedExactlyOnce() {
        var engine = engine(count: 12)
        engine.grab(at: 5)
        #expect(engine.drag(byItems: 0.2) == nil)
        #expect(engine.drag(byItems: 0.6) == 6)
        #expect(engine.drag(byItems: 0.7) == nil)
        #expect(engine.drag(byItems: 1.6) == 7)
        #expect(engine.drag(byItems: -1.0) == 4)
    }

    @Test
    func aMovingWheelIsTakenWhereItIsWithoutAJump() {
        // Mid-fling, as a thumb stops a scroll view.
        var engine = engine(count: 40)
        engine.grab(at: 10)
        engine.release(velocityInItemsPerSecond: 30)
        for _ in 0..<12 { engine.step(dt: 1 / 120) }
        let moving = engine.position
        #expect(moving > 10)
        engine.grabInPlace()
        #expect(engine.phase == .dragging)
        #expect(engine.velocity == 0)
        #expect(engine.position == moving)
        engine.drag(byItems: 0)
        #expect(abs(engine.position - moving) < 1e-9)
        engine.drag(byItems: 1)
        #expect(abs(engine.position - (moving + 1)) < 1e-9)

        // And from inside the band, where the pull is banded: the same thumb
        // position must map back onto the same surface position.
        engine.grab(at: 0)
        engine.drag(byItems: -3)
        engine.release(velocityInItemsPerSecond: 0)
        engine.step(dt: 1 / 120)
        let banded = engine.position
        #expect(banded < 0)
        engine.grabInPlace()
        engine.drag(byItems: 0)
        #expect(abs(engine.position - banded) < 1e-9)
    }

    // MARK: - Ends

    @Test
    func bothEndsGiveUpGroundOnACurveInsteadOfHittingAWall() {
        var engine = engine(count: 12)
        engine.grab(at: 0)
        engine.drag(byItems: -1)
        let first = engine.position
        engine.drag(byItems: -3)
        let near = engine.position
        engine.drag(byItems: -30)
        let far = engine.position
        #expect(engine.isOverscrolled)
        // The band resists from the start: the surface takes less than the
        // thumb gave it…
        #expect(first < 0 && first > -1)
        // …keeps moving with the thumb…
        #expect(near < first)
        #expect(far < near)
        // …but comes to a stop rather than following forever.
        #expect(far > -engine.tuning.maximumOverscroll - 1e-9)
        #expect(engine.detent == 0)

        engine.grab(at: 11)
        engine.drag(byItems: 40)
        #expect(engine.isOverscrolled)
        #expect(engine.position < 11 + engine.tuning.maximumOverscroll + 1e-9)
        #expect(engine.detent == 11)
    }

    @Test
    func aPullPastTheTopSpringsBackWithoutAWobble() {
        var engine = engine(count: 12)
        engine.grab(at: 0)
        engine.drag(byItems: -3)
        #expect(engine.isOverscrolled)
        let landing = engine.release(velocityInItemsPerSecond: 0)
        #expect(landing == 0)
        var previous = engine.position
        var crossedIntoTheList = false
        settle(&engine) { state in
            // Critically damped: it only ever moves back toward the end, and
            // never overshoots into the rows.
            #expect(state.position >= previous - 1e-9)
            if state.position > 1e-6 { crossedIntoTheList = true }
            previous = state.position
        }
        #expect(!crossedIntoTheList)
        #expect(!engine.isOverscrolled)
        #expect(engine.position == 0)
        #expect(!engine.isRunning)
    }

    @Test
    func aPullPastTheBottomSpringsBackInsideTheList() {
        var engine = engine(count: 12)
        engine.grab(at: 11)
        engine.drag(byItems: 30)
        #expect(engine.isOverscrolled)
        // Even flung outward on release, the band turns it round.
        engine.release(velocityInItemsPerSecond: 12)
        var deepest = engine.position
        settle(&engine) { deepest = max(deepest, $0.position) }
        #expect(deepest < 11 + engine.tuning.maximumOverscroll)
        #expect(!engine.isOverscrolled)
        #expect(engine.position == 11)
        #expect(engine.detent == 11)
    }

    @Test
    func throwingBackFromTheBandDoesNotShootIntoTheList() {
        var engine = engine(count: 12)
        engine.grab(at: 0)
        engine.drag(byItems: -3)
        // A hard flick back toward the rows while still in the band.
        engine.release(velocityInItemsPerSecond: 60)
        var furthest = engine.position
        settle(&engine) { furthest = max(furthest, $0.position) }
        #expect(furthest < 0.01)
        #expect(engine.position == 0)
    }

    // MARK: - Flinging

    @Test
    func aFlingCoastsPastWhereItWasLetGoAndLandsOnADetent() {
        var engine = engine(count: 40)
        engine.grab(at: 20)
        engine.drag(byItems: 1)
        let landing = engine.release(velocityInItemsPerSecond: 18)
        #expect(landing != nil)
        // It must travel well beyond the thumb's own displacement.
        #expect((landing ?? 0) > 22)
        settle(&engine)
        #expect(engine.position == Double(landing ?? -1))
        // And come to rest exactly on a detent, never between two.
        #expect(engine.position == engine.position.rounded())
        #expect(engine.detent == landing)
    }

    @Test
    func aHarderFlingTravelsFurtherAndTheDirectionIsPreserved() {
        func landing(_ velocity: Double) -> Int? {
            var engine = engine(count: 60)
            engine.grab(at: 30)
            return engine.release(velocityInItemsPerSecond: velocity)
        }
        let gentle = landing(6) ?? 0
        let hard = landing(30) ?? 0
        #expect(gentle > 30)
        #expect(hard > gentle)
        #expect((landing(-6) ?? 0) < 30)
        #expect((landing(-30) ?? 0) < (landing(-6) ?? 0))
        // A fling never leaves the hierarchy for good.
        #expect(landing(5_000) == 59)
        #expect(landing(-5_000) == 0)
    }

    @Test
    func aFlingThatRunsOutOfListCoastsIntoTheBandAndComesBack() {
        for (origin, velocity) in [(5, 60.0), (10, 200.0), (6, -60.0), (1, -200.0), (5, 5_000.0)] {
            var engine = engine(count: 12)
            engine.grab(at: origin)
            let landing = engine.release(velocityInItemsPerSecond: velocity)
            let end = velocity > 0 ? 11 : 0
            #expect(landing == end)
            #expect(engine.phase == .coasting)
            var deepest = 0.0
            let frames = settle(&engine) { state in
                let past = velocity > 0 ? state.position - 11 : -state.position
                deepest = max(deepest, past)
            }
            // It goes out into the band, like a scroll view hitting its end…
            #expect(deepest > 0.05, "fling \(velocity) from \(origin) never overscrolled")
            // …never as far as the band's hard limit…
            #expect(deepest < engine.tuning.maximumOverscroll * 0.85)
            // …and comes to rest exactly on the end row.
            #expect(frames < 1_200)
            #expect(!engine.isRunning)
            #expect(engine.position == Double(end))
            #expect(engine.detent == end)
        }
    }

    @Test
    func aCoastSlowsDownAllTheWayToTheEnd() {
        var engine = engine(count: 30)
        engine.grab(at: 2)
        engine.release(velocityInItemsPerSecond: 150)
        var previousSpeed = abs(engine.velocity)
        var previousPosition = engine.position
        while engine.phase == .coasting {
            engine.step(dt: 1 / 120)
            guard engine.phase == .coasting else { break }
            // Friction only: always forward, always slower.
            #expect(engine.position > previousPosition)
            #expect(abs(engine.velocity) < previousSpeed)
            previousSpeed = abs(engine.velocity)
            previousPosition = engine.position
        }
        #expect(engine.phase == .settling)
    }

    @Test
    func everySettleReachesRestAndNeverOscillatesForever() {
        for velocity in stride(from: -400.0, through: 400.0, by: 8) {
            var engine = engine(count: 30)
            engine.grab(at: 15)
            engine.drag(byItems: 0.4)
            engine.release(velocityInItemsPerSecond: velocity)
            let frames = settle(&engine)
            #expect(frames < 1_200, "velocity \(velocity) never came to rest")
            #expect(!engine.isRunning)
            #expect(engine.position == engine.position.rounded())
            #expect(engine.position >= 0 && engine.position <= 29)
        }
    }

    @Test
    func aDroppedFrameCannotMakeTheSpringExplode() {
        for velocity in [25.0, 400.0, -400.0] {
            var engine = engine(count: 20)
            engine.grab(at: 10)
            engine.release(velocityInItemsPerSecond: velocity)
            // A debugger pause, a hitch, a backgrounded app: one enormous dt.
            engine.step(dt: 4)
            #expect(engine.position.isFinite)
            #expect(engine.position >= -engine.tuning.maximumOverscroll)
            #expect(engine.position <= 19 + engine.tuning.maximumOverscroll)
            settle(&engine)
            #expect(engine.position == engine.position.rounded())
        }
    }

    @Test
    func theRowItComesToRestOnIsAlwaysTheRowItSaidItWouldReach() {
        // The pick lands exactly where `release` projected it. Nothing is
        // chosen there; it is just where the list stops.
        for (count, origin) in [(40, 20), (14, 7), (60, 0), (60, 59), (30, 15)] {
            for tenths in stride(from: -1_600, through: 1_600, by: 25) {
                var engine = engine(count: count)
                engine.grab(at: origin)
                engine.drag(byItems: 0.3)
                let landing = engine.release(velocityInItemsPerSecond: Double(tenths) / 2)
                settle(&engine)
                #expect(engine.detent == landing)
                #expect(engine.position == Double(landing ?? -1))
            }
        }
    }

    // MARK: - Catching

    @Test
    func aTapCatchesATravellingWheelOnTheRowItIsPassing() {
        var engine = engine(count: 40)
        engine.grab(at: 5)
        engine.release(velocityInItemsPerSecond: 60)
        for _ in 0..<10 { engine.step(dt: 1 / 120) }
        #expect(engine.isCatchable)
        let caught = engine.position
        engine.halt()
        #expect(engine.velocity == 0)
        let frames = settle(&engine)
        // It stops on the nearest row, promptly, instead of coasting on.
        #expect(engine.position == caught.rounded())
        #expect(frames < 240)
    }

    @Test
    func aWheelThatHasAlmostStoppedIsNotCaught() {
        var engine = engine(count: 40)
        engine.grab(at: 5)
        engine.drag(byItems: 0.2)
        engine.release(velocityInItemsPerSecond: 0)
        // A slow settle onto a row is not "travelling"; a tap there is a tap.
        engine.step(dt: 1 / 120)
        #expect(!engine.isCatchable)
        #expect(!SidebarWheelEngine().isCatchable)
    }

    // MARK: - The escape hatch

    @Test
    func cancellingRollsHomeRatherThanTeleporting() {
        var engine = engine(count: 20)
        engine.grab(at: 12)
        engine.drag(byItems: -5)
        #expect(engine.detent == 7)
        #expect(!engine.isAtOrigin)
        engine.cancel()
        // It does not jump — it is still where the thumb left it, heading back.
        #expect(engine.position < 12)
        settle(&engine)
        #expect(engine.position == 12)
        #expect(engine.isAtOrigin)
    }

    @Test
    func liftingWithoutMovingRestsWhereTheGrabBegan() {
        var engine = engine(count: 20)
        engine.grab(at: 12)
        engine.drag(byItems: 6)
        engine.drag(byItems: 0)
        let landing = engine.release(velocityInItemsPerSecond: 0)
        #expect(landing == 12)
        #expect(engine.isAtOrigin)
    }

    // MARK: - Engagement

    @Test
    func theWheelBlendsInWhileHeldAndBackOutOnceItSleeps() {
        var engine = engine(count: 12)
        #expect(engine.engagement == 0)
        #expect(!engine.isRunning)
        engine.grab(at: 4)
        // Held: it blends toward fully wheeled and stays there.
        for _ in 0..<60 { engine.step(dt: 1 / 120) }
        #expect(engine.engagement > 0.99)
        #expect(engine.isRunning)
        engine.release(velocityInItemsPerSecond: 0)
        settle(&engine)
        // Asleep: fully back to the resting list, and the clock can stop.
        #expect(engine.engagement == 0)
        #expect(!engine.isRunning)
    }

    @Test
    func reduceMotionKeepsTheDetentsAndDropsThePhysicality() {
        var engine = engine(count: 30, tuning: .reduced)
        engine.grab(at: 15)
        engine.drag(byItems: -40)
        // No overscroll band at all.
        #expect(!engine.isOverscrolled)
        #expect(engine.position == 0)
        // And a hard fling does not coast past where it was let go…
        engine.grab(at: 15)
        #expect(engine.release(velocityInItemsPerSecond: 30) == 15)
        // …nor bounce off an end it was already at.
        engine.grab(at: 29)
        engine.release(velocityInItemsPerSecond: 3_000)
        settle(&engine) { #expect(!$0.isOverscrolled) }
        #expect(engine.position == 29)
    }

    @Test
    func switchingToReduceMotionMidFlingStillComesToRest() {
        var engine = engine(count: 60)
        engine.grab(at: 5)
        engine.release(velocityInItemsPerSecond: 400)
        for _ in 0..<5 { engine.step(dt: 1 / 120) }
        engine.tuning = .reduced
        let frames = settle(&engine)
        #expect(frames < 1_200)
        #expect(engine.position == engine.position.rounded())
        #expect(engine.position >= 0 && engine.position <= 59)
    }

    // MARK: - Structure changes

    @Test
    func theHierarchyCanChangeUnderneathAWheelWithoutStrandingIt() {
        var engine = engine(count: 20)
        engine.grab(at: 18)
        engine.drag(byItems: 0)
        engine.setCount(5)
        #expect(engine.position <= 4)
        #expect(engine.detent <= 4)
        #expect(engine.origin <= 4)
        engine.setCount(0)
        #expect(engine.position == 0)
        #expect(engine.detent == 0)
        // A wheel with nothing in it does nothing rather than crashing.
        engine.grab(at: 3)
        #expect(engine.drag(byItems: 5) == nil)
        #expect(engine.release(velocityInItemsPerSecond: 10) == nil)
        #expect(!engine.isRunning || engine.phase == .idle)
    }

    @Test
    func theHierarchyCanShrinkUnderAFlingWithoutStrandingIt() {
        for (count, shrunk, velocity) in [(40, 10, 200.0), (40, 10, -200.0), (40, 30, 40.0), (12, 1, 90.0), (12, 0, 90.0)] {
            var engine = engine(count: count)
            engine.grab(at: count / 2)
            engine.release(velocityInItemsPerSecond: velocity)
            for _ in 0..<8 { engine.step(dt: 1 / 120) }
            engine.setCount(shrunk)
            let frames = settle(&engine)
            #expect(frames < 1_200)
            #expect(!engine.isRunning)
            #expect(engine.position >= 0)
            #expect(engine.position <= Double(max(0, shrunk - 1)))
            #expect(engine.detent <= max(0, shrunk - 1))
        }
    }
}

// Where the surface is allowed to sit. A fixed slot cannot work on a bounded
// list — no single slot avoids a void at both ends — so the surface is clamped
// and the slot migrates. Between gestures the surface stays where the scroll
// left it, and never shows empty rail. These are the rules that keep the
// hierarchy on screen.
struct SidebarWheelPlacementTests {
    private func centers(_ count: Int, gap: CGFloat = 50) -> [CGFloat] {
        (0..<count).map { 22 + gap * CGFloat($0) }
    }

    @Test
    func rollingToTheTopFromABottomRowCannotParkTheListOffScreen() {
        // The reported bug: grab while on a mail row near the bottom, roll to
        // Brief, and the whole hierarchy slid down to meet the slot.
        let rows = centers(14)
        let total = rows[13] + 22
        let viewport: CGFloat = 500
        let slot = SidebarWheelPlacement.slot(resting: rows[12], viewport: viewport)
        let shift = SidebarWheelPlacement.shift(
            position: 0, centers: rows, slotY: slot, viewport: viewport, total: total
        )
        // Inside the list the surface stops at the top exactly, like a scroll
        // view, rather than showing empty rail.
        #expect(shift == 0)
        let focus = SidebarWheelPlacement.focus(
            position: 0, centers: rows, slotY: slot, viewport: viewport, total: total, engagement: 1
        )
        #expect(focus >= 0 && focus <= viewport)
    }

    @Test
    func theHierarchyNeverLeavesMoreThanTheBandOfEmptyRailAtEitherEdge() {
        for (count, viewport) in [(14, CGFloat(500)), (14, 900), (30, 700), (5, 600), (2, 600)] {
            let rows = centers(count)
            let total = rows[count - 1] + 22
            for origin in 0..<count {
                let slot = SidebarWheelPlacement.slot(resting: rows[origin], viewport: viewport)
                for tenths in stride(from: -20, through: (count - 1) * 10 + 20, by: 1) {
                    let position = Double(tenths) / 10
                    let shift = SidebarWheelPlacement.shift(
                        position: position, centers: rows, slotY: slot, viewport: viewport, total: total
                    )
                    #expect(shift <= SidebarWheelPlacement.overscroll + 0.001)
                    #expect(shift + total >= min(viewport, total) - SidebarWheelPlacement.overscroll - 0.001)
                    if position >= 0, position <= Double(count - 1) {
                        // Inside the list: no empty rail at all.
                        #expect(shift <= 0.001)
                        #expect(shift + total >= min(viewport, total) - 0.001)
                        // And the open page is always somewhere you can see it.
                        let focus = SidebarWheelPlacement.focus(
                            position: position, centers: rows, slotY: slot,
                            viewport: viewport, total: total, engagement: 1
                        )
                        #expect(focus >= -2 && focus <= viewport + 2)
                    }
                }
            }
        }
    }

    @Test
    func pastEitherEndTheSurfaceFollowsIntoTheBandOnACurve() {
        // A hierarchy that fits: it never moves inside the list, so any
        // movement at all is the band.
        let rows = centers(5)
        let total = rows[4] + 22
        let viewport: CGFloat = 600
        let slot = SidebarWheelPlacement.slot(resting: rows[2], viewport: viewport)
        func shift(_ position: Double) -> CGFloat {
            SidebarWheelPlacement.shift(position: position, centers: rows, slotY: slot, viewport: viewport, total: total)
        }
        // Past the top the list moves down, past the bottom it moves up…
        #expect(shift(-0.5) > 0)
        #expect(shift(-1) > shift(-0.5))
        #expect(shift(4.5) < 0)
        #expect(shift(5) < shift(4.5))
        // …giving less ground the further it goes…
        #expect(shift(-2) - shift(-1) < shift(-1) - shift(0))
        // …and never more than the band.
        #expect(shift(-40) <= SidebarWheelPlacement.overscroll)
        #expect(shift(44) >= -SidebarWheelPlacement.overscroll)
    }

    @Test
    func awayFromTheEndsTheWheelStillDoesExactlyWhatItSays() {
        let rows = centers(14)
        let total = rows[13] + 22
        let viewport: CGFloat = 500
        let slot = SidebarWheelPlacement.slot(resting: rows[6], viewport: viewport)
        // In the unclamped middle the picked row lands on the slot precisely.
        for position in [6.0, 7.0] {
            let focus = SidebarWheelPlacement.focus(
                position: position, centers: rows, slotY: slot, viewport: viewport,
                total: total, engagement: 1
            )
            #expect(abs(focus - slot) < 0.001)
        }
        // Disengaged, the surface is exactly where it rests.
        let resting = SidebarWheelPlacement.focus(
            position: 0, centers: rows, slotY: slot, viewport: viewport, total: total, engagement: 0
        )
        #expect(abs(resting - rows[0]) < 0.001)
        let scrolled = SidebarWheelPlacement.focus(
            position: 0, centers: rows, slotY: slot, viewport: viewport, total: total,
            engagement: 0, restOffset: -120
        )
        #expect(abs(scrolled - (rows[0] - 120)) < 0.001)
    }

    @Test
    func aRestingSurfaceNeverShowsEmptyRail() {
        // A long list rests anywhere between its top and its bottom.
        #expect(SidebarWheelPlacement.resting(-120, viewport: 500, total: 700) == -120)
        #expect(SidebarWheelPlacement.resting(40, viewport: 500, total: 700) == 0)
        #expect(SidebarWheelPlacement.resting(-900, viewport: 500, total: 700) == -200)
        // A list that fits rests where it stacks, whatever it is given.
        #expect(SidebarWheelPlacement.resting(-120, viewport: 800, total: 700) == 0)
        #expect(SidebarWheelPlacement.resting(60, viewport: 800, total: 700) == 0)
        // A degenerate viewport does not divide by anything.
        #expect(SidebarWheelPlacement.resting(-50, viewport: 0, total: 700) == 0)
    }

    @Test
    func theSurfaceBlendsFromWhereItRestsToWhereTheWheelPutsIt() {
        let rows = centers(14)
        let total = rows[13] + 22
        let viewport: CGFloat = 500
        let slot = SidebarWheelPlacement.slot(resting: rows[3], viewport: viewport)
        func surface(_ engagement: Double) -> CGFloat {
            SidebarWheelPlacement.surface(
                position: 9, centers: rows, slotY: slot, viewport: viewport,
                total: total, engagement: engagement, restOffset: -80
            )
        }
        let wheel = SidebarWheelPlacement.shift(position: 9, centers: rows, slotY: slot, viewport: viewport, total: total)
        #expect(surface(0) == -80)
        #expect(abs(surface(1) - wheel) < 0.001)
        #expect(abs(surface(0.5) - (-80 + (wheel + 80) / 2)) < 0.001)
        // No measurement yet: the surface simply rests.
        #expect(SidebarWheelPlacement.surface(
            position: 9, centers: [], slotY: slot, viewport: viewport,
            total: total, engagement: 1, restOffset: -80
        ) == -80)
    }

    @Test
    func aSlotBelowTheFoldIsPulledIntoView() {
        // A row that rests off the bottom cannot be the slot as it stands.
        #expect(SidebarWheelPlacement.slot(resting: 900, viewport: 500) < 500)
        #expect(SidebarWheelPlacement.slot(resting: -40, viewport: 500) > 0)
        // One already comfortably in view is left alone.
        #expect(SidebarWheelPlacement.slot(resting: 250, viewport: 500) == 250)
        // Degenerate viewport does not divide by anything.
        #expect(SidebarWheelPlacement.slot(resting: 250, viewport: 0) == 250)
    }

    @Test
    func aHierarchyThatFitsStaysPutAndOnlyThePickMoves() {
        let rows = centers(5)
        let total = rows[4] + 22
        let viewport: CGFloat = 600
        let slot = SidebarWheelPlacement.slot(resting: rows[2], viewport: viewport)
        for position in 0...4 {
            let shift = SidebarWheelPlacement.shift(
                position: Double(position), centers: rows, slotY: slot,
                viewport: viewport, total: total
            )
            #expect(shift == 0)
        }
    }

    @Test
    func anEmptyOrSingleRowHierarchyIsHarmless() {
        #expect(SidebarWheelPlacement.detentCenter(position: 3, centers: []) == 0)
        #expect(SidebarWheelPlacement.detentCenter(position: 3, centers: [40]) == 40)
        #expect(SidebarWheelPlacement.shift(
            position: 2, centers: [], slotY: 100, viewport: 500, total: 0
        ) == 0)
        #expect(SidebarWheelPlacement.shift(
            position: 2, centers: [40], slotY: 100, viewport: 0, total: 100
        ) == 0)
        #expect(SidebarWheelPlacement.shift(
            position: -1, centers: [40], slotY: 100, viewport: 500, total: 80
        ) == 0)
    }
}
#endif
