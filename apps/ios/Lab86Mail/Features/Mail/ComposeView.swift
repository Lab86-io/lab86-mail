import SwiftStreamingMarkdown
import SwiftUI
import UniformTypeIdentifiers

// Compose as authoring a document, not filling a form: identity header,
// hairline recipient rows, the subject as the page's display-face headline,
// and a borderless body. The send contract is unchanged.
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
    @State private var undoSendSeconds = 10
    @State private var showsCustomSchedule = false
    @State private var previewsMarkdown = false
    @State private var showsDiscardConfirmation = false
    @State private var didSeedDraft = false
    @State private var baselineFingerprint = ""
    @State private var isSavingDraft = false
    @State private var isDraftingWithAlbatross = false
    @FocusState private var focusedField: Field?

    private enum Field: Hashable {
        case to, cc, bcc, subject, body
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    fromRow
                    hairline
                    recipientRows
                    subjectField
                    hairline
                    bodyEditor
                    if !attachments.isEmpty {
                        attachmentRows
                    }
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .padding(.horizontal, 20)
                            .padding(.top, 10)
                    }
                }
                .padding(.bottom, 24)
            }
            .background(environment.theme.paperColor)
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom, spacing: 0) { utilityStrip }
            .navigationTitle(navigationTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        if isDirty {
                            showsDiscardConfirmation = true
                        } else {
                            dismiss()
                        }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await send() }
                    } label: {
                        if isSending {
                            ProgressView()
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(.white)
                                .frame(width: 32, height: 32)
                                .background(
                                    Circle().fill(
                                        canSend ? environment.theme.accentColor : Color.secondary.opacity(0.4)
                                    )
                                )
                        }
                    }
                    .disabled(!canSend || isSending)
                    .accessibilityLabel(sendsLater ? "Schedule" : "Send")
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
                if focusedField == nil {
                    focusedField = mode == "new" && to.isEmpty ? .to : .body
                }
                Task {
                    await loadSendingPreferences()
                    await MainActor.run {
                        baselineFingerprint = draftFingerprint
                        didSeedDraft = true
                    }
                }
            }
            .task(id: draftFingerprint) {
                guard didSeedDraft, hasMeaningfulDraft, isDirty, !isSending else { return }
                do {
                    try await Task.sleep(for: .milliseconds(850))
                    try Task.checkCancellation()
                    await persistDraft()
                } catch is CancellationError {
                    // A newer edit owns the next debounced save.
                } catch {
                    errorMessage = "Couldn’t save this draft yet. Your text remains here."
                }
            }
            .interactiveDismissDisabled(isDirty)
            .confirmationDialog(
                "Keep this draft?",
                isPresented: $showsDiscardConfirmation,
                titleVisibility: .visible
            ) {
                Button("Keep Draft") {
                    Task {
                        await persistDraft()
                        if errorMessage == nil { dismiss() }
                    }
                }
                Button("Discard Draft", role: .destructive) {
                    Task {
                        if let draftID { try? await environment.store.deleteDraft(id: draftID) }
                        if let attachmentsKey {
                            try? await MailIntentAttachmentStore.shared.remove(draftID: attachmentsKey)
                        }
                        dismiss()
                    }
                }
                Button("Continue Editing", role: .cancel) {}
            } message: {
                Text("Albatross can keep the message as a draft, including its local attachment copies.")
            }
            .sheet(isPresented: $showsCustomSchedule) {
                NavigationStack {
                    Form {
                        DatePicker(
                            "Send",
                            selection: $sendLaterDate,
                            in: Date.now.addingTimeInterval(60)...Date.now.addingTimeInterval(30 * 24 * 60 * 60),
                            displayedComponents: [.date, .hourAndMinute]
                        )
                    }
                    .navigationTitle("Custom Send Time")
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { showsCustomSchedule = false }
                        }
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") {
                                sendsLater = true
                                showsCustomSchedule = false
                            }
                        }
                    }
                }
                .presentationDetents([.medium])
            }
            .fileImporter(
                isPresented: $isImporting,
                allowedContentTypes: [.item],
                allowsMultipleSelection: true,
                onCompletion: importFiles
            )
        }
    }

    private var hairline: some View {
        Divider()
            .overlay(environment.theme.hairlineColor)
            .padding(.leading, 20)
    }

    // Which account is sending, always visible — this is a multi-account app.
    private var fromRow: some View {
        Menu {
            ForEach(environment.store.accounts) { account in
                Button {
                    accountID = account.id
                } label: {
                    if account.id == accountID {
                        Label(account.email, systemImage: "checkmark")
                    } else {
                        Text(account.email)
                    }
                }
            }
        } label: {
            HStack(spacing: 10) {
                InitialsAvatar(name: selectedAccountLabel, seed: accountID, size: 30)
                VStack(alignment: .leading, spacing: 1) {
                    Text("From")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(selectedAccountLabel)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                }
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .contentShape(.rect)
        }
        .accessibilityLabel("From \(selectedAccountLabel)")
    }

    private var selectedAccountLabel: String {
        environment.store.accounts.first(where: { $0.id == accountID })?.email ?? "Choose account"
    }

    @ViewBuilder private var recipientRows: some View {
        HStack(spacing: 8) {
            Text("To")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            TextField("", text: $to)
                .textContentType(.emailAddress)
                .textInputAutocapitalization(.never)
                .keyboardType(.emailAddress)
                .focused($focusedField, equals: .to)
            if !showsCopyFields {
                Button("Cc, Bcc") {
                    showsCopyFields = true
                    focusedField = .cc
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        hairline
        if showsCopyFields {
            HStack(spacing: 8) {
                Text("Cc")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                TextField("", text: $cc)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                    .focused($focusedField, equals: .cc)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            hairline
            HStack(spacing: 8) {
                Text("Bcc")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                TextField("", text: $bcc)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                    .focused($focusedField, equals: .bcc)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            hairline
        }
    }

    // The subject is the page headline, set in the display face.
    private var subjectField: some View {
        TextField("Subject", text: $subject, axis: .vertical)
            .font(environment.theme.displayType.displayFont(size: 24))
            .lineLimit(1...3)
            .focused($focusedField, equals: .subject)
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
    }

    @ViewBuilder private var bodyEditor: some View {
        if previewsMarkdown {
            Group {
                if bodyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    ContentUnavailableView(
                        "Nothing to Preview",
                        systemImage: "doc.richtext",
                        description: Text("Switch to Write and add message text.")
                    )
                } else {
                    MarkdownView(text: bodyText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
            .accessibilityLabel("Message preview")
        } else {
            TextField("Write your message…", text: $bodyText, axis: .vertical)
                .font(.body)
                .lineLimit(10...)
                .focused($focusedField, equals: .body)
                .padding(.horizontal, 20)
                .padding(.top, 10)
                .accessibilityLabel("Message body")
        }
    }

    private var attachmentRows: some View {
        VStack(alignment: .leading, spacing: 0) {
            hairline
            ForEach(attachments) { attachment in
                HStack(spacing: 10) {
                    Image(systemName: "paperclip")
                        .foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(attachment.filename)
                            .font(.subheadline)
                            .lineLimit(1)
                        Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.data.count), countStyle: .file))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Remove", systemImage: "xmark.circle.fill") {
                        attachments.removeAll { $0.id == attachment.id }
                    }
                    .labelStyle(.iconOnly)
                    .foregroundStyle(.tertiary)
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
                hairline
            }
        }
        .padding(.top, 8)
    }

    // The floating utility capsule: attach and delivery, detached from the
    // keyboard edge — a tool palette, not a system bar.
    private var utilityStrip: some View {
        HStack(spacing: 4) {
            Button("Attach") { isImporting = true }
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.primary)
                .buttonStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
            Button {
                previewsMarkdown.toggle()
            } label: {
                Label(previewsMarkdown ? "Write" : "Preview", systemImage: previewsMarkdown ? "pencil" : "eye")
                    .labelStyle(.iconOnly)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .accessibilityLabel(previewsMarkdown ? "Write message" : "Preview formatting")
            Button {
                Task { await draftWithAlbatross() }
            } label: {
                if isDraftingWithAlbatross {
                    ProgressView()
                } else {
                    Image(systemName: "sparkles")
                }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .disabled(isDraftingWithAlbatross)
            .accessibilityLabel("Draft with Albatross")
            Spacer(minLength: 0)
            Menu {
                Button("Send now") { sendsLater = false }
                Button("In 1 hour") {
                    sendsLater = true
                    sendLaterDate = .now.addingTimeInterval(60 * 60)
                }
                Button("Tomorrow at 9:00") {
                    sendsLater = true
                    let calendar = Calendar.autoupdatingCurrent
                    let tomorrow = calendar.date(byAdding: .day, value: 1, to: .now) ?? .now
                    sendLaterDate = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) ?? tomorrow
                }
                Button("Custom date and time…") {
                    showsCustomSchedule = true
                }
            } label: {
                Text(deliveryLabel)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(sendsLater ? environment.theme.accentColor : .secondary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .contentShape(.rect)
            }
            .accessibilityLabel("Delivery: \(deliveryLabel)")
        }
        .padding(6)
        .glassEffect(.regular.interactive(), in: .capsule)
        .padding(.horizontal, 14)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    private var deliveryLabel: String {
        guard sendsLater else { return "Send now" }
        return "Sends \(sendLaterDate.formatted(date: .abbreviated, time: .shortened))"
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

    private var hasMeaningfulDraft: Bool {
        !to.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !cc.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !bcc.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !bodyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !attachments.isEmpty
    }

    private var isDirty: Bool {
        didSeedDraft && draftFingerprint != baselineFingerprint
    }

    private var draftFingerprint: String {
        [
            accountID,
            to,
            cc,
            bcc,
            subject,
            bodyText,
            sendsLater ? String(Int(sendLaterDate.timeIntervalSince1970)) : "",
            attachments.map { "\($0.filename):\($0.data.count)" }.joined(separator: "|"),
        ].joined(separator: "\u{1F}")
    }

    private func send() async {
        isSending = true
        defer { isSending = false }
        do {
            let attachmentKey = attachmentsKey ?? (attachments.isEmpty ? nil : "compose-\(UUID().uuidString)")
            if let attachmentKey {
                try await MailIntentAttachmentStore.shared.saveComposeAttachments(
                    attachments,
                    draftID: attachmentKey
                )
            }
            let submission = try await environment.store.sendCompose(
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
                sendAt: sendsLater ? sendLaterDate : nil,
                undoSeconds: sendsLater ? 0 : undoSendSeconds
            )
            switch submission {
            case .pending(let receipt):
                guard let ownerID = environment.sessionStore.ownerID else {
                    throw BackendError.unauthorized
                }
                let snapshot = ComposeDraftSnapshot(
                    recipient: to,
                    cc: cc,
                    bcc: bcc,
                    subject: subject,
                    body: bodyText,
                    mode: mode,
                    accountID: accountID,
                    threadID: sourceThreadID,
                    messageID: sourceMessageID,
                    replyAll: replyAll,
                    attachmentsKey: attachmentKey,
                    draftID: draftID
                )
                environment.pendingSends.register(receipt: receipt, ownerID: ownerID, snapshot: snapshot)
            case .scheduled, .sent:
                if let draftID { try? await environment.store.deleteDraft(id: draftID) }
                if let attachmentKey {
                    try? await MailIntentAttachmentStore.shared.remove(draftID: attachmentKey)
                }
            }
            dismiss()
        } catch { errorMessage = error.localizedDescription }
    }

    private func loadSendingPreferences() async {
        do {
            let result = try await environment.backend.get(path: "/api/prefs")
            undoSendSeconds = Int(result["prefs"]?["undoSendSeconds"]?.doubleValue ?? 10)
        } catch {
            // The shared default remains safe while offline; Settings and the
            // server still own the durable preference.
            undoSendSeconds = 10
        }
    }

    private func persistDraft() async {
        guard hasMeaningfulDraft, !accountID.isEmpty else { return }
        isSavingDraft = true
        defer { isSavingDraft = false }
        do {
            let key = attachmentsKey ?? (attachments.isEmpty ? nil : "draft-\(UUID().uuidString)")
            if let key {
                try await MailIntentAttachmentStore.shared.saveComposeAttachments(attachments, draftID: key)
                attachmentsKey = key
            }
            draftID = try await environment.store.saveDraft(
                id: draftID,
                accountID: accountID,
                threadID: sourceThreadID,
                messageID: sourceMessageID,
                to: to,
                cc: cc,
                bcc: bcc,
                subject: subject,
                body: bodyText,
                scheduledFor: sendsLater ? sendLaterDate : nil
            )
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func draftWithAlbatross() async {
        isDraftingWithAlbatross = true
        defer { isDraftingWithAlbatross = false }
        do {
            bodyText = try await environment.store.draftCompose(
                accountID: accountID,
                threadID: sourceThreadID,
                to: to,
                subject: subject,
                currentBody: bodyText
            )
            previewsMarkdown = false
            focusedField = .body
        } catch {
            errorMessage = error.localizedDescription
        }
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
