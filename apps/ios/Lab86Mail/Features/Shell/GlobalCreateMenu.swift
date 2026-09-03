import SwiftUI

// The one global creation surface — Ask or hold, Compose email — with
// its presentation chosen by the owner: a floating liquid-glass circle over
// most root pages, or a native bottom-toolbar item where a root owns its
// bottom bar (Mail, whose search field sits beside it). The action set must
// stay identical in every placement; only the chrome differs.
struct GlobalCreateMenu<MenuLabel: View>: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var errorMessage: String?
    @ViewBuilder var label: () -> MenuLabel

    var body: some View {
        Menu {
            // One door. The bar decides whether the text is a question or
            // something to hold.
            Button("Ask or hold") {
                environment.startAssistantChat()
            }
            Button("Compose email") {
                environment.navigation.sheet = .compose
            }
            Divider()
            ForEach(AlbatrossDocumentKind.allCases) { kind in
                Button("New \(kind.title.lowercased())", systemImage: kind.symbol) {
                    Task {
                        do {
                            try await environment.createAndOpenDocument(kind: kind)
                        } catch {
                            errorMessage = error.localizedDescription
                        }
                    }
                }
            }
        } label: {
            label()
        }
        .accessibilityLabel("Ask or hold, write an email, or make a file")
        .alert("Couldn’t create file", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "Try again.")
        }
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
        case .chat, .files:
            // Chat's composer and Files' native toolbar own their create controls.
            return false
        case .today, .tasks, .calendar, .work:
            return true
        }
    }
}
