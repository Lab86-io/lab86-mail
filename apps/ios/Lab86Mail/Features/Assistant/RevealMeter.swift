import Foundation

// The text reveal meter (docs/chat-agentic-pass.md, section 4). Text arrives
// in chunks of several words; the meter releases it one word at a time so the
// reply reads as writing. Pure value type: the view owns the clock.
struct RevealMeter: Equatable, Sendable {
    /// One word every 18 ms at rest.
    static let baseCadence: TimeInterval = 0.018
    /// Above this backlog the reveal speeds up.
    static let catchUpThreshold = 40
    /// The reveal never lags the stream by more than about this.
    static let maxLag: TimeInterval = 0.6
    /// Once the stream finishes, the rest drains within this window.
    static let drainWindow: TimeInterval = 0.4

    private(set) var buffer = ""
    private(set) var revealedWords = 0
    private(set) var isFinished = false
    private var finishCadence: TimeInterval?
    private var catchUpCadence = RevealMeter.baseCadence
    private var timeCredit: TimeInterval = 0
    private var bufferedTokens: [Token] = []

    init() {}

    /// Replace the buffer with the latest full text. A text that does not
    /// extend the previous one (a new part, a retry) restarts the cursor.
    mutating func update(text: String) {
        if !text.hasPrefix(buffer) {
            revealedWords = 0
            isFinished = false
            finishCadence = nil
            timeCredit = 0
        }
        buffer = text
        bufferedTokens = Self.tokens(in: text)
        revealedWords = min(revealedWords, availableWords)
        catchUpCadence = backlog > Self.catchUpThreshold ? min(Self.baseCadence, Self.maxLag / Double(backlog)) : Self.baseCadence
    }

    /// The stream ended; the trailing partial word becomes revealable.
    mutating func finish() {
        isFinished = true
        timeCredit = 0
        finishCadence = min(Self.baseCadence, Self.drainWindow / Double(max(backlog, 1)))
    }

    /// Reveal everything at once (reduced motion, restored transcripts).
    mutating func revealAll() {
        isFinished = true
        revealedWords = availableWords
    }

    /// Reveal the next word. Returns false when nothing was left to reveal.
    @discardableResult
    mutating func advance() -> Bool {
        guard revealedWords < availableWords else { return false }
        revealedWords += 1
        return true
    }

    /// Advance by elapsed time so a large backlog does not require one timer per word.
    mutating func advance(elapsed: TimeInterval) {
        guard elapsed.isFinite, elapsed > 0 else { return }
        timeCredit += elapsed
        while backlog > 0, timeCredit >= cadence {
            timeCredit -= cadence
            revealedWords += 1
        }
        if backlog == 0 { timeCredit = 0 }
    }

    /// Words that may be revealed now: complete words, plus the trailing
    /// partial word once the stream has finished.
    var availableWords: Int {
        let tokens = bufferedTokens
        guard let last = tokens.last else { return 0 }
        if isFinished || last.complete { return tokens.count }
        return tokens.count - 1
    }

    var backlog: Int { availableWords - revealedWords }
    var isDrained: Bool { backlog == 0 }

    /// The prefix of the buffer through the revealed words. The whitespace
    /// after the last revealed word is included so a paragraph break shows
    /// as soon as the word before it is out.
    var revealedText: String {
        guard revealedWords > 0 else { return "" }
        let tokens = bufferedTokens
        guard revealedWords <= tokens.count else { return buffer }
        if revealedWords == tokens.count {
            let last = tokens[revealedWords - 1]
            return last.complete || isFinished ? buffer : String(buffer[..<last.end])
        }
        return String(buffer[..<tokens[revealedWords].start])
    }

    /// Delay before the next word. Faster when behind, and fast enough to
    /// empty the backlog inside the drain window once the stream is done.
    var cadence: TimeInterval {
        var delay = catchUpCadence
        if isFinished {
            delay = min(delay, finishCadence ?? Self.baseCadence)
        }
        return delay
    }

    // MARK: - Tokens

    struct Token: Equatable, Sendable {
        let start: String.Index
        let end: String.Index
        /// Whitespace follows the token, so it cannot grow.
        let complete: Bool
    }

    static func tokens(in text: String) -> [Token] {
        var tokens: [Token] = []
        var wordStart: String.Index?
        var index = text.startIndex
        while index < text.endIndex {
            let character = text[index]
            if character.isWhitespace || character.isNewline {
                if let start = wordStart {
                    tokens.append(Token(start: start, end: index, complete: true))
                    wordStart = nil
                }
            } else if wordStart == nil {
                wordStart = index
            }
            index = text.index(after: index)
        }
        if let start = wordStart {
            tokens.append(Token(start: start, end: text.endIndex, complete: false))
        }
        return tokens
    }
}

/// Splits revealed text into the part the Markdown renderer owns and the
/// trailing run that rises word by word. The run is the current paragraph, or
/// the current line inside a list. Blocks the flow layout cannot draw
/// (fenced code, tables, headings) stay with the renderer whole.
enum RevealSplit {
    struct Result: Equatable, Sendable {
        let head: String
        let tail: String
    }

    static func split(_ text: String) -> Result {
        guard !text.isEmpty else { return Result(head: "", tail: "") }
        if fenceCount(in: text) % 2 == 1 {
            return Result(head: text, tail: "")
        }
        let block: Substring
        let blockStart: String.Index
        if let paragraphBreak = text.range(of: "\n\n", options: .backwards) {
            blockStart = paragraphBreak.upperBound
        } else {
            blockStart = text.startIndex
        }
        block = text[blockStart...]
        var tailStart = blockStart
        if block.contains("\n") {
            guard isListBlock(block), let lineBreak = text.range(of: "\n", options: .backwards) else {
                return Result(head: text, tail: "")
            }
            tailStart = lineBreak.upperBound
        }
        let tail = text[tailStart...]
        if tail.isEmpty { return Result(head: text, tail: "") }
        if startsRendererBlock(tail) {
            return Result(head: text, tail: "")
        }
        return Result(head: String(text[..<tailStart]), tail: String(tail))
    }

    private static func fenceCount(in text: String) -> Int {
        text.components(separatedBy: "```").count - 1
    }

    private static func isListBlock(_ block: Substring) -> Bool {
        guard let first = block.split(separator: "\n", omittingEmptySubsequences: false).first else { return false }
        return isListLine(first)
    }

    private static func isListLine(_ line: Substring) -> Bool {
        let trimmed = line.drop(while: { $0 == " " })
        if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ") { return true }
        var digits = 0
        for character in trimmed {
            if character.isNumber { digits += 1; continue }
            return digits > 0 && (character == "." || character == ")")
        }
        return false
    }

    private static func startsRendererBlock(_ tail: Substring) -> Bool {
        let trimmed = tail.drop(while: { $0 == " " })
        return isListLine(trimmed) || trimmed.hasPrefix("~~~") || trimmed.hasPrefix("#") || trimmed.hasPrefix("|") || trimmed.hasPrefix(">") || trimmed.hasPrefix("```")
    }
}
