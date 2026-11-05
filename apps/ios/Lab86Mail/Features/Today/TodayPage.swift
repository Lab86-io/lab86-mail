import Foundation

// The live Today page (docs/research/today-live-2026-11-04.md), a port of
// `lib/obligations/today-page.ts` and the row rules of
// `components/needs-you/NeedsYouRow.tsx`. Pure: the note at the top, the rows
// of the list, and the day's schedule. All of it reads the ledger and the
// calendar at this moment, so no sentence goes stale after the morning. No
// model writes these words. TodayPageTests holds it to the web's answers.

/// One row of the Today list: the entry, and the other notices from the same
/// sender. Done and Later close them with the row.
struct TodayRow: Identifiable, Hashable, Sendable {
    let entry: NeedsYouEntry
    var others: [ObligationView] = []
    /// Due now or today. The row's first action carries the accent only then.
    var urgent = false

    var id: String { entry.id }
    var otherIDs: [String] { others.map(\.id) }
}

struct TodayRows: Hashable, Sendable {
    let rows: [TodayRow]
    /// Open rows that the list does not show.
    let more: Int
    /// Every open row, shown or not. The notices of one sender count once.
    let open: Int
    /// The open rows that are due now or today.
    let dueToday: Int
}

/// The moment of an event, as `scheduleLines` reads it.
enum TodayScheduleState: Hashable, Sendable {
    case past
    case now
    case next
    case later
}

struct TodayScheduleEvent: Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let startAt: ObligationMillis
    let endAt: ObligationMillis
    var allDay = false
    var location: String?
    var status: String?
    /// The calendar row a tap opens.
    var summary: CalendarEventSummary?

    init(
        id: String,
        title: String,
        startAt: ObligationMillis,
        endAt: ObligationMillis,
        allDay: Bool = false,
        location: String? = nil,
        status: String? = nil,
        summary: CalendarEventSummary? = nil
    ) {
        self.id = id
        self.title = title
        self.startAt = startAt
        self.endAt = endAt
        self.allDay = allDay
        self.location = location
        self.status = status
        self.summary = summary
    }

    /// One event id can repeat across accounts, so the row id names both.
    init(summary: CalendarEventSummary) {
        self.init(
            id: "\(summary.accountID):\(summary.id)",
            title: summary.title,
            startAt: NeedsYouClock.millis(summary.start),
            endAt: NeedsYouClock.millis(summary.end),
            allDay: summary.allDay,
            location: summary.location,
            summary: summary
        )
    }
}

enum TodayScheduleLine: Identifiable, Hashable, Sendable {
    case event(TodayScheduleEvent, state: TodayScheduleState)
    case open(id: String, until: ObligationMillis)

    var id: String {
        switch self {
        case .event(let event, _): event.id
        case .open(let id, _): id
        }
    }
}

/// The two lines of the note: what needs the person, and what the day does next.
struct TodayNoteLines: Hashable, Sendable {
    let lead: String
    let day: String
}

/// The tone of the status word on a row. On this list a due word says one
/// thing: time is short. An urgent item with no due word has a tag.
enum TodayStatusTone: Hashable, Sendable {
    case plain
    case hot
    case tag
}

/// The words of one row, so the row and the tests agree.
struct TodayRowWords: Hashable, Sendable {
    let name: String
    let place: String
    let line: String
    let status: String
    let statusTone: TodayStatusTone
    /// The digits of an open code, spaced. They replace the line.
    let code: String?
}

/// What a button of a row does.
enum TodayRowAction: Hashable, Sendable {
    case reply
    case copy
    case accept
    case decline
    case startInAlbatross
    case open
    case answer
    case done
}

struct TodayRowButton: Identifiable, Hashable, Sendable {
    let title: String
    let action: TodayRowAction
    let isPrimary: Bool

    var id: String { title }
}

/// A row that the user closed. It stays in its old place for the Undo window.
struct TodayLeavingRow: Hashable, Sendable {
    let row: TodayRow
    let index: Int
    /// The word beside Undo: "Done", "Later", "Replied", "Not mine".
    let word: String
}

enum TodayPage {
    /// `TODAY_NEEDS_YOU_CAP`.
    static let needsYouCap = 6
    /// At most this many short facts.
    static let worthKnowingLimit = 2
    /// A gap this long is worth a line: it is the room to do what the list asks.
    static let openGapMillis: ObligationMillis = 60 * 60_000
    /// Below this page width the list and the schedule stack.
    static let columnsWidth: CGFloat = 860
    /// Below this list width the actions sit under the text of the row.
    static let actionsBesideWidth: CGFloat = 560
    /// The schedule column beside the list.
    static let asideWidth: CGFloat = 288
    static let columnGap: CGFloat = 48

    // MARK: - Layout

    static func usesColumns(pageWidth: CGFloat) -> Bool {
        pageWidth >= columnsWidth
    }

    /// The width the list has inside the page.
    static func listWidth(pageWidth: CGFloat, asideWidth: CGFloat = TodayPage.asideWidth) -> CGFloat {
        usesColumns(pageWidth: pageWidth) ? pageWidth - asideWidth - columnGap : pageWidth
    }

    static func actionsBeside(listWidth: CGFloat, isAccessibilitySize: Bool) -> Bool {
        !isAccessibilitySize && listWidth >= actionsBesideWidth
    }

    /// The page shows for a user in the flag, on the current edition only. A
    /// past edition and everyone else keep the page they have.
    static func showsLivePage(enabled: Bool, showsLatestEdition: Bool) -> Bool {
        enabled && showsLatestEdition
    }

    // MARK: - The rows of the list

    /// One sender: the same name at the same domain. A company writes from
    /// more than one mailbox, and two companies can show the same short name.
    private static func senderKey(_ obligation: ObligationView) -> String {
        let name = obligation.asker.trimmingCharacters(in: .whitespacesAndNewlines)
        let domain = (obligation.askerAddress ?? "").split(separator: "@").dropFirst().first.map(String.init) ?? ""
        return "\(name)|\(domain.trimmingCharacters(in: .whitespacesAndNewlines))".lowercased()
    }

    /// Only a notice bundles. Two questions from one person are two things to answer.
    private static func bundles(_ obligation: ObligationView) -> Bool {
        obligation.kind == .change && !obligation.isClosed
    }

    /// The first group holds what is due now and today, in the page order.
    /// After it, a question from a person leads, then work, then notices. The
    /// later groups otherwise put a notice with a due word above a question
    /// with none.
    private static func laterRank(_ entry: NeedsYouEntry) -> Int {
        guard case .obligation(let obligation) = entry else { return 0 }
        switch obligation.kind {
        case .reply: return 0
        case .change: return 2
        case .action, .waiting, .code, .rsvp, .prepare, .unknown: return 1
        }
    }

    /// The rows of the Today list: the page groups without Waiting on others
    /// and Closed today, with the notices of one sender in one row, cut at
    /// the cap (`todayRows`).
    static func rows(groups: [NeedsYouGroup], cap: Int = TodayPage.needsYouCap) -> TodayRows {
        let active = groups.filter { $0.id != .closedToday && $0.id != .waiting }
        let urgent = active.filter { $0.id == .now || $0.id == .today }
        let later = active.filter { $0.id != .now && $0.id != .today }
        let laterEntries = later.flatMap(\.entries).enumerated().sorted { left, right in
            let leftRank = laterRank(left.element)
            let rightRank = laterRank(right.element)
            return leftRank == rightRank ? left.offset < right.offset : leftRank < rightRank
        }.map(\.element)
        let urgentEntries = urgent.flatMap(\.entries)
        let urgentIDs = Set(urgentEntries.map(\.id))
        let ordered = urgentEntries + laterEntries

        var rows: [TodayRow] = []
        var rowOfSender: [String: Int] = [:]
        for entry in ordered {
            if case .obligation(let obligation) = entry, bundles(obligation) {
                let key = senderKey(obligation)
                if let index = rowOfSender[key] {
                    rows[index].others.append(obligation)
                    continue
                }
                rowOfSender[key] = rows.count
            }
            rows.append(TodayRow(entry: entry, urgent: urgentIDs.contains(entry.id)))
        }
        return TodayRows(
            rows: Array(rows.prefix(cap)),
            more: max(0, rows.count - cap),
            open: rows.count,
            dueToday: rows.filter(\.urgent).count
        )
    }

    /// The rows in view: the open list, with the row that leaves still in its
    /// old place. A row that came back (Undo) is on the list again, once.
    static func rowsInView(_ rows: [TodayRow], leaving: TodayLeavingRow?) -> [TodayRow] {
        guard let leaving, !rows.contains(where: { $0.id == leaving.row.id }) else { return rows }
        var shown = rows
        shown.insert(leaving.row, at: min(max(0, leaving.index), shown.count))
        return shown
    }

    // MARK: - The schedule

    private static func liveEvents(_ events: [TodayScheduleEvent]) -> [TodayScheduleEvent] {
        events.filter { !($0.status ?? "").lowercased().hasPrefix("cancel") }
    }

    /// The lines of the schedule at this moment: timed events in order, with
    /// their state. An open stretch of an hour or more after now gets its own
    /// line, so the room in the day shows without a chart (`scheduleLines`).
    static func scheduleLines(_ events: [TodayScheduleEvent], now: ObligationMillis) -> [TodayScheduleLine] {
        let timed = liveEvents(events)
            .filter { !$0.allDay }
            .enumerated()
            .sorted { left, right in
                if left.element.startAt != right.element.startAt { return left.element.startAt < right.element.startAt }
                if left.element.endAt != right.element.endAt { return left.element.endAt < right.element.endAt }
                return left.offset < right.offset
            }
            .map(\.element)
        var lines: [TodayScheduleLine] = []
        var sawNext = false
        var cursor = now
        for event in timed {
            if event.endAt > now, event.startAt - cursor >= openGapMillis {
                lines.append(.open(id: "open:\(event.id)", until: event.startAt))
            }
            let state: TodayScheduleState
            if event.endAt <= now {
                state = .past
            } else if event.startAt <= now {
                state = .now
            } else if !sawNext {
                state = .next
                sawNext = true
            } else {
                state = .later
            }
            lines.append(.event(event, state: state))
            if event.endAt > cursor { cursor = event.endAt }
        }
        return lines
    }

    static func allDayEvents(_ events: [TodayScheduleEvent]) -> [TodayScheduleEvent] {
        liveEvents(events).filter(\.allDay)
    }

    // MARK: - The note

    /// "9:30 AM", "3 PM": as a person says it (`clockLabel`).
    static func clockLabel(_ at: ObligationMillis, timezone: String?) -> String {
        NeedsYouLabels.timeOfDay(at, timezone: timezone).replacingOccurrences(of: ":00", with: "")
    }

    /// Who to start with: the name that the first row leads with.
    private static func firstName(_ row: TodayRow) -> String {
        switch row.entry {
        case .albatross(let extra):
            switch extra.kind {
            case .approval: return "the approval for an Albatross"
            case .checkin: return "your daily check-in"
            case .question, .update: return "the question from an Albatross"
            }
        case .obligation(let obligation):
            let asker = obligation.asker.trimmingCharacters(in: .whitespacesAndNewlines)
            if obligation.kind == .prepare {
                let place = obligation.sourceLabel?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return place.isEmpty ? asker : place
            }
            return asker
        }
    }

    private static func leadLine(rows: [TodayRow], open: Int, dueToday: Int) -> String {
        guard let first = rows.first else { return "Nothing needs you right now." }
        let start = "Start with \(firstName(first))."
        if open == 1 { return "One thing needs you. \(start)" }
        if dueToday == open { return "\(open) things need you today. \(start)" }
        if dueToday > 0 { return "\(open) things need you, \(dueToday) of them today. \(start)" }
        return "\(open) things need you. \(start)"
    }

    private static func dayLine(lines: [TodayScheduleLine], now: ObligationMillis, timezone: String?) -> String {
        var current: TodayScheduleEvent?
        var next: TodayScheduleEvent?
        var eventCount = 0
        for line in lines {
            guard case .event(let event, let state) = line else { continue }
            eventCount += 1
            if state == .now, current == nil { current = event }
            if state == .next, next == nil { next = event }
        }
        if let current, let next {
            return "\(current.title) ends at \(clockLabel(current.endAt, timezone: timezone)). \(next.title) is next, at \(clockLabel(next.startAt, timezone: timezone))."
        }
        if let current {
            return "\(current.title) ends at \(clockLabel(current.endAt, timezone: timezone)). Nothing else is on your calendar today."
        }
        if let next {
            let minutes = Int(((next.startAt - now) / NeedsYouClock.minuteMillis).rounded())
            if minutes <= 1 { return "\(next.title) starts now." }
            if minutes <= 30 { return "\(next.title) starts in \(minutes) minutes." }
            return "No more events until \(next.title) at \(clockLabel(next.startAt, timezone: timezone))."
        }
        return eventCount > 0
            ? "Your calendar is clear for the rest of today."
            : "Nothing is on your calendar today."
    }

    /// The note: how much needs the person and where to start, then what the
    /// day does next. It reads the same data as the sections under it, so it
    /// can never say something that they do not show (`todayNote`).
    static func note(
        rows: [TodayRow],
        open: Int,
        dueToday: Int,
        lines: [TodayScheduleLine],
        now: ObligationMillis,
        timezone: String?
    ) -> TodayNoteLines {
        TodayNoteLines(
            lead: leadLine(rows: rows, open: open, dueToday: dueToday),
            day: dayLine(lines: lines, now: now, timezone: timezone)
        )
    }

    // MARK: - The words of a row

    private static let fullDays: [String: String] = [
        "Mon": "Monday",
        "Tue": "Tuesday",
        "Wed": "Wednesday",
        "Thu": "Thursday",
        "Fri": "Friday",
        "Sat": "Saturday",
        "Sun": "Sunday",
    ]

    /// A due word alone asks the reader to guess: "Fri" reads "Due Friday";
    /// an invitation says when it starts (`dueSentenceWord`).
    static func dueSentenceWord(kind: ObligationKind, text: String) -> String {
        let lowered = text.lowercased()
        if text.isEmpty || kind == .code || kind == .waiting || lowered.hasPrefix("over") || lowered.hasPrefix("past") {
            return text
        }
        let firstWord = text.split(separator: " ").first.map(String.init) ?? text
        let word: String
        if ["Today", "Tomorrow", "Yesterday"].contains(firstWord) {
            // "Tomorrow 1:05 PM" reads "tomorrow, 1:05 PM".
            let rest = text.dropFirst(firstWord.count)
            word = firstWord.lowercased() + (rest.isEmpty ? "" : ",\(rest)")
        } else {
            word = fullDays[text] ?? text
        }
        return "\(kind == .rsvp || kind == .prepare ? "Starts" : "Due") \(word)"
    }

    /// The line of a row, without the words that its first action says:
    /// "Review: Move the export" beside a Review button reads "Move the
    /// export" (`todayRowLine`).
    static func rowLine(_ title: String) -> String {
        var line = title
        if line.lowercased().hasPrefix("review:") {
            line = String(line.dropFirst("review:".count)).trimmingCharacters(in: .whitespaces)
        } else if line.lowercased().hasPrefix("answer the invitation:") {
            let rest = line.dropFirst("answer the invitation:".count).trimmingCharacters(in: .whitespaces)
            line = "Invitation: \(rest)"
        }
        if line.hasSuffix(".") { line.removeLast() }
        return line
    }

    /// The word of a row whose first action only opens the item (`firstActionWord`).
    static func firstActionWord(_ obligation: ObligationView) -> String {
        let title = obligation.title.lowercased()
        if title.hasPrefix("review") {
            let rest = title.dropFirst("review".count).first
            if rest == nil || !(rest?.isLetter == true || rest?.isNumber == true || rest == "_") { return "Review" }
        }
        return "Open"
    }

    /// The first action says what to do, in words from fixed rules. Done,
    /// Decline, and Later stay quiet (`rowPills` with `actionsInline`).
    static func buttons(for entry: NeedsYouEntry, copied: Bool = false) -> [TodayRowButton] {
        guard case .obligation(let obligation) = entry else {
            return [TodayRowButton(title: "Answer", action: .answer, isPrimary: true)]
        }
        if obligation.isClosed { return [] }
        if obligation.kind == .rsvp {
            return [
                TodayRowButton(title: "Accept", action: .accept, isPrimary: true),
                TodayRowButton(title: "Decline", action: .decline, isPrimary: false),
            ]
        }
        let first: TodayRowButton
        if obligation.kind == .code {
            first = TodayRowButton(title: copied ? "Copied" : "Copy", action: .copy, isPrimary: true)
        } else if NeedsYouPresentation.canSendReply(obligation) {
            first = TodayRowButton(title: obligation.draftReady ? "Open draft" : "Reply", action: .reply, isPrimary: true)
        } else if obligation.workID != nil {
            first = TodayRowButton(title: "Start in Albatross", action: .startInAlbatross, isPrimary: true)
        } else {
            first = TodayRowButton(title: firstActionWord(obligation), action: .open, isPrimary: true)
        }
        return [first, TodayRowButton(title: "Done", action: .done, isPrimary: false)]
    }

    /// Later, for every open obligation but a code.
    static func showsLater(_ entry: NeedsYouEntry) -> Bool {
        guard case .obligation(let obligation) = entry else { return false }
        return !obligation.isClosed && obligation.kind != .code
    }

    /// The mark on the avatar names the source, so the words name only the
    /// place, and not when the line already says it (`placeWords`).
    private static func placeWord(_ obligation: ObligationView) -> String {
        guard let place = obligation.sourceLabel?.trimmingCharacters(in: .whitespacesAndNewlines),
              !place.isEmpty, place != obligation.asker, !obligation.title.contains(place) else { return "" }
        return place
    }

    static func words(for row: TodayRow, now: ObligationMillis, timezone: String?) -> TodayRowWords {
        switch row.entry {
        case .albatross(let extra):
            return TodayRowWords(
                name: extra.kind == .checkin ? "Daily check-in" : extra.title,
                place: extra.kind == .approval ? "" : "Albatross",
                line: extra.line ?? NeedsYouPresentation.extraKindLabel(extra),
                status: extra.kind == .checkin ? "Today" : "Your turn",
                statusTone: extra.kind == .checkin ? .hot : .plain,
                code: nil
            )
        case .obligation(let obligation):
            let due = NeedsYouLabels.dueLabel(obligation, now: now, timezone: timezone)
            let urgent = obligation.pushLevel == .timeSensitive
            let status = due.text.isEmpty
                ? (urgent ? "Urgent" : "")
                : dueSentenceWord(kind: obligation.kind, text: due.text)
            let tone: TodayStatusTone
            if urgent, due.text.isEmpty {
                tone = .tag
            } else if due.tone == .plain, !urgent {
                tone = .plain
            } else {
                tone = .hot
            }
            let isOpenCode = obligation.kind == .code && !obligation.isClosed
            return TodayRowWords(
                name: obligation.asker,
                place: row.others.isEmpty ? placeWord(obligation) : "\(row.others.count + 1) notices",
                line: rowLine(obligation.title),
                status: status,
                statusTone: tone,
                code: isOpenCode ? obligation.code.map { NeedsYouLabels.spacedCode($0.value) } : nil
            )
        }
    }

    /// The round lead of a row: initials for a person, a glyph for a code or a
    /// source with no person behind it (`rowLeadKind`).
    static func lead(for entry: NeedsYouEntry) -> NeedsYouLead {
        guard case .obligation(let obligation) = entry else { return .glyph(PrimaryTab.work.symbol) }
        if obligation.kind == .code { return .glyph("key") }
        if obligation.kind == .prepare { return .glyph(NeedsYouPresentation.sourceGlyph(obligation.source)) }
        switch obligation.source {
        case .granola, .atlassian, .bitbucket:
            return .glyph(NeedsYouPresentation.sourceGlyph(obligation.source))
        case .mail, .slack, .drive, .github, .calendar, .other:
            return .initials(name: obligation.asker, seed: obligation.askerAddress ?? obligation.asker)
        }
    }

    /// The source mark on the avatar, for items that are not mail.
    static func sourceBadge(for entry: NeedsYouEntry) -> String? {
        guard case .obligation(let obligation) = entry, obligation.source != .mail else { return nil }
        return NeedsYouPresentation.sourceGlyph(obligation.source)
    }

    /// The spoken label of one row.
    static func accessibilityLabel(_ words: TodayRowWords) -> String {
        var parts = [words.name, words.place, words.status]
        if let code = words.code {
            parts.append("Verification code \(code)")
        } else {
            parts.append(words.line)
        }
        return parts.filter { !$0.isEmpty }.joined(separator: ", ")
    }
}
