import Foundation

// MARK: - The wheel's body

// Every physical property of the sidebar wheel lives here: position, velocity,
// detents, overscroll, and the blend in and out of the resting list. There is
// no UIKit, no SwiftUI, and no clock of its own — time is injected — so the
// feel of the gesture is verifiable without a simulator.
//
// The distinction that matters is between the two phases. While a thumb is
// down the finger is the authority: position is assigned, never integrated, so
// there is no lag by construction. On release the engine takes over and
// integrates a spring whose target is where friction would have coasted to.
// Because that spring inherits the release velocity there is no seam between
// the two — it is one continuous curve from the thumb to rest.
//
// Position is measured in items, so 4.5 is exactly between rows four and five.
struct SidebarWheelEngine: Equatable, Sendable {
    struct Tuning: Equatable, Sendable {
        // Exponential decay rate used to project where a fling coasts to.
        // Lower means a longer throw.
        var friction: Double = 4.2
        // The settle spring. Response is its period; damping just under one
        // lets it kiss the detent instead of crawling into it.
        var springResponse: Double = 0.34
        var springDamping: Double = 0.82
        // How far past either end the surface can be pulled, in items.
        var maximumOverscroll: Double = 2
        // Time constant for the blend in and out of the resting list. This is
        // the one thing the user waits on before the wheel is theirs, so it is
        // brisk: visually complete in under a fifth of a second.
        var engagementResponse: Double = 0.06
        // Below both of these the spring is done and the engine sleeps.
        var restVelocity: Double = 0.04
        var restDistance: Double = 0.0015
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
            maximumOverscroll: 0,
            engagementResponse: 0.001
        )
    }

    enum Phase: Equatable, Sendable {
        case idle
        case dragging
        case settling
    }

    private(set) var position: Double = 0
    private(set) var velocity: Double = 0
    private(set) var phase: Phase = .idle
    // The detent nearest the current position — the row that would commit.
    private(set) var detent: Int = 0
    // Where this grab began. Rolling back to it and lifting is the escape
    // hatch: it commits the page you were already on, which is a no-op.
    private(set) var origin: Int = 0
    // 0 while the sidebar rests as a plain list, 1 while the wheel is held.
    private(set) var engagement: Double = 0

    private(set) var count: Int = 0
    var tuning: Tuning = .standard

    private var target: Double = 0
    private var grabbedAt: Double = 0

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

    var isAtOrigin: Bool { detent == origin }

    // MARK: - Structure

    mutating func setCount(_ newCount: Int) {
        count = max(0, newCount)
        guard count > 0 else {
            position = 0
            detent = 0
            origin = 0
            return
        }
        position = min(upperBound, max(lowerBound, position))
        detent = min(count - 1, max(0, detent))
        origin = min(count - 1, max(0, origin))
        target = min(upperBound, max(lowerBound, target))
    }

    // MARK: - Gesture

    // The wheel is always grabbed at a known index — the current page — so the
    // origin is never a surprise and rolling home is always the same distance.
    mutating func grab(at index: Int) {
        guard count > 0 else { return }
        let clamped = min(count - 1, max(0, index))
        position = Double(clamped)
        grabbedAt = position
        origin = clamped
        detent = clamped
        velocity = 0
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

    // Returns the detent the wheel is now headed for, so the caller can commit
    // on lift rather than waiting out the settle.
    @discardableResult
    mutating func release(velocityInItemsPerSecond releaseVelocity: Double) -> Int? {
        guard phase == .dragging else { return nil }
        velocity = releaseVelocity
        target = settleTarget()
        phase = .settling
        guard count > 0 else { return nil }
        return min(count - 1, max(0, Int(target.rounded())))
    }

    // Abandon the gesture by rolling home rather than by snapping — the wheel
    // never teleports.
    mutating func cancel() {
        guard phase != .idle else { return }
        velocity = 0
        target = Double(min(count - 1, max(0, origin)))
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
        stepEngagement(min(dt, tuning.maximumTimeStep))
        guard phase == .settling else { return nil }

        let omega = 2 * Double.pi / max(tuning.springResponse, .ulpOfOne)
        let zeta = tuning.springDamping
        let floorPosition = lowerBound - tuning.maximumOverscroll
        let ceilingPosition = upperBound + tuning.maximumOverscroll

        var remaining = min(dt, tuning.maximumTimeStep)
        var crossed: Int?
        while remaining > 0 {
            let h = min(tuning.integrationStep, remaining)
            remaining -= h
            // Semi-implicit Euler on a damped spring: stable at any frame rate
            // the display link can deliver, given the fixed sub-step above.
            let displacement = position - target
            let acceleration = -omega * omega * displacement - 2 * zeta * omega * velocity
            velocity += acceleration * h
            position = min(ceilingPosition, max(floorPosition, position + velocity * h))
            if let rolled = updateDetent() { crossed = rolled }
        }

        if abs(position - target) < tuning.restDistance, abs(velocity) < tuning.restVelocity {
            position = target
            velocity = 0
            phase = .idle
            if let rolled = updateDetent() { crossed = rolled }
        }
        return crossed
    }

    // MARK: - Internals

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
        if raw < lowerBound {
            return lowerBound - limit * tanh((lowerBound - raw) / limit)
        }
        if raw > upperBound {
            return upperBound + limit * tanh((raw - upperBound) / limit)
        }
        return raw
    }

    // Where the wheel is headed once the thumb lifts: the detent nearest to
    // where friction alone would have brought it to rest.
    private func settleTarget() -> Double {
        guard count > 0 else { return 0 }
        if position < lowerBound { return lowerBound }
        if position > upperBound { return upperBound }
        let projected = position + velocity / max(tuning.friction, .ulpOfOne)
        return min(upperBound, max(lowerBound, projected.rounded()))
    }
}
