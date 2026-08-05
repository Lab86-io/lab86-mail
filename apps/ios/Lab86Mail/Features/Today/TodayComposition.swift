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
    static func dayShapeLine(
        needsYouCount: Int,
        eventCount: Int,
        capacity: Capacity,
        carryingCount: Int = 0
    ) -> String {
        if needsYouCount == 0 && eventCount == 0 {
            // "The day is yours" is only true when there is genuinely nothing in
            // it. Saying it while Albatross is visibly carrying work reads as a
            // system that has not looked at its own page.
            if carryingCount == 1 {
                return "Nothing needs you today. Albatross is carrying one thing on its own."
            }
            if carryingCount > 1 {
                return "Nothing needs you today. Albatross is carrying \(carryingCount) things on its own."
            }
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
