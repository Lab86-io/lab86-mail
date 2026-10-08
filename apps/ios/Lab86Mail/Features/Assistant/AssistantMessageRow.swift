import SwiftUI

// One message of an Albatross conversation: a user turn in a quiet raised
// bubble, or an Albatross turn as document text with its work log, cards,
// approvals, questions, and sources. The Chat tab and the Albatross thread
// share it.
struct AssistantMessageRow: View {
    @Environment(AppEnvironment.self) private var environment
    // The thread this row renders inside, when it renders inside one: a note
    // to a run gets its receipt from it (docs/albatross-threads.md, T7).
    @Environment(\.workThread) private var workThread
    @Bindable var model: AssistantChatModel
    let message: AssistantChatMessage

    var body: some View {
        switch message.role {
        case .user:
            VStack(alignment: .trailing, spacing: 4) {
                HStack {
                    Spacer(minLength: 56)
                    Text(message.text)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .surfaceCard(cornerRadius: 20)
                }
                if let thread = workThread, let receipt = thread.receipt(for: message) {
                    noteReceipt(receipt, thread: thread)
                }
            }
        case .assistant:
            VStack(alignment: .leading, spacing: 10) {
                ForEach(AssistantWorkLog.group(parts: message.parts)) { block in
                    switch block {
                    case .text(let id, let text):
                        RevealedMarkdownView(
                            text: text,
                            isLive: model.isStreaming && message.id == model.messages.last?.id
                                && !message.endedTextIDs.contains(id)
                        )
                    case .reasoning(let reasoning):
                        AssistantReasoningLine(reasoning: reasoning)
                    case .workLog(_, let rows):
                        AssistantWorkLogView(
                            rows: rows,
                            turnFinished: !model.isStreaming || message.id != model.messages.last?.id,
                            sessionID: model.sessionID
                        )
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
                if !message.sources.isEmpty {
                    AssistantSourcesLine(sources: message.sources)
                }
                if model.isStreaming, message.id == model.messages.last?.id, message.parts.isEmpty {
                    HStack(spacing: 8) {
                        RevealDot()
                        Text("Working").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if holdThisApplies {
                    HoldThisButton(
                        isHeld: model.heldMessageIDs.contains(message.id),
                        isWorking: model.holdingMessageID == message.id
                    ) {
                        Task {
                            await model.holdReply(
                                messageID: message.id,
                                userText: userTextBefore,
                                replyText: message.text
                            )
                        }
                    }
                }
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

    /// The action shows under a finished reply that carries text.
    private var holdThisApplies: Bool {
        guard message.role == .assistant, !message.isVisuallyEmpty else { return false }
        if model.isStreaming, message.id == model.messages.last?.id { return false }
        return !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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

struct AssistantApprovalCard: View {
    let approval: AssistantInlineApproval
    let onDecision: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(
                approval.title,
                systemImage: approval.destructive ? "exclamationmark.shield" : "checkmark.shield"
            )
            .font(.headline)
            if let description = approval.description {
                Text(description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            ForEach(approval.metadata) { row in
                LabeledContent(row.label, value: row.value)
                    .font(.caption)
            }
            if let decision = approval.decision {
                Label(decision ? "Approved" : "Declined", systemImage: decision ? "checkmark.circle" : "xmark.circle")
                    .foregroundStyle(decision ? .green : .secondary)
                if let outcome = approval.outcome {
                    Text(outcome)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } else {
                HStack {
                    Button(approval.denyLabel) { onDecision(false) }
                        .buttonStyle(.bordered)
                    Button(approval.confirmLabel) { onDecision(true) }
                        .buttonStyle(.borderedProminent)
                        .tint(approval.destructive ? .red : .accentColor)
                }
            }
        }
        .padding(14)
        .background(.thinMaterial, in: .rect(cornerRadius: 16))
        .accessibilityElement(children: .contain)
    }
}
