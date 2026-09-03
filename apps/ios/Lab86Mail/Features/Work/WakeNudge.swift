import SwiftUI

/// One wake: a dormant Work reached its date and came back. Shown once per
/// wake, keyed on the Work and its `wokeAt`.
struct WakeNudge: Identifiable, Equatable, Sendable {
    let workID: String
    let title: String
    let wokeAt: Date

    var id: String { "\(workID):\(Int(wokeAt.timeIntervalSince1970 * 1_000))" }

    /// "{title} is back. Ready when you are."
    var line: String { WorkHorizon.wakeLine(title: title) }
}

/// Which wake to show. Pure, so the rule is testable without a store.
enum WakeNudgeSelection {
    /// A wake older than this is stale news. The daily cron fires the push;
    /// the in-app nudge covers the days the user did not open the app.
    static let window: TimeInterval = 7 * 24 * 3600

    /// The newest unseen wake on open Work, inside the window.
    static func pick(from work: [WorkListItem], seen: Set<String>, now: Date) -> WakeNudge? {
        work
            .compactMap { item -> WakeNudge? in
                guard !item.isClosed,
                      let horizon = item.horizon,
                      horizon.kind == .now,
                      let wokeAt = horizon.wokeAt,
                      wokeAt <= now,
                      now.timeIntervalSince(wokeAt) <= window else { return nil }
                return WakeNudge(workID: item.id, title: item.displayTitle, wokeAt: wokeAt)
            }
            .filter { !seen.contains($0.id) }
            .max { $0.wokeAt < $1.wokeAt }
    }
}

/// Remembers which wakes were shown. Bounded so the list never grows without
/// end.
struct WakeNudgeLedger {
    static let key = "albatross.wakeNudge.seen"
    static let capacity = 60

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var seen: Set<String> {
        Set(defaults.stringArray(forKey: Self.key) ?? [])
    }

    func markSeen(_ id: String) {
        var list = defaults.stringArray(forKey: Self.key) ?? []
        list.removeAll { $0 == id }
        list.append(id)
        if list.count > Self.capacity { list.removeFirst(list.count - Self.capacity) }
        defaults.set(list, forKey: Self.key)
    }
}

/// The in-app nudge model. It watches the Work list and shows one wake at a
/// time. The banner leaves after 6 s, a swipe, or "Open".
@MainActor
@Observable
final class WakeNudgeModel {
    private(set) var current: WakeNudge?
    private let ledger: WakeNudgeLedger

    init(ledger: WakeNudgeLedger = WakeNudgeLedger()) {
        self.ledger = ledger
    }

    func consider(_ work: [WorkListItem], now: Date = .now) {
        guard current == nil else { return }
        current = WakeNudgeSelection.pick(from: work, seen: ledger.seen, now: now)
    }

    func dismiss() {
        guard let current else { return }
        ledger.markSeen(current.id)
        self.current = nil
    }
}

/// A 52 pt glass capsule: the line on the left, one plain-text "Open" on the
/// right. It slides in from the trailing edge with `settle`, leaves with
/// `cross` after 6 s or on a swipe to the trailing edge.
struct WakeNudgeBanner: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let nudge: WakeNudge
    let onOpen: () -> Void
    let onDismiss: () -> Void

    @State private var dragOffset: CGFloat = 0

    static let dismissAfter: Duration = .seconds(6)

    var body: some View {
        HStack(spacing: 12) {
            Text(nudge.line)
                .font(.subheadline)
                .lineLimit(2)
                .minimumScaleFactor(0.9)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Open", action: onOpen)
                .font(.subheadline.weight(.semibold))
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
        }
        .padding(.horizontal, 18)
        .frame(minHeight: 52)
        .frame(maxWidth: 520)
        .glassEffect(.regular, in: .capsule)
        .offset(x: max(0, dragOffset))
        .gesture(
            DragGesture(minimumDistance: 12)
                .onChanged { value in dragOffset = value.translation.width }
                .onEnded { value in
                    if value.translation.width > 60 {
                        onDismiss()
                    } else {
                        withAnimation(WorkMotion.settle(reduceMotion: reduceMotion)) { dragOffset = 0 }
                    }
                }
        )
        .task(id: nudge.id) {
            try? await Task.sleep(for: Self.dismissAfter)
            guard !Task.isCancelled else { return }
            onDismiss()
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(nudge.line)
        .accessibilityAction(named: "Dismiss", onDismiss)
    }
}

/// Hosts the banner under the navigation bar. Shared by the iOS shell and the
/// Mac shell; each shell chooses the anchor.
struct WakeNudgeOverlay: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var model = WakeNudgeModel()

    var body: some View {
        ZStack(alignment: .topTrailing) {
            if let nudge = model.current {
                WakeNudgeBanner(
                    nudge: nudge,
                    onOpen: {
                        model.dismiss()
                        environment.navigation.openWork(id: nudge.workID, title: nudge.title)
                    },
                    onDismiss: { model.dismiss() }
                )
                .transition(entry)
                .id(nudge.id)
            }
        }
        .animation(model.current == nil ? WorkMotion.cross : WorkMotion.settle(reduceMotion: reduceMotion), value: model.current)
        .modifier(WakeHaptic(trigger: model.current?.id))
        .onChange(of: environment.store.allWork, initial: true) { _, work in
            model.consider(work)
        }
    }

    private var entry: AnyTransition {
        reduceMotion
            ? .opacity
            : .asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .opacity)
    }
}

/// `.impact(flexibility: .soft)` once per wake. Silent on the Mac.
private struct WakeHaptic: ViewModifier {
    let trigger: String?

    func body(content: Content) -> some View {
        #if os(iOS)
        content.sensoryFeedback(.impact(flexibility: .soft), trigger: trigger) { _, new in new != nil }
        #else
        content
        #endif
    }
}
