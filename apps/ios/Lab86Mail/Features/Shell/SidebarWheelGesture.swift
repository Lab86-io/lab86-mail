#if os(iOS)
import SwiftUI
import UIKit

// MARK: - Recognizer

// A real gesture recognizer rather than a SwiftUI `DragGesture`, for two
// reasons that are structural rather than cosmetic.
//
// It stays `.possible` until the thumb has actually moved vertically, so a tap
// is delivered to the row's own Button — which means rows stay real buttons
// with real VoiceOver activation instead of having taps synthesised out of the
// drag. And it fails outright on a dominant horizontal movement, which hands
// the touch to the sidebar's reveal/dismiss pan through the normal arbitration
// instead of a hand-written heuristic.
final class SidebarWheelRecognizer: UIGestureRecognizer {
    // Vertical travel that turns a touch into a wheel grab.
    var activationDistance: CGFloat = 8
    // How much more horizontal than vertical a movement must be to be somebody
    // else's gesture.
    var horizontalFailRatio: CGFloat = 1.4
    // Touches starting outside this rectangle, in window coordinates, are not
    // ours. Published by the sidebar as it lays out.
    var activeRect: CGRect = .zero

    private(set) var startLocation: CGPoint = .zero
    private(set) var translation: CGPoint = .zero
    // Points per second, smoothed across samples so a single jittery frame at
    // the moment of lift cannot throw the wheel across the list.
    private(set) var velocity: CGPoint = .zero

    // Exactly one touch drives the wheel. A second finger arriving mid-drag
    // used to re-enter the begin path and reset the origin while the model
    // still held the travel already spent, which made the wheel jump by that
    // amount; and reading `touches.first` rather than the tracked touch let a
    // stray finger steer it.
    private var trackedTouch: UITouch?
    private var startPoint: CGPoint = .zero
    private var lastPoint: CGPoint = .zero
    private var lastTimestamp: TimeInterval = 0

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        guard trackedTouch == nil else {
            for touch in touches { ignore(touch, for: event) }
            return
        }
        guard let touch = touches.first else {
            state = .failed
            return
        }
        let point = touch.location(in: nil)
        guard activeRect.contains(point) else {
            state = .failed
            return
        }
        trackedTouch = touch
        for extra in touches where extra !== touch { ignore(extra, for: event) }
        startPoint = point
        startLocation = point
        lastPoint = point
        lastTimestamp = event.timestamp
        translation = .zero
        velocity = .zero
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesMoved(touches, with: event)
        guard state != .failed, let touch = trackedTouch, touches.contains(touch) else { return }
        let point = touch.location(in: nil)
        translation = CGPoint(x: point.x - startPoint.x, y: point.y - startPoint.y)

        let dt = event.timestamp - lastTimestamp
        if dt > 0 {
            let instant = CGPoint(x: (point.x - lastPoint.x) / dt, y: (point.y - lastPoint.y) / dt)
            let smoothing: CGFloat = 0.35
            velocity = CGPoint(
                x: velocity.x * (1 - smoothing) + instant.x * smoothing,
                y: velocity.y * (1 - smoothing) + instant.y * smoothing
            )
        }
        lastPoint = point
        lastTimestamp = event.timestamp

        switch state {
        case .possible:
            let vertical = abs(translation.y)
            let horizontal = abs(translation.x)
            if vertical >= activationDistance, vertical > horizontal {
                state = .began
            } else if horizontal >= activationDistance, horizontal > vertical * horizontalFailRatio {
                state = .failed
            }
        case .began, .changed:
            state = .changed
        default:
            break
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesEnded(touches, with: event)
        guard let touch = trackedTouch, touches.contains(touch) else { return }
        // `touchesMoved` stops arriving the moment the thumb stops, so the
        // smoothed velocity keeps whatever it held when motion last ended.
        // Lifting after a deliberate pause would then fling the wheel off the
        // row you had settled on. Decay it by how long ago you actually moved.
        let idle = event.timestamp - lastTimestamp
        if idle > 0 {
            let decay = CGFloat(exp(-idle / 0.05))
            velocity = CGPoint(x: velocity.x * decay, y: velocity.y * decay)
        }
        state = (state == .began || state == .changed) ? .ended : .failed
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesCancelled(touches, with: event)
        guard let touch = trackedTouch, touches.contains(touch) else { return }
        state = .cancelled
    }

    override func reset() {
        super.reset()
        trackedTouch = nil
        translation = .zero
        velocity = .zero
        startLocation = .zero
        startPoint = .zero
        lastPoint = .zero
        lastTimestamp = 0
    }
}

// MARK: - Clock

// A display link, not an animation. A value sampled at the display's own rate
// is smooth because of when it is sampled, not because of how it is eased —
// and on a 120Hz phone that difference is most of the feel.
@MainActor
final class SidebarWheelClock {
    private var link: CADisplayLink?
    private var lastTimestamp: CFTimeInterval = 0
    private var onFrame: ((Double) -> Void)?

    init(onFrame: @escaping (Double) -> Void) {
        self.onFrame = onFrame
    }

    var isRunning: Bool { link != nil }

    func start() {
        guard link == nil else { return }
        let proxy = Proxy(self)
        let created = CADisplayLink(target: proxy, selector: #selector(Proxy.tick(_:)))
        created.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
        created.add(to: .main, forMode: .common)
        lastTimestamp = CACurrentMediaTime()
        link = created
    }

    func stop() {
        link?.invalidate()
        link = nil
    }

    fileprivate func frame(_ link: CADisplayLink) {
        let now = link.timestamp
        let dt = lastTimestamp > 0 ? now - lastTimestamp : link.duration
        lastTimestamp = now
        onFrame?(max(0, dt))
    }

    // CADisplayLink retains its target, so the link cannot hold the clock
    // directly without a cycle.
    @MainActor
    private final class Proxy: NSObject {
        weak var clock: SidebarWheelClock?
        init(_ clock: SidebarWheelClock) { self.clock = clock }
        @objc func tick(_ link: CADisplayLink) { clock?.frame(link) }
    }
}

// MARK: - Attachment

// Installs the recognizer on the window and filters by rectangle, rather than
// hunting for an ancestor view. The window always exists and always spans the
// screen, so there is nothing to get wrong at layout time; the rectangle test
// in `touchesBegan` is what scopes it to the sidebar.
struct SidebarWheelGestureAttachment: UIViewRepresentable {
    let isEnabled: Bool
    let activeRect: CGRect
    let onChange: (CGPoint, CGPoint, CGPoint) -> Void
    let onEnd: (CGPoint, Bool) -> Void

    func makeUIView(context: Context) -> UIView {
        let view = AttachmentView()
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        view.coordinator = context.coordinator
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.onChange = onChange
        context.coordinator.onEnd = onEnd
        context.coordinator.recognizer.activeRect = activeRect
        context.coordinator.recognizer.isEnabled = isEnabled
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        let recognizer = SidebarWheelRecognizer()
        var onChange: ((CGPoint, CGPoint, CGPoint) -> Void)?
        var onEnd: ((CGPoint, Bool) -> Void)?

        override init() {
            super.init()
            recognizer.addTarget(self, action: #selector(handle(_:)))
            recognizer.delegate = self
            // Once the wheel claims the touch, the row's button press is
            // cancelled — the same handoff a scroll view performs.
            recognizer.cancelsTouchesInView = true
            recognizer.delaysTouchesBegan = false
            recognizer.delaysTouchesEnded = false
        }

        @objc func handle(_ recognizer: UIGestureRecognizer) {
            guard let wheel = recognizer as? SidebarWheelRecognizer else { return }
            switch wheel.state {
            case .began, .changed:
                onChange?(wheel.startLocation, wheel.translation, wheel.velocity)
            case .ended:
                onEnd?(wheel.velocity, true)
            case .cancelled, .failed:
                onEnd?(.zero, false)
            default:
                break
            }
        }

        // Must stay true, and the reason is worth recording because refusing it
        // looks like the obvious fix for a double-commit and is not.
        //
        // Prevention runs both ways. SwiftUI's own recogniser lives on a
        // descendant view and can reach a recognised state before this one has
        // seen its 8pt of vertical travel; refusing simultaneity therefore lets
        // *it* prevent *us*, and the wheel stops engaging at all.
        //
        // The row's Button firing on the same touch is a real problem, but it
        // is solved where we have actual control — the model's tap suppression
        // flag, which is set from the moment the wheel claims a touch until a
        // run-loop turn after it lets go, whichever order the two actions
        // happen to fire in.
        nonisolated func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool {
            true
        }
    }

    @MainActor
    private final class AttachmentView: UIView {
        var coordinator: Coordinator?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard let coordinator else { return }
            if let window {
                if coordinator.recognizer.view !== window {
                    coordinator.recognizer.view?.removeGestureRecognizer(coordinator.recognizer)
                    window.addGestureRecognizer(coordinator.recognizer)
                }
            } else {
                coordinator.recognizer.view?.removeGestureRecognizer(coordinator.recognizer)
            }
        }
    }
}
#endif
