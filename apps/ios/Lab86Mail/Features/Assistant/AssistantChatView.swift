import SwiftStreamingMarkdown
import SwiftUI
import UniformTypeIdentifiers

// A full-page conversation with Albatross, patterned after ChatGPT and Claude:
// user turns in quiet raised bubbles, assistant turns as plain document text,
// and a single floating glass composer detached from the bottom edge.
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
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
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
                            MarkdownView(text: text)
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
            }
        }
    }

    private func activityRow(_ label: String) -> some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
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

            if model.scope.kind != .global {
                Label(
                    "\(model.scope.kind == .work ? "Work" : "Area"): \(model.scope.label ?? "Current context")",
                    systemImage: "scope"
                )
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
                }
                .disabled(model.isStreaming || model.isUploading || pendingFiles.count >= 5)
                .accessibilityLabel("Attach files")

                TextField("Message Albatross", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .focused($composerFocused)
                .padding(.leading, 16)
                .padding(.trailing, 4)
                .padding(.vertical, 10)
                .onSubmit(sendDraft)

                if model.isStreaming {
                    Button(action: model.stop) {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color(uiColor: .systemBackground))
                        .frame(width: 34, height: 34)
                        .background(Circle().fill(Color.primary))
                }
                .accessibilityLabel("Stop responding")
                } else {
                    Button(action: sendDraft) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 34, height: 34)
                        .background(
                            Circle().fill(
                                canSend ? environment.theme.accentColor : Color.secondary.opacity(0.4)
                            )
                        )
                }
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

    private var canSend: Bool {
        (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingFiles.isEmpty)
            && !model.isUploading
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
