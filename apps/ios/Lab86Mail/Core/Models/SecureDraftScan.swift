import Foundation

// Values that look like secrets in the user's own words (lib/secure/redact.ts,
// V9). The composer warns before a message goes out. The server is the
// backstop: a message that still holds such a value reaches the model and
// the saved chat as "[removed: looks like a Social Security number]". The
// checks are strict on purpose, so tracking numbers, phone numbers, and
// order numbers stay as they are. The patterns are the TypeScript ones,
// character for character.

enum SecretShapeKind: String, Hashable, Sendable, CaseIterable {
    case ssn
    case card
    case apiKey = "api_key"

    /// `SECRET_SHAPE_NAMES`.
    var name: String {
        switch self {
        case .ssn: "a Social Security number"
        case .card: "a card number"
        case .apiKey: "an API key"
        }
    }

    /// The item kind the value can be saved as. A card number has none.
    var saveKind: SecureItemKind? {
        switch self {
        case .ssn: .idNumber
        case .apiKey: .apiKey
        case .card: nil
        }
    }
}

struct SecretShapeMatch: Hashable, Sendable {
    let kind: SecretShapeKind
    let range: Range<String.Index>
}

enum SecureDraftScan {
    /// `redactedMarker`.
    static func marker(_ kind: SecretShapeKind) -> String {
        "[removed: looks like \(kind.name)]"
    }

    private static let ssnGrouped = #"\b(?!000|666|9\d\d)\d{3}([- ])(?!00)\d{2}\1(?!0000)\d{4}\b"#
    private static let ssnNamed =
        #"\b(?:ssn|social security(?: number| no\.?)?|soc\.? ?sec\.?)\b[^0-9\n]{0,20}((?!000|666|9\d\d)\d{3}(?!00)\d{2}(?!0000)\d{4})\b"#
    private static let cardCandidate = #"\b\d(?:[ -]?\d){12,18}\b"#
    private static let apiKeys = [
        #"\bsk-[A-Za-z0-9_-]{16,}"#,
        #"\bsk_(?:live|test)_[A-Za-z0-9]{16,}"#,
        #"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"#,
        #"\bgh[pousr]_[A-Za-z0-9]{30,}"#,
        #"\bxox[abprs]-[A-Za-z0-9-]{10,}"#,
        #"\bAIza[0-9A-Za-z_-]{30,}"#,
        #"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)"#,
    ]

    /// Every secret-shaped value in a text, in order, without overlaps.
    static func detect(_ text: String) -> [SecretShapeMatch] {
        guard !text.isEmpty else { return [] }
        var found: [SecretShapeMatch] = []
        for range in ranges(of: ssnGrouped, in: text) {
            found.append(SecretShapeMatch(kind: .ssn, range: range))
        }
        for range in ranges(of: ssnNamed, in: text, options: [.caseInsensitive], group: 1) {
            found.append(SecretShapeMatch(kind: .ssn, range: range))
        }
        for range in ranges(of: cardCandidate, in: text) {
            let digits = text[range].filter(\.isNumber)
            if digits.count >= 13, digits.count <= 19, cardNetwork(digits), luhn(digits) {
                found.append(SecretShapeMatch(kind: .card, range: range))
            }
        }
        for pattern in apiKeys {
            for range in ranges(of: pattern, in: text) {
                found.append(SecretShapeMatch(kind: .apiKey, range: range))
            }
        }
        found.sort { left, right in
            if left.range.lowerBound != right.range.lowerBound { return left.range.lowerBound < right.range.lowerBound }
            return left.range.upperBound > right.range.upperBound
        }
        var kept: [SecretShapeMatch] = []
        for match in found {
            if let last = kept.last, match.range.lowerBound < last.range.upperBound { continue }
            kept.append(match)
        }
        return kept
    }

    /// The text with each secret-shaped value replaced by its marker, and the kinds found.
    static func redact(_ text: String) -> (text: String, kinds: [SecretShapeKind]) {
        let matches = detect(text)
        guard !matches.isEmpty else { return (text, []) }
        var out = ""
        var at = text.startIndex
        var kinds: [SecretShapeKind] = []
        for match in matches {
            out += text[at..<match.range.lowerBound]
            out += marker(match.kind)
            at = match.range.upperBound
            if !kinds.contains(match.kind) { kinds.append(match.kind) }
        }
        out += text[at...]
        return (out, kinds)
    }

    /// The text with the matches taken out, and nothing in their place.
    static func removing(_ matches: [SecretShapeMatch], from text: String) -> String {
        var out = ""
        var at = text.startIndex
        for match in matches.sorted(by: { $0.range.lowerBound < $1.range.lowerBound }) {
            guard match.range.lowerBound >= at else { continue }
            out += text[at..<match.range.lowerBound]
            at = match.range.upperBound
        }
        out += text[at...]
        return out
    }

    static func luhn(_ digits: String) -> Bool {
        var sum = 0
        var double = false
        for character in digits.reversed() {
            guard var digit = character.wholeNumberValue else { return false }
            if double {
                digit *= 2
                if digit > 9 { digit -= 9 }
            }
            sum += digit
            double.toggle()
        }
        return !digits.isEmpty && sum % 10 == 0
    }

    /// A card network prefix with a length that network uses.
    static func cardNetwork(_ digits: String) -> Bool {
        let length = digits.count
        if digits.hasPrefix("4") { return [13, 16, 19].contains(length) }
        if matches(digits, #"^(5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)"#) { return length == 16 }
        if matches(digits, #"^3[47]"#) { return length == 15 }
        if matches(digits, #"^(6011|65|64[4-9])"#) { return length >= 16 && length <= 19 }
        if matches(digits, #"^35(2[89]|[3-8]\d)"#) { return length >= 16 && length <= 19 }
        return false
    }

    private static func matches(_ text: String, _ pattern: String) -> Bool {
        text.range(of: pattern, options: .regularExpression) != nil
    }

    /// The ranges of a pattern (or of one of its groups) in the text.
    private static func ranges(
        of pattern: String,
        in text: String,
        options: NSRegularExpression.Options = [],
        group: Int = 0
    ) -> [Range<String.Index>] {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return [] }
        let whole = NSRange(text.startIndex..<text.endIndex, in: text)
        return regex.matches(in: text, range: whole).compactMap { result in
            let nsRange = group == 0 ? result.range : result.range(at: group)
            guard nsRange.location != NSNotFound else { return nil }
            return Range(nsRange, in: text)
        }
    }
}
