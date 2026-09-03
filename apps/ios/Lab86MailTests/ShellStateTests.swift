import Foundation
import Testing
@testable import Lab86Mail

// The Areas list placeholder shared by both shells: a failed first load must
// expose its retry instead of sitting behind "Loading areas…" forever.
struct ShellStateTests {
    @Test
    func areaListStatePrefersLoadingThenFailureThenEmptiness() {
        #expect(AreaListState.resolve(isLoading: true, didLoad: false, hasError: false) == .loading)
        #expect(AreaListState.resolve(isLoading: true, didLoad: true, hasError: true) == .loading)
        // The initial failure: nothing loaded, not loading, an error recorded.
        #expect(AreaListState.resolve(isLoading: false, didLoad: false, hasError: true) == .failed)
        #expect(AreaListState.resolve(isLoading: false, didLoad: true, hasError: true) == .failed)
        #expect(AreaListState.resolve(isLoading: false, didLoad: true, hasError: false) == .empty)
        // Before the first fetch even starts there is nothing to say but loading.
        #expect(AreaListState.resolve(isLoading: false, didLoad: false, hasError: false) == .loading)
    }

    @Test
    func aThreadRouteMatchesOnlyItsOwnThread() {
        let route = ThreadRoute(accountID: "acct-1", threadID: "thread-1")
        func thread(_ id: String, account: String) -> MailThreadSummary {
            MailThreadSummary(
                id: id, accountID: account, subject: "S", sender: "a@example.com", snippet: "",
                date: Date(timeIntervalSince1970: 2_000_000_000), unread: false, starred: false
            )
        }
        #expect(route.matches(thread("thread-1", account: "acct-1")))
        #expect(!route.matches(thread("thread-1", account: "acct-2")))
        #expect(!route.matches(thread("thread-2", account: "acct-1")))
    }

    @Test
    func theMacNotificationPaneOpensOnTheAppsOwnRow() {
        #expect(
            PlatformSettings.notificationSettingsURL(bundleIdentifier: "io.lab86.mail")?.absoluteString
                == "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=io.lab86.mail"
        )
        #expect(
            PlatformSettings.notificationSettingsURL(bundleIdentifier: nil)?.absoluteString
                == "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
        )
        #expect(
            PlatformSettings.notificationSettingsURL(bundleIdentifier: "")?.absoluteString
                == "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
        )
    }
}
