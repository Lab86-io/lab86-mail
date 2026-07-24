import SwiftUI

// The one global creation surface — New intent, New chat, Compose email — with
// its presentation chosen by the owner: a floating liquid-glass circle over
// most root pages, or a native bottom-toolbar item where a root owns its
// bottom bar (Mail, whose search field sits beside it). The action set must
// stay identical in every placement; only the chrome differs.
struct GlobalCreateMenu<MenuLabel: View>: View {
    @Environment(AppEnvironment.self) private var environment
    @ViewBuilder var label: () -> MenuLabel

    var body: some View {
        Menu {
            Button("New intent") {
                environment.navigation.sheet = .assistant
            }
            Button("New chat") {
                environment.startAssistantChat()
            }
            Button("Compose email") {
                environment.navigation.sheet = .compose
            }
        } label: {
            label()
        }
        .accessibilityLabel("New intent, chat, or email")
    }
}

// Where the floating copy of the create menu renders. Pure so the ownership
// rule — the plus exists exactly once per screen — is unit-testable.
enum GlobalCreateMenuPolicy {
    static func showsFloatingButton(selectedTab: PrimaryTab, hasNestedDestination: Bool) -> Bool {
        guard !hasNestedDestination else { return false }
        switch selectedTab {
        case .mail:
            // Mail mounts the same menu in its bottom toolbar beside the
            // system search field; a floating copy would double the control
            // and overlap the search bar.
            return false
        case .chat:
            // The chat composer owns that corner.
            return false
        case .today, .tasks, .calendar, .work:
            return true
        }
    }
}
