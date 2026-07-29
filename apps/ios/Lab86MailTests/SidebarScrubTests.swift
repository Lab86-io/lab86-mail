import Foundation
import Testing
@testable import Lab86Mail

// The sidebar wheel's physics. The engine deliberately has no clock, no UIKit,
// and no SwiftUI, so a whole gesture can be played through it here — grab,
// drag, fling, settle — and asserted on frame by frame.
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
        limit: Int = 1_200
    ) -> Int {
        var frames = 0
        while engine.isRunning, frames < limit {
            engine.step(dt: 1 / fps)
            frames += 1
        }
        return frames
    }

    // MARK: - Grabbing

    @Test
    func theWheelIsAlwaysGrabbedAtAKnownOriginRatherThanUnderTheThumb() {
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

    // MARK: - Ends

    @Test
    func bothEndsGiveUpGroundOnACurveInsteadOfHittingAWall() {
        var engine = engine(count: 12)
        engine.grab(at: 0)
        engine.drag(byItems: -3)
        let near = engine.position
        engine.drag(byItems: -30)
        let far = engine.position
        #expect(engine.isOverscrolled)
        #expect(near < 0)
        // It keeps moving with the thumb…
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
    func releasingBeyondAnEndSpringsBackInsideTheList() {
        var engine = engine(count: 12)
        engine.grab(at: 11)
        engine.drag(byItems: 30)
        #expect(engine.isOverscrolled)
        engine.release(velocityInItemsPerSecond: 12)
        settle(&engine)
        #expect(!engine.isOverscrolled)
        #expect(engine.position == 11)
        #expect(engine.detent == 11)
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
        // A fling never leaves the hierarchy.
        #expect(landing(5_000) == 59)
        #expect(landing(-5_000) == 0)
    }

    @Test
    func everySettleReachesRestAndNeverOscillatesForever() {
        for velocity in stride(from: -40.0, through: 40.0, by: 8) {
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
        var engine = engine(count: 20)
        engine.grab(at: 10)
        engine.release(velocityInItemsPerSecond: 25)
        // A debugger pause, a hitch, a backgrounded app: one enormous dt.
        engine.step(dt: 4)
        #expect(engine.position.isFinite)
        #expect(engine.position >= -engine.tuning.maximumOverscroll)
        #expect(engine.position <= 19 + engine.tuning.maximumOverscroll)
        settle(&engine)
        #expect(engine.position == engine.position.rounded())
    }

    @Test
    func theRowItComesToRestOnIsAlwaysTheRowItSaidItWouldTake() {
        // The commit is deferred until the wheel arrives, so that the row
        // showing as picked and the row being opened can never disagree. That
        // only holds if the settle lands exactly where `release` promised.
        for (count, origin) in [(40, 20), (14, 7), (60, 0), (60, 59), (30, 15)] {
            for tenths in stride(from: -160, through: 160, by: 5) {
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
    func liftingBackAtTheOriginCommitsThePageYouWereAlreadyOn() {
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
        // And a hard fling does not coast past where it was let go.
        engine.grab(at: 15)
        #expect(engine.release(velocityInItemsPerSecond: 30) == 15)
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
    }
}

// The page fan. Distance is in rows, signed, and derived from where a row
// actually landed, so these are the shape rules for the whole sidebar.
struct SidebarPageGeometryTests {
    private func page(_ distance: Double, engagement: Double = 1) -> SidebarPageTransform {
        SidebarPageGeometry.transform(
            distance: distance,
            engagement: engagement,
            reduceMotion: false
        )
    }

    @Test
    func theOpenPageIsFlatAndTheRestFanShut() {
        let open = page(0)
        #expect(open.hingeDegrees == 0)
        #expect(open.opacity > 0.999)
        #expect(open.lift > 1)
        // Pages shut in both directions — a fan, not a tilt.
        #expect(page(2).hingeDegrees < 0)
        #expect(page(-2).hingeDegrees < 0)
        #expect(abs(page(2).hingeDegrees - page(-2).hingeDegrees) < 1e-9)
        #expect(abs(page(2).lift - page(-2).lift) < 1e-9)
    }

    @Test
    func theFanIsSmoothThroughTheOpenPageAndHasNoClampToFreezeAgainst() {
        // A crease at the open page is what a `tanh(|d|)` shape would give.
        let step = 0.01
        let left = page(-step).hingeDegrees
        let right = page(step).hingeDegrees
        #expect(abs(left - right) < 1e-6)
        #expect(abs(left) < 0.02)

        // Every channel keeps separating row to row all the way out; nothing
        // freezes at a limit the way the old clamped version did.
        let distances = stride(from: 0.0, through: 14.0, by: 1.0).map { page($0) }
        for index in 0..<(distances.count - 1) {
            #expect(distances[index + 1].hingeDegrees < distances[index].hingeDegrees)
            #expect(distances[index + 1].lift < distances[index].lift)
            #expect(distances[index + 1].opacity < distances[index].opacity)
        }
    }

    @Test
    func nothingEverBendsOrFadesOutOfLegibility() {
        for distance in stride(from: -40.0, through: 40.0, by: 2.0) {
            let transform = page(distance)
            #expect(abs(transform.hingeDegrees) <= SidebarPageGeometry.maximumHinge)
            #expect(transform.opacity >= SidebarPageGeometry.farOpacity)
            #expect(transform.lift <= 1 + CGFloat(SidebarPageGeometry.liftAmount))
            #expect(transform.lift >= 1)
            // Growth is always outward from the spine, never inward.
            #expect(transform.slide >= 0)
        }
    }

    @Test
    func aRestingSidebarIsCompletelyUntouched() {
        // At zero engagement the wheel leaves no trace, whatever the distance.
        for distance in stride(from: -10.0, through: 10.0, by: 1.0) {
            #expect(page(distance, engagement: 0) == .identity)
        }
        // And it scales in continuously rather than appearing.
        let partial = page(3, engagement: 0.5)
        let full = page(3, engagement: 1)
        #expect(partial.hingeDegrees > full.hingeDegrees)
        #expect(partial.hingeDegrees < 0)
        #expect(partial.opacity > full.opacity)
    }

    @Test
    func reduceMotionKeepsTheFocusAndDropsTheThirdDimension() {
        let reduced = SidebarPageGeometry.transform(
            distance: 3,
            engagement: 1,
            reduceMotion: true
        )
        #expect(reduced.hingeDegrees == 0)
        #expect(reduced.slide == 0)
        // The open page is still the one that stands out.
        let open = SidebarPageGeometry.transform(distance: 0, engagement: 1, reduceMotion: true)
        #expect(open.lift > reduced.lift)
        #expect(open.opacity > reduced.opacity)
    }
}

// Destination identity, which the wheel uses to find where it should start.
struct SidebarDestinationTests {
    private let ordered: [SidebarDestination] = [
        .primary(.today),
        .area(id: "area_1", name: "House"),
        .mail(.main),
    ]

    @Test
    func anAreaResolvesOnIdSoAStaleRouteNameStillFindsItsRow() {
        #expect(SidebarDestination.index(of: .primary(.today), in: ordered) == 0)
        #expect(SidebarDestination.index(of: .mail(.main), in: ordered) == 2)
        #expect(SidebarDestination.index(of: .area(id: "area_1", name: ""), in: ordered) == 1)
        #expect(SidebarDestination.index(of: .area(id: "gone", name: "House"), in: ordered) == nil)
        #expect(SidebarDestination.index(of: nil, in: ordered) == nil)
        // Settings is not a wheel stop at all.
        #expect(SidebarDestination.index(of: .settings, in: ordered) == nil)
    }
}

// Where the surface is allowed to sit. A fixed slot cannot work on a bounded
// list — no single slot avoids a void at both ends — so the surface is clamped
// and the slot migrates. These are the rules that keep the hierarchy on screen.
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
        // Unclamped this was the better part of a screen of empty rail.
        #expect(shift <= SidebarWheelPlacement.overscroll)
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
                    if total > viewport {
                        #expect(shift + total >= viewport - SidebarWheelPlacement.overscroll - 0.001)
                    }
                    // And the open page is always somewhere you can see it.
                    if position >= 0, position <= Double(count - 1) {
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
            #expect(abs(shift) <= SidebarWheelPlacement.overscroll)
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
    }
}
