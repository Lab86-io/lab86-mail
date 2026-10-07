import Foundation
import Observation

// Requests that cross from the menu bar or one surface into another surface
// on the Mac. A menu item runs before the surface that answers it is on
// screen, so the request is a value the surface reads when it appears, not
// a call the surface must be alive to receive.
//
// Tokens count up. A surface watches a token and acts on every change. A
// stale token is never acted on twice because the watcher only fires on a
// change.
@MainActor
@Observable
final class MacRequests {
    static let shared = MacRequests()

    // ⌘R "Sync Calendar". The calendar surface runs a manual sync per change.
    private(set) var syncCalendarToken = 0

    // ⇧⌘H "Horizon…". The open Albatross shows its horizon control.
    private(set) var openHorizonToken = 0

    // ⌘K while an Albatross thread is on screen. The thread focuses its
    // composer instead of the corner chat.
    private(set) var focusComposerToken = 0

    // ⌃⌘P and ⌃⌘I from the View menu. The open thread shows or hides the
    // pane named by `threadPaneTarget`.
    private(set) var threadPaneToken = 0
    private(set) var threadPaneTarget: MacThreadPaneMode = .page

    // What the open thread's pane shows now, for the View menu titles. The
    // thread writes it and clears it when it leaves the screen.
    var threadPaneMode: MacThreadPaneMode = .none

    // The source list. The thread collapses it when the pane needs the room
    // and restores it when the pane closes. The shell mirrors the live state
    // into `sidebarShown`.
    private(set) var sidebarToken = 0
    private(set) var sidebarVisible = true
    var sidebarShown = true

    // A day the Calendar tab must select when it appears. Week-ahead prose
    // sets it; the calendar surface clears it once applied.
    var calendarDay: Date?

    init() {}

    func requestCalendarSync() {
        syncCalendarToken += 1
    }

    func requestHorizonPopover() {
        openHorizonToken += 1
    }

    func requestComposerFocus() {
        focusComposerToken += 1
    }

    func requestThreadPane(_ target: MacThreadPaneMode) {
        threadPaneTarget = target
        threadPaneToken += 1
    }

    func requestSidebar(visible: Bool) {
        sidebarVisible = visible
        sidebarToken += 1
    }

    // The calendar surface calls this once. A second appearance of the
    // surface must not re-select an old day.
    func takeCalendarDay() -> Date? {
        defer { calendarDay = nil }
        return calendarDay
    }
}
