import SwiftUI
import UniformTypeIdentifiers

/// The one measure of the chat: the desk, the transcript, and the composer
/// stay inside it and center on a wide screen.
enum ChatLayout {
    static let measure: CGFloat = 680
    static let composerMeasure: CGFloat = 704
}

// A full-page conversation with Albatross. Before the first message, the
// desk: the user's day as one sentence and four asks. After it, the
// transcript: user turns in the accent-soft tint, replies as plain text with
// their work line and their inserts, and one glass composer. The message row
// and the composer are shared with the Albatross thread.
struct AssistantChatView: View {
    @Environment(AppEnvironment.self) private var environment
    @Bindable var model: AssistantChatModel
    @State private var draft = ""
    @State private var pendingFiles: [ComposeAttachment] = []
    @State private var showsFileImporter = false
    @State private var showsHistory = false
    @FocusState private var composerFocused: Bool

    static let newChatLabel = "New chat"
    static let historyLabel = "History"

    var body: some View {
        page
            .navigationTitle(model.conversationTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarItems }
            .onAppear {
                if !model.hasStarted { composerFocused = true }
            }
            .onChange(of: model.sessionID) { _, _ in
                // Another conversation took the page: its bar starts empty.
                draft = ""
                pendingFiles = []
            }
            .sheet(isPresented: $showsHistory) {
                AssistantHistorySheet(model: model) { session in
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

    private var page: some View {
        Group {
            if model.hasStarted {
                transcript
            } else {
                desk
            }
        }
        .background(environment.theme.paperColor)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if model.holdCards.isEmpty {
                composer
            } else {
                holdLanding
            }
        }
    }

    @ToolbarContentBuilder private var toolbarItems: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            Text(model.conversationTitle)
                .font(.headline)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: 240)
        }
        ToolbarItemGroup(placement: .primaryAction) {
            Button {
                environment.startAssistantChat()
            } label: {
                Label(Self.newChatLabel, systemImage: "square.and.pencil")
            }
            Button {
                showsHistory = true
            } label: {
                Label(Self.historyLabel, systemImage: "clock")
            }
        }
    }

    // MARK: - The desk

    private var desk: some View {
        ChatDeskView(desk: ChatDesk.make(input: ChatDesk.Input(store: environment.store), now: .now)) { ask in
            model.send(ask)
        }
    }

    // MARK: - The transcript

    private var transcript: some View {
        // Computed once for the list (C7): a token redraws the streaming row.
        let streaming = model.isStreaming
        let lastID = model.messages.last?.id
        let latestReplyID = model.latestReplyID
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                ForEach(model.messages) { message in
                    AssistantMessageRow(
                        model: model,
                        message: message,
                        isStreamingReply: streaming && message.id == lastID,
                        isLatestReply: message.id == latestReplyID
                    )
                }
                receipts
                footer
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
            .frame(maxWidth: ChatLayout.measure, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
    }

    @ViewBuilder private var receipts: some View {
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
    }

    @ViewBuilder private var footer: some View {
        if model.errorMessage != nil || model.canContinue {
            VStack(alignment: .leading, spacing: 8) {
                if let error = model.errorMessage {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
                HStack {
                    if model.canRetry {
                        Button("Retry", action: model.retryLastTurn)
                            .buttonStyle(.bordered)
                            .buttonBorderShape(.roundedRectangle(radius: 8))
                    }
                    if model.canContinue {
                        Button("Continue", action: model.continueResponse)
                            .buttonStyle(.bordered)
                            .buttonBorderShape(.roundedRectangle(radius: 8))
                    }
                }
            }
        }
    }

    // MARK: - The composer

    private var composer: some View {
        AssistantComposer(
            model: model,
            draft: $draft,
            pendingFiles: $pendingFiles,
            focus: $composerFocused,
            onSubmit: submitDraft,
            onAttach: { showsFileImporter = true }
        )
    }

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

    /// Return follows the route. Ask sends to the chat. Hold makes Work and
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

    /// The draft and the files leave the bar once the turn has started. A
    /// failed upload keeps both, so the send control is the retry (C10).
    private func sendDraft() {
        guard canSend, !model.isStreaming else { return }
        let text = draft
        let files = pendingFiles
        guard !files.isEmpty else {
            model.send(text)
            draft = ""
            // The pin belonged to that message; the next one starts on Ask.
            model.clearRoute()
            return
        }
        Task {
            guard await model.sendDraft(text, attachments: files) else { return }
            if draft == text { draft = "" }
            pendingFiles = []
            model.clearRoute()
        }
    }
}
