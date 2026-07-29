import CoreHaptics
import UIKit

// MARK: - Haptic vocabulary

// One tick per row is not a vocabulary, it is a beep. The point of the wheel is
// that you can eventually find Personal without reading anything, and that only
// works if the ends, the section seams, and home each feel unmistakably unlike
// an ordinary row — in duration as well as strength.
@MainActor
final class SidebarWheelHaptics {
    enum Tick {
        // An ordinary destination rolling past: short, light, frequent.
        case row
        // The seam between sections — primaries to areas, areas to mail.
        case boundary
        // The first or last row: you cannot go further this way.
        case end
        // Back where the grab started. Lifting here changes nothing.
        case home
        // The wheel took the pick.
        case commit

        var intensity: Float {
            switch self {
            case .row: 0.28
            case .boundary: 0.8
            case .end: 1
            case .home: 0.55
            case .commit: 0.85
            }
        }

        var sharpness: Float {
            switch self {
            case .row: 0.45
            case .boundary: 0.85
            case .end: 0.1
            case .home: 0.95
            case .commit: 0.55
            }
        }

        // Zero plays a transient. Anything else plays a continuous event, which
        // is what actually makes a seam or an end-stop feel *longer* rather than
        // merely harder.
        var duration: TimeInterval {
            switch self {
            case .row, .home, .commit: 0
            case .boundary: 0.04
            case .end: 0.11
            }
        }

        // Everything except an ordinary row is worth interrupting the stream
        // for. Without this, the seam tick loses a race it should always win.
        var isPriority: Bool {
            if case .row = self { return false }
            return true
        }

        var minimumInterval: TimeInterval {
            switch self {
            case .row: 0.028
            case .boundary, .home: 0.06
            case .end: 0.12
            case .commit: 0
            }
        }
    }

    private var engine: CHHapticEngine?
    private var lastRow: TimeInterval = 0
    private var lastPriority: TimeInterval = 0
    private var fallback: UISelectionFeedbackGenerator?

    var isEnabled = true

    func prepare() {
        guard isEnabled else { return }
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else {
            installFallback()
            return
        }
        if let engine {
            try? engine.start()
            return
        }
        do {
            let created = try CHHapticEngine()
            created.playsHapticsOnly = true
            // Left to itself the engine stops between gestures, and the first
            // few ticks after the next grab are swallowed while it spins back
            // up — which reads as the seams simply not firing.
            created.isAutoShutdownEnabled = false
            created.resetHandler = { [weak created] in try? created?.start() }
            created.stoppedHandler = { _ in }
            try created.start()
            engine = created
        } catch {
            installFallback()
        }
    }

    func play(_ tick: Tick) {
        guard isEnabled else { return }
        let now = CACurrentMediaTime()
        // Rows and priority ticks are throttled on separate clocks, so a stream
        // of row ticks during a fling can never crowd out a seam or an end.
        if tick.isPriority {
            guard now - lastPriority >= tick.minimumInterval else { return }
            lastPriority = now
        } else {
            guard now - lastRow >= tick.minimumInterval else { return }
            lastRow = now
        }

        guard let engine else {
            fallback?.selectionChanged()
            fallback?.prepare()
            return
        }
        do {
            let event = if tick.duration > 0 {
                CHHapticEvent(
                    eventType: .hapticContinuous,
                    parameters: [
                        CHHapticEventParameter(parameterID: .hapticIntensity, value: tick.intensity),
                        CHHapticEventParameter(parameterID: .hapticSharpness, value: tick.sharpness),
                    ],
                    relativeTime: 0,
                    duration: tick.duration
                )
            } else {
                CHHapticEvent(
                    eventType: .hapticTransient,
                    parameters: [
                        CHHapticEventParameter(parameterID: .hapticIntensity, value: tick.intensity),
                        CHHapticEventParameter(parameterID: .hapticSharpness, value: tick.sharpness),
                    ],
                    relativeTime: 0
                )
            }
            let pattern = try CHHapticPattern(events: [event], parameters: [])
            let player = try engine.makePlayer(with: pattern)
            try player.start(atTime: CHHapticTimeImmediate)
        } catch {
            // A stopped engine throws here; restart it and let the next tick
            // land rather than silently going dead for the rest of the session.
            try? engine.start()
            fallback?.selectionChanged()
        }
    }

    // Called whenever the wheel comes to rest. The engine deliberately stays
    // running — restarting it per gesture is what dropped the first ticks.
    func relax() {}

    func shutdown() {
        engine?.stop()
        engine = nil
        fallback = nil
    }

    private func installFallback() {
        guard fallback == nil else { return }
        let generator = UISelectionFeedbackGenerator()
        generator.prepare()
        fallback = generator
    }
}
