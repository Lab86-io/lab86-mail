import SwiftUI

// The View menu items of the Albatross thread on the Mac: "Show Page" and
// "Show Details" with their shortcuts, then the Albatrosses section of the
// source list and its filter (docs/albatross-threads.md, T12). A menu item
// runs before the thread reads it, so each one is a request in
// `MacRequests`. Design notes:
// docs/research/albatross-thread-macos-design-2026-10-07.md, section 2.6, and
// docs/research/albatross-threads-macos-design-2026-10-08.md, section 4.4.

/// The pure state of the thread's menu items, for the menu and the tests.
enum MacThreadCommandState {
    static let showPage = "Show Page"
    static let hidePage = "Hide Page"
    static let showDetails = "Show Details"
    static let hideDetails = "Hide Details"
    static let showAlbatrosses = "Show Albatrosses"
    static let hideAlbatrosses = "Hide Albatrosses"
    static let filterTitle = "Albatrosses"
    static let markUnread = "Mark as Unread"
    static let markRead = "Mark as Read"
    static let stopAndRedirect = "Stop and Redirect…"

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

    /// The disclosure item of the Albatrosses section.
    static func albatrossesTitle(expanded: Bool) -> String {
        expanded ? hideAlbatrosses : showAlbatrosses
    }

    /// The filter words in the View menu, in title case.
    static func filterItemTitle(_ filter: WorkFilter) -> String {
        switch filter {
        case .all: "All Albatrosses"
        case .needsYou: "Needs You"
        case .inProgress: "In Progress"
        case .unhomed: "No Area Yet"
        }
    }

    /// ⇧⌘U flips the open thread's mark.
    static func unreadTitle(unread: Bool) -> String {
        unread ? markRead : markUnread
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

            Divider()

            Button(MacThreadCommandState.albatrossesTitle(expanded: requests.threadsExpanded)) {
                requests.setThreadsExpanded(!requests.threadsExpanded)
            }

            Picker(
                MacThreadCommandState.filterTitle,
                selection: Binding(
                    get: { requests.threadFilter },
                    set: { requests.setThreadFilter($0) }
                )
            ) {
                ForEach(MacThreadListLayout.filters, id: \.self) { filter in
                    Text(MacThreadCommandState.filterItemTitle(filter)).tag(filter)
                }
            }
            .pickerStyle(.inline)
        }
    }
}
