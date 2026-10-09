import SwiftUI

// The blank: the user's part of a handoff, drawn as the form line it is
// (docs/albatross-blank-design.md). "Fill in ___, ___, and ___." The text is
// in the display font. Each blank is an empty line in the highlight voice
// (accent3), with the field name under the line. The web rules are
// lib/albatross/blanks.ts. iOS and macOS share this file.

/// One run of the sentence: text, or a blank with its field name.
enum BlankSentencePart: Equatable, Sendable {
    case text(String)
    case blank(String)
}

/// The sentence rules. The web pins the same words in `blankSentence`.
enum BlankSentenceRules {
    /// "Fill in [a]." / "Fill in [a] and [b]." / "Fill in [a], [b], and [c]."
    /// Empty when no name is left after the trim.
    static func parts(_ blanks: [String]) -> [BlankSentencePart] {
        let names = blanks
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !names.isEmpty else { return [] }
        var parts: [BlankSentencePart] = [.text("Fill in ")]
        for (index, name) in names.enumerated() {
            if index > 0 {
                let last = index == names.count - 1
                parts.append(.text(last ? (names.count == 2 ? " and " : ", and ") : ", "))
            }
            parts.append(.blank(name))
        }
        parts.append(.text("."))
        return parts
    }

    /// The sentence as plain text, for VoiceOver and notifications.
    static func text(_ blanks: [String]) -> String {
        parts(blanks)
            .map { part in
                switch part {
                case .text(let text): text
                case .blank(let name): name
                }
            }
            .joined()
    }

    /// One word or one blank of the drawn sentence. A word that follows a
    /// space has `spaceBefore`; punctuation after a blank has none.
    struct Token: Equatable, Sendable {
        enum Kind: Equatable, Sendable {
            case word(String)
            case blank(String)
        }

        let kind: Kind
        let spaceBefore: Bool
    }

    /// The words and blanks of the sentence, in order, so the line wraps
    /// between words like text.
    static func tokens(_ parts: [BlankSentencePart]) -> [Token] {
        var tokens: [Token] = []
        var pendingSpace = false
        var word = ""

        func flush() {
            guard !word.isEmpty else { return }
            tokens.append(Token(kind: .word(word), spaceBefore: pendingSpace && !tokens.isEmpty))
            word = ""
            pendingSpace = false
        }

        for part in parts {
            switch part {
            case .text(let text):
                for character in text {
                    if character == " " {
                        flush()
                        pendingSpace = true
                    } else {
                        word.append(character)
                    }
                }
                flush()
            case .blank(let name):
                tokens.append(Token(kind: .blank(name), spaceBefore: pendingSpace && !tokens.isEmpty))
                pendingSpace = false
            }
        }
        return tokens
    }
}

/// The user's part as one sentence with blanks. With no blanks, the
/// fallback text shows in the same display font, without lines; with no
/// fallback, nothing shows.
struct BlankSentence: View {
    @Environment(AppEnvironment.self) private var environment
    /// Dynamic Type for the lines and the gaps. `Font.custom` scales the
    /// text itself, relative to the body style.
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

    let blanks: [String]
    let fallback: String?
    let size: CGFloat

    init(blanks: [String], fallback: String? = nil, size: CGFloat = 19) {
        self.blanks = blanks
        self.fallback = fallback
        self.size = size
    }

    /// The text size after Dynamic Type, for the geometry around the words.
    private var pointSize: CGFloat { size * scale }

    private var displayFont: Font {
        environment.theme.displayType.displayFont(size: size, weight: .regular)
    }

    private var fallbackText: String? {
        fallback?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
    }

    var body: some View {
        let tokens = BlankSentenceRules.tokens(BlankSentenceRules.parts(blanks))
        if tokens.isEmpty {
            if let fallbackText {
                Text(fallbackText)
                    .font(displayFont)
                    .foregroundStyle(.primary)
                    .lineSpacing(pointSize * 0.2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else {
            BlankFlowLayout(
                spaceWidth: pointSize * 0.26,
                blankMargin: pointSize * 0.12,
                minimumAscent: pointSize * 0.9,
                lineSpacing: pointSize * 0.35
            ) {
                ForEach(Array(tokens.enumerated()), id: \.offset) { _, token in
                    tokenView(token)
                        .layoutValue(key: BlankTokenSpaceBefore.self, value: token.spaceBefore)
                        .layoutValue(key: BlankTokenIsBlank.self, value: token.isBlank)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(BlankSentenceRules.text(blanks))
        }
    }

    @ViewBuilder private func tokenView(_ token: BlankSentenceRules.Token) -> some View {
        switch token.kind {
        case .word(let word):
            Text(word)
                .font(displayFont)
                .foregroundStyle(.primary)
                .lineLimit(1)
                .fixedSize()
        case .blank(let name):
            blankLine(name)
        }
    }

    /// One empty line with its field name centered under it. The name sets
    /// the least width. The line sits a little under the text baseline.
    private func blankLine(_ name: String) -> some View {
        let color = environment.theme.accent3Color
        let underBaseline = -(pointSize * 0.12)
        return Text(name)
            .font(.system(size: 11 * scale, weight: .medium))
            .foregroundStyle(color)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, pointSize * 0.4)
            .padding(.top, 5)
            .frame(minWidth: pointSize * 4.7)
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(color)
                    .frame(height: 2)
            }
            .alignmentGuide(.firstTextBaseline) { _ in underBaseline }
    }
}

private extension BlankSentenceRules.Token {
    var isBlank: Bool {
        if case .blank = kind { return true }
        return false
    }
}

private struct BlankTokenSpaceBefore: LayoutValueKey {
    static let defaultValue = false
}

private struct BlankTokenIsBlank: LayoutValueKey {
    static let defaultValue = false
}

/// Words and blanks from left to right on shared text baselines, wrapping
/// at the proposed width. Punctuation after a blank does not start a line
/// alone: the word before it moves down with it.
private struct BlankFlowLayout: Layout {
    var spaceWidth: CGFloat
    var blankMargin: CGFloat
    /// The least distance from a line's top to its baseline, so a line of
    /// blanks only keeps the height of a line of text.
    var minimumAscent: CGFloat
    var lineSpacing: CGFloat

    private struct Item {
        let index: Int
        var x: CGFloat
        let width: CGFloat
        let baseline: CGFloat
        let height: CGFloat
        let spaceBefore: Bool
        let isBlank: Bool
    }

    private struct Line {
        var items: [Item] = []
        var y: CGFloat = 0
        var baseline: CGFloat = 0
        var height: CGFloat = 0
        var width: CGFloat { items.last.map { $0.x + $0.width } ?? 0 }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let lines = arrange(width: Self.finiteWidth(proposal.width), subviews: subviews)
        let width = lines.map(\.width).max() ?? 0
        let height = lines.last.map { $0.y + $0.height } ?? 0
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let lines = arrange(width: bounds.width, subviews: subviews)
        for line in lines {
            for item in line.items {
                subviews[item.index].place(
                    at: CGPoint(
                        x: bounds.minX + item.x,
                        y: bounds.minY + line.y + line.baseline - item.baseline
                    ),
                    anchor: .topLeading,
                    proposal: .unspecified
                )
            }
        }
    }

    private static func finiteWidth(_ width: CGFloat?) -> CGFloat {
        guard let width, width.isFinite else { return .infinity }
        return max(width, 0)
    }

    private func gap(before item: Item, after previous: Item?) -> CGFloat {
        guard let previous else { return 0 }
        var gap: CGFloat = item.spaceBefore ? spaceWidth : 0
        if item.isBlank || previous.isBlank { gap += blankMargin }
        return gap
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Line] {
        var lines: [Line] = []
        var line = Line()
        for (index, subview) in subviews.enumerated() {
            let dimensions = subview.dimensions(in: .unspecified)
            var item = Item(
                index: index,
                x: 0,
                width: dimensions.width,
                baseline: dimensions[VerticalAlignment.firstTextBaseline],
                height: dimensions.height,
                spaceBefore: subview[BlankTokenSpaceBefore.self],
                isBlank: subview[BlankTokenIsBlank.self]
            )
            let x = line.width + gap(before: item, after: line.items.last)
            if !line.items.isEmpty, x + item.width > width {
                // Punctuation keeps the word or blank before it.
                var carried: Item?
                if !item.spaceBefore, line.items.count > 1 {
                    carried = line.items.removeLast()
                }
                lines.append(line)
                line = Line()
                if var carried {
                    carried.x = 0
                    line.items.append(carried)
                }
            }
            item.x = line.items.isEmpty ? 0 : line.width + gap(before: item, after: line.items.last)
            line.items.append(item)
        }
        if !line.items.isEmpty { lines.append(line) }

        var y: CGFloat = 0
        for index in lines.indices {
            let baseline = max(minimumAscent, lines[index].items.map(\.baseline).max() ?? 0)
            let height = lines[index].items.map { baseline - $0.baseline + $0.height }.max() ?? 0
            lines[index].y = y
            lines[index].baseline = baseline
            lines[index].height = height
            y += height + lineSpacing
        }
        return lines
    }
}
