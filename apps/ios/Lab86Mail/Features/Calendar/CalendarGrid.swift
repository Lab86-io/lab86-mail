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

    // One identity for an event across every grid: the provider id and the
    // account joined through a separator neither can contain, so "ab"+"c"
    // and "a"+"bc" stop colliding and a tap can never open the wrong event.
    static let entityKeySeparator = "\u{1F}"

    static func entityKey(id: String, accountID: String) -> String {
        id + entityKeySeparator + accountID
    }

    static func entityKey(for event: CalendarEventSummary) -> String {
        entityKey(id: event.id, accountID: event.accountID)
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

        var id: String { CalendarGrid.entityKey(for: event) }
    }

    // Where a moment sits on the day's 24 wall-clock hour rows. The axis is
    // drawn from hour labels, so a 23:00 event on the 23-hour day in March
    // belongs beside "23", not an hour early where its elapsed minutes would
    // put it; on the 25-hour day in November the repeated hour collapses onto
    // the row it reads as. Moments outside the day clamp to its edges.
    static func wallClockMinutes(of date: Date, on day: Date, calendar: Calendar) -> Int {
        let dayStart = calendar.startOfDay(for: day)
        guard date >= dayStart else { return 0 }
        guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart), date < dayEnd else {
            return minutesPerDay
        }
        let components = calendar.dateComponents([.hour, .minute], from: date)
        return (components.hour ?? 0) * 60 + (components.minute ?? 0)
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
        let sorted = events.sorted {
            $0.start == $1.start ? $0.end > $1.end : $0.start < $1.start
        }

        func minutes(_ date: Date) -> Int {
            wallClockMinutes(of: date, on: day, calendar: calendar)
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
        // The calendar the chip belongs to, so the grid can paint it in the
        // calendar's own colour. Nil for a task.
        var calendarKey: String?
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
            allDay.map {
                Chip(
                    id: CalendarGrid.entityKey(for: $0), title: $0.title, kind: .allDay,
                    seed: seed(for: $0), calendarKey: CalendarVisibility.key(for: $0)
                )
            }
            + timed.map {
                Chip(
                    id: CalendarGrid.entityKey(for: $0), title: $0.title, kind: .timed,
                    seed: seed(for: $0), calendarKey: CalendarVisibility.key(for: $0)
                )
            }
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

// MARK: - Hour axis

// The hour gutter of the day and week timelines. Its width comes from the
// widest label the locale produces ("12 AM", "23"), not from a constant, so
// the labels never cut to "2…" at accessibility text sizes (D2).
enum HourAxis {
    static func label(hour: Int, on day: Date, calendar: Calendar) -> String {
        let date = calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day) ?? day
        return date.formatted(.dateTime.hour())
    }

    static func labels(on day: Date, calendar: Calendar) -> [String] {
        (0..<24).map { label(hour: $0, on: day, calendar: calendar) }
    }

    // The label the gutter is measured against. The longest string wins; a tie
    // goes to the later hour, whose digits are wider ("10", "11", "12").
    static func widestLabel(on day: Date, calendar: Calendar) -> String {
        var widest = ""
        for label in labels(on: day, calendar: calendar) where label.count >= widest.count {
            widest = label
        }
        return widest
    }

    // The hour the timeline opens on. Today opens an hour before now once the
    // day is under way; before the first entry it opens on that entry, so the
    // morning is not hidden under hours of empty grid (D12). Another day opens
    // on its first entry, or on 8 when it has none.
    static func openingHour(now: Date, isToday: Bool, firstStart: Date?, calendar: Calendar) -> Int {
        if let firstStart {
            let firstHour = calendar.component(.hour, from: firstStart)
            if !isToday || now < firstStart { return max(0, firstHour - 1) }
        }
        if isToday { return max(0, calendar.component(.hour, from: now) - 1) }
        return 8
    }

    // The height of one hour row. It grows with the text, at six tenths of the
    // text's growth, so a day stays scrollable at the largest sizes while the
    // labels and titles still fit.
    static func hourHeight(base: CGFloat, textScale: CGFloat) -> CGFloat {
        let scale = max(1, textScale)
        return (base * (1 + (scale - 1) * 0.6)).rounded()
    }

    // The hour labels grow with the text to a ceiling. They are the axis,
    // not the content: at the largest sizes an uncapped label would take a
    // quarter of the screen for "12 AM" and leave the events no room.
    static let maximumLabelFontSize: CGFloat = 20

    static func labelFontSize(scaled: CGFloat) -> CGFloat {
        min(max(scaled, 1), maximumLabelFontSize)
    }
}

// The day numerals of the strips grow with the text to a ceiling, so seven
// of them always fit across a phone.
enum DayNumeralSize {
    static let maximumAccessibleFontSize: CGFloat = 24

    static func accessibleFontSize(scaled: CGFloat) -> CGFloat {
        min(max(scaled, 1), maximumAccessibleFontSize)
    }
}

// MARK: - Block text

// How much of its title an event block shows. A block narrower than a few
// characters shows no text at all (its colour says it is there); a narrow
// column shows one line cut at the end, never a word broken in the middle
// (D11); a wide block shows as many lines as its height holds, to a limit.
enum BlockText {
    struct Plan: Equatable {
        let lines: Int
        var showsText: Bool { lines > 0 }
    }

    static func plan(
        width: CGFloat,
        height: CGFloat,
        fontSize: CGFloat,
        inset: CGFloat = 8,
        maxLines: Int = 3
    ) -> Plan {
        guard fontSize > 0 else { return Plan(lines: 0) }
        let lineHeight = fontSize * 1.22
        let characterWidth = fontSize * 0.52
        let characters = (width - inset) / characterWidth
        guard characters >= 4 else { return Plan(lines: 0) }
        let rows = Int((height - 4) / lineHeight)
        guard rows >= 1 else { return Plan(lines: 0) }
        if characters < 10 { return Plan(lines: 1) }
        return Plan(lines: min(rows, maxLines))
    }
}

// MARK: - Slots

// Where a touch on the empty grid lands in time. A hold on the grid creates
// an event at that slot.
enum TimelineSlot {
    static let defaultSnapMinutes = 30

    static func minutes(forY y: CGFloat, hourHeight: CGFloat, snap: Int = defaultSnapMinutes) -> Int {
        guard hourHeight > 0, snap > 0 else { return 0 }
        let raw = Int((y / hourHeight * 60).rounded(.down))
        let snapped = (raw / snap) * snap
        return min(max(snapped, 0), TimelineLayout.minutesPerDay - snap)
    }

    static func start(
        forY y: CGFloat,
        hourHeight: CGFloat,
        on day: Date,
        calendar: Calendar,
        snap: Int = defaultSnapMinutes
    ) -> Date {
        let total = minutes(forY: y, hourHeight: hourHeight, snap: snap)
        let start = calendar.startOfDay(for: day)
        return calendar.date(byAdding: .minute, value: total, to: start) ?? start
    }

    // The week column under an x position, or nil in the gutter.
    static func column(forX x: CGFloat, gutter: CGFloat, columnWidth: CGFloat, count: Int = 7) -> Int? {
        guard columnWidth > 0, x >= gutter else { return nil }
        let index = Int((x - gutter) / columnWidth)
        return index < count ? index : nil
    }
}

// MARK: - Calendar colours

// A provider calendar colour ("#3B6E8F") as red, green, blue in 0...1. The
// view turns it into a Color; this part stays testable.
enum CalendarPalette {
    struct RGB: Equatable {
        let red: Double
        let green: Double
        let blue: Double
    }

    static func rgb(hex: String?) -> RGB? {
        guard let hex else { return nil }
        var digits = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if digits.hasPrefix("#") { digits.removeFirst() }
        if digits.count == 3 {
            digits = digits.map { "\($0)\($0)" }.joined()
        }
        guard digits.count == 6 || digits.count == 8,
              digits.allSatisfy(\.isHexDigit),
              let value = UInt32(digits.prefix(6), radix: 16)
        else { return nil }
        return RGB(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}

// MARK: - Visibility

// A calendar the user hid stays out of every grid. The key joins the account
// and the calendar, the same identity `CalendarChoice.id` carries.
enum CalendarVisibility {
    static func key(accountID: String, calendarID: String) -> String {
        "\(accountID):\(calendarID)"
    }

    static func key(for event: CalendarEventSummary) -> String? {
        guard let calendarID = event.calendarID?.nilIfBlank else { return nil }
        return key(accountID: event.accountID, calendarID: calendarID)
    }

    static func visible(_ events: [CalendarEventSummary], hiddenKeys: Set<String>) -> [CalendarEventSummary] {
        guard !hiddenKeys.isEmpty else { return events }
        return events.filter { event in
            guard let key = key(for: event) else { return true }
            return !hiddenKeys.contains(key)
        }
    }
}

// MARK: - Reconnect

// The accounts whose calendar sign-in ended, as the store lists them, in a
// stable order for the banner.
enum CalendarReconnect {
    static func accounts(unauthorizedIDs: Set<String>, accounts: [AccountSummary]) -> [AccountSummary] {
        accounts
            .filter { unauthorizedIDs.contains($0.id) }
            .sorted { $0.email.localizedCaseInsensitiveCompare($1.email) == .orderedAscending }
    }

    static func message(for account: AccountSummary) -> String {
        "\(account.email) stopped syncing its calendar. Sign in again to see its events."
    }
}

// MARK: - Bar title

// What the navigation bar says in each mode. Month and year scroll, so the
// title follows the period under the reader's eye (D17); day and week name
// the selected day's month.
enum CalendarTitle {
    static func text(mode: String, visibleMonth: Date?, visibleYear: Int?, selectedDay: Date, calendar: Calendar) -> String {
        switch mode {
        case "year":
            return String(visibleYear ?? calendar.component(.year, from: selectedDay))
        case "month":
            return (visibleMonth ?? selectedDay).formatted(.dateTime.month(.wide).year())
        default:
            return selectedDay.formatted(.dateTime.month(.wide).year())
        }
    }
}

// MARK: - Month cells

// At accessibility text sizes a month cell cannot hold titles; it shows one
// dot for each entry in the calendar's colour instead.
enum MonthCellStyle {
    static let dotLimit = 3

    static func showsTitles(isAccessibilitySize: Bool) -> Bool {
        !isAccessibilitySize
    }
}

// Matches the file-scoped helper ProductModels and AssistantChatModel each
// carry; the declaration is private in both, so it is not visible here.
