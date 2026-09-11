import SwiftUI

// The live work log block (docs/chat-agentic-pass.md, section 2): a vertical
// rule on the left, a header that reads the state of the group, one row per
// tool call, and the tool's card under its row inside the rule.
struct AssistantWorkLogView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let rows: [AssistantToolRow]
    /// True once the turn that owns these rows has finished.
    let turnFinished: Bool
    /// The conversation the rows belong to. Draft artifacts need it.
    var sessionID: String? = nil
    // nil follows the collapse rule; a tap pins the choice for this block.
    @State private var expandedOverride: Bool?

    private var headerState: AssistantWorkLog.HeaderState {
        AssistantWorkLog.headerState(rows: rows, turnFinished: turnFinished)
    }

    private var isExpanded: Bool {
        expandedOverride ?? !AssistantWorkLog.collapsesByDefault(rows: rows, turnFinished: turnFinished)
    }

    private var canToggle: Bool {
        turnFinished
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if isExpanded {
                ForEach(rows) { row in
                    AssistantWorkLogRowView(row: row, sessionID: sessionID)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 14)
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 1)
                .fill(environment.theme.hairlineColor)
                .frame(width: 2)
                .padding(.vertical, 2)
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: isExpanded)
        .accessibilityElement(children: .contain)
    }

    private var header: some View {
        Button {
            guard canToggle else { return }
            expandedOverride = !isExpanded
        } label: {
            HStack(spacing: 8) {
                if case .working = headerState {
                    RevealDot()
                }
                Text(AssistantWorkLog.headerText(headerState))
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(headerColor)
                if canToggle {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(!canToggle)
        .accessibilityLabel(AssistantWorkLog.headerText(headerState))
        .accessibilityHint(canToggle ? (isExpanded ? "Collapses the steps" : "Shows the steps") : "")
    }

    private var headerColor: Color {
        if case .failed = headerState { return .red }
        return .secondary
    }
}

struct AssistantWorkLogRowView: View {
    @Environment(AppEnvironment.self) private var environment
    let row: AssistantToolRow
    var sessionID: String? = nil
    var showsSentence = true

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if showsSentence {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    indicator
                        .frame(width: 12, alignment: .center)
                    Text(row.sentence)
                        .font(.footnote)
                        .foregroundStyle(sentenceColor)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
            if let card = row.card {
                AssistantToolCardView(card: card, sessionID: sessionID)
            } else if let shape = row.shape {
                AssistantShapeCardView(shape: shape)
                    .environment(\.assistantShapeActionScope, "\(sessionID ?? "chat"):\(row.callID)")
            }
        }
    }

    @ViewBuilder private var indicator: some View {
        switch row.state {
        case .running:
            RevealDot()
        case .done:
            Image(systemName: "checkmark")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(.tertiary)
                .accessibilityLabel("Done")
        case .failed:
            Image(systemName: "xmark")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(.red)
                .accessibilityLabel("Failed")
        }
    }

    private var sentenceColor: Color {
        switch row.state {
        case .running: .secondary
        case .done: Color.secondary.opacity(0.7)
        case .failed: .red
        }
    }
}

/// One collapsed `Thought` line above the reply. A tap shows the text.
struct AssistantReasoningLine: View {
    let reasoning: AssistantReasoningPart
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                expanded.toggle()
            } label: {
                HStack(spacing: 6) {
                    if reasoning.isStreaming {
                        RevealDot()
                    }
                    Text(reasoning.label)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.secondary)
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint(expanded ? "Hides the reasoning" : "Shows the reasoning")
            if expanded {
                Text(reasoning.text.trimmingCharacters(in: .whitespacesAndNewlines))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .animation(.easeOut(duration: 0.2), value: expanded)
    }
}

/// Sources the reply cited, as one quiet list of links.
struct AssistantSourcesLine: View {
    @Environment(\.openURL) private var openURL
    let sources: [AssistantSourceLink]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Sources")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(sources) { source in
                Button {
                    if let url = URL(string: source.url), ["https", "http"].contains(url.scheme?.lowercased() ?? "") { openURL(url) }
                } label: {
                    Text(source.title?.nilIfBlank ?? URL(string: source.url)?.host() ?? source.url)
                        .font(.caption)
                        .lineLimit(1)
                        .foregroundStyle(.secondary)
                        .underline()
                }
                .buttonStyle(.plain)
            }
        }
    }
}
