import Foundation

/// Where the bar sends the text. `ask` goes to the chat. `hold` makes Work.
///
/// The rules below mirror `lib/albatross/route-rules.ts`. The client runs
/// the same pre-pass, so the chip is right before the endpoint answers.
enum BarRoute: String, Codable, Hashable, Sendable {
    case ask
    case hold
    /// A note to the run that works now (docs/albatross-threads.md, T7). The
    /// thread offers it while a run is open; the Chat tab never does.
    case run

    /// The other route of the ask and hold pair. A run note flips to ask.
    var flipped: BarRoute { self == .ask ? .hold : .ask }

    /// The route after a flip: Run → Ask → Hold → Run while a run works,
    /// else Ask ↔ Hold.
    func next(runAvailable: Bool) -> BarRoute {
        switch self {
        case .run: return .ask
        case .ask: return .hold
        case .hold: return runAvailable ? .run : .ask
        }
    }

    /// The word on the chip.
    var word: String {
        switch self {
        case .ask: "Ask"
        case .hold: "Hold"
        case .run: "Run"
        }
    }
}

struct RouteVerdict: Equatable, Sendable {
    let route: BarRoute
    let confidence: Double
    let reason: String?

    init(route: BarRoute, confidence: Double, reason: String? = nil) {
        self.route = route
        self.confidence = confidence
        self.reason = reason
    }

    static let askFallback = RouteVerdict(route: .ask, confidence: 0, reason: "fallback")
}

/// The deterministic pre-pass. It answers the clear cases and returns nil when
/// the text is unclear. A question mark always wins for ask. An explicit hold
/// word always wins for hold. An imperative that acts on mail, events,
/// contacts, files, or tasks is ask, also with a date in it. Quoted text (a
/// subject, a title) gives no signal.
///
/// The word lists and the patterns are the same as in
/// `lib/albatross/route-rules.ts`. Change both files together.
enum RouteHeuristic {
    static let interrogatives: Set<String> = [
        "what", "who", "whom", "whose", "when", "where", "why", "how", "which",
        "did", "does", "do", "is", "are", "was", "were", "can", "could",
        "would", "should", "will", "has", "have", "had", "am",
    ]

    // Verbs that ask the assistant for an answer or an action now.
    static let askOpeners = [
        "show me", "find", "search", "look up", "look for", "tell me",
        "summarize", "summarise", "explain", "pull up", "open", "draft",
        "write", "reply to", "compose", "translate", "compare", "check if",
        "check whether", "list my", "list the", "give me", "help me understand",
    ]

    // Phrases anywhere in the text that ask for information.
    static let askPhrases = [
        "need to know", "want to know", "wondering", "curious", "what did",
        "what does", "what is", "how many", "how much", "when is", "when did",
        "who is", "where is",
    ]

    // Explicit words for keeping something.
    static let holdExplicit = [
        "hold this", "hold that", "keep this", "keep that", "remember this",
        "remember that", "remember to", "remind me", "note to self",
        "add to my list", "put this on my list", "do not forget",
        "don't forget", "todo:", "to-do:",
    ]

    // A person committing to an outcome.
    static let holdCommitment = [
        "i need to", "i have to", "i should", "i want to", "i must",
        "i plan to", "i am going to", "i'm going to", "we need to",
        "we should", "we have to", "need to", "have to", "got to", "gotta",
    ]

    // Imperatives that name an errand or a goal, not a request to the assistant.
    static let holdVerbs = [
        "book", "renew", "pay", "buy", "cancel", "sign up", "register",
        "submit", "file", "apply for", "pick up", "drop off", "order", "fix",
        "finish", "ship", "lose", "call", "return", "clean", "prepare",
        "get the", "get a", "start", "learn",
    ]

    // Time words that place an outcome on a horizon.
    static let horizonPhrases = [
        "by friday", "by monday", "by tuesday", "by wednesday", "by thursday",
        "by saturday", "by sunday", "by next", "by the end of", "by spring",
        "by summer", "by fall", "by winter", "before the", "not before",
        "after the", "next week", "next month", "next year", "this weekend",
        "in two weeks", "in a week", "in a month", "someday", "no rush",
        "eventually", "tomorrow", "tonight",
    ]

    // Verbs that name an action on the user's mail, calendar, contacts, files,
    // or tasks. The verb alone is enough: "archive", "forward", "rsvp".
    static let appActionVerbs: Set<String> = [
        "archive", "unarchive", "trash", "untrash", "forward", "reply", "rsvp",
        "unsubscribe", "star", "unstar", "label", "relabel", "unlabel",
    ]

    // Verbs that name an app action only with an app object: "cancel the
    // meeting" is an action, "cancel the gym membership" is an errand.
    static let appObjectVerbs: Set<String> = [
        "add", "apply", "attach", "accept", "block", "cancel", "change",
        "clear", "close", "complete", "copy", "create", "decline", "delete",
        "download", "edit", "file", "invite", "mark", "move", "mute", "pin",
        "put", "remove", "rename", "reschedule", "restore", "save", "schedule",
        "send", "set", "share", "snooze", "tag", "unpin", "unsnooze", "update",
        "upload",
    ]

    // The things those verbs act on in the app.
    static let appObjects = [
        "message", "messages", "email", "emails", "e-mail", "e-mails", "mail",
        "thread", "threads", "conversation", "conversations", "inbox", "label",
        "labels", "draft", "drafts", "attachment", "attachments", "sender",
        "senders", "newsletter", "newsletters", "subject", "unread", "event",
        "events", "meeting", "meetings", "invitation", "invitations", "invite",
        "invites", "calendar", "contact", "contacts", "file", "files", "folder",
        "folders", "document", "documents", "doc", "docs", "spreadsheet",
        "spreadsheets", "slides", "deck", "presentation", "pdf", "task", "tasks",
        "board", "boards", "column",
    ]

    static let months = [
        "january", "february", "march", "april", "may", "june", "july",
        "august", "september", "october", "november", "december",
    ]

    // Words a request can start with before its verb: "please archive …".
    private static let leadingFillers = ["please", "pls", "now", "also", "and"]

    // Curly and modifier apostrophes from phone keyboards.
    private static let apostrophes: Set<Character> = ["\u{2018}", "\u{2019}", "\u{02BC}", "\u{2032}"]

    // Contractions the rules read as two words. "what's" must count as the
    // interrogative "what" (WRK-6).
    private static let contractions: [(NSRegularExpression, String)] = [
        (pattern(#"\b(what|who|where|when|how|why|which|that|there|it|here)'s\b"#), "$1 is"),
        (pattern(#"\bcan't\b"#), "can not"),
        (pattern(#"\bwon't\b"#), "will not"),
        (pattern(#"\b(\w+)n't\b"#), "$1 not"),
        (pattern(#"\bi'm\b"#), "i am"),
        (pattern(#"\b(\w+)'re\b"#), "$1 are"),
        (pattern(#"\b(\w+)'ll\b"#), "$1 will"),
        (pattern(#"\b(\w+)'ve\b"#), "$1 have"),
        (pattern(#"\b(i|you|we|they|he|she)'d\b"#), "$1 would"),
    ]

    // Text in double quotes names a thing (a subject, a title, a file name). A
    // date or a hold word inside it says nothing about when to act. Straight,
    // curly, low-high, and angle quotes count; an apostrophe does not.
    private static let quoted = pattern(
        #""[^"]*"|\u201c[^\u201d]*\u201d|\u201e[^\u201c\u201d]*[\u201c\u201d]|\u00ab[^\u00bb]*\u00bb"#
    )

    private static let markedAs = pattern(#"\bas (not )?(read|unread|important|spam|done|complete|completed)\b"#)

    // "May" is also a modal verb ("may i see the invoice"). It counts as a
    // month only next to a date word or a day number (WRK-6).
    private static let mayAsMonth = pattern(
        #"\b(in|by|before|after|until|since|from|of|early|mid|late|next|this|last) may\b|\bmay \d{1,2}(st|nd|rd|th)?\b|\b\d{1,2}(st|nd|rd|th)? (of )?may\b"#
    )

    private static let mayQuestion = pattern(#"^may (i|we|you)\b"#)

    private static let otherMonths = pattern(
        "\\b(" + months.filter { $0 != "may" }.joined(separator: "|") + ")\\b"
    )

    private static func pattern(_ source: String) -> NSRegularExpression {
        // The sources are constants, so a bad one fails the first test run.
        try! NSRegularExpression(pattern: source)
    }

    private static func matches(_ regex: NSRegularExpression, _ text: String) -> Bool {
        regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    private static func replacing(_ regex: NSRegularExpression, in text: String, with template: String) -> String {
        regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }

    private static func collapseSpaces(_ text: String) -> String {
        text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    static func normalize(_ text: String) -> String {
        let lowered = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var normalized = collapseSpaces(String(lowered.map { apostrophes.contains($0) ? "'" : $0 }))
        for (regex, template) in contractions {
            normalized = replacing(regex, in: normalized, with: template)
        }
        return normalized
    }

    static func hasQuoted(_ text: String) -> Bool {
        matches(quoted, text)
    }

    /// The normalized text without its quoted parts. The full text when
    /// nothing stays.
    static func withoutQuotes(_ normalized: String) -> String {
        let stripped = collapseSpaces(replacing(quoted, in: normalized, with: " "))
        return stripped.isEmpty ? normalized : stripped
    }

    private static func isWordCharacter(_ character: Character) -> Bool {
        character.isLetter && character.isASCII
    }

    /// Whole-word match, so "i have to" does not match "i have tomorrow".
    static func includesAny(_ text: String, _ phrases: [String]) -> Bool {
        phrases.contains { phrase in
            var searchStart = text.startIndex
            while let found = text.range(of: phrase, range: searchStart..<text.endIndex) {
                let beforeOK: Bool
                if found.lowerBound == text.startIndex {
                    beforeOK = true
                } else {
                    let before = text[text.index(before: found.lowerBound)]
                    beforeOK = !isWordCharacter(before)
                }
                let afterOK: Bool
                if found.upperBound == text.endIndex {
                    afterOK = true
                } else {
                    afterOK = !isWordCharacter(text[found.upperBound])
                }
                if beforeOK, afterOK { return true }
                searchStart = text.index(after: found.lowerBound)
                if searchStart >= text.endIndex { break }
            }
            return false
        }
    }

    static func startsWithAny(_ text: String, _ phrases: [String]) -> Bool {
        phrases.contains { text == $0 || text.hasPrefix("\($0) ") }
    }

    static func firstWord(_ text: String) -> String {
        let word = text.split(separator: " ").first.map(String.init) ?? ""
        return String(word.filter { isWordCharacter($0) || $0 == "'" })
    }

    /// The text without one leading "please", "now", "also", or "and".
    private static func withoutFiller(_ text: String) -> String {
        for filler in leadingFillers where text.hasPrefix("\(filler) ") {
            return String(text.dropFirst(filler.count + 1))
        }
        return text
    }

    /// An imperative that acts on mail, events, contacts, files, or tasks now:
    /// "label the message …", "mark it as unread", "accept the invitation …".
    /// A date in such a request is an argument of the action, not a deferral.
    static func isAppAction(_ normalized: String, unquoted: String) -> Bool {
        let text = withoutFiller(normalized)
        let verb = firstWord(text)
        if appActionVerbs.contains(verb) { return true }
        guard appObjectVerbs.contains(verb) else { return false }
        // A quoted title names the thing the action works on.
        if hasQuoted(text) { return true }
        // The object comes after the verb: "file the taxes" has no app object.
        let rest = String(withoutFiller(unquoted).dropFirst(verb.count))
        if matches(markedAs, rest) { return true }
        return includesAny(rest, appObjects)
    }

    /// Two or more items separated by bullets or by commas after a colon.
    static func looksEnumerated(_ text: String) -> Bool {
        let lines = text
            .split(whereSeparator: { $0.isNewline })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let bulletLines = lines.filter { line in
            guard let first = line.first else { return false }
            if first == "-" || first == "*" || first == "\u{2022}" {
                return line.dropFirst().first?.isWhitespace == true
            }
            guard first.isNumber else { return false }
            let rest = line.drop { $0.isNumber }
            guard let mark = rest.first, mark == "." || mark == ")" else { return false }
            return rest.dropFirst().first?.isWhitespace == true
        }.count
        if bulletLines >= 2 { return true }
        guard let colon = text.firstIndex(of: ":") else { return false }
        let afterColon = text[text.index(after: colon)...]
        let parts = afterColon.split(separator: ",").filter {
            !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return parts.count >= 2
    }

    static func mentionsMonth(_ text: String) -> Bool {
        matches(otherMonths, text) || matches(mayAsMonth, text)
    }

    static func verdict(for text: String) -> RouteVerdict? {
        let normalized = normalize(text)
        if normalized.isEmpty { return RouteVerdict(route: .ask, confidence: 0, reason: "empty") }
        let unquoted = withoutQuotes(normalized)
        if unquoted.contains("?") {
            return RouteVerdict(route: .ask, confidence: 0.95, reason: "question mark")
        }
        if includesAny(unquoted, holdExplicit) {
            return RouteVerdict(route: .hold, confidence: 0.95, reason: "explicit hold")
        }
        // "Add the label Offsite to the message "Board meeting materials for
        // October 9"" acts now. The date names the message; it does not defer.
        if isAppAction(normalized, unquoted: unquoted) {
            return RouteVerdict(route: .ask, confidence: 0.85, reason: "app action")
        }

        let opener = firstWord(unquoted)
        let interrogative = interrogatives.contains(opener) || (opener == "may" && matches(mayQuestion, unquoted))
        let askOpener = startsWithAny(unquoted, askOpeners)
        let askPhrase = includesAny(unquoted, askPhrases)
        let commitment = includesAny(unquoted, holdCommitment)
        let holdVerb = startsWithAny(unquoted, holdVerbs)
        let horizon = includesAny(unquoted, horizonPhrases) || mentionsMonth(unquoted)
        let enumerated = looksEnumerated(text)

        let askSignals = (interrogative ? 1 : 0) + (askOpener ? 1 : 0) + (askPhrase ? 1 : 0)
        // A time word is weak alone. A question about tomorrow is a question.
        let strongHoldSignals = (commitment ? 1 : 0) + (holdVerb ? 1 : 0) + (enumerated ? 1 : 0)
        let holdSignals = strongHoldSignals + (horizon ? 1 : 0)

        if askSignals > 0, strongHoldSignals == 0 {
            return interrogative
                ? RouteVerdict(route: .ask, confidence: 0.85, reason: "interrogative")
                : RouteVerdict(route: .ask, confidence: 0.8, reason: "ask verb")
        }
        if holdSignals > 0, askSignals == 0 {
            if commitment { return RouteVerdict(route: .hold, confidence: 0.85, reason: "commitment") }
            if holdVerb { return RouteVerdict(route: .hold, confidence: 0.8, reason: "errand verb") }
            if enumerated { return RouteVerdict(route: .hold, confidence: 0.8, reason: "enumerated list") }
            return RouteVerdict(route: .hold, confidence: 0.7, reason: "horizon phrase")
        }
        // A commitment under a question opener still asks to keep the outcome.
        if interrogative, !askOpener, !askPhrase, commitment, holdSignals >= 2 {
            return RouteVerdict(route: .hold, confidence: 0.7, reason: "commitment under a question opener")
        }
        return nil
    }

    /// The chip value before the endpoint answers. Unclear text keeps the
    /// route the chip already shows.
    static func instant(_ text: String, current: BarRoute = .ask) -> RouteVerdict {
        verdict(for: text) ?? RouteVerdict(route: current, confidence: 0, reason: "unclear")
    }
}

/// The rule that decides whether a server answer may move the chip.
enum RoutePredictor {
    /// The wait after the last keystroke before the endpoint runs.
    static let confirmDelay: Duration = .milliseconds(400)
    /// A hold below this confidence never flips the chip by itself.
    static let holdConfidenceFloor = 0.6

    static func shouldAdopt(_ verdict: RouteVerdict, pinned: Bool) -> Bool {
        if pinned { return false }
        if verdict.route == .hold { return verdict.confidence >= holdConfidenceFloor }
        return verdict.confidence > 0
    }
}
