#if os(iOS)
import Foundation
import Testing
@testable import Lab86Mail

// The sidebar riffle is a scroll. These play whole gestures through the real
// model — the same calls the gesture recognizer and the rows make — with the
// display link swapped for a hand-driven clock, and hold it to the contract:
// the riffle moves the pick and the list, letting go never navigates, either
// end bounces back, and only a tap on a row selects. There is no swipe that
// selects; a sideways swipe belongs to the sidebar's own reveal and dismiss.
@MainActor
struct SidebarWheelScrollTests {
    @MainActor
    private final class Recorder {
        var commits: [SidebarDestination] = []
    }

    private static let rowCount = 14
    private static let viewport: CGFloat = 500
    // Rows 50pt apart: 694pt of hierarchy in a 500pt viewport, so the list
    // really scrolls, by at most 194pt.
    private static let centers: [CGFloat] = (0..<rowCount).map { 22 + 50 * CGFloat($0) }
    private static let total: CGFloat = centers[rowCount - 1] + 22
    private static let bottomOffset: CGFloat = viewport - total

    private func makeModel(current: Int, recorder: Recorder) -> SidebarWheelModel {
        let model = SidebarWheelModel()
        model.drivesDisplayClock = false
        model.destinations = (0..<Self.rowCount).map { .area(id: "area_\($0)", name: "Area \($0)") }
        model.viewportHeight = Self.viewport
        model.activeRect = CGRect(x: 0, y: 100, width: 300, height: Self.viewport)
        model.setMeasurement(centers: Self.centers, total: Self.total)
        model.currentIndex = { current }
        model.onCommit = { recorder.commits.append($0) }
        return model
    }

    // Thumb travel in points, positive downward like UIKit. Moving the thumb
    // up turns the wheel down the list.
    private func drag(_ model: SidebarWheelModel, by points: CGFloat, steps: Int = 12) {
        let start = CGPoint(x: 120, y: 360)
        for step in 1...steps {
            let travel = points * CGFloat(step) / CGFloat(steps)
            model.handleChange(start: start, translation: CGPoint(x: 0, y: travel), velocity: .zero)
        }
    }

    private func tick(_ model: SidebarWheelModel, _ count: Int) {
        for _ in 0..<count { model.advance(by: 1.0 / 120) }
    }

    // Runs the wheel to rest, returning the frames taken.
    @discardableResult
    private func runToRest(
        _ model: SidebarWheelModel,
        limit: Int = 2_400,
        observe: (SidebarWheelModel) -> Void = { _ in }
    ) -> Int {
        var count = 0
        while model.isMoving, count < limit {
            model.advance(by: 1.0 / 120)
            observe(model)
            count += 1
        }
        return count
    }

    // MARK: - Letting go never selects

    @Test
    func releasingARiffleNeverSelects() {
        let recorder = Recorder()
        let model = makeModel(current: 3, recorder: recorder)
        drag(model, by: -120)
        #expect(model.isGrabbed)
        let picked = model.detent
        // The riffle really moved the pick.
        #expect(picked > 3)
        model.handleEnd(velocity: .zero, completed: true)
        runToRest(model)
        #expect(recorder.commits.isEmpty)
        #expect(!model.isGrabbed)
        #expect(model.phase == .idle)
        // It rests on the row the pick was on; the page is unchanged.
        #expect(model.detent == picked)
    }

    @Test
    func aFlingCoastsAndNeverSelects() {
        let recorder = Recorder()
        let model = makeModel(current: 3, recorder: recorder)
        drag(model, by: -30)
        let released = model.detent
        model.handleEnd(velocity: CGPoint(x: 0, y: -1_500), completed: true)
        #expect(model.phase == .coasting)
        let frames = runToRest(model)
        #expect(frames < 2_400)
        #expect(recorder.commits.isEmpty)
        // It coasted well past where the thumb let go, to the end of the list.
        #expect(model.detent > released + 2)
        #expect(model.detent == Self.rowCount - 1)
        #expect(model.position == model.position.rounded())
    }

    @Test
    func aCancelledRiffleRollsBackAndSelectsNothing() {
        let recorder = Recorder()
        let model = makeModel(current: 3, recorder: recorder)
        drag(model, by: -120)
        model.handleEnd(velocity: .zero, completed: false)
        runToRest(model)
        #expect(recorder.commits.isEmpty)
        #expect(model.detent == 3)
    }

    // MARK: - Rubber band at either end

    @Test
    func pullingPastTheTopBandsAndSpringsBackIntoRange() {
        let recorder = Recorder()
        let model = makeModel(current: 0, recorder: recorder)
        drag(model, by: 160)
        tick(model, 30)
        #expect(model.position < 0)
        // The surface follows into the band: empty rail shows above the top.
        #expect(model.surfaceOffset > 0)
        #expect(model.surfaceOffset <= SidebarWheelPlacement.overscroll)
        model.handleEnd(velocity: .zero, completed: true)
        runToRest(model) { state in
            #expect(state.position > -2.01)
        }
        #expect(model.position == 0)
        #expect(model.surfaceOffset == 0)
        #expect(model.restOffset == 0)
        #expect(recorder.commits.isEmpty)
    }

    @Test
    func pullingPastTheBottomBandsAndSpringsBackIntoRange() {
        let recorder = Recorder()
        let model = makeModel(current: Self.rowCount - 1, recorder: recorder)
        drag(model, by: -160)
        tick(model, 30)
        #expect(model.position > Double(Self.rowCount - 1))
        #expect(model.surfaceOffset < Self.bottomOffset)
        #expect(model.surfaceOffset >= Self.bottomOffset - SidebarWheelPlacement.overscroll)
        model.handleEnd(velocity: .zero, completed: true)
        runToRest(model)
        #expect(model.position == Double(Self.rowCount - 1))
        // Back in range, and the list stays scrolled to its bottom.
        #expect(model.restOffset == Self.bottomOffset)
        #expect(model.surfaceOffset == Self.bottomOffset)
        #expect(recorder.commits.isEmpty)
    }

    @Test
    func aFlingIntoAnEndOverscrollsThenComesBack() {
        let recorder = Recorder()
        let model = makeModel(current: 4, recorder: recorder)
        drag(model, by: -20)
        model.handleEnd(velocity: CGPoint(x: 0, y: -2_500), completed: true)
        var deepest = -Double.infinity
        var lowestSurface = CGFloat.infinity
        runToRest(model) { state in
            deepest = max(deepest, state.position)
            lowestSurface = min(lowestSurface, state.surfaceOffset)
        }
        let last = Double(Self.rowCount - 1)
        #expect(deepest > last)
        #expect(lowestSurface < Self.bottomOffset)
        #expect(model.position == last)
        #expect(model.surfaceOffset == Self.bottomOffset)
        #expect(recorder.commits.isEmpty)
    }

    // MARK: - The list stays where the scroll left it

    @Test
    func theNextGrabStartsWhereTheLastScrollRestedWithoutAJump() {
        let recorder = Recorder()
        let model = makeModel(current: 0, recorder: recorder)
        drag(model, by: -40)
        model.handleEnd(velocity: CGPoint(x: 0, y: -2_000), completed: true)
        runToRest(model)
        let rested = model.detent
        let surface = model.surfaceOffset
        #expect(surface == Self.bottomOffset)
        // A new touch picks the wheel up on the row it stopped on, not back on
        // the open page at the top, and the list does not move to meet it.
        model.handleChange(start: CGPoint(x: 120, y: 300), translation: CGPoint(x: 0, y: -9), velocity: .zero)
        #expect(model.detent == rested)
        tick(model, 30)
        #expect(abs(model.surfaceOffset - surface) < 0.5)
        model.handleEnd(velocity: .zero, completed: true)
        runToRest(model)
        #expect(recorder.commits.isEmpty)
    }

    @Test
    func grabbingAMovingWheelTakesItWhereItIs() {
        let recorder = Recorder()
        let model = makeModel(current: 2, recorder: recorder)
        drag(model, by: -20)
        model.handleEnd(velocity: CGPoint(x: 0, y: -1_200), completed: true)
        tick(model, 5)
        #expect(model.isMoving)
        let moving = model.position
        model.handleChange(start: CGPoint(x: 120, y: 300), translation: CGPoint(x: 0, y: -9), velocity: .zero)
        #expect(model.isGrabbed)
        #expect(abs(model.position - moving) < 1e-9)
        model.handleEnd(velocity: .zero, completed: true)
        runToRest(model)
        #expect(recorder.commits.isEmpty)
    }

    // MARK: - Only a tap selects

    @Test
    func aTapOnARowSelectsIt() {
        // VoiceOver activates the row's button through this same action.
        let recorder = Recorder()
        let model = makeModel(current: 3, recorder: recorder)
        let target = SidebarDestination.area(id: "area_7", name: "Area 7")
        model.activate(target)
        #expect(recorder.commits == [target])
    }

    @Test
    func aTapRightAfterAScrollSelects() {
        let recorder = Recorder()
        let model = makeModel(current: 3, recorder: recorder)
        drag(model, by: -120)
        model.handleEnd(velocity: CGPoint(x: 0, y: -400), completed: true)
        runToRest(model)
        // No stuck grab, no stuck tap guard.
        #expect(!model.isGrabbed)
        #expect(!model.suppressesRowTaps)
        #expect(model.acceptsRowTap())
        let target = SidebarDestination.area(id: "area_2", name: "Area 2")
        model.activate(target)
        #expect(recorder.commits == [target])
    }

    @Test
    func aTapDuringTheLastOfASettleStillSelects() {
        let recorder = Recorder()
        let model = makeModel(current: 3, recorder: recorder)
        drag(model, by: -60)
        model.handleEnd(velocity: .zero, completed: true)
        // One frame on: the list is only easing onto a row.
        tick(model, 1)
        let target = SidebarDestination.area(id: "area_1", name: "Area 1")
        model.activate(target)
        #expect(recorder.commits == [target])
    }

    @Test
    func theTouchThatEndsARiffleCannotAlsoSelect() {
        let recorder = Recorder()
        let model = makeModel(current: 3, recorder: recorder)
        drag(model, by: -120)
        let target = SidebarDestination.area(id: "area_9", name: "Area 9")
        // Held: a row's button that survived arbitration does nothing.
        model.activate(target)
        model.handleEnd(velocity: .zero, completed: true)
        // Same touch, just released: still nothing.
        model.activate(target)
        #expect(recorder.commits.isEmpty)
        runToRest(model)
        model.activate(target)
        #expect(recorder.commits == [target])
    }

    @Test
    func aTapOnACoastingListCatchesItAndSelectsNothing() {
        let recorder = Recorder()
        let model = makeModel(current: 3, recorder: recorder)
        drag(model, by: -20)
        model.handleEnd(velocity: CGPoint(x: 0, y: -1_500), completed: true)
        tick(model, 3)
        #expect(model.phase == .coasting)
        let target = SidebarDestination.area(id: "area_12", name: "Area 12")
        model.activate(target)
        #expect(recorder.commits.isEmpty)
        let frames = runToRest(model)
        // It stopped where it was caught instead of coasting on to the end.
        #expect(frames < 240)
        #expect(model.detent < Self.rowCount - 1)
        // The next tap goes through.
        model.activate(target)
        #expect(recorder.commits == [target])
    }

    // MARK: - Robustness

    @Test
    func theRowsCanChangeUnderAFlingSafely() {
        let recorder = Recorder()
        let model = makeModel(current: 3, recorder: recorder)
        drag(model, by: -20)
        model.handleEnd(velocity: CGPoint(x: 0, y: -1_500), completed: true)
        tick(model, 3)
        // Areas load asynchronously: the list shrinks under the moving wheel.
        model.destinations = Array(model.destinations.prefix(5))
        model.setMeasurement(centers: Array(Self.centers.prefix(5)), total: Self.centers[4] + 22)
        let frames = runToRest(model)
        #expect(frames < 2_400)
        #expect(!model.isMoving)
        #expect(model.position >= 0 && model.position <= 4)
        #expect(model.detent <= 4)
        #expect(model.pickedDestination != nil)
        // The shorter list fits, so it rests exactly where it stacks.
        #expect(model.surfaceOffset == 0)
        #expect(recorder.commits.isEmpty)
        let target = SidebarDestination.area(id: "area_4", name: "Area 4")
        model.activate(target)
        #expect(recorder.commits == [target])
    }

    @Test
    func reduceMotionScrollsWithoutCoastingOrBouncing() {
        let recorder = Recorder()
        let model = makeModel(current: 0, recorder: recorder)
        model.reduceMotion = true
        #expect(model.tuning == .reduced)
        drag(model, by: 160)
        // No band at the top.
        #expect(model.position == 0)
        model.handleEnd(velocity: .zero, completed: true)
        runToRest(model)
        drag(model, by: -100)
        let released = model.detent
        model.handleEnd(velocity: CGPoint(x: 0, y: -3_000), completed: true)
        runToRest(model) { state in
            #expect(state.position >= 0 && state.position <= Double(Self.rowCount - 1))
        }
        // No coast past where it was let go.
        #expect(abs(model.detent - released) <= 1)
        #expect(recorder.commits.isEmpty)
        model.reduceMotion = false
        #expect(model.tuning == .standard)
    }
}
#endif
