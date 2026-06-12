import SwiftUI

// Inline reply box pinned under the message stack, like the web thread view.
struct ReplyComposerView: View {
    @Environment(MailStore.self) private var store
    let thread: MailThread
    let lastMessage: MailMessage?

    @State private var body_ = ""
    @State private var replyAll = false
    @State private var sending = false
    @State private var sentPendingId: String?
    @State private var undoCountdown = 0
    @AppStorage("compose.undoSeconds") private var undoSecondsSetting = 5

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "arrowshape.turn.up.left")
                    .foregroundStyle(.secondary)
                Text("Reply to \(lastMessage.map { EmailAddress.displayName(from: $0.from) } ?? "thread")")
                    .font(.callout.weight(.medium))
                Spacer()
                Toggle("Reply all", isOn: $replyAll)
                    .toggleStyle(.checkbox)
                    .font(.caption)
            }

            TextEditor(text: $body_)
                .font(.callout)
                .frame(minHeight: 80, maxHeight: 220)
                .scrollContentBackground(.hidden)
                .padding(6)
                .background(.background, in: .rect(cornerRadius: 8))

            HStack {
                if let pendingId = sentPendingId {
                    Label("Sent", systemImage: "checkmark.circle")
                        .foregroundStyle(.secondary)
                    if undoCountdown > 0 {
                        Button("Undo (\(undoCountdown))") {
                            undo(pendingId: pendingId)
                        }
                    }
                }
                Spacer()
                Button {
                    send()
                } label: {
                    if sending {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Send", systemImage: "paperplane.fill")
                    }
                }
                .buttonStyle(.glassProminent)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(body_.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
            }
        }
        .padding(12)
        .glassEffect(.regular, in: .rect(cornerRadius: 16))
        .onChange(of: thread.id) {
            body_ = ""
            sentPendingId = nil
            undoCountdown = 0
        }
    }

    private func send() {
        guard let lastMessage else { return }
        sending = true
        let undoSeconds = undoSecondsSetting
        Task {
            defer { sending = false }
            do {
                let result = try await store.api.compose(
                    mode: replyAll ? "reply_all" : "reply",
                    account: thread.account,
                    to: lastMessage.from,
                    subject: thread.subject.hasPrefix("Re:") ? thread.subject : "Re: \(thread.subject)",
                    body: body_,
                    threadId: thread.threadId,
                    messageId: lastMessage._id,
                    undoSeconds: undoSeconds
                )
                guard result.ok else {
                    store.lastError = result.error ?? "Send failed."
                    return
                }
                body_ = ""
                sentPendingId = result.id
                undoCountdown = undoSeconds
                while undoCountdown > 0 {
                    try? await Task.sleep(for: .seconds(1))
                    undoCountdown -= 1
                }
            } catch {
                store.lastError = error.localizedDescription
            }
        }
    }

    private func undo(pendingId: String) {
        undoCountdown = 0
        sentPendingId = nil
        Task {
            do { try await store.api.undoSend(pendingId: pendingId) }
            catch { store.lastError = "Undo failed: \(error.localizedDescription)" }
        }
    }
}
