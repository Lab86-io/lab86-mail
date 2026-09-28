import Foundation

/// Bold ranges from the contract's `highlights` (UTF-16 offsets). Ranges
/// outside the text, or inside one character, are ignored.
enum RecipientHighlightText {
    static func attributed(_ text: String, highlights: [RecipientHighlight]) -> AttributedString {
        var attributed = AttributedString(text)
        let utf16Count = text.utf16.count
        for highlight in highlights {
            let start = max(0, highlight.start)
            let end = min(utf16Count, highlight.start + highlight.length)
            guard start < end else { continue }
            let utf16 = text.utf16
            let lower = utf16.index(utf16.startIndex, offsetBy: start)
            let upper = utf16.index(utf16.startIndex, offsetBy: end)
            guard let lowerCharacter = lower.samePosition(in: text),
                  let upperCharacter = upper.samePosition(in: text),
                  let range = Range(lowerCharacter..<upperCharacter, in: attributed) else { continue }
            attributed[range].inlinePresentationIntent = .stronglyEmphasized
        }
        return attributed
    }
}
