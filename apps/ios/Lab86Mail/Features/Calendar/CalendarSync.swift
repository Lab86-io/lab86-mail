import Foundation

// Calendar sync kicks. Pure rules for the resync request, the freshness
// subtitle, the pending-event border, and the follow loop that waits for the
// server copy. The store owns the I/O; these types own no state.

enum CalendarResyncReason: String, Codable, Sendable, CaseIterable {
    case viewOpen = "view_open"
    case pull
    case manualHTTP = "manual_http"
}

// The body for `POST /api/calendar/resync`.
struct CalendarResyncRequest: Equatable, Sendable {
    static let path = "/api/calendar/resync"

    let accountID: String?
    let reason: CalendarResyncReason

    init(accountID: String? = nil, reason: CalendarResyncReason) {
        self.accountID = accountID?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
        self.reason = reason
    }

    var body: JSONValue {
        var fields: [String: JSONValue] = ["reason": .string(reason.rawValue)]
        if let accountID { fields["accountId"] = .string(accountID) }
        return .object(fields)
    }
}

// The server answer: `{ ok, started, lastSyncedAt (epoch ms | null), reason }`.
struct CalendarResyncResponse: Equatable, Sendable {
    let started: Bool
    let lastSyncedAt: Date?

    init(started: Bool, lastSyncedAt: Date?) {
        self.started = started
        self.lastSyncedAt = lastSyncedAt
    }

    init?(json: JSONValue) {
        guard json["ok"]?.boolValue == true, let started = json["started"]?.boolValue else { return nil }
        self.started = started
        lastSyncedAt = CalendarSyncStateRow.epochDate(json["lastSyncedAt"])
    }
}

// One row of `calendarSyncStates`, as `calendar_list_calendars` returns it.
struct CalendarSyncStateRow: Equatable, Sendable {
    let accountID: String
    let status: String
    let lastSyncedAt: Date?
    let error: String?

    init(accountID: String, status: String, lastSyncedAt: Date?, error: String? = nil) {
        self.accountID = accountID
        self.status = status
        self.lastSyncedAt = lastSyncedAt
        self.error = error
    }

    init?(json: JSONValue) {
        guard let accountID = json["accountId"]?.stringValue?.nilIfBlank else { return nil }
        self.accountID = accountID
        status = json["status"]?.stringValue ?? "idle"
        lastSyncedAt = Self.epochDate(json["lastSyncedAt"])
        error = json["error"]?.stringValue?.nilIfBlank
    }

    // Epoch milliseconds to a date. Zero, negative, and null stay nil.
    static func epochDate(_ value: JSONValue?) -> Date? {
        guard let milliseconds = value?.doubleValue, milliseconds > 0 else { return nil }
        return Date(timeIntervalSince1970: milliseconds / 1_000)
    }

    // The time every authorized account was fresh. One account without a
    // completed sync makes the answer nil. Same rule as the server.
    static func oldestSyncedAt(_ rows: [CalendarSyncStateRow]) -> Date? {
        var oldest: Date?
        for row in rows where row.status != "unauthorized" {
            guard let value = row.lastSyncedAt else { return nil }
            if let current = oldest, current <= value { continue }
            oldest = value
        }
        return oldest
    }
}

enum CalendarSyncPhase: Equatable, Sendable {
    case idle
    case running
    case done
    case failed
}

struct CalendarSyncState: Equatable, Sendable {
    var phase: CalendarSyncPhase = .idle
    var lastSyncedAt: Date?
    var rows: [CalendarSyncStateRow] = []
    var failureMessage: String?
    // Increments on each completed sync. The view keys the haptic on it.
    var completionToken = 0

    static let failureCopy = "Could not sync. Pull to try again."

    func lastSyncedAt(forAccount accountID: String) -> Date? {
        rows.first(where: { $0.accountID == accountID })?.lastSyncedAt ?? lastSyncedAt
    }
}

// The navigation subtitle. It states freshness or the running sync. It
// never states the reason for a sync.
enum CalendarFreshness {
    static func subtitle(state: CalendarSyncState, now: Date = .now) -> String {
        switch state.phase {
        case .running:
            return "Syncing…"
        case .failed:
            return state.failureMessage ?? CalendarSyncState.failureCopy
        case .idle, .done:
            return updated(at: state.lastSyncedAt, now: now)
        }
    }

    static func updated(at date: Date?, now: Date = .now) -> String {
        guard let date else { return "Not synced yet" }
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return "Updated just now" }
        let minutes = Int(seconds / 60)
        if minutes < 60 { return "Updated \(minutes) min ago" }
        let hours = Int(seconds / 3_600)
        if hours < 24 { return "Updated \(hours) hr ago" }
        return "Updated \(date.formatted(date: .abbreviated, time: .omitted))"
    }
}

// A new event wears a dashed border until the server copy lands. Nothing on
// the event row tells a mirror row from a synced row, so the rule compares
// the client creation time with the account's last completed sync.
enum CalendarPendingEvents {
    // A stalled sync must not leave a dashed border on the screen for good.
    static let maxAge: TimeInterval = 10 * 60

    static func isPending(
        createdAt: Date,
        lastSyncedAt: Date?,
        now: Date = .now,
        maxAge: TimeInterval = maxAge
    ) -> Bool {
        guard now.timeIntervalSince(createdAt) < maxAge else { return false }
        guard let lastSyncedAt else { return true }
        return lastSyncedAt < createdAt
    }
}

// What the follow loop reads from one poll of the sync states while a sync
// runs. `since` is the freshness before the kick.
enum CalendarSyncFollow: Equatable, Sendable {
    case waiting
    case done(lastSyncedAt: Date?)
    case failed(message: String)

    static func outcome(rows: [CalendarSyncStateRow], since: Date?) -> CalendarSyncFollow {
        let active = rows.filter { $0.status != "unauthorized" }
        if active.contains(where: { $0.status == "syncing" }) { return .waiting }
        if let failed = active.first(where: { $0.status == "error" }) {
            return .failed(message: failed.error ?? CalendarSyncState.failureCopy)
        }
        let oldest = CalendarSyncStateRow.oldestSyncedAt(rows)
        guard let oldest else { return .waiting }
        if let since, oldest <= since { return .waiting }
        return .done(lastSyncedAt: oldest)
    }
}
