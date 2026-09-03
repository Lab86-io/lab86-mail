import Foundation

// The horizon of one Work: now, later, or someday.
//
// A mirror of `lib/albatross/horizon.ts`. Dormant Work stays out of Today,
// the conductor does not move it, and no review asks about it. The rules
// live in one shape on both sides and both test suites pin them.

enum WorkHorizonKind: String, Codable, Hashable, Sendable, CaseIterable {
    case now
    case later
    case someday

    var label: String {
        switch self {
        case .now: "Now"
        case .later: "Later"
        case .someday: "Someday"
        }
    }
}

struct WorkHorizon: Hashable, Codable, Sendable {
    var kind: WorkHorizonKind
    /// The Work is dormant while now < notBefore.
    var notBefore: Date?
    /// A soft target date. Shown, never enforced.
    var by: Date?
    /// The user's own words, for example "after the wedding".
    var label: String?
    /// Set once when the wake nudge fired.
    var wokeAt: Date?

    init(
        kind: WorkHorizonKind,
        notBefore: Date? = nil,
        by: Date? = nil,
        label: String? = nil,
        wokeAt: Date? = nil
    ) {
        self.kind = kind
        self.notBefore = notBefore
        self.by = by
        self.label = label
        self.wokeAt = wokeAt
    }

    /// Decodes the server shape. Dates arrive as epoch milliseconds.
    init?(json: JSONValue?) {
        guard let json, json.objectValue != nil,
              let raw = json["kind"]?.stringValue,
              let kind = WorkHorizonKind(rawValue: raw) else { return nil }
        self.kind = kind
        notBefore = CalendarDateParser.date(json["notBefore"])
        by = CalendarDateParser.date(json["by"])
        label = json["label"]?.stringValue?.nilIfBlank
        wokeAt = CalendarDateParser.date(json["wokeAt"])
    }

    /// Dormant Work is kept, not carried. A future `notBefore` sleeps until
    /// that day. "Someday" sleeps until the user moves it. "Later" without a
    /// date also sleeps: nobody can wake it on a date it does not have.
    func isDormant(at now: Date) -> Bool {
        if let notBefore, notBefore > now { return true }
        if kind == .someday { return true }
        if kind == .later && notBefore == nil { return true }
        return false
    }

    /// Wake is due when the sleep date passed and no wake fired yet.
    func wakeIsDue(at now: Date) -> Bool {
        guard let notBefore, wokeAt == nil else { return false }
        return notBefore <= now
    }

    /// One short line for the UI. Nil when there is nothing to say: Work on
    /// the "now" horizon with no target date reads as plain Work.
    func line(at now: Date, calendar: Calendar = .current) -> String? {
        if kind == .someday { return "Someday" }
        if let notBefore, notBefore > now {
            return "Back on \(Self.shortDate(notBefore, now: now, calendar: calendar))"
        }
        if kind == .later {
            if notBefore != nil { return "Back now" }
            if let label { return Self.sentenceCase(label) }
            return "Later"
        }
        if let by {
            return "By \(Self.shortDate(by, now: now, calendar: calendar))"
        }
        return nil
    }

    /// The copy of the wake notification. Exactly one line.
    static func wakeLine(title: String) -> String {
        let clean = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return "\(clean.isEmpty ? "Something you kept" : clean) is back. Ready when you are."
    }

    /// "Friday" inside the coming week, "Nov 1" inside the year, then "Nov 1, 2027".
    static func shortDate(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        let locale = Locale(identifier: "en_US")
        if calendar.isDate(date, inSameDayAs: now) { return "today" }
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) ?? now
        if calendar.isDate(date, inSameDayAs: tomorrow) { return "tomorrow" }
        let daysAhead = calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: now),
            to: calendar.startOfDay(for: date)
        ).day ?? 0
        var style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        if daysAhead > 1 && daysAhead < 7 {
            style = style.weekday(.wide)
            return date.formatted(style)
        }
        if calendar.component(.year, from: date) == calendar.component(.year, from: now) {
            style = style.month(.abbreviated).day()
            return date.formatted(style)
        }
        style = style.month(.abbreviated).day().year()
        return date.formatted(style)
    }

    static func sentenceCase(_ value: String) -> String {
        let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = clean.first else { return clean }
        return String(first).uppercased() + clean.dropFirst()
    }
}

/// Anything that carries a horizon and a change date.
protocol WorkHorizonCarrying {
    var horizon: WorkHorizon? { get }
    var updatedAt: Date? { get }
}

extension WorkHorizonCarrying {
    func isDormant(at now: Date) -> Bool {
        horizon?.isDormant(at: now) ?? false
    }
}

enum WorkHorizonShelf {
    /// The "Later" shelf: dormant Work in wake order. Work without a wake
    /// date sits at the far end, newest change first.
    static func later<T: WorkHorizonCarrying>(_ rows: [T], now: Date) -> [T] {
        rows
            .filter { $0.isDormant(at: now) }
            .sorted { left, right in
                switch (left.horizon?.notBefore, right.horizon?.notBefore) {
                case let (leftDate?, rightDate?): return leftDate < rightDate
                case (.some, .none): return true
                case (.none, .some): return false
                case (.none, .none):
                    return (left.updatedAt ?? .distantPast) > (right.updatedAt ?? .distantPast)
                }
            }
    }
}

// MARK: - Deterministic phrase parse

/// The fallback when the capture model gives no horizon, and the oracle the
/// tests hold the model to. The horizon sheet calls it on each keystroke.
enum WorkHorizonHint {
    private static let numberWords: [String: Int] = [
        "a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
        "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
        "twelve": 12, "couple": 2, "few": 3,
    ]

    private static let months = [
        "january", "february", "march", "april", "may", "june",
        "july", "august", "september", "october", "november", "december",
    ]

    private static let weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

    private static let monthPattern =
        "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
    private static let weekdayPattern =
        "(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?)"
    private static let unitPattern = "(day|week|month|year)s?"
    private static let countPattern =
        "(\\d{1,3}|a couple of|a few|couple of|few|an|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)"

    private struct Match {
        let range: Range<String.Index>
        let text: String
        let groups: [String?]

        func group(_ index: Int) -> String? {
            index < groups.count ? groups[index] : nil
        }
    }

    private static func firstMatch(
        _ pattern: String,
        in text: String,
        from start: String.Index? = nil
    ) -> Match? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }
        let lower = start ?? text.startIndex
        let range = NSRange(lower..<text.endIndex, in: text)
        guard let result = regex.firstMatch(in: text, options: [.withTransparentBounds], range: range),
              let whole = Range(result.range, in: text) else { return nil }
        var groups: [String?] = []
        for index in 1..<max(1, result.numberOfRanges) {
            if let groupRange = Range(result.range(at: index), in: text) {
                groups.append(String(text[groupRange]))
            } else {
                groups.append(nil)
            }
        }
        return Match(range: whole, text: String(text[whole]), groups: groups)
    }

    private static func monthIndex(_ token: String) -> Int? {
        let prefix = token.prefix(3).lowercased()
        return months.firstIndex { $0.hasPrefix(prefix) }
    }

    private static func weekdayIndex(_ token: String) -> Int? {
        let prefix = token.prefix(3).lowercased()
        return weekdays.firstIndex { $0.hasPrefix(prefix) }
    }

    private static func countValue(_ token: String) -> Int {
        var clean = token.trimmingCharacters(in: .whitespaces).lowercased()
        if let match = firstMatch("^an?\\s+", in: clean) {
            clean = String(clean[match.range.upperBound...])
        }
        if let match = firstMatch("\\s+of$", in: clean) {
            clean = String(clean[..<match.range.lowerBound])
        }
        if let number = Int(clean) { return number }
        return numberWords[clean] ?? 1
    }

    /// The next date with this month (and day). A month already passed rolls to next year.
    private static func nextMonthDate(now: Date, month: Int, day: Int = 1, calendar: Calendar) -> Date? {
        let year = calendar.component(.year, from: now)
        let today = calendar.startOfDay(for: now)
        guard let target = calendar.date(from: DateComponents(year: year, month: month + 1, day: day)) else {
            return nil
        }
        if target <= today {
            return calendar.date(from: DateComponents(year: year + 1, month: month + 1, day: day))
        }
        return target
    }

    /// The next occurrence of this weekday, never today.
    private static func nextWeekday(now: Date, weekday: Int, calendar: Calendar) -> Date? {
        let today = calendar.startOfDay(for: now)
        let current = calendar.component(.weekday, from: today) - 1
        var delta = (weekday - current + 7) % 7
        if delta == 0 { delta = 7 }
        return calendar.date(byAdding: .day, value: delta, to: today)
    }

    private static func addUnits(now: Date, count: Int, unit: String, calendar: Calendar) -> Date? {
        let today = calendar.startOfDay(for: now)
        switch unit {
        case "day": return calendar.date(byAdding: .day, value: count, to: today)
        case "week": return calendar.date(byAdding: .day, value: count * 7, to: today)
        case "month": return calendar.date(byAdding: .month, value: count, to: today)
        default: return calendar.date(byAdding: .year, value: count, to: today)
        }
    }

    private static func firstOfNextMonth(now: Date, calendar: Calendar) -> Date? {
        let components = calendar.dateComponents([.year, .month], from: now)
        guard let year = components.year, let month = components.month else { return nil }
        return calendar.date(from: DateComponents(year: year, month: month + 1, day: 1))
    }

    private static func firstOfNextYear(now: Date, calendar: Calendar) -> Date? {
        let year = calendar.component(.year, from: now)
        return calendar.date(from: DateComponents(year: year + 1, month: 1, day: 1))
    }

    private struct DateHit {
        let at: Date
        let label: String
    }

    /// A date phrase after a preposition: month, month + day, weekday, "next week", "tomorrow".
    private static func parseDatePhrase(_ text: String, now: Date, calendar: Calendar) -> DateHit? {
        if let match = firstMatch("^\(monthPattern)(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?)?\\b", in: text),
           let token = match.group(0), let month = monthIndex(token) {
            let day = match.group(1).flatMap { Int($0) }.map { min(max($0, 1), 31) } ?? 1
            if let at = nextMonthDate(now: now, month: month, day: day, calendar: calendar) {
                return DateHit(at: at, label: match.text)
            }
        }
        if let match = firstMatch("^(?:next\\s+)?\(weekdayPattern)\\b", in: text),
           let token = match.group(0), let weekday = weekdayIndex(token),
           let at = nextWeekday(now: now, weekday: weekday, calendar: calendar) {
            return DateHit(at: at, label: match.text)
        }
        if firstMatch("^tomorrow\\b", in: text) != nil,
           let at = addUnits(now: now, count: 1, unit: "day", calendar: calendar) {
            return DateHit(at: at, label: "tomorrow")
        }
        if firstMatch("^next\\s+week\\b", in: text) != nil,
           let at = nextWeekday(now: now, weekday: 1, calendar: calendar) {
            return DateHit(at: at, label: "next week")
        }
        if firstMatch("^next\\s+month\\b", in: text) != nil,
           let at = firstOfNextMonth(now: now, calendar: calendar) {
            return DateHit(at: at, label: "next month")
        }
        if firstMatch("^next\\s+year\\b", in: text) != nil,
           let at = firstOfNextYear(now: now, calendar: calendar) {
            return DateHit(at: at, label: "next year")
        }
        if let match = firstMatch("^(?:in\\s+)?\(countPattern)\\s+\(unitPattern)\\b", in: text),
           let count = match.group(0), let unit = match.group(1),
           let at = addUnits(now: now, count: countValue(count), unit: unit.lowercased(), calendar: calendar) {
            return DateHit(at: at, label: match.text)
        }
        return nil
    }

    /// Parse common horizon phrases. The result is nil when the text carries
    /// no horizon. A phrase with a date sets `notBefore` or `by`. A phrase
    /// without a date ("after Thanksgiving") keeps only the label, so the Work
    /// sleeps until the user sets a date.
    static func parse(_ text: String, now: Date, calendar: Calendar = .current) -> WorkHorizon? {
        let clean = text
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        guard !clean.isEmpty else { return nil }
        let lower = clean.lowercased()

        let somedayPattern = "\\b(someday|some day|one day|eventually|no rush|whenever)\\b"
        if let match = firstMatch(somedayPattern, in: lower) {
            return WorkHorizon(kind: .someday, label: match.group(0))
        }

        var result: WorkHorizon?

        // Sleep phrases. Every hit is tried in order, so a filler "from the
        // office" earlier in the sentence cannot hide a real "not before November".
        let sleepPattern = "\\b(not before|not until|no earlier than|starting|from|after)\\s+(.+)$"
        var cursor = lower.startIndex
        while let sleep = firstMatch(sleepPattern, in: lower, from: cursor),
              let preposition = sleep.group(0), let rest = sleep.group(1) {
            if let hit = parseDatePhrase(rest, now: now, calendar: calendar) {
                result = WorkHorizon(kind: .later, notBefore: hit.at, label: "\(preposition) \(hit.label)")
                break
            }
            // A named moment without a date ("after Thanksgiving"). Keep the
            // user's words only. The phrase must be short and must end the
            // sentence, so "after work call the dentist" stays plain Work.
            var phrase = rest
            if let stop = firstMatch("[.!?,;].*$", in: phrase) {
                phrase = String(phrase[..<stop.range.lowerBound])
            }
            phrase = phrase.trimmingCharacters(in: .whitespaces)
            let words = phrase.isEmpty ? [] : phrase.split(separator: " ")
            var sentenceEnd = rest
            if let trailing = firstMatch("[.!?]\\s*$", in: sentenceEnd) {
                sentenceEnd = String(sentenceEnd[..<trailing.range.lowerBound])
            }
            let endsSentence = phrase.count == sentenceEnd.trimmingCharacters(in: .whitespaces).count
            if preposition == "not before" || preposition == "not until" {
                if !phrase.isEmpty {
                    result = WorkHorizon(kind: .later, label: "\(preposition) \(phrase.prefix(80))")
                    break
                }
            } else if preposition == "after", (1...3).contains(words.count), endsSentence {
                result = WorkHorizon(kind: .later, label: "after \(phrase.prefix(80))")
                break
            }
            cursor = lower.index(sleep.range.lowerBound, offsetBy: preposition.count)
        }

        if result == nil {
            if let relative = firstMatch("\\bin\\s+\(countPattern)\\s+\(unitPattern)\\b", in: lower),
               let count = relative.group(0), let unit = relative.group(1),
               let at = addUnits(now: now, count: countValue(count), unit: unit, calendar: calendar) {
                result = WorkHorizon(kind: .later, notBefore: at, label: relative.text)
            } else if let inMonth = firstMatch("\\bin\\s+\(monthPattern)\\b", in: lower),
                      let token = inMonth.group(0), let month = monthIndex(token),
                      let at = nextMonthDate(now: now, month: month, calendar: calendar) {
                result = WorkHorizon(kind: .later, notBefore: at, label: inMonth.text)
            } else if let next = firstMatch("\\bnext\\s+(week|month|year)\\b", in: lower),
                      let unit = next.group(0) {
                let at: Date? = switch unit {
                case "week": nextWeekday(now: now, weekday: 1, calendar: calendar)
                case "month": firstOfNextMonth(now: now, calendar: calendar)
                default: firstOfNextYear(now: now, calendar: calendar)
                }
                if let at {
                    result = WorkHorizon(kind: .later, notBefore: at, label: "next \(unit)")
                }
            }
        }

        // "not before" is a sleep, never a target.
        if let due = firstMatch("\\b(?:by|(?<!not\\s)before|due)\\s+(.+)$", in: lower),
           let rest = due.group(0),
           let hit = parseDatePhrase(rest, now: now, calendar: calendar) {
            if var current = result {
                let afterWake = current.notBefore.map { hit.at >= $0 } ?? true
                if afterWake { current.by = hit.at }
                result = current
            } else {
                result = WorkHorizon(kind: .now, by: hit.at, label: "by \(hit.label)")
            }
        }

        return result
    }
}
