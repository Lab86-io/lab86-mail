import Foundation

/// What Today says about itself, in the same words the web uses.
///
/// These are a mirror of `lib/albatross/today.ts`. Two clients describing the
/// same day in different sentences is the kind of drift a user reads as the
/// product not knowing its own mind, so the rules live in one shape on both
/// sides and both test suites pin them.
enum TodayComposition {
    /// How much the user is willing to be shown today.
    enum Capacity: String, CaseIterable, Sendable {
        case low, normal, high

        var label: String {
            switch self {
            case .low: "Low capacity"
            case .normal: "Normal"
            case .high: "High capacity"
            }
        }
    }

    /// A brief older than this is describing a different day, and says so loudly.
    static let staleAfter: TimeInterval = 36 * 3600

    /// The date, as a person would say it out loud.
    static func dateline(_ date: Date, calendar: Calendar = .current) -> String {
        var formatter = Date.FormatStyle.dateTime.weekday(.wide).month(.wide).day()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        return date.formatted(formatter)
    }

    /// One sentence about the shape of the day. Never a tally, never a scolding.
    ///
    /// Today no longer lists what Albatross carries, so the deck does not
    /// count it either. The day is the calendar, the mail, and one move.
    static func dayShapeLine(
        needsYouCount: Int,
        eventCount: Int,
        capacity: Capacity
    ) -> String {
        if needsYouCount == 0 && eventCount == 0 {
            return "Nothing needs you and nothing is booked. The day is yours."
        }
        var parts: [String] = []
        if needsYouCount == 1 { parts.append("One thing needs you") }
        else if needsYouCount > 1 { parts.append("\(needsYouCount) things need you") }
        if eventCount == 1 { parts.append("one thing is booked") }
        else if eventCount > 1 { parts.append("\(eventCount) things are booked") }
        let sentence = parts.isEmpty ? "Nothing needs you today." : "\(parts.joined(separator: ", and "))."
        switch capacity {
        case .low: return "\(sentence) Keeping the rest light."
        case .high: return "\(sentence) There is room for more."
        case .normal: return sentence
        }
    }

    /// The one "Next move" line. It renders only when a move is scheduled
    /// for today. An unscheduled move, or one booked for another day, gives
    /// Today nothing to say.
    struct NextMove: Equatable, Sendable {
        let workID: String
        let workTitle: String
        let stepTitle: String
        let time: String
    }

    static func nextMove(
        from move: WorkExecutionMove?,
        now: Date,
        calendar: Calendar = .current
    ) -> NextMove? {
        guard let move, let start = move.scheduledStartAt,
              calendar.isDate(start, inSameDayAs: now) else { return nil }
        // A block that passed is a missed move. That prompt lives in the Work
        // detail, never on Today.
        if let end = move.scheduledEndAt, end <= now { return nil }
        var style = Date.FormatStyle(calendar: calendar, timeZone: calendar.timeZone).hour().minute()
        style.locale = calendar.locale ?? .current
        let time = start <= now ? "Now" : start.formatted(style)
        return NextMove(workID: move.workID, workTitle: move.workTitle, stepTitle: move.stepTitle, time: time)
    }

    /// At most four rows. The section is not a digest.
    static let importantMailLimit = 4

    /// How old the brief is, in plain words. Nil when none has ever been written.
    static func briefFreshness(generatedAt: Date?, now: Date) -> String? {
        guard let generatedAt else { return nil }
        let hours = Int((now.timeIntervalSince(generatedAt) / 3600).rounded(.down))
        if hours < 1 { return "Written just now" }
        if hours < 24 { return "Written \(hours) \(hours == 1 ? "hour" : "hours") ago" }
        let days = hours / 24
        if days == 1 { return "Written yesterday" }
        return "Written \(days) days ago"
    }

    /// Whether the brief describes an older day than the one on screen.
    static func briefIsStale(generatedAt: Date?, now: Date) -> Bool {
        guard let generatedAt else { return false }
        return now.timeIntervalSince(generatedAt) > staleAfter
    }

    /// What the brief's section rule says, given what exists.
    static func briefStandingLine(generatedAt: Date?, now: Date) -> String {
        guard let freshness = briefFreshness(generatedAt: generatedAt, now: now) else {
            return "Not written yet today."
        }
        if briefIsStale(generatedAt: generatedAt, now: now) {
            return "\(freshness) — it describes an older day."
        }
        return "\(freshness), from your mail and calendar."
    }
}
