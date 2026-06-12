import SwiftUI

struct ThreadReaderView: View {
    @Environment(MailStore.self) private var store
    @State private var showAllMessages = false
    @State private var summary: String?
    @State private var summarizing = false

    var body: some View {
        Group {
            if let detail = store.threadDetail, let thread = store.selectedThread {
                reader(detail: detail, thread: thread)
            } else if store.detailLoading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView(
                    "No conversation selected",
                    systemImage: "envelope.open",
                    description: Text("Pick a thread from the list, or press ⌘N to write one.")
                )
            }
        }
        .onChange(of: store.selectedThreadKey) {
            showAllMessages = false
            summary = nil
        }
    }

    @ViewBuilder
    private func reader(detail: ThreadDetail, thread: MailThread) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    Text(detail.subject)
                        .font(.system(.title2, design: .serif, weight: .bold))
                        .textSelection(.enabled)
                        .padding(.horizontal, 4)

                    if let summary {
                        OnDeviceSummaryCard(summary: summary)
                    }

                    let messages = visibleMessages(detail.messages)
                    if detail.messages.count > messages.count {
                        Button("Show \(detail.messages.count - messages.count) earlier messages") {
                            showAllMessages = true
                        }
                        .buttonStyle(.bordered)
                    }
                    ForEach(messages) { message in
                        MessageCardView(message: message)
                            .id(message.id)
                    }

                    ReplyComposerView(thread: thread, lastMessage: detail.messages.last)
                        .padding(.top, 6)
                }
                .padding(16)
            }
            .onAppear {
                proxy.scrollTo(detail.messages.last?.id, anchor: .top)
            }
            .scrollEdgeEffectStyle(.soft, for: .top)
        }
        // Floating liquid-glass action cluster — the reader's primary actions
        // hover over content instead of crowding the toolbar.
        .overlay(alignment: .bottomTrailing) {
            GlassEffectContainer(spacing: 14) {
                HStack(spacing: 14) {
                    if OnDeviceSummarizer.isAvailable {
                        Button {
                            summarize(detail: detail)
                        } label: {
                            Group {
                                if summarizing {
                                    ProgressView().controlSize(.small)
                                } else {
                                    Image(systemName: "sparkles")
                                }
                            }
                            .frame(width: 22, height: 22)
                        }
                        .help("Summarize on-device")
                    }
                    Button {
                        store.archive(thread)
                    } label: {
                        Image(systemName: "archivebox")
                            .frame(width: 22, height: 22)
                    }
                    .help("Archive (e)")
                    Button(role: .destructive) {
                        store.trash(thread)
                    } label: {
                        Image(systemName: "trash")
                            .frame(width: 22, height: 22)
                    }
                    .help("Move to trash")
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .controlSize(.large)
            }
            .padding(.trailing, 24)
            .padding(.bottom, 90)
        }
    }

    private func visibleMessages(_ all: [MailMessage]) -> [MailMessage] {
        if showAllMessages || all.count <= 3 { return all }
        return Array(all.suffix(3))
    }

    private func summarize(detail: ThreadDetail) {
        summarizing = true
        Task {
            defer { summarizing = false }
            do {
                summary = try await OnDeviceSummarizer().summarize(detail: detail)
            } catch {
                summary = "Summary unavailable: \(error.localizedDescription)"
            }
        }
    }
}

private struct OnDeviceSummaryCard: View {
    @Environment(ThemeManager.self) private var theme
    let summary: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "sparkles")
                    .foregroundStyle(theme.accent)
                Text("Summary")
                    .font(.caption.weight(.semibold))
                Text("On-device")
                    .font(.caption2)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(theme.accentSoft, in: .capsule)
                    .foregroundStyle(theme.accent)
            }
            Text(summary)
                .font(.callout)
                .textSelection(.enabled)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular.tint(theme.accent.opacity(0.12)), in: .rect(cornerRadius: 14))
    }
}
