import SwiftUI
import UniformTypeIdentifiers

struct ComposeView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State private var accountID = ""
    @State private var to = ""
    @State private var cc = ""
    @State private var bcc = ""
    @State private var subject = ""
    @State private var bodyText = ""
    @State private var isSending = false
    @State private var errorMessage: String?
    @State private var mode = "new"
    @State private var sourceThreadID: String?
    @State private var sourceMessageID: String?
    @State private var replyAll = false
    @State private var attachments: [ComposeAttachment] = []
    @State private var attachmentsKey: String?
    @State private var draftID: String?
    @State private var showsCopyFields = false
    @State private var isImporting = false
    @State private var sendsLater = false
    @State private var sendLaterDate = Date.now.addingTimeInterval(60 * 60)

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("From", selection: $accountID) {
                        ForEach(environment.store.accounts) { account in
                            Text(account.email).tag(account.id)
                        }
                    }
                    TextField("To", text: $to)
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.emailAddress)
                    if showsCopyFields {
                        TextField("Cc", text: $cc)
                            .textContentType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .keyboardType(.emailAddress)
                        TextField("Bcc", text: $bcc)
                            .textContentType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .keyboardType(.emailAddress)
                    } else {
                        Button("Add Cc or Bcc") { showsCopyFields = true }
                    }
                    TextField("Subject", text: $subject)
                }
                Section("Message") {
                    TextEditor(text: $bodyText).frame(minHeight: 240)
                }
                Section("Attachments") {
                    ForEach(attachments) { attachment in
                        HStack {
                            Image(systemName: "paperclip")
                            VStack(alignment: .leading) {
                                Text(attachment.filename).lineLimit(1)
                                Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.data.count), countStyle: .file))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Remove", systemImage: "xmark.circle.fill") {
                                attachments.removeAll { $0.id == attachment.id }
                            }
                            .labelStyle(.iconOnly)
                            .buttonStyle(.borderless)
                        }
                    }
                    Button("Add Attachment", systemImage: "paperclip") { isImporting = true }
                }
                Section("Delivery") {
                    Toggle("Send Later", isOn: $sendsLater)
                    if sendsLater {
                        DatePicker(
                            "Send",
                            selection: $sendLaterDate,
                            in: Date.now.addingTimeInterval(2 * 60)...,
                            displayedComponents: [.date, .hourAndMinute]
                        )
                    }
                }
                if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
            }
            .navigationTitle(navigationTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(sendsLater ? "Schedule" : "Send") { Task { await send() } }
                        .disabled(!canSend || isSending)
                }
            }
            .onAppear {
                if let pending = environment.navigation.pendingCompose {
                    to = pending.recipient
                    cc = pending.cc
                    bcc = pending.bcc
                    subject = pending.subject
                    bodyText = pending.body
                    mode = pending.mode
                    sourceThreadID = pending.threadID
                    sourceMessageID = pending.messageID
                    replyAll = pending.replyAll
                    attachmentsKey = pending.attachmentsKey
                    draftID = pending.draftID
                    showsCopyFields = !pending.cc.isEmpty || !pending.bcc.isEmpty
                    if let pendingAccount = pending.accountID { accountID = pendingAccount }
                    environment.navigation.pendingCompose = nil
                    if let key = pending.attachmentsKey {
                        Task { await loadAttachments(key: key) }
                    }
                }
                if accountID.isEmpty {
                    accountID = environment.store.accounts.first(where: \.isPrimary)?.id
                        ?? environment.store.accounts.first?.id
                        ?? ""
                }
            }
            .fileImporter(
                isPresented: $isImporting,
                allowedContentTypes: [.item],
                allowsMultipleSelection: true,
                onCompletion: importFiles
            )
        }
    }

    private var navigationTitle: String {
        switch mode {
        case "reply": replyAll ? "Reply All" : "Reply"
        case "forward": "Forward"
        default: "New Message"
        }
    }

    private var canSend: Bool {
        !accountID.isEmpty
            && (mode == "reply" || !to.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            && (mode != "new" || !subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    private func send() async {
        isSending = true
        defer { isSending = false }
        do {
            try await environment.store.sendCompose(
                mode: mode == "reply" && replyAll ? "reply_all" : mode,
                accountID: accountID,
                threadID: sourceThreadID,
                messageID: sourceMessageID,
                to: to,
                cc: cc,
                bcc: bcc,
                subject: subject,
                body: bodyText,
                attachments: attachments,
                sendAt: sendsLater ? sendLaterDate : nil
            )
            if let draftID { try? await environment.store.deleteDraft(id: draftID) }
            if let attachmentsKey { try? await MailIntentAttachmentStore.shared.remove(draftID: attachmentsKey) }
            dismiss()
        } catch { errorMessage = error.localizedDescription }
    }

    private func loadAttachments(key: String) async {
        do {
            attachments = try await MailIntentAttachmentStore.shared.loadComposeAttachments(draftID: key)
        } catch {
            errorMessage = "The draft opened, but its attachments could not be loaded."
        }
    }

    private func importFiles(_ result: Result<[URL], any Error>) {
        do {
            for url in try result.get() {
                let accessed = url.startAccessingSecurityScopedResource()
                defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                let values = try url.resourceValues(forKeys: [.contentTypeKey])
                let data = try Data(contentsOf: url)
                attachments.append(
                    ComposeAttachment(
                        filename: url.lastPathComponent,
                        contentType: values.contentType?.preferredMIMEType ?? "application/octet-stream",
                        data: data
                    )
                )
            }
            let total = attachments.reduce(0) { $0 + $1.data.count }
            if total > 25 * 1_024 * 1_024 {
                attachments.removeAll()
                errorMessage = "Attachments must total 25 MB or less."
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
