import SwiftUI
import UniformTypeIdentifiers

// The email the agent drafted, editable right here in the conversation. The
// view renders `AssistantDraftStore` state and sends intent back; it holds no
// copy of the message. Sending is explicit and goes through the same compose
// transport as the full composer, with the same undo window.
struct AssistantDraftArtifactView: View {
    @Environment(AppEnvironment.self) private var environment
    let key: AssistantDraftKey
    let seed: AssistantDraftSeed

    var body: some View {
        AssistantDraftArtifactContent(
            key: key, seed: seed,
            store: environment.assistantDrafts,
            ownerID: environment.sessionStore.ownerID,
            accounts: environment.store.accounts,
            pendingSends: environment.pendingSends,
            theme: environment.theme,
            sendingPreferences: {
                let result = try await environment.backend.get(path: "/api/prefs")
                return Int(result["prefs"]?["undoSendSeconds"]?.doubleValue ?? 10)
            }
        )
    }
}

// Explicit dependencies let the real rendered artifact be tested without
// creating a signed-in application, changing accounts, or sending mail.
struct AssistantDraftArtifactContent: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let key: AssistantDraftKey
    let seed: AssistantDraftSeed
    let store: AssistantDraftStore
    let ownerID: String?
    let accounts: [AccountSummary]
    let pendingSends: PendingSendCoordinator
    let theme: ThemeStore
    let sendingPreferences: @MainActor () async throws -> Int

    @State private var showsCopyFields = false
    @State private var showsFileImporter = false
    @State private var isReadingAttachments = false
    @State private var undoSendSeconds = 10
    @FocusState private var focusedField: Field?

    private enum Field: Hashable {
        case to, cc, bcc, subject, body
    }

    /// Mirrors the store's rule: editable and no send in flight. The store
    /// enforces it; this only greys the controls to match.
    private var canEdit: Bool { store.canEdit(key, ownerID: ownerID) }

    var body: some View {
        Group {
            if let record = store.record(for: key, ownerID: ownerID) {
                artifact(record)
            } else {
                preview
            }
        }
        .task(id: ownerID) {
            guard let ownerID else { return }
            // Idempotent: the same seed changes nothing on a re-render.
            store.receive(seed, key: key, ownerID: ownerID)
            store.resolveAccountIfNeeded(key, ownerID: ownerID, accounts: accounts)
            await store.syncPendingDelivery(key, ownerID: ownerID, pendingSends: pendingSends)
            await loadSendingPreferences()
        }
        .onChange(of: accounts) { _, accounts in
            store.resolveAccountIfNeeded(key, ownerID: ownerID, accounts: accounts)
        }
        .onChange(of: pendingSends.records) { _, _ in
            Task { await store.syncPendingDelivery(key, ownerID: ownerID, pendingSends: pendingSends) }
        }
        .onChange(of: pendingSends.resolutions) { _, _ in
            Task { await store.syncPendingDelivery(key, ownerID: ownerID, pendingSends: pendingSends) }
        }
        .fileImporter(
            isPresented: $showsFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            let key = key
            let owner = ownerID
            isReadingAttachments = true
            Task { @MainActor in
                defer { isReadingAttachments = false }
                do {
                    let urls = try result.get()
                    let files = try await AssistantDraftFileReader.read(urls)
                    await store.addAttachments(files, to: key, ownerID: owner)
                } catch {
                    let failure = error as NSError
                    if failure.domain == NSCocoaErrorDomain, failure.code == NSUserCancelledError { return }
                    store.reportAttachmentError(error.localizedDescription, for: key, ownerID: owner)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("assistant.draft.\(key.toolCallID)")
    }

    // MARK: - Editable artifact

    @ViewBuilder private func artifact(_ record: AssistantDraftRecord) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            header(record)
            hairline
            fromRow(record)
            hairline
            recipientRows(record)
            subjectField(record)
            hairline
            bodyEditor(record)
            if !record.attachments.isEmpty {
                attachmentChips(record)
            }
            if let suggestion = record.suggestion, record.delivery.isEditable {
                suggestionBanner(suggestion)
            }
            if let error = store.sendError(for: key) {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 14)
                    .padding(.top, 8)
                    .accessibilityIdentifier("assistant.draft.error")
            }
            if let note = record.note, record.delivery.isEditable || record.delivery.isUnconfirmed {
                Text(note)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 14)
                    .padding(.top, 8)
                    .accessibilityIdentifier("assistant.draft.note")
            }
            footer(record)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .surfaceCard(theme: theme, cornerRadius: 16)
    }

    private var hairline: some View {
        Divider()
            .overlay(theme.hairlineColor)
            .padding(.leading, 14)
    }

    private func header(_ record: AssistantDraftRecord) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "envelope")
                .font(.caption)
                .foregroundStyle(theme.accentColor)
            Text("Email draft")
                .font(.footnote.weight(.semibold))
            Spacer(minLength: 8)
            Text(statusLine(record))
                .font(.caption)
                .foregroundStyle(statusIsProblem(record) ? .red : .secondary)
                .lineLimit(1)
                .accessibilityIdentifier("assistant.draft.status")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private func statusLine(_ record: AssistantDraftRecord) -> String {
        switch record.delivery {
        case .pending:
            return "Sending"
        case .scheduled(let sendAt):
            return "Scheduled · \(sendAt.formatted(date: .abbreviated, time: .shortened))"
        case .sent:
            return "Sent"
        case .unconfirmed:
            return "Not confirmed"
        case .editable:
            break
        }
        if store.isSending(key) { return "Sending…" }
        if isReadingAttachments { return "Adding files…" }
        if record.accountID.isEmpty { return "Choose an account" }
        switch store.saveState(for: key) {
        case .saving: return "Saving…"
        case .saved: return "Saved"
        case .failed: return "Couldn’t save · kept here"
        case .idle: return record.isEdited ? "Edited" : "Draft"
        }
    }

    private func statusIsProblem(_ record: AssistantDraftRecord) -> Bool {
        if record.delivery.isUnconfirmed { return true }
        if case .failed = store.saveState(for: key), record.delivery.isEditable { return true }
        return false
    }

    // Which account sends: this is a multi-account product.
    private func fromRow(_ record: AssistantDraftRecord) -> some View {
        let label = accounts.first(where: { $0.id == record.accountID })?.email ?? "Choose account"
        return Menu {
            ForEach(accounts) { account in
                Button {
                    store.update(key, ownerID: ownerID) { $0.accountID = account.id }
                } label: {
                    if account.id == record.accountID {
                        Label(account.email, systemImage: "checkmark")
                    } else {
                        Text(account.email)
                    }
                }
            }
        } label: {
            HStack(spacing: 8) {
                Text("From")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Text(label)
                    .font(.subheadline)
                    .foregroundStyle(record.accountID.isEmpty ? .secondary : .primary)
                    .lineLimit(1)
                if canEdit {
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .disabled(!canEdit)
        .accessibilityLabel("From \(label)")
        .accessibilityIdentifier("assistant.draft.account")
    }

    @ViewBuilder private func recipientRows(_ record: AssistantDraftRecord) -> some View {
        let editable = canEdit
        addressRow("To", text: binding(\.to), field: .to, editable: editable)
            .accessibilityIdentifier("assistant.draft.to")
        hairline
        if showsCopyFields || !record.cc.isEmpty || !record.bcc.isEmpty {
            addressRow("Cc", text: binding(\.cc), field: .cc, editable: editable)
                .accessibilityIdentifier("assistant.draft.cc")
            hairline
            addressRow("Bcc", text: binding(\.bcc), field: .bcc, editable: editable)
                .accessibilityIdentifier("assistant.draft.bcc")
            hairline
        }
    }

    private func addressRow(
        _ title: String,
        text: Binding<String>,
        field: Field,
        editable: Bool
    ) -> some View {
        HStack(spacing: 8) {
            Text(title)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            TextField("", text: text)
                .textFieldStyle(.plain)
                .textContentType(.emailAddress)
                .textInputAutocapitalization(.never)
                .keyboardType(.emailAddress)
                .focused($focusedField, equals: field)
                .disabled(!editable)
                .accessibilityLabel(title)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .frame(minHeight: 44)
    }

    private func subjectField(_ record: AssistantDraftRecord) -> some View {
        TextField("Subject", text: binding(\.subject), axis: .vertical)
            .textFieldStyle(.plain)
            .font(.subheadline.weight(.semibold))
            .lineLimit(1...3)
            .focused($focusedField, equals: .subject)
            .disabled(!canEdit)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .accessibilityLabel("Subject")
            .accessibilityIdentifier("assistant.draft.subject")
    }

    private func bodyEditor(_ record: AssistantDraftRecord) -> some View {
        TextField("Write your message…", text: binding(\.body), axis: .vertical)
            .textFieldStyle(.plain)
            .font(.body)
            .lineLimit(3...14)
            .focused($focusedField, equals: .body)
            .disabled(!canEdit)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .accessibilityLabel("Message body")
            .accessibilityIdentifier("assistant.draft.body")
    }

    private func attachmentChips(_ record: AssistantDraftRecord) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(record.attachments.enumerated()), id: \.element.id) { offset, chip in
                    HStack(spacing: 4) {
                        Image(systemName: "paperclip")
                        Text(chip.filename).lineLimit(1)
                        Text(ByteCountFormatter.string(fromByteCount: Int64(chip.byteCount), countStyle: .file))
                            .foregroundStyle(.secondary)
                        if canEdit {
                            Button {
                                Task { await store.removeAttachment(at: offset, from: key, ownerID: ownerID) }
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundStyle(.tertiary)
                                    .frame(width: 44, height: 44)
                                    .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Remove \(chip.filename)")
                        }
                    }
                    .font(.caption)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .background(Color.primary.opacity(0.06), in: Capsule())
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("assistant.draft.attachment.\(offset)")
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 4)
        }
    }

    // The agent revised the draft after the person typed: their text stays
    // and the revision waits for a decision.
    private func suggestionBanner(_ suggestion: AssistantDraftSeed) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Albatross suggested a revision", systemImage: "sparkles")
                .font(.footnote.weight(.semibold))
            Text(suggestion.subject)
                .font(.caption.weight(.medium))
                .lineLimit(1)
            Text(suggestion.body)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(4)
            HStack {
                Button("Keep mine") { store.dismissSuggestion(key, ownerID: ownerID) }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("assistant.draft.suggestion.dismiss")
                Button("Use revision") { store.applySuggestion(key, ownerID: ownerID) }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("assistant.draft.suggestion.apply")
            }
            .controlSize(.large)
            .disabled(!canEdit)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.accentColor.opacity(0.08), in: .rect(cornerRadius: 12))
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private func footer(_ record: AssistantDraftRecord) -> some View {
        switch record.delivery {
        case .editable:
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .trailing, spacing: 8))
                : AnyLayout(HStackLayout(spacing: 4))
            layout {
                HStack(spacing: 4) {
                Button {
                    showsFileImporter = true
                } label: {
                    Label("Attach", systemImage: "paperclip")
                        .labelStyle(.iconOnly)
                        .frame(width: 44, height: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .disabled(!canEdit)
                .accessibilityLabel("Attach files")
                .accessibilityIdentifier("assistant.draft.attach")
                .disabled(isReadingAttachments)
                if !showsCopyFields, record.cc.isEmpty, record.bcc.isEmpty {
                    Button {
                        showsCopyFields = true
                        focusedField = .cc
                    } label: {
                        Text("Cc, Bcc")
                            .frame(minHeight: 44)
                            .contentShape(.rect)
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .buttonStyle(.plain)
                    .disabled(!canEdit)
                    .accessibilityIdentifier("assistant.draft.copyFields")
                }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    Task {
                        await store.send(
                            key,
                            ownerID: ownerID,
                            pendingSends: pendingSends,
                            undoSeconds: undoSendSeconds
                        )
                    }
                } label: {
                    HStack(spacing: 6) {
                        if store.isSending(key) {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "arrow.up")
                        }
                        Text("Send")
                            .fixedSize()
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(theme.paperColor)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(theme.accentColor)
                .disabled(!record.canSend || store.isSending(key) || isReadingAttachments)
                .accessibilityLabel(store.isSending(key) ? "Sending" : "Send")
                .accessibilityIdentifier("assistant.draft.send")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)

        case .pending(let pendingID, let fireAt):
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let remaining = max(0, Int(ceil(fireAt.timeIntervalSince(context.date))))
                HStack(spacing: 10) {
                    Image(systemName: "paperplane")
                        .foregroundStyle(theme.accentColor)
                    Text(remaining > 0 ? "Sending in \(remaining)s" : "Confirming…")
                        .font(.subheadline.weight(.medium))
                    Spacer(minLength: 8)
                    if let held = pendingSends.records.first(where: { $0.id == pendingID }) {
                        Button("Undo Send") {
                            Task {
                                _ = await pendingSends.undo(held)
                                await store.syncPendingDelivery(
                                    key,
                                    ownerID: ownerID,
                                    pendingSends: pendingSends
                                )
                            }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                        .disabled(remaining <= 0)
                        .accessibilityIdentifier("assistant.draft.undo")
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            }
            .task(id: pendingID) {
                // The server owns the deadline; ask it once the window closes.
                let delay = max(0, fireAt.timeIntervalSinceNow)
                do { try await Task.sleep(for: .seconds(delay + 0.5)) }
                catch { return }
                await pendingSends.reconcile(ownerID: ownerID)
                await store.syncPendingDelivery(key, ownerID: ownerID, pendingSends: pendingSends)
            }

        case .scheduled(let sendAt):
            Label(
                "Scheduled for \(sendAt.formatted(date: .abbreviated, time: .shortened))",
                systemImage: "clock"
            )
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)

        case .sent:
            Label("Sent", systemImage: "checkmark.circle.fill")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.green)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .accessibilityIdentifier("assistant.draft.sent")

        case .unconfirmed(let pendingID):
            HStack(spacing: 8) {
                // Only a known receipt can be looked up; otherwise the
                // honest answer is the note above: check Sent.
                if pendingID != nil {
                    Button("Check status") {
                        Task {
                            await store.checkUnconfirmedDelivery(
                                key,
                                ownerID: ownerID,
                                pendingSends: pendingSends
                            )
                        }
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("assistant.draft.check")
                }
                Button("Keep editing") { store.resumeEditing(key, ownerID: ownerID) }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("assistant.draft.resume")
                Spacer(minLength: 0)
            }
            .controlSize(.large)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
    }

    // MARK: - Signed-out preview

    // Without an owner there is no durable artifact; the text still shows.
    private var preview: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("Email draft").font(.footnote.weight(.semibold))
            if !seed.to.isEmpty {
                Text("To: \(seed.to)").font(.caption).foregroundStyle(.secondary)
            }
            Text(seed.subject).font(.footnote.weight(.semibold))
            Text(seed.body)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(8)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .surfaceCard(theme: theme, cornerRadius: 14)
    }

    // MARK: - Helpers

    private func binding(_ keyPath: WritableKeyPath<AssistantDraftRecord, String>) -> Binding<String> {
        Binding(
            get: { store.record(for: key, ownerID: ownerID)?[keyPath: keyPath] ?? "" },
            set: { value in store.update(key, ownerID: ownerID) { $0[keyPath: keyPath] = value } }
        )
    }

    private func loadSendingPreferences() async {
        do {
            undoSendSeconds = try await sendingPreferences()
        } catch {
            // The shared default stays safe offline; the server owns the
            // durable preference, as in the full composer.
            undoSendSeconds = 10
        }
    }

}
