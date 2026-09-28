import Foundation

/// One address in a To, Cc, or Bcc field: a chip.
struct RecipientToken: Identifiable, Hashable, Sendable {
    let id: UUID
    var name: String?
    /// The address. For an invalid token this is the text as typed.
    var email: String
    var isValid: Bool
    var alternateEmails: [String]
    var photoURL: URL?

    init(
        id: UUID = UUID(),
        name: String?,
        email: String,
        isValid: Bool = true,
        alternateEmails: [String] = [],
        photoURL: URL? = nil
    ) {
        self.id = id
        self.name = name?.nilIfBlank
        self.email = email
        self.isValid = isValid
        self.alternateEmails = alternateEmails
        self.photoURL = photoURL
    }

    init(_ suggestion: RecipientSuggestion) {
        self.init(
            name: suggestion.name,
            email: suggestion.email,
            alternateEmails: suggestion.alternateEmails,
            photoURL: suggestion.photoURL
        )
    }

    static func invalid(_ text: String) -> RecipientToken {
        RecipientToken(name: nil, email: text, isValid: false)
    }

    /// The chip text: the name when known, the address when not.
    var displayName: String { name ?? email }

    var normalizedEmail: String { email.lowercased() }

    /// The text the compose value carries for this chip. The server splits the
    /// value on commas and reads `Name <email>` or `email`, so a name loses the
    /// characters that would break that format.
    var headerValue: String {
        guard isValid else { return RecipientAddressParser.sanitizedName(email) ?? "" }
        guard let name = RecipientAddressParser.sanitizedName(name),
              name.lowercased() != email.lowercased() else { return email }
        return "\(name) <\(email)>"
    }

    /// The text that Copy puts on the pasteboard. A paste into a recipient
    /// field makes the same chip again; an invalid chip copies the text as typed.
    var pasteboardText: String { isValid ? headerValue : email }
}

/// Reads and writes the comma-separated recipient strings that compose,
/// drafts, and the send path use (`Name <email>, email`).
enum RecipientAddressParser {
    // "\r\n" is one Character in Swift, so it is listed on its own.
    static let separators: Set<Character> = [",", ";", "\n", "\r", "\r\n", "\t"]

    /// Every chip in a recipient string. Commas inside quotes or angle
    /// brackets do not split, and `Last, First <email>` stays one chip.
    static func tokens(from value: String) -> [RecipientToken] {
        let split = splitKeepingRemainder(value)
        var pieces = split.complete
        let remainder = split.remainder.trimmingCharacters(in: .whitespacesAndNewlines)
        if !remainder.isEmpty { pieces.append(remainder) }
        return mergeSplitNames(pieces).flatMap(tokens(fromPiece:))
    }

    /// The valid addresses in a recipient string, lowercased.
    static func addresses(in value: String) -> [String] {
        tokens(from: value).filter(\.isValid).map(\.normalizedEmail)
    }

    /// The first entry that is not a complete address, across all fields.
    static func firstInvalidEntry(in values: [String]) -> String? {
        for value in values {
            if let invalid = tokens(from: value).first(where: { !$0.isValid }) {
                return invalid.email
            }
        }
        return nil
    }

    /// Splits at top-level separators. `complete` holds the trimmed, non-empty
    /// pieces before the last separator; `remainder` is the text after it.
    static func splitKeepingRemainder(_ text: String) -> (complete: [String], remainder: String, hadSeparator: Bool) {
        var pieces: [String] = []
        var current = ""
        var inQuotes = false
        var inAngle = false
        var hadSeparator = false
        for character in text {
            if character == "\"" {
                inQuotes.toggle()
                current.append(character)
            } else if character == "<", !inQuotes {
                inAngle = true
                current.append(character)
            } else if character == ">", !inQuotes {
                inAngle = false
                current.append(character)
            } else if separators.contains(character), !inQuotes, !inAngle {
                hadSeparator = true
                pieces.append(current)
                current = ""
            } else {
                current.append(character)
            }
        }
        let complete = pieces
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return (complete, current, hadSeparator)
    }

    /// Joins `Last` and `First <email>` when a provider wrote a name with a
    /// comma and no quotes.
    static func mergeSplitNames(_ pieces: [String]) -> [String] {
        var merged: [String] = []
        var index = 0
        while index < pieces.count {
            let piece = pieces[index]
            let next: String? = index + 1 < pieces.count ? pieces[index + 1] : nil
            if let next,
               !piece.contains("@"), !piece.contains("<"),
               next.contains("<"), next.contains("@"), next.hasSuffix(">"),
               next.first != "<" {
                merged.append("\(piece), \(next)")
                index += 2
            } else {
                merged.append(piece)
                index += 1
            }
        }
        return merged
    }

    /// The chips in one piece. A piece of several bare addresses separated by
    /// spaces becomes several chips; anything else becomes one chip.
    static func tokens(fromPiece piece: String) -> [RecipientToken] {
        let single = token(from: piece)
        if single.isValid { return [single] }
        let words = piece.split(whereSeparator: \.isWhitespace).map(String.init)
        if words.count > 1, !piece.contains("<"), words.allSatisfy(isValidEmail) {
            return words.map { RecipientToken(name: nil, email: $0) }
        }
        return [single]
    }

    /// One chip from `Name <email>`, `"Name" <email>`, `<email>`, `mailto:email`, or `email`.
    static func token(from piece: String) -> RecipientToken {
        var text = piece.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.lowercased().hasPrefix("mailto:") {
            text = String(text.dropFirst("mailto:".count))
        }
        if let open = text.lastIndex(of: "<"),
           let close = text.lastIndex(of: ">"),
           open < close {
            let email = text[text.index(after: open)..<close]
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let name = text[..<open]
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
            if isValidEmail(email) {
                return RecipientToken(name: name.nilIfBlank, email: email)
            }
            return .invalid(text)
        }
        if isValidEmail(text) {
            return RecipientToken(name: nil, email: text)
        }
        return .invalid(text)
    }

    /// The whole text is one or more complete addresses (a paste or an
    /// autofill), with no text left over.
    static func completeTokens(in text: String) -> [RecipientToken]? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let tokens = tokens(fromPiece: trimmed)
        return tokens.allSatisfy(\.isValid) ? tokens : nil
    }

    static func isCompleteAddress(_ text: String) -> Bool {
        token(from: text).isValid
    }

    /// A practical address check: one `@`, a local part with the usual
    /// characters, and a domain of two or more labels. International letters
    /// are allowed.
    static func isValidEmail(_ text: String) -> Bool {
        guard !text.isEmpty, text.count <= 254,
              !text.contains(where: { $0.isWhitespace }) else { return false }
        let parts = text.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return false }
        let local = parts[0]
        let domain = parts[1]
        guard !local.isEmpty, local.count <= 64,
              !local.hasPrefix("."), !local.hasSuffix("."), !local.contains("..") else { return false }
        guard local.unicodeScalars.allSatisfy({ localCharacters.contains($0) }) else { return false }
        let labels = domain.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2 else { return false }
        for label in labels {
            guard !label.isEmpty, label.count <= 63,
                  !label.hasPrefix("-"), !label.hasSuffix("-"),
                  label.unicodeScalars.allSatisfy({ domainCharacters.contains($0) }) else { return false }
        }
        guard let topLevel = labels.last, topLevel.count >= 2,
              !topLevel.allSatisfy(\.isNumber) else { return false }
        return true
    }

    /// A display name with the characters the header format cannot carry
    /// removed, and white space collapsed. Nil when nothing is left.
    static func sanitizedName(_ name: String?) -> String? {
        guard let name else { return nil }
        let removed = name.unicodeScalars.map { scalar -> Character in
            unsafeNameCharacters.contains(scalar) ? " " : Character(scalar)
        }
        let collapsed = String(removed)
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
        return collapsed.nilIfBlank
    }

    /// The compose value for a list of chips and the text still in the field.
    static func value(tokens: [RecipientToken], draft: String) -> String {
        var parts = tokens.map(\.headerValue).filter { !$0.isEmpty }
        if let draft = draft.nilIfBlank { parts.append(draft) }
        return parts.joined(separator: ", ")
    }

    private static let localCharacters: CharacterSet = {
        var set = CharacterSet.alphanumerics
        set.insert(charactersIn: "!#$%&'*+/=?^_`{|}~.-")
        return set
    }()

    private static let domainCharacters: CharacterSet = {
        var set = CharacterSet.alphanumerics
        set.insert(charactersIn: "-")
        return set
    }()

    private static let unsafeNameCharacters = CharacterSet(charactersIn: ",;<>\"")
}

/// The chips and the typed text of one recipient field, with the rules that
/// turn typing, pasting, and picking into chips. A value type, so every rule
/// has a unit test without a view.
struct RecipientFieldState: Equatable, Sendable {
    var tokens: [RecipientToken] = []
    var draft: String = ""
    /// The chip that a Backspace on an empty field selected. The next
    /// Backspace removes it; typing clears the selection.
    var selectedTokenID: UUID?

    init(tokens: [RecipientToken] = [], draft: String = "") {
        self.tokens = tokens
        self.draft = draft
    }

    /// The chips in a compose value. All text becomes chips; text that is not
    /// a complete address becomes a chip marked invalid.
    init(value: String) {
        self.init(tokens: RecipientAddressParser.tokens(from: value))
    }

    /// The compose value: the chips as `Name <email>` or `email`, comma
    /// separated, then the typed text.
    var value: String { RecipientAddressParser.value(tokens: tokens, draft: draft) }

    /// Lowercased addresses of the valid chips, for `exclude`.
    var addresses: [String] { tokens.filter(\.isValid).map(\.normalizedEmail) }

    var hasInvalidToken: Bool { tokens.contains { !$0.isValid } }

    /// Applies the field's new text. A comma, semicolon, or new line turns the
    /// text before it into chips; a space does the same only after a complete
    /// address. When the text before a separator is not a complete address,
    /// `suggestion` (the highlighted search result) becomes the chip instead.
    /// A paste of complete addresses becomes chips at once.
    @discardableResult
    mutating func edit(_ newText: String, pick suggestion: RecipientSuggestion? = nil) -> Bool {
        let before = tokens
        let previousDraft = draft
        let isPaste = newText.count > previousDraft.count + 1
        let split = RecipientAddressParser.splitKeepingRemainder(newText)
        if !split.hadSeparator {
            let trimmed = newText.trimmingCharacters(in: .whitespacesAndNewlines)
            if isPaste, let pasted = RecipientAddressParser.completeTokens(in: trimmed) {
                append(pasted)
                draft = ""
            } else if newText.last?.isWhitespace == true,
                      !trimmed.contains(where: { $0.isWhitespace }),
                      RecipientAddressParser.isValidEmail(trimmed) {
                append([RecipientToken(name: nil, email: trimmed)])
                draft = ""
            } else {
                draft = String(newText.drop(while: { $0.isWhitespace }))
            }
        } else {
            var pieces = RecipientAddressParser.mergeSplitNames(split.complete)
            var added: [RecipientToken] = []
            if !isPaste, let suggestion, let first = pieces.first,
               !RecipientAddressParser.isCompleteAddress(first) {
                added.append(RecipientToken(suggestion))
                pieces.removeFirst()
            }
            added += pieces.flatMap(RecipientAddressParser.tokens(fromPiece:))
            if isPaste, let rest = RecipientAddressParser.completeTokens(in: split.remainder) {
                added += rest
                draft = ""
            } else {
                draft = String(split.remainder.drop(while: { $0.isWhitespace }))
            }
            append(added)
        }
        if draft != previousDraft || tokens != before { selectedTokenID = nil }
        return tokens != before
    }

    /// Turns the typed text into chips (Return, Tab, or leaving the field).
    /// With `onlyValid`, text that is not a complete address stays as text.
    @discardableResult
    mutating func commitDraft(onlyValid: Bool = false) -> Bool {
        guard let text = draft.nilIfBlank else {
            draft = ""
            return false
        }
        let tokens = RecipientAddressParser.tokens(from: text)
        if onlyValid, !tokens.allSatisfy(\.isValid) { return false }
        let before = self.tokens
        append(tokens)
        draft = ""
        selectedTokenID = nil
        return self.tokens != before
    }

    /// Adds the picked suggestion as a chip and clears the typed text.
    mutating func pick(_ suggestion: RecipientSuggestion) {
        append([RecipientToken(suggestion)])
        draft = ""
        selectedTokenID = nil
    }

    /// Backspace with no typed text: select the last chip, or remove the
    /// selected one. Returns true when a chip was removed.
    @discardableResult
    mutating func backspaceOnEmptyDraft() -> Bool {
        guard draft.isEmpty else { return false }
        if let selected = selectedTokenID {
            tokens.removeAll { $0.id == selected }
            selectedTokenID = nil
            return true
        }
        selectedTokenID = tokens.last?.id
        return false
    }

    mutating func remove(_ id: UUID) {
        tokens.removeAll { $0.id == id }
        if selectedTokenID == id { selectedTokenID = nil }
    }

    var selectedToken: RecipientToken? {
        guard let selectedTokenID else { return nil }
        return tokens.first { $0.id == selectedTokenID }
    }

    /// Left arrow with no typed text: select the last chip, then the chip
    /// before it. The first chip stays selected.
    mutating func selectPreviousToken() {
        guard draft.isEmpty, !tokens.isEmpty else { return }
        guard let selectedTokenID, let index = tokens.firstIndex(where: { $0.id == selectedTokenID }) else {
            self.selectedTokenID = tokens.last?.id
            return
        }
        self.selectedTokenID = tokens[max(index - 1, 0)].id
    }

    /// Right arrow on a selected chip: select the next chip. After the last
    /// chip, the selection goes back to the text.
    mutating func selectNextToken() {
        guard let selectedTokenID, let index = tokens.firstIndex(where: { $0.id == selectedTokenID }) else { return }
        self.selectedTokenID = index + 1 < tokens.count ? tokens[index + 1].id : nil
    }

    /// Forward Delete or Cut on a selected chip. Returns true when a chip was removed.
    @discardableResult
    mutating func removeSelectedToken() -> Bool {
        guard let selectedTokenID, tokens.contains(where: { $0.id == selectedTokenID }) else { return false }
        remove(selectedTokenID)
        return true
    }

    /// Puts a chip back into the field as text, to correct it.
    mutating func beginEditing(_ id: UUID) {
        guard let token = tokens.first(where: { $0.id == id }) else { return }
        remove(id)
        draft = token.email
    }

    /// Changes a chip to one of the contact's other addresses.
    mutating func useAlternate(_ email: String, for id: UUID) {
        guard let index = tokens.firstIndex(where: { $0.id == id }),
              RecipientAddressParser.isValidEmail(email) else { return }
        let old = tokens[index]
        guard !tokens.contains(where: { $0.id != id && $0.isValid && $0.normalizedEmail == email.lowercased() }) else {
            return
        }
        tokens[index].alternateEmails = ([old.email] + old.alternateEmails)
            .filter { $0.lowercased() != email.lowercased() }
        tokens[index].email = email
        tokens[index].isValid = true
    }

    /// Adds chips, skipping a valid address that is already in the field.
    private mutating func append(_ newTokens: [RecipientToken]) {
        for token in newTokens {
            if token.isValid, tokens.contains(where: { $0.isValid && $0.normalizedEmail == token.normalizedEmail }) {
                continue
            }
            tokens.append(token)
        }
    }
}
