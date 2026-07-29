import Foundation

// The arithmetic behind the calendar's grids and timelines, kept free of
// SwiftUI so it can be tested directly. The month, week and year views all
// draw from here rather than each deriving their own geometry.

enum CalendarGrid {
    // A month as rows of weekday slots, `nil` where a slot belongs to a
    // neighbouring month.
    //
    // Building one matrix matters: the previous mini-month emitted a run of
    // blank placeholders identified 0..<n followed by day numbers identified
    // 1...31, and a SwiftUI grid silently drops the cells whose identities
    // collide — which is why every mini month was missing its first few days.
    static func weeks(ofMonthContaining date: Date, calendar: Calendar) -> [[Int?]] {
        guard let interval = calendar.dateInterval(of: .month, for: date),
              let days = calendar.range(of: .day, in: .month, for: date)
        else { return [] }
        var cells: [Int?] = Array(
            repeating: nil,
            count: leadingBlanks(monthStart: interval.start, calendar: calendar)
        )
        cells += days.map { Optional($0) }
        while cells.count % 7 != 0 { cells.append(nil) }
        return stride(from: 0, to: cells.count, by: 7).map { Array(cells[$0..<$0 + 7]) }
    }

    // How many slots the first row leaves empty before the 1st, honouring the
    // user's first day of the week.
    static func leadingBlanks(monthStart: Date, calendar: Calendar) -> Int {
        let weekday = calendar.component(.weekday, from: monthStart)
        return (weekday - calendar.firstWeekday + 7) % 7
    }

    // Weekday initials rotated into the order the user's week starts in.
    static func weekdayInitials(calendar: Calendar) -> [String] {
        let symbols = calendar.veryShortStandaloneWeekdaySymbols
        guard symbols.count == 7 else { return symbols }
        let offset = calendar.firstWeekday - 1
        return (0..<7).map { symbols[($0 + offset) % 7] }
    }
}

// MARK: - Timeline placement

enum TimelineLayout {
    static let minutesPerDay = 24 * 60
    // No event reads as a hairline: a zero-length or heavily clipped event
    // still claims a quarter hour of the axis.
    static let minimumMinutes = 15

    struct Placement: Identifiable, Equatable {
        let event: CalendarEventSummary
        let lane: Int
        let laneCount: Int
        let startMinutes: Int
        let endMinutes: Int

        var id: String { event.id + event.accountID }
    }

    // Overlapping events share the width of their cluster the way Apple and
    // Google lay them out: greedy lane assignment inside each cluster of
    // transitively overlapping events, so a cluster of three splits in thirds
    // while an unrelated event elsewhere in the day still gets full width.
    static func place(
        _ events: [CalendarEventSummary],
        on day: Date,
        calendar: Calendar
    ) -> [Placement] {
        let dayStart = calendar.startOfDay(for: day)
        let sorted = events.sorted {
            $0.start == $1.start ? $0.end > $1.end : $0.start < $1.start
        }

        func minutes(_ date: Date) -> Int {
            Int((date.timeIntervalSince(dayStart) / 60).rounded(.down))
        }

        var result: [Placement] = []
        var cluster: [(event: CalendarEventSummary, lane: Int)] = []
        var laneEnds: [Date] = []
        var clusterEnd = Date.distantPast

        func flush() {
            let count = max(1, laneEnds.count)
            result += cluster.map { entry in
                let start = min(
                    max(minutes(entry.event.start), 0),
                    minutesPerDay - minimumMinutes
                )
                let end = min(
                    max(minutes(entry.event.end), start + minimumMinutes),
                    minutesPerDay
                )
                return Placement(
                    event: entry.event,
                    lane: entry.lane,
                    laneCount: count,
                    startMinutes: start,
                    endMinutes: end
                )
            }
            cluster = []
            laneEnds = []
        }

        for event in sorted {
            if !cluster.isEmpty, event.start >= clusterEnd { flush() }
            if let free = laneEnds.firstIndex(where: { $0 <= event.start }) {
                laneEnds[free] = event.end
                cluster.append((event, free))
            } else {
                laneEnds.append(event.end)
                cluster.append((event, laneEnds.count - 1))
            }
            clusterEnd = max(clusterEnd, event.end)
        }
        flush()
        return result
    }
}

// MARK: - Day cell contents

// What a month day cell shows: the day's own entries in reading order, capped
// to what the cell can hold, with the remainder counted rather than hidden.
enum DayChips {
    struct Chip: Identifiable, Equatable {
        enum Kind: Equatable { case allDay, timed, task }

        let id: String
        let title: String
        let kind: Kind
        // The identity the colour family is derived from — the calendar for an
        // event, so one calendar reads as one colour across the month.
        let seed: String
    }

    static func make(
        events: [CalendarEventSummary],
        tasks: [TaskSummary],
        limit: Int
    ) -> (chips: [Chip], overflow: Int) {
        // All-day entries lead, as they do in Apple Calendar, then timed
        // entries in clock order, then what is merely due that day.
        let allDay = events.filter(\.allDay).sorted { $0.title < $1.title }
        let timed = events.filter { !$0.allDay }.sorted { $0.start < $1.start }
        let ordered =
            allDay.map { Chip(id: $0.id + $0.accountID, title: $0.title, kind: .allDay, seed: seed(for: $0)) }
            + timed.map { Chip(id: $0.id + $0.accountID, title: $0.title, kind: .timed, seed: seed(for: $0)) }
            + tasks.map { Chip(id: "task:" + $0.id, title: $0.title, kind: .task, seed: "task") }

        guard limit > 0 else { return ([], ordered.count) }
        guard ordered.count > limit else { return (ordered, 0) }
        // The overflow count needs a slot of its own, so the last visible chip
        // gives way to it rather than the count covering a chip that is shown.
        let shown = Array(ordered.prefix(limit - 1))
        return (shown, ordered.count - shown.count)
    }

    static func seed(for event: CalendarEventSummary) -> String {
        event.calendarID?.nilIfBlank ?? event.accountID.nilIfBlank ?? "calendar"
    }
}

// Matches the file-scoped helper ProductModels and AssistantChatModel each
// carry; the declaration is private in both, so it is not visible here.
private extension String {
    var nilIfBlank: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}
