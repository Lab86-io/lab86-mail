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

    /// "Next that needs you" has somewhere to go only while a row needs
    /// the user.
    static func nextNeedsYouEnabled(needsYouCount: Int) -> Bool {
        needsYouCount > 0
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
            .disabled(!MacGoCommandState.nextNeedsYouEnabled(needsYouCount: environment.threads.needsYouCount))
        }
    }
}
