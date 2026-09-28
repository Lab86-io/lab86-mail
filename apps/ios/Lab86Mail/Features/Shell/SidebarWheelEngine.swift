#if os(iOS)
import Foundation

// MARK: - The wheel's body

// Every physical property of the sidebar wheel lives here: position, velocity,
// detents, overscroll, and the blend in and out of the resting list. There is
// no UIKit, no SwiftUI, and no clock of its own — time is injected — so the
// feel of the gesture is verifiable without a simulator.
//
// The wheel is a scroll, not a picker. Moving it riffles the pick through the
// rows, but letting go never chooses anything: a slow release settles on the
// nearest row, a fling coasts and decelerates like a scroll view, and either
// end of the list gives ground on a rubber band and springs back. Only a tap
// on a row navigates, and that happens outside the engine entirely.
//
// While a thumb is down the finger is the authority: position is assigned,
// never integrated, so there is no lag by construction. On release the engine
// takes over. A fling that stays inside the list integrates a spring whose
// target is where friction would have coasted to, and because that spring
// inherits the release velocity there is no seam between the two. A fling
// that would leave the list decays with friction until it reaches the end,
// then hands its remaining speed to a critically damped spring that carries
// it into the band and back, exactly once.
//
// Position is measured in items, so 4.5 is exactly between rows four and five.
struct SidebarWheelEngine: Equatable, Sendable {
    struct Tuning: Equatable, Sendable {
        // Exponential decay rate of a fling, per second. Lower means a longer
        // throw.
        var friction: Double = 4.2
        // The settle spring inside the list. Response is its period; damping
        // just under one lets it kiss the detent instead of crawling into it.
        var springResponse: Double = 0.34
        var springDamping: Double = 0.82
        // The spring at either end — the turn of a fling that ran out of list,
        // and the pull home of a surface dragged past an end. Critically damped
        // like a scroll view's bounce: out once, back once, no wobble.
        var bounceResponse: Double = 0.4
        // How far past either end the surface can be pulled, in items.
        var maximumOverscroll: Double = 2
        // How hard the band resists. Past an end the surface takes this share
        // of the thumb's travel at first, and less the further it goes.
        var overscrollResistance: Double = 0.45
        // Time constant for the blend in and out of the resting list. This is
        // the one thing the user waits on before the wheel is theirs, so it is
        // brisk: visually complete in under a fifth of a second.
        var engagementResponse: Double = 0.06
        // Below both of these the spring is done and the engine sleeps.
        var restVelocity: Double = 0.04
        var restDistance: Double = 0.0015
        // Items per second. A tap on a wheel moving faster than this catches
        // it, as a tap stops a scroll view, instead of opening a row that is
        // sliding past under the finger. Well above the speed of a snap onto
        // the nearest row, so a tap just after a slow release still selects.
        var catchVelocity: Double = 4
        // The longest frame the integrator will accept in one go, and the
        // fixed sub-step it takes, so a dropped frame or a debugger pause
        // cannot make the spring explode.
        var maximumTimeStep: Double = 1.0 / 30
        var integrationStep: Double = 1.0 / 240

        static let standard = Tuning()

        // Reduce Motion keeps the wheel and its detents but removes the
        // physicality: no coasting past where you let go, no bounce at the
        // ends, and no blend into the resting list.
        static let reduced = Tuning(
            friction: 1_000,
            springResponse: 0.12,
            springDamping: 1,
            bounceResponse: 0.12,
            maximumOverscroll: 0,
            engagementResponse: 0.001
        )
    }

    enum Phase: Equatable, Sendable {
        case idle
        case dragging
        // A fling on its way to an end of the list, decaying with friction.
        case coasting
        // A spring on its way to rest: onto a row, or back from the band.
        case settling
    }

    private(set) var position: Double = 0
    private(set) var velocity: Double = 0
    private(set) var phase: Phase = .idle
    // The detent nearest the current position — the row the pick is on.
    private(set) var detent: Int = 0
    // Where this grab began. Cancelling rolls back to it.
    private(set) var origin: Int = 0
    // 0 while the sidebar rests as a plain list, 1 while the wheel is held.
    private(set) var engagement: Double = 0

    private(set) var count: Int = 0
    var tuning: Tuning = .standard

    private var target: Double = 0
    private var grabbedAt: Double = 0
    // True while the settle uses the bounce spring rather than the detent one.
    private var bouncing = false

    var lowerBound: Double { 0 }
    var upperBound: Double { Double(max(0, count - 1)) }

    var isOverscrolled: Bool {
        position < lowerBound - 1e-9 || position > upperBound + 1e-9
    }

    // True while anything at all is moving, including the blend back to the
    // resting list after the wheel has stopped. The display link runs exactly
    // as long as this is true.
    var isRunning: Bool {
        phase != .idle || engagement > 0.001
    }

    // True while the wheel is visibly travelling on its own, so a tap should
    // stop it rather than open a row.
    var isCatchable: Bool {
        switch phase {
        case .coasting: true
        case .settling: abs(velocity) > tuning.catchVelocity
        case .idle, .dragging: false
        }
    }

    var isAtOrigin: Bool { detent == origin }

    // MARK: - Structure

    mutating func setCount(_ newCount: Int) {
        count = max(0, newCount)
        guard count > 0 else {
            position = 0
            velocity = 0
            target = 0
            detent = 0
            origin = 0
            bouncing = false
            // Nothing is left to move. A thumb that is still down keeps its
            // grab; it simply has nothing to turn.
            if phase != .dragging { phase = .idle }
            return
        }
        let previous = position
        position = min(upperBound, max(lowerBound, position))
        // Keep the thumb's reference in step, so the next drag frame does not
        // throw the wheel back past the end that just moved.
        grabbedAt += position - previous
        detent = min(count - 1, max(0, detent))
        origin = min(count - 1, max(0, origin))
        if phase == .coasting {
            // The end the fling was heading for may have moved. If the list
            // shrank past the wheel, the next step turns it round.
            target = velocity < 0 ? lowerBound : upperBound
        } else {
            target = min(upperBound, max(lowerBound, target))
        }
        updateDetent()
    }

    // MARK: - Gesture

    // A wheel at rest is grabbed at a known row, chosen by the caller — the
    // row the last scroll stopped on, or the current page — so the pick opens
    // on a row that is already on screen.
    mutating func grab(at index: Int) {
        guard count > 0 else { return }
        let clamped = min(count - 1, max(0, index))
        position = Double(clamped)
        grabbedAt = position
        origin = clamped
        detent = clamped
        velocity = 0
        bouncing = false
        phase = .dragging
    }

    // A wheel that is still moving is taken where it is, as a thumb stops a
    // scroll view: no jump to a row, even from inside the band.
    mutating func grabInPlace() {
        guard count > 0 else { return }
        let limit = tuning.maximumOverscroll
        position = min(upperBound + limit, max(lowerBound - limit, position))
        grabbedAt = unbanded(position)
        velocity = 0
        bouncing = false
        origin = min(count - 1, max(0, Int(position.rounded())))
        updateDetent()
        phase = .dragging
    }

    // Delta is in items and signed like the wheel, not like the thumb: the
    // caller converts points and applies the inversion. Returns the detent
    // rolled into, if that changed.
    @discardableResult
    mutating func drag(byItems delta: Double) -> Int? {
        guard phase == .dragging, count > 0 else { return nil }
        position = banded(grabbedAt + delta)
        return updateDetent()
    }

    // Lets go. Returns the row the wheel will come to rest on, which is where
    // the pick ends up — never a selection.
    @discardableResult
    mutating func release(velocityInItemsPerSecond releaseVelocity: Double) -> Int? {
        guard phase == .dragging else { return nil }
        guard count > 0 else {
            velocity = 0
            phase = .idle
            return nil
        }
        velocity = releaseVelocity
        if position < lowerBound || position > upperBound {
            // Let go inside the band: it pulls the surface home.
            let bound = position < lowerBound ? lowerBound : upperBound
            startBounce(toward: bound)
            return Int(bound)
        }
        let projected = position + velocity / max(tuning.friction, .ulpOfOne)
        let landing = projected.rounded()
        if landing < lowerBound || landing > upperBound {
            // The fling would run off the list. Coast to the end on friction
            // alone, and let the bounce take whatever speed is left there.
            target = landing < lowerBound ? lowerBound : upperBound
            bouncing = false
            phase = .coasting
            return Int(target)
        }
        target = landing
        bouncing = false
        phase = .settling
        return Int(landing)
    }

    // Abandon the gesture by rolling home rather than by snapping — the wheel
    // never teleports.
    mutating func cancel() {
        guard phase != .idle, count > 0 else { return }
        velocity = 0
        target = Double(min(count - 1, max(0, origin)))
        bouncing = false
        phase = .settling
    }

    // Stops a wheel that is travelling on its own, on the row it is passing,
    // or back at the end if it is out in the band.
    mutating func halt() {
        guard phase == .coasting || phase == .settling, count > 0 else { return }
        velocity = 0
        if position < lowerBound || position > upperBound {
            startBounce(toward: position < lowerBound ? lowerBound : upperBound)
            return
        }
        target = min(upperBound, max(lowerBound, position.rounded()))
        bouncing = false
        phase = .settling
    }

    // MARK: - Integration

    // Advances the simulation and returns the detent rolled into during this
    // frame, if any. One tick per frame at most: a fling can pass several
    // detents in a single step and the Taptic Engine cannot keep up with that
    // anyway.
    @discardableResult
    mutating func step(dt: Double) -> Int? {
        guard dt > 0 else { return nil }
        let frame = min(dt, tuning.maximumTimeStep)
        stepEngagement(frame)
        guard phase == .coasting || phase == .settling else { return nil }

        let floorPosition = lowerBound - tuning.maximumOverscroll
        let ceilingPosition = upperBound + tuning.maximumOverscroll

        var remaining = frame
        var crossed: Int?
        while remaining > 0 {
            let h = min(tuning.integrationStep, remaining)
            remaining -= h
            if phase == .coasting {
                // The part of the sub-step after the fling reaches the end
                // belongs to the bounce.
                let leftover = coast(h)
                if leftover > 0, phase == .settling { spring(leftover) }
            } else {
                spring(h)
            }
            position = min(ceilingPosition, max(floorPosition, position))
            if let rolled = updateDetent() { crossed = rolled }
        }

        if phase == .settling, abs(position - target) < tuning.restDistance,
           abs(velocity) < tuning.restVelocity {
            position = target
            velocity = 0
            bouncing = false
            phase = .idle
            if let rolled = updateDetent() { crossed = rolled }
        }
        return crossed
    }

    // MARK: - Internals

    // Exact exponential decay rather than an Euler step, so the coast ends
    // precisely where `release` projected it would. It stops at the end of the
    // list on the exact instant it arrives, and returns the unused part of the
    // sub-step for the bounce to spend.
    private mutating func coast(_ h: Double) -> Double {
        let friction = max(tuning.friction, .ulpOfOne)
        let distance = target - position
        guard velocity != 0 else {
            settleInPlace()
            return 0
        }
        guard distance * velocity > 0 else {
            // Already at or past the end it was heading for.
            startBounce(toward: target)
            return h
        }
        // The share of the remaining throw needed to reach the end. At one or
        // more the fling dies before it gets there.
        let reach = friction * distance / velocity
        if reach < 1 {
            let arrival = -log(1 - reach) / friction
            if arrival <= h {
                position = target
                velocity *= exp(-friction * arrival)
                startBounce(toward: target)
                return h - arrival
            }
        }
        let decay = exp(-friction * h)
        position += velocity * (1 - decay) / friction
        velocity *= decay
        if abs(velocity) < tuning.restVelocity { settleInPlace() }
        return 0
    }

    // Only reachable if the tuning changed mid-fling (Reduce Motion switched
    // on): settle on the nearest row rather than creep toward the end forever.
    private mutating func settleInPlace() {
        target = min(upperBound, max(lowerBound, position.rounded()))
        bouncing = false
        phase = .settling
    }

    // Semi-implicit Euler on a damped spring: stable at any frame rate the
    // display link can deliver, given the fixed sub-step.
    private mutating func spring(_ h: Double) {
        let response = bouncing ? tuning.bounceResponse : tuning.springResponse
        let zeta = bouncing ? 1 : tuning.springDamping
        let omega = 2 * Double.pi / max(response, .ulpOfOne)
        let displacement = position - target
        let acceleration = -omega * omega * displacement - 2 * zeta * omega * velocity
        velocity += acceleration * h
        position += velocity * h
    }

    // Hands the wheel to the bounce spring at an end. Speed carrying it out
    // into the band is capped so the spring turns it round before it meets the
    // band's hard limit; speed carrying it back is capped so it comes home
    // without shooting past the end into the list.
    private mutating func startBounce(toward bound: Double) {
        target = bound
        bouncing = true
        phase = .settling
        let limit = tuning.maximumOverscroll
        guard limit > 0 else {
            velocity = 0
            return
        }
        let omega = 2 * Double.pi / max(tuning.bounceResponse, .ulpOfOne)
        let displacement = position - bound
        let outward: Double = bound <= lowerBound ? -1 : 1
        let speedOut = velocity * outward
        if speedOut > 0 {
            // A critically damped spring leaving its rest point at speed v
            // peaks at v / (omega * e). From inside the band the headroom is
            // smaller, and v / omega bounds the peak from above.
            let depth = displacement * outward
            let cap = depth <= 1e-9
                ? 0.8 * limit * omega * exp(1)
                : max(0, 0.95 * limit - depth) * omega
            velocity = outward * min(speedOut, cap)
        } else {
            // At no more than omega times the distance, a critically damped
            // spring reaches its target without crossing it.
            let cap = abs(displacement) * omega
            velocity = outward * max(speedOut, -cap)
        }
    }

    private mutating func stepEngagement(_ dt: Double) {
        let goal: Double = phase == .idle ? 0 : 1
        let rate = 1 - exp(-dt / max(tuning.engagementResponse, .ulpOfOne))
        engagement += (goal - engagement) * rate
        if abs(goal - engagement) < 0.001 { engagement = goal }
    }

    @discardableResult
    private mutating func updateDetent() -> Int? {
        guard count > 0 else { return nil }
        let next = min(count - 1, max(0, Int(position.rounded())))
        guard next != detent else { return nil }
        detent = next
        return next
    }

    // Past either end the surface keeps moving with the thumb but gives up
    // ground on a curve, so it comes to a stop rather than hitting a wall.
    private func banded(_ raw: Double) -> Double {
        let limit = tuning.maximumOverscroll
        guard limit > 0 else { return min(upperBound, max(lowerBound, raw)) }
        let resistance = max(tuning.overscrollResistance, .ulpOfOne)
        if raw < lowerBound {
            return lowerBound - limit * tanh(resistance * (lowerBound - raw) / limit)
        }
        if raw > upperBound {
            return upperBound + limit * tanh(resistance * (raw - upperBound) / limit)
        }
        return raw
    }

    // The thumb position that `banded` maps onto `position`, so a grab taken
    // inside the band continues from exactly where the surface is.
    private func unbanded(_ banded: Double) -> Double {
        let limit = tuning.maximumOverscroll
        guard limit > 0 else { return banded }
        let resistance = max(tuning.overscrollResistance, .ulpOfOne)
        if banded < lowerBound {
            let ratio = min(0.999_999, (lowerBound - banded) / limit)
            return lowerBound - limit * atanh(ratio) / resistance
        }
        if banded > upperBound {
            let ratio = min(0.999_999, (banded - upperBound) / limit)
            return upperBound + limit * atanh(ratio) / resistance
        }
        return banded
    }
}
#endif
