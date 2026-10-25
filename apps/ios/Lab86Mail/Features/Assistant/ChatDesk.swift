import Foundation

// The opening state of the chat, "the desk" (docs/research/ios-refresh-design-
// 2026-10-24.md): a dateline from the clock, one sentence from the user's own
// day, and up to four rows the user can send with a tap. Pure value type: the
// view hands it the store's data and the clock, so tests can prove every
// sentence without a view or a server.

struct ChatDesk: Equatable, Sendable {
    /// An unread thread in the main inbox. `waitsOnReply` is true only when the
    /// server classified the thread as one that needs a reply.
    struct Mail: Equatable, Sendable {
        let id: String
        let senderName: String
        let subject: String
        let date: Date
        var waitsOnReply = false
    }

    /// One of today's events.
    struct Event: Equatable, Sendable {
        let id: String
        let title: String
        let start: Date
        let end: Date
        var allDay = false
    }

    /// An Albatross that cannot move without the user.
    struct Work: Equatable, Sendable {
        let id: String
        let title: String
    }

    /// An area whose overview counts Work that needs the user.
    struct Area: Equatable, Sendable {
        let id: String
        let name: String
        let needsYou: Int
    }

    struct Input: Equatable, Sendable {
        var mail: [Mail] = []
        var events: [Event] = []
        var work: [Work] = []
        var areas: [Area] = []

        init(mail: [Mail] = [], events: [Event] = [], work: [Work] = [], areas: [Area] = []) {
            self.mail = mail
            self.events = events
            self.work = work
            self.areas = areas
        }
    }

    /// One row: the ask the tap sends, and where it comes from.
    struct Row: Identifiable, Equatable, Sendable {
        enum Kind: Equatable, Sendable {
            case mail, event, work, area, fixed
        }

        let id: String
        let kind: Kind
        let ask: String
        let source: String?
    }

    let dateline: String
    let sentence: String
    let rows: [Row]

    static let fallbackSentence = "What should Albatross take on?"
    static let rowLimit = 4
    /// The asks that fill the list when the day has fewer real items.
    static let fixedAsks = [
        "What needs my reply today?",
        "Walk me through my afternoon",
        "What changed in my areas overnight?",
        "Draft a reply to my newest thread",
    ]
    static let sendHint = "Sends this to Albatross"

    static func make(
        input: Input,
        now: Date,
        calendar: Calendar = .autoupdatingCurrent,
        locale: Locale = .autoupdatingCurrent
    ) -> ChatDesk {
        ChatDesk(
            dateline: dateline(now: now, calendar: calendar, locale: locale),
            sentence: sentence(input: input, now: now, calendar: calendar, locale: locale),
            rows: rows(input: input, now: now, calendar: calendar, locale: locale)
        )
    }

    // MARK: - The dateline

    /// "Friday afternoon": the weekday in the user's language and the part of
    /// the day.
    static func dateline(now: Date, calendar: Calendar, locale: Locale) -> String {
        let weekday = now.formatted(style(calendar: calendar, locale: locale).weekday(.wide))
        return "\(weekday) \(partOfDay(hour: calendar.component(.hour, from: now)))"
    }

    static func partOfDay(hour: Int) -> String {
        if hour < 12 { return "morning" }
        if hour < 17 { return "afternoon" }
        return "evening"
    }

    // MARK: - The sentence

    /// The first two of: who wrote, the next event today, and the Work that
    /// needs the user. Two parts keep the sentence inside three display lines
    /// on a phone. With no data at all, the fallback asks the question.
    static func sentence(input: Input, now: Date, calendar: Calendar, locale: Locale) -> String {
        let parts = [
            mailSentence(input.mail),
            eventSentence(input.events, now: now, calendar: calendar, locale: locale),
            workSentence(work: input.work, areas: input.areas),
        ].compactMap { $0 }
        guard !parts.isEmpty else { return fallbackSentence }
        return parts.prefix(2).joined(separator: " ")
    }

    /// "Sarah and Priya wrote to you." The verb says what the data proves: a
    /// reply is waited on only when every named thread carries that mark.
    static func mailSentence(_ mail: [Mail]) -> String? {
        var names: [String] = []
        var waits = true
        for item in mail {
            let name = firstName(item.senderName)
            guard !name.isEmpty, !names.contains(name) else { continue }
            names.append(name)
            waits = waits && item.waitsOnReply
        }
        guard !names.isEmpty else { return nil }
        // Three names read as a list; more than that, the first two and a
        // count in words. "And 1 other" read as a form, not a sentence.
        let subject: String
        switch names.count {
        case 1: subject = names[0]
        case 2: subject = "\(names[0]) and \(names[1])"
        case 3: subject = "\(names[0]), \(names[1]), and \(names[2])"
        default: subject = "\(names[0]), \(names[1]), and \(countWord(names.count - 2)) others"
        }
        if waits {
            return names.count == 1 ? "\(subject) waits on a reply." : "\(subject) wait on a reply."
        }
        return "\(subject) wrote to you."
    }

    /// "Standup starts at 3:30 PM." The next timed event today; when none is
    /// left, the one that runs now; else an all-day event.
    static func eventSentence(_ events: [Event], now: Date, calendar: Calendar, locale: Locale) -> String? {
        let style = style(calendar: calendar, locale: locale).hour().minute()
        if let next = nextEvent(events, now: now) {
            return "\(next.title) starts at \(next.start.formatted(style))."
        }
        if let current = events.filter({ !$0.allDay && $0.start <= now && $0.end > now }).min(by: { $0.end < $1.end }) {
            return "\(current.title) runs until \(current.end.formatted(style))."
        }
        if let allDay = events.first(where: \.allDay) {
            return "\(allDay.title) is all day."
        }
        return nil
    }

    /// The next timed event that has not started.
    static func nextEvent(_ events: [Event], now: Date) -> Event? {
        events.filter { !$0.allDay && $0.start > now }.min { $0.start < $1.start }
    }

    /// "One Albatross needs you." Work first; without Work, the areas that
    /// count some.
    static func workSentence(work: [Work], areas: [Area]) -> String? {
        if !work.isEmpty {
            return work.count == 1 ? "One Albatross needs you." : "\(work.count) Albatrosses need you."
        }
        let areasNeedingYou = areas.filter { $0.needsYou > 0 }
        guard let first = areasNeedingYou.first else { return nil }
        if areasNeedingYou.count == 1 { return "\(first.name) needs you." }
        return "\(areasNeedingYou.count) areas need you."
    }

    // MARK: - The rows

    /// Two mail rows, the next event, one Work or area row, then fixed asks
    /// up to the limit. Each real row carries its source line.
    static func rows(input: Input, now: Date, calendar: Calendar, locale: Locale) -> [Row] {
        var rows: [Row] = []
        let base = style(calendar: calendar, locale: locale)
        for item in input.mail.prefix(2) {
            let when = calendar.isDate(item.date, inSameDayAs: now)
                ? item.date.formatted(base.hour().minute())
                : item.date.formatted(base.month(.abbreviated).day())
            rows.append(Row(
                id: "mail-\(item.id)",
                kind: .mail,
                ask: "Reply to \(firstName(item.senderName)) about “\(item.subject)”",
                source: "\(item.senderName), \(when)"
            ))
        }
        if let event = nextEvent(input.events, now: now) {
            rows.append(Row(
                id: "event-\(event.id)",
                kind: .event,
                ask: "Get ready for \(event.title)",
                source: "Today at \(event.start.formatted(base.hour().minute()))"
            ))
        }
        if let work = input.work.first {
            rows.append(Row(
                id: "work-\(work.id)",
                kind: .work,
                ask: "What does “\(work.title)” need from me?",
                source: "Waiting on you"
            ))
        } else if let area = input.areas.first(where: { $0.needsYou > 0 }) {
            rows.append(Row(
                id: "area-\(area.id)",
                kind: .area,
                ask: "What does \(area.name) need from me?",
                source: area.needsYou == 1
                    ? "Area, one thing waits on you"
                    : "Area, \(countWord(area.needsYou)) things wait on you"
            ))
        }
        var result = Array(rows.prefix(rowLimit))
        for (index, ask) in fixedAsks.enumerated() where result.count < rowLimit {
            result.append(Row(id: "fixed-\(index)", kind: .fixed, ask: ask, source: nil))
        }
        return result
    }

    // MARK: - Helpers

    /// Small counts in words, as a sentence writes them; 10 and up in digits.
    static func countWord(_ count: Int) -> String {
        let words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
        return words.indices.contains(count) ? words[count] : "\(count)"
    }

    /// "Priya Patel" gives "Priya"; a bare address gives its mailbox.
    static func firstName(_ name: String) -> String {
        let cleaned = name
            .replacingOccurrences(of: "\"", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.contains("@"), !cleaned.contains(" ") {
            return String(cleaned.prefix { $0 != "@" })
        }
        return cleaned.split(separator: " ").first.map(String.init) ?? cleaned
    }

    private static func style(calendar: Calendar, locale: Locale) -> Date.FormatStyle {
        Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
    }
}

// MARK: - From the store

extension ChatDesk.Input {
    /// Mail categories whose threads a person answers. Codes, orders, noise,
    /// and label-filed mail stay out of the desk.
    static func isReplyCandidate(category: String?) -> Bool {
        guard let category else { return true }
        return category == "main" || category == "needs_reply"
    }

    /// A sender nobody replies to.
    static func isNoReply(email: String?) -> Bool {
        guard let email = email?.lowercased() else { return false }
        return ["no-reply", "noreply", "donotreply", "do-not-reply"].contains { email.contains($0) }
    }

    /// The desk's data from the product store. Reads only; the store stays as
    /// it is.
    @MainActor
    init(store: ProductStore) {
        let mail = store.threads
            .filter { $0.unread && Self.isReplyCandidate(category: $0.category) && !Self.isNoReply(email: $0.senderEmail) }
            .sorted { $0.date > $1.date }
            .prefix(6)
            .map { thread in
                ChatDesk.Mail(
                    id: thread.id,
                    senderName: thread.senderDisplayName,
                    subject: thread.subject,
                    date: thread.date,
                    waitsOnReply: thread.category == "needs_reply"
                )
            }
        let events = store.todaysEvents.map { event in
            ChatDesk.Event(id: event.id, title: event.title, start: event.start, end: event.end, allDay: event.allDay)
        }
        let work = store.allWork.filter(\.needsYou).map { ChatDesk.Work(id: $0.id, title: $0.displayTitle) }
        let areas = store.areas.compactMap { area -> ChatDesk.Area? in
            guard let overview = area.overview, overview.needsYou > 0 else { return nil }
            return ChatDesk.Area(id: area.id, name: area.name, needsYou: overview.needsYou)
        }
        self.init(mail: Array(mail), events: events, work: work, areas: areas)
    }
}

extension AssistantChatModel {
    /// The inline title: the first thing the user said, or "New chat".
    var conversationTitle: String {
        let first = messages.first(where: { $0.role == .user })?.text
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return first?.nilIfBlank ?? Self.newChatTitle
    }

    static let newChatTitle = "New chat"
}
