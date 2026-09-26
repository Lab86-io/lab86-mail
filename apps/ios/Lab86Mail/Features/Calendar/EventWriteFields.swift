import Foundation

/// The values of the event form that a save can change.
struct EventFormSnapshot: Equatable {
    var title: String
    var allDay: Bool
    var start: Date
    var end: Date
    var location: String
    /// Nil means the event does not repeat.
    var repeatRule: [String]?
    var attendees: [String]
    var notes: String
}

/// The write rules for calendar events (audit CAL-2 and CAL-4, 2026-09-26).
///
/// - An edit sends only the fields the user changed. A series edit on an
///   expanded instance must never send the instance's times or an empty
///   repeat rule to the master by accident.
/// - An all-day event travels as date-only strings with an exclusive end.
///   The editor shows an inclusive end date, so the write adds one day.
enum EventWriteFields {
    static func dateOnly(_ date: Date, calendar: Calendar = .autoupdatingCurrent) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    static func timeArguments(
        start: Date,
        end: Date,
        allDay: Bool,
        calendar: Calendar = .autoupdatingCurrent
    ) -> [String: JSONValue] {
        if allDay {
            let lastDay = calendar.startOfDay(for: max(start, end))
            let exclusiveEnd = calendar.date(byAdding: .day, value: 1, to: lastDay) ?? lastDay
            return [
                "startIso": .string(dateOnly(start, calendar: calendar)),
                "endIso": .string(dateOnly(exclusiveEnd, calendar: calendar)),
                "allDay": .bool(true),
            ]
        }
        let iso = ISO8601DateFormatter()
        return [
            "startIso": .string(iso.string(from: start)),
            "endIso": .string(iso.string(from: max(start, end))),
            "allDay": .bool(false),
        ]
    }

    /// The editor's dates for a stored event. A stored all-day row holds a
    /// midnight instant (UTC midnight from sync, or local midnight) with an
    /// exclusive end; the editor shows local dates with an inclusive end.
    static func editorDates(
        start: Date,
        end: Date?,
        allDay: Bool,
        calendar: Calendar = .autoupdatingCurrent
    ) -> (start: Date, end: Date?) {
        guard allDay else { return (start, end) }
        let localStart = localDay(of: start, calendar: calendar)
        guard let end else { return (localStart, nil) }
        var localEnd = localDay(of: end, calendar: calendar)
        if localEnd > localStart {
            localEnd = calendar.date(byAdding: .day, value: -1, to: localEnd) ?? localEnd
        }
        return (localStart, localEnd)
    }

    /// Local midnight of the calendar date an all-day instant names.
    static func localDay(of instant: Date, calendar: Calendar = .autoupdatingCurrent) -> Date {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        let utcParts = utc.dateComponents([.year, .month, .day, .hour, .minute, .second], from: instant)
        let isUTCMidnight = utcParts.hour == 0 && utcParts.minute == 0 && utcParts.second == 0
        let parts = isUTCMidnight
            ? DateComponents(year: utcParts.year, month: utcParts.month, day: utcParts.day)
            : calendar.dateComponents([.year, .month, .day], from: instant)
        return calendar.date(from: parts) ?? calendar.startOfDay(for: instant)
    }

    static func changedArguments(
        from initial: EventFormSnapshot,
        to current: EventFormSnapshot,
        calendar: Calendar = .autoupdatingCurrent
    ) -> [String: JSONValue] {
        var arguments: [String: JSONValue] = [:]
        if current.title != initial.title { arguments["title"] = .string(current.title) }
        if current.location != initial.location { arguments["location"] = .string(current.location) }
        if current.notes != initial.notes { arguments["description"] = .string(current.notes) }
        if current.attendees != initial.attendees {
            arguments["attendees"] = .array(current.attendees.map { .object(["email": .string($0)]) })
        }
        // Start, end, and all-day travel together: the server reads them as
        // one time span.
        if current.allDay != initial.allDay || current.start != initial.start || current.end != initial.end {
            arguments.merge(
                timeArguments(start: current.start, end: current.end, allDay: current.allDay, calendar: calendar)
            ) { _, new in new }
        }
        // An empty rule removes the repeat, so it goes only when the user
        // chose "Never" for an event that repeated.
        if current.repeatRule != initial.repeatRule {
            arguments["recurrence"] = .array((current.repeatRule ?? []).map(JSONValue.string))
        }
        return arguments
    }
}
