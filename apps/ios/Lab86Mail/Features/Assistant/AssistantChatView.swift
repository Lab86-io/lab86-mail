import SwiftStreamingMarkdown
import SwiftUI

// A full-page conversation with Albatross, patterned after ChatGPT and Claude:
// user turns in quiet raised bubbles, assistant turns as plain document text,
// and a single floating glass composer detached from the bottom edge.
struct AssistantChatView: View {
    @Environment(AppEnvironment.self) private var environment
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
        .background(environment.theme.paperColor)
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
                        .foregroundStyle(.white)
                        .frame(width: 34, height: 34)
                        .background(
                            Circle().fill(
                                canSend ? environment.theme.accentColor : Color.secondary.opacity(0.4)
                            )
                        )
                }
                .disabled(!canSend)
                .accessibilityLabel("Send")
            }
        }
        .padding(4)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 26))
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func sendDraft() {
        guard canSend, !model.isStreaming else { return }
        model.send(draft)
        draft = ""
    }
}
