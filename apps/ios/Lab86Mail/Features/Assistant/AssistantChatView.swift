import SwiftUI
import UniformTypeIdentifiers

// A full-page conversation with Albatross, patterned after ChatGPT and Claude:
// user turns in quiet raised bubbles, Albatross turns as plain document text,
// and a single floating glass composer detached from the bottom edge. The
// message row and the composer are shared with the Albatross thread.
struct AssistantChatView: View {
    @Environment(AppEnvironment.self) private var environment
    @Bindable var model: AssistantChatModel
    @State private var draft = ""
    @State private var pendingFiles: [ComposeAttachment] = []
    @State private var showsFileImporter = false
    @State private var showsHistory = false
    @State private var history: [AssistantChatSessionSummary] = []
    @FocusState private var composerFocused: Bool

    var body: some View {
        Group {
            if model.hasStarted {
                transcript
            } else {
                openingState
            }
        }
        .background(environment.theme.paperColor)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if model.holdCards.isEmpty {
                AssistantComposer(
                    model: model,
                    draft: $draft,
                    pendingFiles: $pendingFiles,
                    focus: $composerFocused,
                    onSubmit: submitDraft,
                    onAttach: { showsFileImporter = true }
                )
            } else {
                holdLanding
            }
        }
        .navigationTitle("Albatross")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task {
                        history = await model.history()
                        showsHistory = true
                    }
                } label: {
                    Label("Chat history", systemImage: "clock.arrow.circlepath")
                }
            }
        }
        .onAppear {
            if !model.hasStarted { composerFocused = true }
        }
        .sheet(isPresented: $showsHistory) {
            AssistantHistorySheet(sessions: history) { session in
                await model.restore(sessionID: session.id)
                showsHistory = false
            }
        }
        .fileImporter(
            isPresented: $showsFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            guard case .success(let urls) = result else { return }
            AssistantComposerFiles.importing(urls, into: &pendingFiles)
        }
    }

    private var transcript: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                ForEach(model.messages) { message in
                    AssistantMessageRow(model: model, message: message)
                }
                ForEach(model.receipts) { receipt in
                    HoldReceiptRow(
                        model: receipt,
                        isUndoing: model.isUndoingHold,
                        onOpen: { environment.navigation.openWork(id: receipt.id, title: receipt.title) },
                        onUndo: undoAction(for: receipt)
                    )
                }
                if let holdError = model.holdError {
                    Text(holdError)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
                if model.errorMessage != nil || model.canContinue {
                    VStack(alignment: .leading, spacing: 8) {
                        if let error = model.errorMessage {
                            Text(error).font(.footnote).foregroundStyle(.red)
                        }
                        HStack {
                            if model.canRetry {
                                Button("Retry", action: model.retryLastTurn)
                                    .buttonStyle(.bordered)
                            }
                            if model.canContinue {
                                Button("Continue", action: model.continueResponse)
                                    .buttonStyle(.bordered)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
        }
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
    }

    // Zero state: a display-face greeting and a quiet vertical list of
    // suggested asks — plain text rows, no chips, no decoration.
    private var openingState: some View {
        VStack(alignment: .leading, spacing: 32) {
            VStack(alignment: .leading, spacing: 8) {
                Text("What can Albatross take on?")
                    .font(environment.theme.displayType.displayFont(size: 27))
                    .fixedSize(horizontal: false, vertical: true)
                Text("Ask about your mail, calendar, tasks, and areas — or hand something off.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 0) {
                Text("Suggested")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 6)
                    .accessibilityAddTraits(.isHeader)
                ForEach(Self.suggestions, id: \.self) { suggestion in
                    Button {
                        model.send(suggestion)
                    } label: {
                        Text(suggestion)
                            .font(.body)
                            .foregroundStyle(.primary)
                            .frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    Divider().overlay(environment.theme.hairlineColor)
                }
            }
        }
        .padding(.horizontal, 28)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private static let suggestions = [
        "What needs my reply today?",
        "Walk me through my afternoon",
        "What changed in my areas overnight?",
        "Draft a reply to my newest thread",
    ]

    /// The cards stand where the composer was, then travel to the Work rail.
    private var holdLanding: some View {
        VStack(spacing: 6) {
            ForEach(Array(model.holdCards.enumerated()), id: \.element.id) { index, card in
                HoldCard(model: card, phase: model.holdPhase, isWorking: model.isHolding)
                    .animation(
                        .easeIn(duration: HoldPhase.travelDuration).delay(Double(index) * 0.06),
                        value: model.holdPhase
                    )
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    private var canSend: Bool {
        (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingFiles.isEmpty)
            && !model.isUploading
    }

    /// Return follows the chip. Ask sends to the chat. Hold makes Work and
    /// produces no reply.
    private func submitDraft() {
        guard canSend, !model.isStreaming, !model.isHolding else { return }
        if model.route == .hold, pendingFiles.isEmpty {
            let text = draft
            draft = ""
            Task { await model.hold(text) }
            return
        }
        sendDraft()
    }

    /// Undo is only for a Hold from the bar. A kept reply has no bar text.
    private func undoAction(for receipt: HoldCardModel) -> (() -> Void)? {
        guard model.canUndoHold(receipt) else { return nil }
        return { undoHold(receipt) }
    }

    /// Undo archives the held Work. Then the text comes back to the bar on
    /// Ask, under a newer draft when there is one.
    private func undoHold(_ receipt: HoldCardModel) {
        Task {
            guard let text = await model.undoHold(receipt) else { return }
            draft = HoldUndo.restoredDraft(current: draft, held: text)
            model.presetRoute(.ask)
            composerFocused = true
        }
    }

    private func sendDraft() {
        guard canSend, !model.isStreaming else { return }
        model.send(draft, attachments: pendingFiles)
        draft = ""
        pendingFiles = []
        // The pin belonged to that message; the next one starts on Ask.
        model.clearRoute()
    }
}

private struct AssistantHistorySheet: View {
    @Environment(\.dismiss) private var dismiss
    let sessions: [AssistantChatSessionSummary]
    let onSelect: (AssistantChatSessionSummary) async -> Void

    var body: some View {
        NavigationStack {
            List {
                if sessions.isEmpty {
                    ContentUnavailableView(
                        "No conversations yet",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text("Finished conversations in this scope appear here.")
                    )
                }
                ForEach(sessions) { session in
                    Button {
                        Task { await onSelect(session) }
                    } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(session.title)
                                .foregroundStyle(.primary)
                            Text(session.updatedAt, style: .relative)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("History")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }
}
