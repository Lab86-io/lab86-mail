import Foundation

/// Where the bar sends the text. `ask` goes to the chat. `hold` makes Work.
///
/// The rules below mirror `lib/albatross/route-classifier.ts`. The client runs
/// the same pre-pass, so the chip is right before the endpoint answers.
enum BarRoute: String, Codable, Hashable, Sendable {
    case ask
    case hold

    /// The other route.
    var flipped: BarRoute { self == .ask ? .hold : .ask }

    /// The word on the chip.
    var word: String { self == .ask ? "Ask" : "Hold" }
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
/// word always wins for hold.
enum RouteHeuristic {
    static let interrogatives: Set<String> = [
        "what", "who", "whom", "whose", "when", "where", "why", "how", "which",
        "did", "does", "do", "is", "are", "was", "were", "can", "could",
        "would", "should", "will", "has", "have", "had", "am",
    ]

    static let askOpeners = [
        "show me", "find", "search", "look up", "look for", "tell me",
        "summarize", "summarise", "explain", "pull up", "open", "draft",
        "write", "reply to", "compose", "translate", "compare", "check if",
        "check whether", "list my", "list the", "give me", "help me understand",
    ]

    static let askPhrases = [
        "need to know", "want to know", "wondering", "curious", "what did",
        "what does", "what is", "how many", "how much", "when is", "when did",
        "who is", "where is",
    ]

    static let holdExplicit = [
        "hold this", "hold that", "keep this", "keep that", "remember this",
        "remember that", "remember to", "remind me", "note to self",
        "add to my list", "put this on my list", "do not forget",
        "don't forget", "todo:", "to-do:",
    ]

    static let holdCommitment = [
        "i need to", "i have to", "i should", "i want to", "i must",
        "i plan to", "i am going to", "i'm going to", "we need to",
        "we should", "we have to", "need to", "have to", "got to", "gotta",
    ]

    static let holdVerbs = [
        "book", "renew", "pay", "buy", "cancel", "sign up", "register",
        "submit", "file", "apply for", "pick up", "drop off", "order", "fix",
        "finish", "ship", "lose", "call", "return", "clean", "prepare",
        "get the", "get a", "start", "learn",
    ]

    static let horizonPhrases = [
        "by friday", "by monday", "by tuesday", "by wednesday", "by thursday",
        "by saturday", "by sunday", "by next", "by the end of", "by spring",
        "by summer", "by fall", "by winter", "before the", "not before",
        "after the", "next week", "next month", "next year", "this weekend",
        "in two weeks", "in a week", "in a month", "someday", "no rush",
        "eventually", "tomorrow", "tonight",
    ]

    static let months = [
        "january", "february", "march", "april", "may", "june", "july",
        "august", "september", "october", "november", "december",
    ]

    static func normalize(_ text: String) -> String {
        let lowered = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return lowered.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
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

    /// Two or more items separated by bullets or by commas after a colon.
    static func looksEnumerated(_ text: String) -> Bool {
        let lines = text
            .split(whereSeparator: { $0.isNewline })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let bulletLines = lines.filter { line in
            guard let first = line.first else { return false }
            if first == "-" || first == "*" || first == "\u{2022}" {
                return line.dropFirst().first == " "
            }
            guard first.isNumber else { return false }
            let rest = line.drop { $0.isNumber }
            guard let mark = rest.first, mark == "." || mark == ")" else { return false }
            return rest.dropFirst().first == " "
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
        includesAny(text, months)
    }

    static func verdict(for text: String) -> RouteVerdict? {
        let normalized = normalize(text)
        if normalized.isEmpty { return RouteVerdict(route: .ask, confidence: 0, reason: "empty") }
        if normalized.contains("?") {
            return RouteVerdict(route: .ask, confidence: 0.95, reason: "question mark")
        }
        if includesAny(normalized, holdExplicit) {
            return RouteVerdict(route: .hold, confidence: 0.95, reason: "explicit hold")
        }

        let interrogative = interrogatives.contains(firstWord(normalized))
        let askOpener = startsWithAny(normalized, askOpeners)
        let askPhrase = includesAny(normalized, askPhrases)
        let commitment = includesAny(normalized, holdCommitment)
        let holdVerb = startsWithAny(normalized, holdVerbs)
        let horizon = includesAny(normalized, horizonPhrases) || mentionsMonth(normalized)
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
