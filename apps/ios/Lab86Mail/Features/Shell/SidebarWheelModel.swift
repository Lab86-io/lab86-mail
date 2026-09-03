#if os(iOS)
import SwiftUI

enum SidebarWheelSpace {
    static let name = "sidebarWheel"
    // Nominal distance between rows, used only to shape the fan's falloff.
    // Rows have genuinely different heights; the layout interpolates between
    // their real centres, and this is just the curve's horizontal scale.
    static let pitch: CGFloat = 48
}

// MARK: - Model

// Owns the engine, the clock, and the haptics, and mirrors the engine's outputs
// into separately observed properties.
//
// That mirroring is deliberate rather than redundant. Observation tracks whole
// stored properties, so if a view read `engine.engagement` it would register a
// dependency on `engine` — which changes every single frame — and every row
// would rebuild at 120Hz. Splitting the outputs means the layout container
// depends on `position`, rows depend only on `engagement`, and the bloom
// depends only on `detent`.
@MainActor
@Observable
final class SidebarWheelModel {
    // Read by the layout container, and by nothing else.
    private(set) var position: Double = 0
    // Read by every row's visual effect; constant at 1 through a whole drag,
    // so it costs nothing while the wheel is actually turning.
    private(set) var engagement: Double = 0
    // Read by the picked row's bloom.
    private(set) var detent: Int = 0
    private(set) var slotY: CGFloat = 0
    // Where the picked row actually ended up once the clamp has had its say.
    // The fan opens here, not at the slot — near either end of the hierarchy
    // the surface stops moving and the pick walks the rows already on screen.
    private(set) var focusY: CGFloat = 0
    private(set) var isGrabbed = false
    var viewportHeight: CGFloat = 0

    var destinations: [SidebarDestination] = [] {
        didSet {
            guard destinations != oldValue else { return }
            // The index a fling is coasting toward means nothing once the
            // ordering changes underneath it — areas load asynchronously, so
            // this is reachable — and a bounds check cannot catch a reorder.
            pendingCommit = nil
            engine.setCount(destinations.count)
            sync()
        }
    }
    // Indices that begin a new section, for the seam tick.
    var boundaryIndices: Set<Int> = []
    // The wheel's frame in window coordinates; touches outside are not ours.
    var activeRect: CGRect = .zero
    var onCommit: ((SidebarDestination) -> Void)?
    var currentIndex: (() -> Int?)?

    var reduceMotion = false {
        didSet { engine.tuning = reduceMotion ? .reduced : .standard }
    }

    @ObservationIgnored private var engine = SidebarWheelEngine()
    @ObservationIgnored private var clock: SidebarWheelClock?
    @ObservationIgnored private let haptics = SidebarWheelHaptics()
    // Resting centre of each detent, published by the layout. Not observed:
    // reading it must never invalidate a view.
    @ObservationIgnored private var restingCenters: [CGFloat] = []
    @ObservationIgnored private var contentHeight: CGFloat = 0
    // The newest measurement the layout has published. Measurements arrive
    // through main-actor tasks whose relative order Swift does not promise,
    // so an older one that lands late is dropped rather than applied.
    @ObservationIgnored private(set) var measurementSequence = 0
    // A pick the wheel is still coasting toward. Held until it arrives so the
    // committed row is always the one showing as picked.
    @ObservationIgnored private var pendingCommit: Int?
    // Thumb travel already spent activating the recogniser. Without rebasing
    // it, the wheel arrived already half a row along from movement the user
    // reads as merely pressing.
    @ObservationIgnored private var grabTranslationY: CGFloat = 0
    // True from the moment the wheel claims a touch until just after it is
    // released. Rows consult it so that even if a Button somehow survives
    // gesture arbitration, it cannot navigate behind the wheel's back.
    @ObservationIgnored private(set) var suppressesRowTaps = false

    func setMeasurement(centers: [CGFloat], total: CGFloat, sequence: Int? = nil) {
        if let sequence {
            guard sequence > measurementSequence else { return }
            measurementSequence = sequence
        }
        restingCenters = centers
        contentHeight = total
    }

    // Exposed for the layout's tests: what the wheel currently believes.
    var publishedMeasurement: (centers: [CGFloat], total: CGFloat) {
        (restingCenters, contentHeight)
    }

    var pickedDestination: SidebarDestination? {
        destinations.indices.contains(detent) ? destinations[detent] : nil
    }

    // One comfortable thumb arc has to cover the whole hierarchy, so per-item
    // travel divides that budget rather than tracking row heights. Raising the
    // budget slows the wheel down: it is the single number to turn if the scrub
    // feels twitchy or sluggish.
    var itemTravel: CGFloat {
        let count = destinations.count
        guard count > 1 else { return maximumItemTravel }
        return max(minimumItemTravel, min(maximumItemTravel, travelBudget / CGFloat(count - 1)))
    }

    private var travelBudget: CGFloat { 300 }
    private var minimumItemTravel: CGFloat { 16 }
    private var maximumItemTravel: CGFloat { 36 }

    // MARK: - Gesture handling

    func handleChange(start: CGPoint, translation: CGPoint, velocity: CGPoint) {
        if !isGrabbed {
            guard !destinations.isEmpty else { return }
            isGrabbed = true
            // Grabbing again mid-settle abandons whatever the last fling was
            // heading for.
            pendingCommit = nil
            grabTranslationY = translation.y
            suppressesRowTaps = true
            let origin = min(destinations.count - 1, max(0, currentIndex?() ?? 0))
            // The slot is where the current page already sits, not where the
            // thumb landed. Anchoring it to the thumb meant grabbing anywhere
            // yanked the whole hierarchy across to meet your finger before you
            // had asked for anything.
            let resting = restingCenters.indices.contains(origin)
                ? restingCenters[origin]
                : start.y - activeRect.minY
            // …but a long hierarchy can leave the current page below the fold,
            // and a slot off the bottom of the viewport would put the open page
            // somewhere nobody can see. Pull it into view; that is the one case
            // where the surface is meant to move on grab.
            slotY = SidebarWheelPlacement.slot(resting: resting, viewport: viewportHeight)
            haptics.prepare()
            engine.grab(at: origin)
            haptics.play(.home)
            sync()
            startClock()
        }
        guard itemTravel > 0 else { return }
        let delta = Double(-(translation.y - grabTranslationY) / itemTravel)
        if let rolled = engine.drag(byItems: delta) { play(rolled) }
        sync()
    }

    func handleEnd(velocity: CGPoint, completed: Bool) {
        guard isGrabbed else { return }
        isGrabbed = false
        // Released on the next turn of the run loop: a Button's action for this
        // same touch would otherwise land after the flag had already cleared.
        DispatchQueue.main.async { [weak self] in self?.suppressesRowTaps = false }
        if completed {
            let items = Double(-velocity.y / max(itemTravel, 1))
            let highlighted = engine.detent
            let landing = engine.release(velocityInItemsPerSecond: items)
            if let landing, destinations.indices.contains(landing) {
                if landing == highlighted {
                    // Nothing to coast to: what you were looking at is what you
                    // get, immediately.
                    commit(landing)
                } else {
                    // A fling is going somewhere you have not seen yet.
                    // Committing now would navigate to a row that was never the
                    // highlighted one, so the pick waits for the wheel to
                    // actually arrive — you watch it land on what it takes.
                    pendingCommit = landing
                }
            }
        } else {
            pendingCommit = nil
            engine.cancel()
        }
        sync()
        startClock()
    }

    func stop() {
        pendingCommit = nil
        // Never leave taps suppressed behind us; a stuck flag would make every
        // row in the sidebar dead to a plain tap.
        suppressesRowTaps = false
        clock?.stop()
        clock = nil
        haptics.shutdown()
    }

    // MARK: - Clock

    private func startClock() {
        if clock == nil {
            clock = SidebarWheelClock { [weak self] dt in self?.frame(dt) }
        }
        clock?.start()
    }

    private func frame(_ dt: Double) {
        if let rolled = engine.step(dt: dt) { play(rolled) }
        sync()
        // The spring is done well before the blend back to the resting list is,
        // so a coasted pick commits the moment it arrives rather than waiting
        // out the fade.
        if pendingCommit != nil, engine.phase == .idle {
            let landing = pendingCommit
            pendingCommit = nil
            if let landing { commit(landing) }
        }
        guard !isGrabbed, !engine.isRunning else { return }
        clock?.stop()
        haptics.relax()
    }

    // The single place a pick becomes navigation. By the time this runs the
    // wheel is resting on `index`, so the row showing as picked and the row
    // being opened are the same row.
    private func commit(_ index: Int) {
        guard destinations.indices.contains(index) else { return }
        haptics.play(index == engine.origin ? .home : .commit)
        onCommit?(destinations[index])
    }

    // Assign only on change. `@Observable` fires the observation on assignment
    // rather than on difference, so writing these unconditionally invalidated
    // every row at display-link rate and the split into separate properties
    // bought nothing. Away from the ends `focusY` is the slot and `engagement`
    // is pinned at 1, so guarding leaves `position` as the only per-frame write.
    private func sync() {
        if position != engine.position { position = engine.position }
        if engagement != engine.engagement { engagement = engine.engagement }
        if detent != engine.detent { detent = engine.detent }
        let focus = SidebarWheelPlacement.focus(
            position: engine.position,
            centers: restingCenters,
            slotY: slotY,
            viewport: viewportHeight,
            total: contentHeight,
            engagement: engine.engagement
        )
        if focusY != focus { focusY = focus }
    }

    // One definition of what "picked" means, rather than the same threshold
    // written out at each row.
    func isPicked(_ destination: SidebarDestination) -> Bool {
        engagement > 0.01 && pickedDestination == destination
    }

    private func play(_ index: Int) {
        let last = destinations.count - 1
        let tick: SidebarWheelHaptics.Tick =
            if index <= 0 || index >= last {
                .end
            } else if boundaryIndices.contains(index) {
                .boundary
            } else if index == engine.origin {
                .home
            } else {
                .row
            }
        haptics.play(tick)
    }
}

// MARK: - The page

// One open page and a fan of closed ones. Both the hinge and the growth are
// anchored on the leading edge — that edge is the spine, so it never moves and
// the left margin of the sidebar stays exactly where it was. Everything the
// page does happens to the right of it.
struct SidebarPageTransform: Equatable {
    let hingeDegrees: Double
    let lift: CGFloat
    let opacity: Double
    let slide: CGFloat

    static let identity = SidebarPageTransform(hingeDegrees: 0, lift: 1, opacity: 1, slide: 0)
}

enum SidebarPageGeometry {
    static let maximumHinge: Double = 26
    static let hingeSpread: Double = 2.6
    static let liftAmount: Double = 0.075
    static let liftSpread: Double = 1.5
    static let farOpacity: Double = 0.44
    static let opacitySpread: Double = 3.2
    static let slidePoints: Double = 10

    // `distance` is in rows, signed, continuous, and derived from where the row
    // actually landed. Pages fan shut in both directions — `sech` is even and
    // smooth through zero, so there is no crease at the open page and no clamp
    // anywhere for a row to freeze against.
    static func transform(
        distance: Double,
        engagement: Double,
        reduceMotion: Bool
    ) -> SidebarPageTransform {
        let blend = min(1, max(0, engagement))
        guard blend > 0 else { return .identity }
        let focus = 1 / cosh(distance / liftSpread)
        let visible = farOpacity + (1 - farOpacity) / cosh(distance / opacitySpread)
        let opacity = 1 + (visible - 1) * blend
        guard !reduceMotion else {
            return SidebarPageTransform(
                hingeDegrees: 0,
                lift: 1 + CGFloat(liftAmount * focus * blend),
                opacity: opacity,
                slide: 0
            )
        }
        let shut = 1 - 1 / cosh(distance / hingeSpread)
        return SidebarPageTransform(
            hingeDegrees: -maximumHinge * shut * blend,
            lift: 1 + CGFloat(liftAmount * focus * blend),
            opacity: opacity,
            slide: CGFloat(slidePoints * focus * blend)
        )
    }
}

private struct SidebarPageEffect: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let engagement: Double
    let focusY: CGFloat

    func body(content: Content) -> some View {
        let blend = engagement
        let focus = focusY
        let reduce = reduceMotion
        content.visualEffect { effect, proxy in
            let middle = proxy.frame(in: .named(SidebarWheelSpace.name)).midY
            let distance = Double((middle - focus) / SidebarWheelSpace.pitch)
            let page = SidebarPageGeometry.transform(
                distance: distance,
                engagement: blend,
                reduceMotion: reduce
            )
            return effect
                .rotation3DEffect(
                    .degrees(page.hingeDegrees),
                    axis: (x: 0, y: 1, z: 0),
                    anchor: .leading,
                    anchorZ: 0,
                    perspective: 0.55
                )
                .scaleEffect(page.lift, anchor: .leading)
                .offset(x: page.slide)
                .opacity(page.opacity)
        }
    }
}

extension View {
    // The fan opens on the picked row wherever the clamp actually left it, so
    // near the ends of the hierarchy the open page is still the picked one
    // rather than whichever row happens to sit at the slot.
    func sidebarPage(engagement: Double, focusY: CGFloat) -> some View {
        modifier(SidebarPageEffect(engagement: engagement, focusY: focusY))
    }
}
#endif
