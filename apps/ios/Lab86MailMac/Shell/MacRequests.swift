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

    // ⇧⌘H "Horizon…". The open Work detail shows its horizon popover.
    private(set) var openHorizonToken = 0

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

    // The calendar surface calls this once. A second appearance of the
    // surface must not re-select an old day.
    func takeCalendarDay() -> Date? {
        defer { calendarDay = nil }
        return calendarDay
    }
}
