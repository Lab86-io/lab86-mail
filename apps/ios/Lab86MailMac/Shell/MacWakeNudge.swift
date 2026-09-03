import AppKit
import SwiftUI
import UserNotifications

// The wake nudge on the Mac: a bar that slides in from the trailing edge of
// the detail pane, under the toolbar. One line and one text button, "Open".
// It leaves after 8 s; the pointer over it pauses the clock. When the app is
// not active, a system notification carries the same line and an "Open"
// action that lands on the Work detail through the deep-link path.

enum MacWakeNudgeTiming {
    static let dismissAfter: TimeInterval = 8
    static let tick: Duration = .milliseconds(100)
    static let tickSeconds: TimeInterval = 0.1

    // The clock only runs while the pointer is away. Pure, so the pause rule
    // is testable.
    static func elapsed(after previous: TimeInterval, hovering: Bool) -> TimeInterval {
        hovering ? previous : previous + tickSeconds
    }

    static func shouldDismiss(elapsed: TimeInterval) -> Bool {
        elapsed >= dismissAfter
    }
}

struct MacWakeNudgeBanner: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let nudge: WakeNudge
    let onOpen: () -> Void
    let onDismiss: () -> Void

    @State private var hovering = false

    var body: some View {
        HStack(spacing: 14) {
            Text(nudge.line)
                .font(.subheadline)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Open", action: onOpen)
                .buttonStyle(.plain)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(environment.theme.accentColor)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(width: 360, alignment: .leading)
        .background(environment.theme.elevatedColor, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(environment.theme.hairlineColor, lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.08), radius: 12, y: 6)
        .onHover { hovering = $0 }
        .task(id: nudge.id) {
            var elapsed: TimeInterval = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: MacWakeNudgeTiming.tick)
                guard !Task.isCancelled else { return }
                elapsed = MacWakeNudgeTiming.elapsed(after: elapsed, hovering: hovering)
                if MacWakeNudgeTiming.shouldDismiss(elapsed: elapsed) {
                    onDismiss()
                    return
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(nudge.line)
        .accessibilityAction(named: "Dismiss", onDismiss)
    }

    // 320 ms spring in from the trailing edge, 200 ms ease out.
    static var entry: AnyTransition {
        .asymmetric(
            insertion: .move(edge: .trailing).combined(with: .opacity),
            removal: .opacity
        )
    }

    static let springIn: Animation = .spring(duration: 0.32, bounce: 0.08)
    static let easeOut: Animation = .easeOut(duration: 0.2)
}

// The system notification for a wake while the app is not active.
enum MacWakeNotifier {
    static let categoryID = "LAB86_WAKE"
    static let openActionID = "OPEN_WORK"

    // The deep link the "Open" action follows. The shell reads it through
    // the same path as every other notification route.
    static func route(workID: String) -> String {
        "/work?work=\(workID)"
    }

    static func request(for nudge: WakeNudge) -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = "Albatross"
        content.body = nudge.line
        content.categoryIdentifier = categoryID
        content.userInfo = ["route": route(workID: nudge.workID), "workId": nudge.workID]
        content.interruptionLevel = .active
        return UNNotificationRequest(identifier: "wake:\(nudge.id)", content: content, trigger: nil)
    }

    // Adds the wake category next to the shared ones. Runs once at launch.
    static func registerCategory(center: UNUserNotificationCenter = .current()) {
        let open = UNNotificationAction(identifier: openActionID, title: "Open", options: [.foreground])
        let category = UNNotificationCategory(identifier: categoryID, actions: [open], intentIdentifiers: [])
        center.getNotificationCategories { existing in
            center.setNotificationCategories(existing.union([category]))
        }
    }

    // Posts the notification only while the app is in the background. An
    // active app shows the in-window bar instead.
    @MainActor
    static func postIfInactive(_ nudge: WakeNudge, center: UNUserNotificationCenter = .current()) {
        guard !NSApplication.shared.isActive else { return }
        center.add(request(for: nudge))
    }
}


/// The Mac host for the wake nudge. It sits under the toolbar at the trailing
/// edge and shows one Work at a time.
struct MacWakeNudgeOverlay: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var model = WakeNudgeModel()

    var body: some View {
        ZStack(alignment: .topTrailing) {
            if let nudge = model.current {
                MacWakeNudgeBanner(
                    nudge: nudge,
                    onOpen: {
                        model.dismiss()
                        environment.navigation.openWork(id: nudge.workID, title: nudge.title)
                    },
                    onDismiss: { model.dismiss() }
                )
                .transition(
                    reduceMotion
                        ? .opacity
                        : .asymmetric(
                            insertion: .move(edge: .trailing).combined(with: .opacity),
                            removal: .opacity
                        )
                )
                .id(nudge.id)
            }
        }
        .animation(
            model.current == nil ? WorkMotion.cross : WorkMotion.settle(reduceMotion: reduceMotion),
            value: model.current
        )
        .onChange(of: environment.store.allWork, initial: true) { _, work in
            model.consider(work)
        }
    }
}
