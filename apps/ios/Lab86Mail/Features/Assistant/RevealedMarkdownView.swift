import SwiftStreamingMarkdown
import SwiftUI

// The text reveal (docs/chat-agentic-pass.md, section 4). The model keeps the
// raw buffer; this view meters it out one word at a time and draws the
// leading indicator after the last revealed word.
//
// SwiftStreamingMarkdown fades appended text but takes no custom transition,
// so the revealed text is split in two: everything up to the current
// paragraph (or the current list line) goes to `MarkdownView` with the
// library's fade off, and the trailing run is laid out word by word in a flow
// layout where each new word rises 6pt with opacity over 150ms on the route
// chip curve. When the run completes it moves into the Markdown view; blocks
// the flow layout cannot draw (fenced code, tables, headings) stay whole in
// the Markdown view. The dot sits after the last word of the run, or on its
// own line while the run is empty.
struct RevealedMarkdownView: View {
    /// The word rise: the route chip flip curve.
    static let riseAnimation = Animation.timingCurve(0.165, 0.84, 0.44, 1, duration: 0.15)
    private static let headConfig = MarkdownRenderConfig(shouldAnimateText: false)

    let text: String
    /// True while this text is the reply being written.
    let isLive: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var meter = RevealMeter()
    @State private var revealed = ""
    @State private var pump: Task<Void, Never>?
    @State private var didAppear = false

    var body: some View {
        let split = isLive || !meter.isDrained ? RevealSplit.split(revealed) : RevealSplit.Result(head: revealed, tail: "")
        VStack(alignment: .leading, spacing: 6) {
            if !split.head.isEmpty {
                MarkdownView(text: split.head, config: Self.headConfig)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !split.tail.isEmpty || showsDot {
                RevealRunView(text: split.tail, showsDot: showsDot)
            }
        }
        .onChange(of: text, initial: true) { _, next in
            let restoring = !didAppear && !isLive
            didAppear = true
            if reduceMotion || restoring {
                pump?.cancel()
                pump = nil
                meter.update(text: next)
                meter.revealAll()
                revealed = next
                return
            }
            meter.update(text: next)
            if !isLive { meter.finish() }
            startPump()
        }
        .onChange(of: isLive) { _, live in
            guard !live else { return }
            meter.finish()
            if reduceMotion {
                meter.revealAll()
                revealed = meter.revealedText
            } else {
                startPump()
            }
        }
        .onChange(of: reduceMotion) { _, reduced in
            guard reduced else { return }
            pump?.cancel()
            pump = nil
            meter.revealAll()
            revealed = text
        }
        .onDisappear {
            pump?.cancel()
            pump = nil
        }
    }

    /// The indicator shows while the reply is live and until the backlog
    /// drains. Reduced motion keeps a still dot; the pulse is the only motion.
    private var showsDot: Bool {
        isLive || !meter.isDrained
    }

    private func startPump() {
        guard pump == nil else { return }
        pump = Task { @MainActor in
            defer { pump = nil }
            var previous = Date.now.addingTimeInterval(-RevealMeter.baseCadence)
            while !Task.isCancelled, meter.backlog > 0 {
                let now = Date.now
                meter.advance(elapsed: now.timeIntervalSince(previous))
                previous = now
                withAnimation(reduceMotion ? nil : Self.riseAnimation) {
                    revealed = meter.revealedText
                }
                try? await Task.sleep(for: .seconds(RevealMeter.baseCadence))
            }
        }
    }
}

/// The trailing run: attributed word runs in a flow layout, plus the dot.
private struct RevealRunView: View {
    let text: String
    let showsDot: Bool

    var body: some View {
        WordFlowLayout(horizontalSpacing: 4, verticalSpacing: 3) {
            ForEach(Array(words.enumerated()), id: \.offset) { _, word in
                Text(word)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.asymmetric(
                        insertion: .offset(y: 6).combined(with: .opacity),
                        removal: .identity
                    ))
            }
            if showsDot {
                RevealDot()
                    .padding(.leading, 2)
                    .transition(.identity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var words: [AttributedString] {
        RevealWordRuns.words(in: text)
    }
}

/// Inline Markdown split into word runs that keep their attributes.
enum RevealWordRuns {
    static func words(in text: String) -> [AttributedString] {
        let attributed: AttributedString
        if let parsed = try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            attributed = parsed
        } else {
            attributed = AttributedString(text)
        }
        var words: [AttributedString] = []
        var wordStart: AttributedString.Index?
        let characters = attributed.characters
        var index = characters.startIndex
        while index < characters.endIndex {
            let character = characters[index]
            if character.isWhitespace {
                if let start = wordStart {
                    words.append(AttributedString(attributed[start..<index]))
                    wordStart = nil
                }
            } else if wordStart == nil {
                wordStart = index
            }
            index = characters.index(after: index)
        }
        if let start = wordStart {
            words.append(AttributedString(attributed[start..<characters.endIndex]))
        }
        return words
    }
}

/// A 6pt accent dot that pulses on a 1.2s cycle. It marks the writing
/// position in the reply and the running rows of the work log.
struct RevealDot: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var lit = false

    var body: some View {
        Circle()
            .fill(environment.theme.accentColor)
            .frame(width: 6, height: 6)
            .opacity(reduceMotion ? 1 : (lit ? 1 : 0.35))
            .scaleEffect(reduceMotion ? 1 : (lit ? 1 : 0.85))
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) {
                    lit = true
                }
            }
            .accessibilityHidden(true)
    }
}

/// Left-to-right flow of word views that wraps at the proposed width.
struct WordFlowLayout: Layout {
    var horizontalSpacing: CGFloat = 4
    var verticalSpacing: CGFloat = 3

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        return arrange(width: width, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let arrangement = arrange(width: bounds.width, subviews: subviews)
        for (index, frame) in arrangement.frames.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                anchor: .topLeading,
                proposal: ProposedViewSize(frame.size)
            )
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> (size: CGSize, frames: [CGRect]) {
        var frames: [CGRect] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        var maxX: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: width.isFinite ? width : nil, height: nil))
            if x > 0, x + size.width > width {
                x = 0
                y += lineHeight + verticalSpacing
                lineHeight = 0
            }
            // Short items (the dot) sit on the text baseline region, not the
            // line top.
            let offsetY = size.height < lineHeight ? (lineHeight - size.height) * 0.62 : 0
            frames.append(CGRect(x: x, y: y + offsetY, width: size.width, height: size.height))
            x += size.width + horizontalSpacing
            lineHeight = max(lineHeight, size.height)
            maxX = max(maxX, x - horizontalSpacing)
        }
        let height = subviews.isEmpty ? 0 : y + lineHeight
        return (CGSize(width: width.isFinite ? width : maxX, height: height), frames)
    }
}
