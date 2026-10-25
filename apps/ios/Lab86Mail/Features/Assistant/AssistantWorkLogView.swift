import SwiftUI

// The work log block (docs/chat-agentic-pass.md, section 2, and the 2026-10-24
// refresh): one italic work line that names what Albatross did, and the
// cards under it as flat inserts. A tap on the line shows the rows, one per
// tool call. No rule, no header meta string.
struct AssistantWorkLogView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let rows: [AssistantToolRow]
    /// True once the turn that owns these rows has finished.
    let turnFinished: Bool
    /// The conversation the rows belong to. Draft artifacts need it.
    var sessionID: String? = nil
    @State private var expanded = false

    static let showHint = "Shows the steps"
    static let hideHint = "Hides the steps"

    private var line: AssistantWorkLine.Line {
        AssistantWorkLine.line(rows: rows, turnFinished: turnFinished)
    }

    /// The rows drawn under the line: every row once open, else the ones
    /// with a card to show.
    private var shownRows: [AssistantToolRow] {
        expanded ? rows : rows.filter { $0.card != nil || $0.shape != nil }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            lineButton
            ForEach(shownRows) { row in
                AssistantWorkLogRowView(row: row, sessionID: sessionID, showsSentence: expanded)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: expanded)
        .accessibilityElement(children: .contain)
    }

    private var lineButton: some View {
        Button {
            expanded.toggle()
        } label: {
            WorkLineView(line: line, showsChevron: true, expanded: expanded)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(line.text)
        .accessibilityHint(expanded ? Self.hideHint : Self.showHint)
    }
}

struct AssistantWorkLogRowView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.workThread) private var thread
    let row: AssistantToolRow
    var sessionID: String? = nil
    var showsSentence = true

    var body: some View {
        if let stepRun = row.shape?.stepRun {
            stepRunBody(stepRun)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                if showsSentence {
                    sentence
                }
                if let card = row.card {
                    AssistantToolCardView(card: card, sessionID: sessionID)
                } else if let shape = row.shape {
                    AssistantShapeCardView(shape: shape)
                        .environment(\.assistantShapeActionScope, "\(sessionID ?? "chat"):\(row.callID)")
                }
            }
        }
    }

    private var sentence: some View {
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

    /// `albatross_handle_step`: inside the Albatross thread the run block
    /// draws in place of the row. A steer note leaves no row at all; the run
    /// log says "Read your note". Outside the thread the row offers "Open".
    @ViewBuilder private func stepRunBody(_ shape: ThreadStepRunShape) -> some View {
        if shape.action == .steered {
            EmptyView()
        } else if let thread, let view = thread.store.run(id: shape.runID) {
            RunBlockView(
                view: view,
                step: thread.step(for: view.run),
                ownsWaitingShortcut: thread.ownsWaitingShortcut(view),
                hasContinuation: thread.hasContinuation(view),
                busy: thread.store.busy,
                pageShown: thread.pageRun?.id == view.id,
                questionState: thread.questionState(for: view),
                actions: thread.actions
            )
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                sentence
                if thread == nil, !shape.workID.isEmpty {
                    Spacer(minLength: 8)
                    Button("Open") { environment.navigation.openWork(id: shape.workID, title: nil) }
                        .buttonStyle(.borderless)
                        .font(.footnote.weight(.medium))
                }
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
        case .needsInput:
            Image(systemName: "questionmark")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(.tint)
                .accessibilityLabel("Needs your choice")
        case .paused:
            Image(systemName: "pause")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(.secondary)
                .accessibilityLabel("Paused by you")
        }
    }

    private var sentenceColor: Color {
        switch row.state {
        case .running: .secondary
        case .done: Color.secondary.opacity(0.7)
        case .failed: .red
        case .needsInput: .primary
        case .paused: .secondary
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

/// The sources the reply cited, as one footnote line of links that wraps.
struct AssistantSourcesLine: View {
    @Environment(\.openURL) private var openURL
    let sources: [AssistantSourceLink]

    static let lead = "Sources"

    var body: some View {
        ChipFlowLayout(spacing: 10) {
            Text(Self.lead)
                .font(.footnote)
                .foregroundStyle(.tertiary)
            ForEach(sources) { source in
                Button {
                    open(source)
                } label: {
                    Text(Self.title(source))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .underline()
                        .lineLimit(1)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the source")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    static func title(_ source: AssistantSourceLink) -> String {
        source.title?.nilIfBlank ?? URL(string: source.url)?.host() ?? source.url
    }

    private func open(_ source: AssistantSourceLink) {
        guard let url = URL(string: source.url),
              ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { return }
        openURL(url)
    }
}
