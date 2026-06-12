import SwiftUI
import UniformTypeIdentifiers

// New-message sheet (⌘N).
struct ComposeView: View {
    @Environment(MailStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var fromAccount: String = ""
    @State private var to = ""
    @State private var cc = ""
    @State private var subject = ""
    @State private var body_ = ""
    @State private var attachments: [MailAPI.OutgoingAttachment] = []
    @State private var sending = false
    @State private var showFileImporter = false

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Picker("From", selection: $fromAccount) {
                    ForEach(store.accounts) { account in
                        Text(account.label).tag(account.accountId)
                    }
                }
                TextField("To", text: $to, prompt: Text("recipient@example.com"))
                TextField("Cc", text: $cc)
                TextField("Subject", text: $subject)
            }
            .formStyle(.columns)
            .padding([.horizontal, .top], 16)

            TextEditor(text: $body_)
                .font(.callout)
                .scrollContentBackground(.hidden)
                .padding(10)
                .background(.background, in: .rect(cornerRadius: 8))
                .padding(.horizontal, 16)
                .padding(.top, 10)

            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(Array(attachments.enumerated()), id: \.offset) { index, attachment in
                            HStack(spacing: 4) {
                                Image(systemName: "paperclip")
                                Text(attachment.filename).font(.caption).lineLimit(1)
                                Button {
                                    attachments.remove(at: index)
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .foregroundStyle(.secondary)
                                }
                                .buttonStyle(.plain)
                            }
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(.quaternary, in: .capsule)
                        }
                    }
                    .padding(.horizontal, 16)
                }
                .padding(.top, 8)
            }

            HStack {
                Button {
                    showFileImporter = true
                } label: {
                    Label("Attach", systemImage: "paperclip")
                }
                Spacer()
                Button("Discard", role: .cancel) { dismiss() }
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
                .disabled(!sendable || sending)
            }
            .padding(16)
        }
        .frame(minWidth: 620, minHeight: 460)
        .onAppear {
            if fromAccount.isEmpty {
                fromAccount = store.accounts.first?.accountId ?? ""
            }
        }
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            guard case let .success(urls) = result else { return }
            for url in urls {
                guard url.startAccessingSecurityScopedResource() else { continue }
                defer { url.stopAccessingSecurityScopedResource() }
                if let data = try? Data(contentsOf: url) {
                    attachments.append(.init(
                        filename: url.lastPathComponent,
                        contentType: UTType(filenameExtension: url.pathExtension)?
                            .preferredMIMEType ?? "application/octet-stream",
                        data: data
                    ))
                }
            }
        }
    }

    private var sendable: Bool {
        !fromAccount.isEmpty
            && !to.trimmingCharacters(in: .whitespaces).isEmpty
            && !body_.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        sending = true
        Task {
            defer { sending = false }
            do {
                let result = try await store.api.compose(
                    mode: "new",
                    account: fromAccount,
                    to: to,
                    cc: cc.isEmpty ? nil : cc,
                    subject: subject,
                    body: body_,
                    undoSeconds: 5,
                    attachments: attachments
                )
                if result.ok {
                    dismiss()
                } else {
                    store.lastError = result.error ?? "Send failed."
                }
            } catch {
                store.lastError = error.localizedDescription
            }
        }
    }
}
