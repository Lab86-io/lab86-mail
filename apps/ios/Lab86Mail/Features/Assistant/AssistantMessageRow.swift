import SwiftUI

// One message of an Albatross conversation: the user's words in the
// accent-soft turn, or an Albatross reply as plain text with its work line,
// its inserts, its questions, and its sources. The Chat tab and the
// Albatross thread share it. The host says which reply streams and which
// one is newest, so a token redraws one row and not the list (C7).
struct AssistantMessageRow: View {
    @Environment(AppEnvironment.self) private var environment
    // The thread this row renders inside, when it renders inside one: a note
    // to a run gets its receipt from it (docs/albatross-threads.md, T7).
    @Environment(\.workThread) private var workThread
    @Bindable var model: AssistantChatModel
    let message: AssistantChatMessage
    /// The reply that streams now.
    var isStreamingReply = false
    /// The newest reply: the one with "Copy" and "Hold this" once it ends.
    var isLatestReply = false

    static let copyLabel = "Copy"
    static let copiedLabel = "Copied"
    static let holdLabel = "Hold this"
    static let keptLabel = "Kept"
    static let shareLabel = "Share"

    var body: some View {
        switch message.role {
        case .user:
            userTurn
        case .assistant:
            replyWithMenu
        }
    }

    // MARK: - The user's turn

    private var userTurn: some View {
        VStack(alignment: .trailing, spacing: 4) {
            TrailingBubbleLayout(fraction: 0.8) {
                Text(message.text)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(
                        environment.theme.accentSoftColor,
                        in: RoundedRectangle(cornerRadius: 20, style: .continuous)
                    )
                    .textSelection(.enabled)
            }
            if let thread = workThread, let receipt = thread.receipt(for: message) {
                noteReceipt(receipt, thread: thread)
            }
        }
    }

    /// The receipt under a note to a run, with "Send again" once.
    private func noteReceipt(_ receipt: NoteReceipt, thread: WorkThreadModel) -> some View {
        let message = message
        let sendAgain: (() -> Void)? = thread.canSendAgain(message)
            ? { Task { await thread.sendAgain(message) } }
            : nil
        return NoteReceiptView(receipt: receipt, onSendAgain: sendAgain)
    }

    // MARK: - The reply

    @ViewBuilder private var replyWithMenu: some View {
        if hasText {
            reply.contextMenu { replyMenu }
        } else {
            reply
        }
    }

    private var reply: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(AssistantWorkLog.group(parts: message.parts)) { block in
                blockView(block)
            }
            if !message.sources.isEmpty {
                AssistantSourcesLine(sources: message.sources)
            }
            if isStreamingReply, message.parts.isEmpty {
                WorkLineView(line: AssistantWorkLine.Line(text: AssistantWorkLine.workingText, tone: .live))
            }
            if showsActions {
                ReplyActions(
                    isHeld: isHeld,
                    isHolding: model.holdingMessageID == message.id,
                    onCopy: copy,
                    onHold: hold
                )
            }
        }
    }

    @ViewBuilder private func blockView(_ block: AssistantTranscriptBlock) -> some View {
        switch block {
        case .text(let id, let text):
            RevealedMarkdownView(
                text: text,
                isLive: isStreamingReply && !message.endedTextIDs.contains(id)
            )
        case .reasoning(let reasoning):
            AssistantReasoningLine(reasoning: reasoning)
        case .workLog(_, let rows):
            AssistantWorkLogView(rows: rows, turnFinished: !isStreamingReply, sessionID: model.sessionID)
        case .card(_, let card, _):
            AssistantToolCardView(card: card, sessionID: model.sessionID)
        case .approval(let approval):
            AssistantApprovalCard(approval: approval) { approved in
                model.answerApproval(approval.id, approved: approved)
            }
            .disabled(model.isStreaming)
        case .question(let question):
            AssistantQuestionCard(question: question) { output in
                model.answerQuestion(question.id, output: output)
            }
            .disabled(model.isStreaming)
        }
    }

    @ViewBuilder private var replyMenu: some View {
        Button(Self.copyLabel, action: copy)
        Button(isHeld ? Self.keptLabel : Self.holdLabel, action: hold)
            .disabled(isHeld || model.holdingMessageID != nil || isStreamingReply)
        ShareLink(item: message.text) {
            Text(Self.shareLabel)
        }
    }

    private var hasText: Bool {
        !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var isHeld: Bool {
        model.heldMessageIDs.contains(message.id)
    }

    /// The actions show under the newest finished reply that carries text.
    private var showsActions: Bool {
        isLatestReply && !isStreamingReply && hasText
    }

    private func copy() {
        PlatformPasteboard.copy(message.text)
    }

    private func hold() {
        guard !isHeld else { return }
        Task {
            await model.holdReply(messageID: message.id, userText: userTextBefore, replyText: message.text)
        }
    }

    /// The person's message that produced this reply. It gives the capture the
    /// request as well as the answer.
    private var userTextBefore: String {
        guard let index = model.messages.firstIndex(where: { $0.id == message.id }) else { return "" }
        for candidate in model.messages[..<index].reversed() where candidate.role == .user {
            return candidate.text
        }
        return ""
    }
}

extension AssistantChatModel {
    /// The newest reply in the conversation. The host passes it to the rows.
    var latestReplyID: String? {
        messages.last(where: { $0.role == .assistant })?.id
    }
}

/// "Copy" and "Hold this" under the newest reply, as footnote text. Copy
/// reads "Copied" for a moment; Hold this becomes "Kept".
struct ReplyActions: View {
    let isHeld: Bool
    var isHolding = false
    let onCopy: () -> Void
    let onHold: () -> Void
    @State private var copied = false
    @State private var copiedReset: Task<Void, Never>?

    var body: some View {
        HStack(spacing: 18) {
            Button(copied ? AssistantMessageRow.copiedLabel : AssistantMessageRow.copyLabel) {
                onCopy()
                copied = true
                copiedReset?.cancel()
                copiedReset = Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    guard !Task.isCancelled else { return }
                    copied = false
                }
            }
            .accessibilityHint("Copies the reply")
            if isHolding {
                ProgressView().controlSize(.mini)
            }
            Button(isHeld ? AssistantMessageRow.keptLabel : AssistantMessageRow.holdLabel) {
                guard !isHeld else { return }
                onHold()
            }
            .disabled(isHeld || isHolding)
            .accessibilityHint("Keeps this reply as Work")
        }
        .buttonStyle(.plain)
        .font(.footnote)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
}

/// Places its one subview at the trailing edge, no wider than a fraction of
/// the row. The user's turn uses it so a long message wraps at 80 percent
/// of the column on every screen.
struct TrailingBubbleLayout: Layout {
    var fraction: CGFloat = 0.8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let subview = subviews.first else { return .zero }
        let width = Self.width(proposal)
        let size = subview.sizeThatFits(ProposedViewSize(width: width * fraction, height: nil))
        return CGSize(width: width, height: size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let subview = subviews.first else { return }
        let size = subview.sizeThatFits(ProposedViewSize(width: bounds.width * fraction, height: nil))
        subview.place(
            at: CGPoint(x: bounds.maxX - size.width, y: bounds.minY),
            anchor: .topLeading,
            proposal: ProposedViewSize(width: size.width, height: size.height)
        )
    }

    private static func width(_ proposal: ProposedViewSize) -> CGFloat {
        guard let width = proposal.width, width.isFinite else { return 320 }
        return width
    }
}

struct AssistantApprovalCard: View {
    let approval: AssistantInlineApproval
    let onDecision: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(approval.title)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
            if let description = approval.description {
                Text(description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(approval.metadata) { row in
                LabeledContent(row.label, value: row.value)
                    .font(.caption)
            }
            if let decision = approval.decision {
                Text(decision ? "Approved" : "Declined")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(decision ? .primary : .secondary)
                if let outcome = approval.outcome {
                    Text(outcome)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } else {
                HStack {
                    Button(approval.denyLabel) { onDecision(false) }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.roundedRectangle(radius: 8))
                    Button(approval.confirmLabel) { onDecision(true) }
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.roundedRectangle(radius: 8))
                        .tint(approval.destructive ? .red : .accentColor)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .insetPanel(cornerRadius: 12)
        .accessibilityElement(children: .contain)
    }
}
