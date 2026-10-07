import SwiftUI

// The View menu items of the Albatross thread on the Mac: "Show Page" and
// "Show Details" with their shortcuts. A menu item runs before the thread
// reads it, so each one is a request in `MacRequests`. Design note:
// docs/research/albatross-thread-macos-design-2026-10-07.md, section 2.6.

/// The pure state of the thread's menu items, for the menu and the tests.
enum MacThreadCommandState {
    static let showPage = "Show Page"
    static let hidePage = "Hide Page"
    static let showDetails = "Show Details"
    static let hideDetails = "Hide Details"

    static func pageTitle(mode: MacThreadPaneMode) -> String {
        mode == .page ? hidePage : showPage
    }

    static func detailsTitle(mode: MacThreadPaneMode) -> String {
        mode == .details ? hideDetails : showDetails
    }

    /// The items work only while a thread is on screen.
    static func isEnabled(threadOpen: Bool) -> Bool {
        threadOpen
    }
}

extension NavigationModel {
    /// An Albatross thread is the detail of the Work tab. The corner chat
    /// hides while it is, and ⌘K goes to its composer.
    var showsWorkThread: Bool {
        selectedTab == .work && workRoute != nil
    }
}

struct MacThreadCommands: Commands {
    let environment: AppEnvironment

    private var requests: MacRequests { MacRequests.shared }

    private var enabled: Bool {
        MacThreadCommandState.isEnabled(threadOpen: environment.navigation.showsWorkThread)
    }

    var body: some Commands {
        CommandGroup(after: .sidebar) {
            Button(MacThreadCommandState.pageTitle(mode: requests.threadPaneMode)) {
                requests.requestThreadPane(.page)
            }
            .keyboardShortcut("p", modifiers: [.control, .command])
            .disabled(!enabled)

            Button(MacThreadCommandState.detailsTitle(mode: requests.threadPaneMode)) {
                requests.requestThreadPane(.details)
            }
            .keyboardShortcut("i", modifiers: [.control, .command])
            .disabled(!enabled)
        }
    }
}
