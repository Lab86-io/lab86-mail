import SwiftStreamingMarkdown
import SwiftUI

// What a goal run wrote to the user while it worked (docs/albatross-goal-runs.md,
// G2): Albatross's own voice, in the same Markdown renderer as its chat
// messages, no bubble, no time. Each message carries its sources as text
// capsules: the title, then one locator in the secondary style. The newest
// messages show in full; older ones fold under "Earlier messages". The only
// motion is a new message's arrival. iOS and macOS share this file.

struct RunMessagesView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let messages: [RunMessage]
    let state: RunBlockState
    var onSource: (RunSource) -> Void = { _ in }

    @State private var showsEarlier = false

    /// The chat's own renderer, without the reveal animation.
    static let markdownConfig = MarkdownRenderConfig(shouldAnimateText: false)

    var body: some View {
        let split = GoalRunMessages.split(messages, state: state)
        VStack(alignment: .leading, spacing: 10) {
            if !split.earlier.isEmpty {
                earlier(split.earlier)
            }
            ForEach(split.shown) { message in
                RunMessageView(message: message, onSource: onSource)
                    .transition(.opacity)
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: split.shown.map(\.id))
        .accessibilityElement(children: .contain)
    }

    private func earlier(_ messages: [RunMessage]) -> some View {
        DisclosureGroup(isExpanded: $showsEarlier) {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(messages) { message in
                    RunMessageView(message: message, onSource: onSource)
                }
            }
            .padding(.top, 8)
        } label: {
            HStack(spacing: 6) {
                Text(GoalRunCopy.earlierMessages)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text("\(messages.count)")
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
        }
    }
}

/// One message: the text, then its source capsules.
struct RunMessageView: View {
    let message: RunMessage
    var onSource: (RunSource) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            MarkdownView(text: RunMessageText.safe(message.text), config: RunMessagesView.markdownConfig)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !message.sources.isEmpty {
                RunSourceChips(sources: message.sources, onOpen: onSource)
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// The sources of one message, as capsules that wrap like words.
struct RunSourceChips: View {
    let sources: [RunSource]
    var onOpen: (RunSource) -> Void = { _ in }

    var body: some View {
        ChipFlowLayout(spacing: 6) {
            ForEach(sources) { source in
                RunSourceChip(source: source) { onOpen(source) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One source: the title, then one locator in the secondary style ("irs.gov",
/// "HD-214"). Text only, no icon. A tap opens the source.
struct RunSourceChip: View {
    @Environment(AppEnvironment.self) private var environment
    let source: RunSource
    let action: () -> Void

    /// A long title truncates inside the capsule instead of pushing past the line.
    static let maxWidth: CGFloat = 260

    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(source.title)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                if let locator = RunSourceLocator.text(source) {
                    Text(locator)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .layoutPriority(1)
                }
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .frame(maxWidth: Self.maxWidth, alignment: .leading)
            .fixedSize(horizontal: true, vertical: false)
            .background(environment.theme.subtleColor, in: Capsule())
            .overlay {
                Capsule().strokeBorder(environment.theme.hairlineColor, lineWidth: 1)
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help(source.url ?? source.title)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint("Opens the source")
    }

    private var accessibilityLabel: String {
        var parts = ["Source.", "\(source.title)."]
        if let locator = RunSourceLocator.text(source) { parts.append("\(locator).") }
        return parts.joined(separator: " ")
    }
}

/// Capsules from left to right, with a new line when the next one does not
/// fit. The same idea as `BlankFlowLayout`, without baselines.
struct ChipFlowLayout: Layout {
    var spacing: CGFloat = 6

    private struct Item {
        let index: Int
        let x: CGFloat
        let size: CGSize
    }

    private struct Row {
        var items: [Item] = []
        var y: CGFloat = 0
        var height: CGFloat = 0
        var width: CGFloat = 0
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = Self.finiteWidth(proposal.width)
        let rows = arrange(width: width, subviews: subviews)
        let height = rows.last.map { $0.y + $0.height } ?? 0
        let widest = rows.map(\.width).max() ?? 0
        return CGSize(width: width.isFinite ? min(width, max(widest, 0)) : widest, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = arrange(width: bounds.width, subviews: subviews)
        for row in rows {
            for item in row.items {
                subviews[item.index].place(
                    at: CGPoint(x: bounds.minX + item.x, y: bounds.minY + row.y),
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

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        var x: CGFloat = 0
        var y: CGFloat = 0
        for (index, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)
            if !row.items.isEmpty, x + size.width > width {
                row.width = max(0, x - spacing)
                rows.append(row)
                y += row.height + spacing
                row = Row()
                row.y = y
                x = 0
            }
            row.items.append(Item(index: index, x: x, size: size))
            row.height = max(row.height, size.height)
            x += size.width + spacing
        }
        if !row.items.isEmpty {
            row.width = max(0, x - spacing)
            rows.append(row)
        }
        return rows
    }
}
