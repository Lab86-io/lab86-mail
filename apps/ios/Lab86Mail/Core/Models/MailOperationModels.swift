import Foundation

// Undo for mail changes (round 2, FEATURES item 10). The server records an
// operation for each archive, trash, restore, snooze, label, block, and rule
// change, and returns its id. Undo runs `undo_operation` with that id: the
// same inverse Activity runs, so a change taken back from the toast also
// reads as undone in Activity.

enum MailUndoCopy {
    /// The toast line for mail list actions the server confirmed.
    static func summary(for commands: [DurableMobileCommand], now: Date = .now) -> String {
        guard let first = commands.first else { return "Changed" }
        let count = commands.count
        let kinds = Set(commands.map(\.kind))
        guard kinds.count == 1 else { return "Changed \(count) conversations" }
        switch first {
        case .mailArchive:
            return count == 1 ? "Archived" : "Archived \(count) conversations"
        case .mailTrash:
            return count == 1 ? "Moved to Trash" : "Moved \(count) conversations to Trash"
        case .mailRestore:
            return count == 1 ? "Moved to Inbox" : "Moved \(count) conversations to Inbox"
        case .mailSnooze(let payload):
            guard count == 1 else { return "Snoozed \(count) conversations" }
            return "Snoozed until \(wakeLabel(payload.untilAt, now: now))"
        case .mailUnsnooze:
            return count == 1 ? "Back in the inbox" : "\(count) conversations back in the inbox"
        case .mailMarkRead:
            return count == 1 ? "Marked read" : "Marked \(count) conversations read"
        case .mailMarkUnread:
            return count == 1 ? "Marked unread" : "Marked \(count) conversations unread"
        case .mailStar:
            return count == 1 ? "Starred" : "Starred \(count) conversations"
        case .mailUnstar:
            return count == 1 ? "Unstarred" : "Unstarred \(count) conversations"
        default:
            return count == 1 ? "Changed" : "Changed \(count) conversations"
        }
    }

    /// "today at 5:00 PM", "tomorrow at 9:00 AM", or "Mon, Sep 28 at 9:00 AM".
    static func wakeLabel(_ date: Date, now: Date, calendar: Calendar = .autoupdatingCurrent) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDate(date, inSameDayAs: now) { return "today at \(time)" }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) {
            return "tomorrow at \(time)"
        }
        return "\(date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())) at \(time)"
    }
}

/// One row of the operations log, as `list_recent_operations` returns it.
struct RecentOperation: Identifiable, Equatable, Sendable {
    enum Status: String, Sendable {
        case applied
        case undoing
        case undone
        case undoFailed = "undo_failed"
    }

    let id: String
    let tool: String
    let surface: String
    let summary: String
    let reason: String?
    let byAlbatross: Bool
    let status: Status
    let undoable: Bool
    let createdAt: Date?
    let accountID: String?

    init?(json: JSONValue) {
        guard let id = (json["operationId"] ?? json["_id"])?.stringValue?.nilIfBlank,
              let summary = json["summary"]?.stringValue?.nilIfBlank else { return nil }
        self.id = id
        tool = json["tool"]?.stringValue ?? ""
        surface = json["surface"]?.stringValue ?? ""
        self.summary = summary
        reason = json["reason"]?.stringValue?.nilIfBlank
        byAlbatross = json["agent"]?.stringValue == "ai"
        status = json["status"]?.stringValue.flatMap(Status.init(rawValue:)) ?? .applied
        undoable = (json["undoable"]?.boolValue ?? false) && status == .applied
        createdAt = CalendarDateParser.date(json["createdAt"])
        accountID = json["target"]?["accountId"]?.stringValue?.nilIfBlank
    }

    static let surfaceLabels = ["mail": "Mail", "calendar": "Calendar", "tasks": "Tasks", "albatross": "Albatross"]

    /// "Albatross did this · Mail · 9:14 AM".
    func metaLine(now: Date = .now, calendar: Calendar = .autoupdatingCurrent) -> String {
        var parts = [byAlbatross ? "Albatross did this" : "You did this"]
        parts.append(Self.surfaceLabels[surface] ?? surface.capitalized)
        if let createdAt {
            parts.append(
                calendar.isDate(createdAt, inSameDayAs: now)
                    ? createdAt.formatted(date: .omitted, time: .shortened)
                    : createdAt.formatted(.dateTime.month(.abbreviated).day())
            )
        }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// "Undone", "Undoing…", or "Could not be undone". Nil while applied.
    var statusNote: String? {
        switch status {
        case .applied: nil
        case .undoing: "Undoing…"
        case .undone: "Undone"
        case .undoFailed: "Could not be undone"
        }
    }

    static func list(from json: JSONValue) -> [RecentOperation] {
        (json["operations"]?.arrayValue ?? []).compactMap(RecentOperation.init(json:))
    }
}

/// The operations log reads and the Undo, for Activity.
struct OperationsClient: Sendable {
    let tools: any ToolInvoking

    func recent(limit: Int = 50) async throws -> [RecentOperation] {
        let result = try await tools.invoke(
            "list_recent_operations",
            arguments: ["limit": .number(Double(min(max(limit, 1), 200)))]
        )
        return RecentOperation.list(from: result)
    }

    func undo(_ operationID: String) async throws {
        _ = try await tools.invoke("undo_operation", arguments: ["operationId": .string(operationID)])
    }
}
