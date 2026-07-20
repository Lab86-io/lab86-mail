import SwiftStreamingMarkdown
import SwiftUI

// A full-page conversation with Albatross, patterned after ChatGPT and Claude:
// user turns in quiet trailing bubbles, assistant turns as plain document text,
// and a single rounded composer pinned to the bottom.
struct AssistantChatView: View {
    @Bindable var model: AssistantChatModel
    @State private var draft = ""
    @FocusState private var composerFocused: Bool

    var body: some View {
        Group {
            if model.hasStarted {
                transcript
            } else {
                openingState
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .navigationTitle("Albatross")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if !model.hasStarted { composerFocused = true }
        }
    }

    private var transcript: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                ForEach(model.messages) { message in
                    messageRow(message)
                }
                if let error = model.errorMessage {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
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
                    .background(
                        Color(uiColor: .secondarySystemBackground),
                        in: RoundedRectangle(cornerRadius: 20, style: .continuous)
                    )
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

    private var openingState: some View {
        VStack(spacing: 8) {
            Text("What can Albatross take on?")
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.center)
            Text("Ask about your mail, calendar, tasks, and areas — or hand something off.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
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
                        .foregroundStyle(Color(uiColor: .systemBackground))
                        .frame(width: 34, height: 34)
                        .background(Circle().fill(canSend ? Color.accentColor : Color.secondary.opacity(0.4)))
                }
                .disabled(!canSend)
                .accessibilityLabel("Send")
            }
        }
        .padding(4)
        .background(
            Color(uiColor: .secondarySystemBackground),
            in: RoundedRectangle(cornerRadius: 26, style: .continuous)
        )
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .background(Color(uiColor: .systemBackground))
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func sendDraft() {
        guard canSend, !model.isStreaming else { return }
        model.send(draft)
        draft = ""
    }

    private static func rendered(_ text: String) -> AttributedString {
        (try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(text)
    }
}
