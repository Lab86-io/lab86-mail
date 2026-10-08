import SwiftUI

// The Go menu (docs/albatross-threads.md, T3; lead decision 4): ⌥⌘↓ and
// ⌥⌘↑ move through the Albatrosses the source list shows, ⌥⌘↩ opens the
// next one that needs the user. A menu item runs before the shell reads it,
// so each one is a request in `MacRequests`; the shell answers with or
// without a thread on screen. Design note:
// docs/research/albatross-threads-macos-design-2026-10-08.md, section 4.

/// The words of the Go menu, for the menu and the tests.
enum MacGoCommandState {
    static let menu = "Go"
    static let next = "Next Albatross"
    static let previous = "Previous Albatross"
    static let nextNeedsYou = "Next Albatross That Needs You"

    /// "Next that needs you" has somewhere to go only when the move finds
    /// a row: the same rows and the same rule as the move itself, so a
    /// filter that hides every needs-you row also disables the item.
    static func nextNeedsYouEnabled(from current: String?, in rows: [ThreadListRow]) -> Bool {
        MacThreadListLayout.target(.nextNeedsYou, from: current, in: rows) != nil
    }

    /// The rows a move goes through: the source list's awake rows under its
    /// filter.
    @MainActor
    static func rows(_ environment: AppEnvironment, now: Date = .now) -> [ThreadListRow] {
        MacThreadListLayout.rows(
            items: environment.store.allWork,
            live: environment.threads.rows,
            filter: MacRequests.shared.threadFilter,
            now: now
        )
    }

    /// The open thread, when the Albatross tab shows one.
    @MainActor
    static func current(_ environment: AppEnvironment) -> String? {
        environment.navigation.selectedTab == .work ? environment.navigation.workRoute?.workID : nil
    }
}

struct MacGoCommands: Commands {
    let environment: AppEnvironment

    private var requests: MacRequests { MacRequests.shared }

    var body: some Commands {
        CommandMenu(MacGoCommandState.menu) {
            Button(MacGoCommandState.next) {
                requests.requestThreadMove(.next)
            }
            .keyboardShortcut(.downArrow, modifiers: [.option, .command])

            Button(MacGoCommandState.previous) {
                requests.requestThreadMove(.previous)
            }
            .keyboardShortcut(.upArrow, modifiers: [.option, .command])

            Divider()

            Button(MacGoCommandState.nextNeedsYou) {
                requests.requestThreadMove(.nextNeedsYou)
            }
            .keyboardShortcut(.return, modifiers: [.option, .command])
            .disabled(!MacGoCommandState.nextNeedsYouEnabled(
                from: MacGoCommandState.current(environment),
                in: MacGoCommandState.rows(environment)
            ))
        }
    }
}
