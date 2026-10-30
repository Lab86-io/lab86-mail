import Foundation

// Needs you: the words on a row and in the detail (a port of
// `lib/obligations/labels.ts`). Pure, so the page, the Mac, and the tests
// print the same words for the same item. Dates print in US English, as the
// web does, with the fixed-width space Foundation puts before "AM" turned
// into a plain space.

enum NeedsYouDueTone: Hashable, Sendable {
    case plain
    case today
    case hot
    case done
}

/// The due column of one row.
struct NeedsYouDueLabel: Hashable, Sendable {
    /// The word in the due column. Empty when the row has nothing to say.
    let text: String
    /// A second, smaller word under the first: "expires", "waiting".
    let sub: String?
    let tone: NeedsYouDueTone

    init(text: String, sub: String? = nil, tone: NeedsYouDueTone) {
        self.text = text
        self.sub = sub
        self.tone = tone
    }
}

enum NeedsYouLabels {
    static let locale = Locale(identifier: "en_US")

    private static func style(_ timezone: String?) -> Date.FormatStyle {
        var style = Date.FormatStyle(date: .omitted, time: .omitted)
        style.locale = locale
        style.timeZone = NeedsYouClock.safeTimeZone(timezone) ?? .current
        return style
    }

    /// Foundation writes a narrow no-break space before "AM" on current SDKs.
    private static func plainSpaces(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
    }

    /// "9:12 AM".
    static func timeOfDay(_ millis: ObligationMillis, timezone: String?) -> String {
        plainSpaces(NeedsYouClock.date(millis).formatted(style(timezone).hour(.defaultDigits(amPM: .abbreviated)).minute()))
    }

    /// "Fri".
    static func shortWeekday(_ millis: ObligationMillis, timezone: String?) -> String {
        NeedsYouClock.date(millis).formatted(style(timezone).weekday(.abbreviated))
    }

    /// "Friday".
    static func longWeekday(_ millis: ObligationMillis, timezone: String?) -> String {
        NeedsYouClock.date(millis).formatted(style(timezone).weekday(.wide))
    }

    /// "Oct 24".
    static func monthDay(_ millis: ObligationMillis, timezone: String?) -> String {
        NeedsYouClock.date(millis).formatted(style(timezone).month(.abbreviated).day())
    }

    /// The reason word of a closed row (`closeReasonLabel`).
    static func closeReasonLabel(_ reason: ObligationCloseReason?) -> String {
        switch reason {
        case .sentReply: "Replied"
        case .userDone: "Done"
        case .userDoneNoReply: "Done, no reply sent"
        case .evidence, .agedOut: "Closed by itself"
        case .notMine: "Not mine"
        case .codeUsed: "Code used"
        case .expired: "Expired"
        case .eventPassed: "Event started"
        case .unknown, nil: "Closed"
        }
    }

    /// The kind word of the row meta and the detail source line (`kindLabel`).
    static func kindLabel(kind: ObligationKind, pushLevel: ObligationPushLevel) -> String {
        switch kind {
        case .reply: "Reply"
        case .action: "Action"
        case .waiting: "Waiting"
        case .change: pushLevel == .timeSensitive ? "Time-sensitive change" : "Change"
        case .code: "Code"
        case .rsvp: "Invitation"
        case .prepare: "Prepare"
        case .unknown: "Item"
        }
    }

    static func kindLabel(_ obligation: ObligationView) -> String {
        kindLabel(kind: obligation.kind, pushLevel: obligation.pushLevel)
    }

    /// When something happened: "9:12 AM" today, "Yesterday 4:48 PM", a
    /// weekday with the time inside the week, else "Oct 24" (`whenLabel`).
    static func whenLabel(_ millis: ObligationMillis, now: ObligationMillis, timezone: String?) -> String {
        let distance = NeedsYouClock(timezone: timezone).dayDistance(millis, from: now)
        if distance == 0 { return timeOfDay(millis, timezone: timezone) }
        if distance == -1 { return "Yesterday \(timeOfDay(millis, timezone: timezone))" }
        if distance > -7, distance < 7 {
            return "\(shortWeekday(millis, timezone: timezone)) \(timeOfDay(millis, timezone: timezone))"
        }
        return monthDay(millis, timezone: timezone)
    }

    /// "just now", "2 min ago", "3 hr ago", "2 days ago" (`agoLabel`).
    static func agoLabel(_ millis: ObligationMillis, now: ObligationMillis) -> String {
        let delta = max(0, now - millis)
        if delta < NeedsYouClock.minuteMillis { return "just now" }
        if delta < NeedsYouClock.hourMillis { return "\(Int(delta / NeedsYouClock.minuteMillis)) min ago" }
        if delta < NeedsYouClock.dayMillis { return "\(Int(delta / NeedsYouClock.hourMillis)) hr ago" }
        let days = Int(delta / NeedsYouClock.dayMillis)
        return days == 1 ? "1 day ago" : "\(days) days ago"
    }

    /// "8 min", "1 hr 5 min", or "Expired" (`expiryLabel`).
    static func expiryLabel(expiresAt: ObligationMillis, now: ObligationMillis) -> String {
        let left = expiresAt - now
        if left <= 0 { return "Expired" }
        let minutes = Int((left / NeedsYouClock.minuteMillis).rounded(.up))
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60
        let rest = minutes % 60
        return rest > 0 ? "\(hours) hr \(rest) min" : "\(hours) hr"
    }

    /// The share of the code's life that is left, 0 to 1, for the expiry
    /// ring (`expiryFraction`).
    static func expiryFraction(createdAt: ObligationMillis, code: ObligationCode?, now: ObligationMillis) -> Double {
        guard let expiresAt = code?.expiresAt, expiresAt > createdAt else { return 0 }
        let fraction = (expiresAt - now) / (expiresAt - createdAt)
        return min(1, max(0, fraction))
    }

    /// The due day as a word: "Today", "Today 6:40 PM", "Tomorrow", "Fri",
    /// "Nov 16". A day in the past reads "Yesterday" or its date, never
    /// "Today" (`dueDayLabel`).
    static func dueDayLabel(_ dueAt: ObligationMillis, now: ObligationMillis, timezone: String?) -> String {
        let clock = NeedsYouClock(timezone: timezone)
        let distance = clock.dayDistance(dueAt, from: now)
        let clockTime = dueAt - clock.startOfDay(dueAt)
        // A due day from the evidence ends at 23:59:59.999. That is the day,
        // not a stated time.
        let endOfDay = clock.startOfDay(dueAt + 1) == dueAt + 1
        let withTime = { (word: String) -> String in
            clockTime > 0 && !endOfDay ? "\(word) \(timeOfDay(dueAt, timezone: timezone))" : word
        }
        if distance == -1 { return withTime("Yesterday") }
        if distance < -1 { return monthDay(dueAt, timezone: timezone) }
        if distance == 0 { return withTime("Today") }
        if distance == 1 { return withTime("Tomorrow") }
        if distance < 7 { return shortWeekday(dueAt, timezone: timezone) }
        return monthDay(dueAt, timezone: timezone)
    }

    /// The due column of one row (`dueLabel`).
    static func dueLabel(_ obligation: ObligationView, now: ObligationMillis, timezone: String?) -> NeedsYouDueLabel {
        if obligation.isClosed {
            return NeedsYouDueLabel(text: closeReasonLabel(obligation.closeReason), tone: .done)
        }
        if obligation.kind == .code {
            guard let expiresAt = obligation.code?.expiresAt else { return NeedsYouDueLabel(text: "", tone: .plain) }
            let text = expiryLabel(expiresAt: expiresAt, now: now)
            return text == "Expired"
                ? NeedsYouDueLabel(text: text, tone: .plain)
                : NeedsYouDueLabel(text: text, sub: "expires", tone: .hot)
        }
        if obligation.kind == .waiting {
            let days = Int(((now - obligation.createdAt) / NeedsYouClock.dayMillis).rounded(.down))
            let text = days < 1 ? "Today" : days == 1 ? "1 day" : "\(days) days"
            return NeedsYouDueLabel(text: text, sub: "waiting", tone: .plain)
        }
        let hot = obligation.pushLevel == .timeSensitive
        if let dueAt = obligation.dueAt {
            let text = dueDayLabel(dueAt, now: now, timezone: timezone)
            return NeedsYouDueLabel(text: text, tone: hot ? .hot : text.hasPrefix("Today") ? .today : .plain)
        }
        switch obligation.due {
        case .today: return NeedsYouDueLabel(text: "Today", tone: hot ? .hot : .today)
        case .soon: return NeedsYouDueLabel(text: "Soon", tone: hot ? .hot : .plain)
        case .later: return NeedsYouDueLabel(text: "Later", tone: .plain)
        case .none: return NeedsYouDueLabel(text: "", tone: hot ? .hot : .plain)
        }
    }

    /// "Due Friday", for the detail source line. Empty without a due day
    /// (`dueSentence`).
    static func dueSentence(_ obligation: ObligationView, now: ObligationMillis, timezone: String?) -> String {
        if obligation.isClosed || obligation.kind == .code || obligation.kind == .waiting { return "" }
        if let dueAt = obligation.dueAt {
            let distance = NeedsYouClock(timezone: timezone).dayDistance(dueAt, from: now)
            if distance > 1, distance < 7 { return "Due \(longWeekday(dueAt, timezone: timezone))" }
            let label = dueDayLabel(dueAt, now: now, timezone: timezone)
            if label.hasPrefix("Today") || label.hasPrefix("Tomorrow") {
                return "Due \(label.prefix(1).lowercased())\(label.dropFirst())"
            }
            return "Due \(label)"
        }
        switch obligation.due {
        case .today: return "Due today"
        case .soon: return "Due soon"
        case .later: return "Due later"
        case .none: return ""
        }
    }

    /// The sentence at the top of the detail (`obligationSentence`).
    static func sentence(_ obligation: ObligationView) -> String {
        if obligation.kind == .code {
            return "Verification code from \(obligation.code?.issuer ?? obligation.asker)."
        }
        return obligation.title
    }

    /// Groups of three digits read easier: "482913" shows as "482 913"
    /// (`spacedCode`).
    static func spacedCode(_ value: String) -> String {
        let compact = value.filter { !$0.isWhitespace }
        guard compact.allSatisfy(\.isNumber), compact.count == 6 || compact.count == 8 else { return value }
        let size = compact.count == 8 ? 4 : 3
        var groups: [String] = []
        var index = compact.startIndex
        while index < compact.endIndex {
            let end = compact.index(index, offsetBy: size, limitedBy: compact.endIndex) ?? compact.endIndex
            groups.append(String(compact[index..<end]))
            index = end
        }
        return groups.joined(separator: " ")
    }

    /// The quiet line under the action buttons (`actionNote`).
    static func actionNote(kind: ObligationKind) -> String {
        switch kind {
        case .reply:
            "Send reply answers in the thread. Done closes this without a reply. Undo for 10 seconds."
        case .code:
            "This closes itself when you use the code or when it expires."
        case .waiting:
            "This closes itself when the reply arrives. Done closes it now. Undo for 10 seconds."
        case .action, .change, .prepare, .rsvp, .unknown:
            "Done closes this. Undo for 10 seconds."
        }
    }
}
