import SwiftStreamingMarkdown
import SwiftUI
import UniformTypeIdentifiers

// A full-page conversation with Albatross, patterned after ChatGPT and Claude:
// user turns in quiet raised bubbles, assistant turns as plain document text,
// and a single floating glass composer detached from the bottom edge.
struct AssistantChatView: View {
    // Copilot-style reveal: the library fades each appended word in as deltas
    // arrive, so streaming reads as continuous writing instead of chunk swaps.
    private static let markdownConfig = MarkdownRenderConfig(shouldAnimateText: true)

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
                composer
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
            importFiles(urls)
        }
    }

    private var transcript: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                ForEach(model.messages) { message in
                    messageRow(message)
                }
                ForEach(model.receipts) { receipt in
                    HoldReceiptRow(model: receipt) {
                        environment.navigation.openWork(id: receipt.id, title: receipt.title)
                    }
                }
                if let holdError = model.holdError {
                    Text(holdError)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
                if let error = model.errorMessage {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
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

    @ViewBuilder private func messageRow(_ message: AssistantChatMessage) -> some View {
        switch message.role {
        case .user:
            HStack {
                Spacer(minLength: 56)
                Text(message.text)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .surfaceCard(cornerRadius: 20)
            }
        case .assistant:
            VStack(alignment: .leading, spacing: 10) {
                ForEach(message.parts) { part in
                    switch part {
                    case .text(_, let text):
                        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            // Full GFM rendering (tables, lists, code blocks)
                            // built for streaming LLM output.
                            MarkdownView(text: text, config: Self.markdownConfig)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    case .card(_, let card):
                        AssistantToolCardView(card: card)
                    case .approval(let approval):
                        AssistantApprovalCard(approval: approval) { approved in
                            model.answerApproval(approval.id, approved: approved)
                        }
                    }
                }
                if let activity = message.toolActivity {
                    activityRow(activity)
                } else if model.isStreaming, message.id == model.messages.last?.id, message.parts.isEmpty {
                    activityRow("Thinking")
                }
                if holdThisApplies(to: message) {
                    HoldThisButton(
                        isHeld: model.heldMessageIDs.contains(message.id),
                        isWorking: model.holdingMessageID == message.id
                    ) {
                        Task {
                            await model.holdReply(
                                messageID: message.id,
                                userText: userTextBefore(message),
                                replyText: message.text
                            )
                        }
                    }
                }
            }
        }
    }

    /// The action shows under a finished reply that carries text.
    private func holdThisApplies(to message: AssistantChatMessage) -> Bool {
        guard message.role == .assistant, !message.isVisuallyEmpty else { return false }
        if model.isStreaming, message.id == model.messages.last?.id { return false }
        return !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The person's message that produced this reply. It gives the capture the
    /// request as well as the answer.
    private func userTextBefore(_ message: AssistantChatMessage) -> String {
        guard let index = model.messages.firstIndex(where: { $0.id == message.id }) else { return "" }
        for candidate in model.messages[..<index].reversed() where candidate.role == .user {
            return candidate.text
        }
        return ""
    }

    private func activityRow(_ label: String) -> some View {
        HStack(spacing: 8) {
            // Typing-indicator dots: the variable-color symbol effect cycles
            // the ellipsis glyphs, which reads as "composing" rather than the
            // generic busy spinner.
            Image(systemName: "ellipsis")
                .font(.body.weight(.semibold))
                .foregroundStyle(environment.theme.accentColor)
                .symbolEffect(.variableColor.iterative.dimInactiveLayers.nonReversing)
            Text(label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
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

    private var composer: some View {
        VStack(spacing: 4) {
            if model.scope.kind != .global {
                HStack {
                    Text("\(model.scope.kind == .work ? "Work" : "Area"): \(model.scope.label ?? "Current context")")
                        .font(.caption)
                        .lineLimit(1)
                        .foregroundStyle(environment.theme.accentColor)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(environment.theme.accentColor.opacity(0.12), in: Capsule())
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 8)
                .padding(.top, 4)
                .accessibilityLabel("Attached \(model.scope.kind == .work ? "Work" : "Area") context: \(model.scope.label ?? "Current context")")
            }
            if !pendingFiles.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(pendingFiles) { file in
                            Button {
                                pendingFiles.removeAll { $0.id == file.id }
                            } label: {
                                Label(file.filename, systemImage: "xmark.circle.fill")
                                    .font(.caption)
                                    .lineLimit(1)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .padding(.horizontal, 8)
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                Button {
                    showsFileImporter = true
                } label: {
                    Image(systemName: "paperclip")
                        .frame(width: 34, height: 34)
                        .contentShape(.rect)
                }
                // Plain everywhere: AppKit's default bordered button painted a
                // grey field behind every glyph in the composer.
                .buttonStyle(.plain)
                .disabled(model.isStreaming || model.isUploading || pendingFiles.count >= 5)
                .accessibilityLabel("Attach files")

                TextField("Ask or hold", text: $draft, axis: .vertical)
                // Plain style and an explicit flexible width: AppKit's default
                // field hugs its content, which collapsed the whole glass
                // composer to a pill on the Mac.
                .textFieldStyle(.plain)
                .frame(maxWidth: .infinity)
                .lineLimit(1...6)
                .focused($composerFocused)
                .padding(.leading, 16)
                .padding(.trailing, 4)
                .padding(.vertical, 10)
                .onSubmit(submitDraft)
                .onChange(of: draft) { _, next in model.updateDraft(next) }
                .onKeyPress(.tab) {
                    guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                        return .ignored
                    }
                    model.flipRoute()
                    return .handled
                }

                RouteChip(
                    route: model.route,
                    isPinned: model.routePinned,
                    isEnabled: !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                    onFlip: model.flipRoute
                )

                if model.isStreaming {
                    Button(action: model.stop) {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color(uiColor: .systemBackground))
                        .frame(width: 34, height: 34)
                        .background(Circle().fill(Color.primary))
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop responding")
                } else {
                    Button(action: submitDraft) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 34, height: 34)
                        .background(
                            Circle().fill(
                                canSend ? routeTint : Color.secondary.opacity(0.4)
                            )
                        )
                        .contentShape(Circle())
                }
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                    .accessibilityLabel(model.isUploading ? "Uploading" : "Send")
                }
            }
        }
        .padding(4)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 26))
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
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

    private var routeTint: Color {
        model.route == .ask ? environment.theme.accentColor : environment.theme.accent2Color
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

    private func sendDraft() {
        guard canSend, !model.isStreaming else { return }
        model.send(draft, attachments: pendingFiles)
        draft = ""
        pendingFiles = []
    }

    private func importFiles(_ urls: [URL]) {
        let available = max(0, 5 - pendingFiles.count)
        for url in urls.prefix(available) {
            let secured = url.startAccessingSecurityScopedResource()
            defer { if secured { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url, options: [.mappedIfSafe]) else { continue }
            let total = pendingFiles.reduce(0) { $0 + $1.data.count } + data.count
            guard total <= 25 * 1_024 * 1_024 else { continue }
            let values = try? url.resourceValues(forKeys: [.contentTypeKey, .nameKey])
            pendingFiles.append(
                ComposeAttachment(
                    filename: values?.name ?? url.lastPathComponent,
                    contentType: values?.contentType?.preferredMIMEType ?? "application/octet-stream",
                    data: data
                )
            )
        }
    }
}

private struct AssistantApprovalCard: View {
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
                Label(decision ? "Approved" : "Rejected", systemImage: decision ? "checkmark.circle" : "xmark.circle")
                    .foregroundStyle(decision ? .green : .secondary)
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
