import Foundation
import Observation

// An email the agent drafted inside a conversation. It stays an editable
// artifact in the transcript: the person edits it in place and sends it
// explicitly. Identity is the conversation plus the tool call that produced
// it, so scrolling, reopening the chat, backgrounding, and a relaunch all
// return to the same draft. This store is the one owner of that editing
// state; the server draft (save_draft / update_draft) and the compose
// endpoint stay the authoritative transport.

struct AssistantDraftKey: Hashable, Codable, Sendable {
    let sessionID: String
    let toolCallID: String

    var storageID: String { "\(sessionID):\(toolCallID)" }

    init(sessionID: String, toolCallID: String) {
        self.sessionID = sessionID
        self.toolCallID = toolCallID
    }

    init?(storageID: String) {
        guard let separator = storageID.firstIndex(of: ":") else { return nil }
        let session = String(storageID[..<separator])
        let call = String(storageID[storageID.index(after: separator)...])
        guard !session.isEmpty, !call.isEmpty else { return nil }
        self.init(sessionID: session, toolCallID: call)
    }
}

/// What the agent proposed. The same shape carries a later revision so the
/// person accepts or refuses it explicitly instead of losing their typing.
struct AssistantDraftSeed: Hashable, Codable, Sendable {
    var fromEmail: String?
    var to: String
    var cc: String
    var bcc: String
    var subject: String
    var body: String

    var fingerprint: String {
        AssistantDraftRecord.fingerprint(to: to, cc: cc, bcc: bcc, subject: subject, body: body)
    }
}

struct AssistantDraftAttachmentChip: Hashable, Codable, Sendable, Identifiable {
    let id: UUID
    let filename: String
    let byteCount: Int
}

enum AssistantDraftDelivery: Hashable, Codable, Sendable {
    case editable
    /// The server holds the message for its undo window.
    case pending(id: String, fireAt: Date)
    case scheduled(sendAt: Date)
    case sent(messageID: String?)
    /// The outcome is unknown: the server answered without confirming a
    /// send, the transport failed after the request may have gone out, or a
    /// held message's receipt was lost. The draft stays and nothing retries
    /// on its own; the person decides. `pendingID` is the receipt that can
    /// still be looked up; without one there is nothing to check.
    case unconfirmed(pendingID: String?)

    var isEditable: Bool { self == .editable }

    var isUnconfirmed: Bool {
        if case .unconfirmed = self { return true }
        return false
    }
}

struct AssistantDraftRecord: Identifiable, Hashable, Codable, Sendable {
    let key: AssistantDraftKey
    let ownerID: String
    var accountID: String
    var fromHint: String?
    var to: String
    var cc: String
    var bcc: String
    var subject: String
    var body: String
    var attachments: [AssistantDraftAttachmentChip]
    var attachmentsKey: String?
    /// Fingerprint of the first agent content, so a replay of the original
    /// card never turns back into a suggestion after a revision was applied.
    var originFingerprint: String
    /// Fingerprint of the agent content the person last accepted. Text that
    /// differs from it is the person's own typing.
    var acceptedFingerprint: String
    var serverDraftID: String?
    /// A newer agent revision waiting for an explicit decision.
    var suggestion: AssistantDraftSeed?
    var delivery: AssistantDraftDelivery
    /// A short line about the last delivery outcome, such as an undo.
    var note: String?
    var updatedAt: Date

    var id: String { key.storageID }

    var fingerprint: String {
        Self.fingerprint(to: to, cc: cc, bcc: bcc, subject: subject, body: body)
    }

    var isEdited: Bool { fingerprint != acceptedFingerprint }

    var hasMeaningfulContent: Bool {
        !to.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !cc.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !bcc.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !attachments.isEmpty
    }

    var canSend: Bool {
        delivery.isEditable
            && !accountID.isEmpty
            && !to.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var seed: AssistantDraftSeed {
        AssistantDraftSeed(fromEmail: fromHint, to: to, cc: cc, bcc: bcc, subject: subject, body: body)
    }

    static func fingerprint(to: String, cc: String, bcc: String, subject: String, body: String) -> String {
        [to, cc, bcc, subject, body].joined(separator: "\u{1F}")
    }
}

enum AssistantDraftSaveState: Equatable, Sendable {
    case idle
    case saving
    case saved(Date)
    case failed(String)
}

/// The compose transport the store reuses. `ProductStore` is the production
/// implementation; tests script it.
@MainActor
protocol AssistantDraftTransport: AnyObject {
    func saveDraft(
        id: String?,
        accountID: String,
        threadID: String?,
        messageID: String?,
        to: String,
        cc: String,
        bcc: String,
        subject: String,
        body: String,
        scheduledFor: Date?
    ) async throws -> String

    func sendCompose(
        mode: String,
        accountID: String,
        threadID: String?,
        messageID: String?,
        to: String,
        cc: String,
        bcc: String,
        subject: String,
        body: String,
        attachments: [ComposeAttachment],
        sendAt: Date?,
        undoSeconds: Int
    ) async throws -> ComposeSubmission

    func deleteDraft(id: String) async throws
}

extension ProductStore: AssistantDraftTransport {}

/// The attachment files behind an artifact's chips. `MailIntentAttachmentStore`
/// is the production owner (the same files the composer and held messages
/// use); tests wrap it to hold an operation at the disk boundary.
protocol AssistantDraftAttachmentStoring: Sendable {
    func saveComposeAttachments(_ attachments: [ComposeAttachment], draftID: String) async throws
    func loadComposeAttachments(draftID: String) async throws -> [ComposeAttachment]
    func remove(draftID: String) async throws
}

extension MailIntentAttachmentStore: AssistantDraftAttachmentStoring {}

@MainActor
@Observable
final class AssistantDraftStore {
    nonisolated static let attachmentByteLimit = 25 * 1_024 * 1_024

    private(set) var records: [String: AssistantDraftRecord] = [:]
    private(set) var saveStates: [String: AssistantDraftSaveState] = [:]
    private(set) var sendingIDs: Set<String> = []
    private(set) var sendErrors: [String: String] = [:]

    private let transport: any AssistantDraftTransport
    private let attachmentStore: any AssistantDraftAttachmentStoring
    private let defaults: UserDefaults
    private let saveDelay: Duration
    private let now: @MainActor () -> Date
    private let persistenceKey = "albatross.assistant-drafts.v1"
    private var debounceTasks: [String: Task<Void, Never>] = [:]
    private var saveChains: [String: Task<Void, Never>] = [:]
    private var pendingSaveIDs: Set<String> = []
    // One queue per artifact for everything that touches its files or
    // commits their metadata: attachment adds and removes, and the send
    // itself. See `serializedWork`.
    private var workChains: [String: Task<Void, Never>] = [:]

    init(
        transport: any AssistantDraftTransport,
        attachmentStore: any AssistantDraftAttachmentStoring = MailIntentAttachmentStore.shared,
        defaults: UserDefaults = .standard,
        saveDelay: Duration = .milliseconds(850),
        now: @escaping @MainActor () -> Date = { Date() }
    ) {
        self.transport = transport
        self.attachmentStore = attachmentStore
        self.defaults = defaults
        self.saveDelay = saveDelay
        self.now = now
        if let data = defaults.data(forKey: persistenceKey),
           let decoded = try? JSONDecoder().decode([AssistantDraftRecord].self, from: data) {
            records = Dictionary(decoded.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
        }
    }

    // MARK: - Reads

    /// The draft for this key, only when it belongs to the signed-in person.
    func record(for key: AssistantDraftKey, ownerID: String?) -> AssistantDraftRecord? {
        guard let ownerID, let record = records[key.storageID], record.ownerID == ownerID else { return nil }
        return record
    }

    func saveState(for key: AssistantDraftKey) -> AssistantDraftSaveState {
        saveStates[key.storageID] ?? .idle
    }

    func isSending(_ key: AssistantDraftKey) -> Bool {
        sendingIDs.contains(key.storageID)
    }

    /// Whether the person can change the artifact right now: it must be
    /// editable and no send may be in flight. Every mutation checks this at
    /// the owner; the view only mirrors it.
    func canEdit(_ key: AssistantDraftKey, ownerID: String?) -> Bool {
        guard let record = record(for: key, ownerID: ownerID) else { return false }
        return record.delivery.isEditable && !sendingIDs.contains(record.id)
    }

    func sendError(for key: AssistantDraftKey) -> String? {
        sendErrors[key.storageID]
    }

    func reportAttachmentError(_ message: String, for key: AssistantDraftKey, ownerID: String?) {
        guard canEdit(key, ownerID: ownerID) else { return }
        sendErrors[key.storageID] = message
    }

    // MARK: - Agent output

    /// A draft arrived from the agent, live or replayed from history. The
    /// first arrival creates the artifact. A replay of the same content is a
    /// no-op. Different content never overwrites the person's text: it waits
    /// as a suggestion until they apply or dismiss it.
    @discardableResult
    func receive(_ seed: AssistantDraftSeed, key: AssistantDraftKey, ownerID: String) -> AssistantDraftRecord {
        let id = key.storageID
        if var existing = records[id], existing.ownerID == ownerID {
            guard existing.delivery.isEditable else { return existing }
            let incoming = seed.fingerprint
            if incoming == existing.fingerprint || incoming == existing.acceptedFingerprint
                || incoming == existing.originFingerprint || incoming == existing.suggestion?.fingerprint {
                return existing
            }
            existing.suggestion = seed
            records[id] = existing
            persist()
            return existing
        }
        let record = AssistantDraftRecord(
            key: key,
            ownerID: ownerID,
            accountID: "",
            fromHint: seed.fromEmail?.nilIfBlank,
            to: seed.to,
            cc: seed.cc,
            bcc: seed.bcc,
            subject: seed.subject,
            body: seed.body,
            attachments: [],
            attachmentsKey: nil,
            originFingerprint: seed.fingerprint,
            acceptedFingerprint: seed.fingerprint,
            serverDraftID: nil,
            suggestion: nil,
            delivery: .editable,
            note: nil,
            updatedAt: now()
        )
        records[id] = record
        persist()
        return record
    }

    /// Picks the sending account once, preferring the agent's `from` hint,
    /// then the primary account. Never changes a choice already made.
    func resolveAccountIfNeeded(_ key: AssistantDraftKey, ownerID: String?, accounts: [AccountSummary]) {
        guard var record = record(for: key, ownerID: ownerID), record.accountID.isEmpty,
              !sendingIDs.contains(record.id) else { return }
        let hint = record.fromHint?.lowercased()
        let chosen = accounts.first { $0.email.lowercased() == hint }
            ?? accounts.first(where: \.isPrimary)
            ?? accounts.first
        guard let chosen else { return }
        record.accountID = chosen.id
        records[record.id] = record
        persist()
        scheduleSave(key)
    }

    // MARK: - Person's edits

    /// Every change to the artifact goes through here. Nothing changes while
    /// a send is in flight, so the outcome always describes what was sent.
    func update(_ key: AssistantDraftKey, ownerID: String?, _ mutate: (inout AssistantDraftRecord) -> Void) {
        guard let record = record(for: key, ownerID: ownerID), !sendingIDs.contains(record.id) else { return }
        commit(key, ownerID: ownerID, mutate)
    }

    /// The one write path for an editable record. `update` adds the send
    /// lock in front of it; attachment work that had already begun before a
    /// Send tap commits through here directly, so the files on disk and the
    /// chips describing them never diverge (see `serializedWork`).
    private func commit(_ key: AssistantDraftKey, ownerID: String?, _ mutate: (inout AssistantDraftRecord) -> Void) {
        guard var record = record(for: key, ownerID: ownerID), record.delivery.isEditable else { return }
        let before = record
        mutate(&record)
        guard record != before else { return }
        if record.accountID != before.accountID {
            // Server draft identities are mailbox-scoped. A From change must
            // create a draft in the newly selected account, never update the
            // old account's draft under the new identity.
            record.serverDraftID = nil
            saveStates[record.id] = .idle
        }
        record.updatedAt = now()
        records[record.id] = record
        persist()
        scheduleSave(key)
    }

    func applySuggestion(_ key: AssistantDraftKey, ownerID: String?) {
        update(key, ownerID: ownerID) { record in
            guard let suggestion = record.suggestion else { return }
            record.to = suggestion.to
            record.cc = suggestion.cc
            record.bcc = suggestion.bcc
            record.subject = suggestion.subject
            record.body = suggestion.body
            record.acceptedFingerprint = suggestion.fingerprint
            record.suggestion = nil
        }
    }

    func dismissSuggestion(_ key: AssistantDraftKey, ownerID: String?) {
        guard var record = record(for: key, ownerID: ownerID), record.suggestion != nil,
              !sendingIDs.contains(record.id) else { return }
        record.suggestion = nil
        records[record.id] = record
        persist()
    }

    /// After an unconfirmed send the person may choose to edit and send
    /// again. Nothing calls this on its own.
    func resumeEditing(_ key: AssistantDraftKey, ownerID: String?) {
        guard var record = record(for: key, ownerID: ownerID), record.delivery.isUnconfirmed else { return }
        record.delivery = .editable
        record.note = nil
        records[record.id] = record
        persist()
    }

    // MARK: - Attachments

    // Attachment changes and the send share one queue per artifact. A Send
    // tap takes the lock at once (so typing, the From menu, and new
    // attachment operations are refused from that moment) but the send body
    // runs behind any attachment operation that had already begun. That
    // operation finishes its file write and commits its chips before the
    // send captures the snapshot, so the receipt names exactly the files
    // that went out; an operation still queued behind it finds the lock and
    // does nothing.
    private func serializedWork(_ id: String, _ work: @escaping @MainActor () async -> Void) async {
        let previous = workChains[id]
        let task = Task { @MainActor in
            await previous?.value
            await work()
        }
        workChains[id] = task
        await task.value
    }

    func addAttachments(_ files: [ComposeAttachment], to key: AssistantDraftKey, ownerID: String?) async {
        guard !files.isEmpty, canEdit(key, ownerID: ownerID) else { return }
        await serializedWork(key.storageID) { [self] in
            guard let record = record(for: key, ownerID: ownerID), record.delivery.isEditable,
                  !sendingIDs.contains(record.id) else { return }
            do {
                var all = try await loadAttachments(record)
                all.append(contentsOf: files)
                let total = all.reduce(0) { $0 + $1.data.count }
                guard total <= Self.attachmentByteLimit else {
                    sendErrors[record.id] = "Attachments must total 25 MB or less."
                    return
                }
                let storageKey = record.attachmentsKey ?? "assistant-draft-\(UUID().uuidString)"
                try await attachmentStore.saveComposeAttachments(all, draftID: storageKey)
                // The record may have been cleared (sign-out) while the file
                // was being written; then the file is an orphan to remove.
                guard self.record(for: key, ownerID: ownerID) != nil else {
                    try? await attachmentStore.remove(draftID: storageKey)
                    return
                }
                sendErrors[record.id] = nil
                // Committed even if a Send tap arrived meanwhile: the send is
                // queued behind this operation and must see these chips.
                commit(key, ownerID: ownerID) { latest in
                    latest.attachmentsKey = storageKey
                    latest.attachments = all.map {
                        AssistantDraftAttachmentChip(id: $0.id, filename: $0.filename, byteCount: $0.data.count)
                    }
                }
            } catch {
                if self.record(for: key, ownerID: ownerID) != nil {
                    sendErrors[record.id] = error.localizedDescription
                }
            }
        }
    }

    func removeAttachment(at offset: Int, from key: AssistantDraftKey, ownerID: String?) async {
        guard canEdit(key, ownerID: ownerID) else { return }
        await serializedWork(key.storageID) { [self] in
            guard let record = record(for: key, ownerID: ownerID), record.delivery.isEditable,
                  !sendingIDs.contains(record.id),
                  record.attachments.indices.contains(offset), let storageKey = record.attachmentsKey else { return }
            do {
                var all = try await loadAttachments(record)
                guard all.indices.contains(offset) else { return }
                all.remove(at: offset)
                if all.isEmpty {
                    try await attachmentStore.remove(draftID: storageKey)
                } else {
                    try await attachmentStore.saveComposeAttachments(all, draftID: storageKey)
                }
                commit(key, ownerID: ownerID) { latest in
                    latest.attachments.remove(at: offset)
                    if latest.attachments.isEmpty { latest.attachmentsKey = nil }
                }
            } catch {
                if self.record(for: key, ownerID: ownerID) != nil {
                    sendErrors[record.id] = error.localizedDescription
                }
            }
        }
    }

    private func loadAttachments(_ record: AssistantDraftRecord) async throws -> [ComposeAttachment] {
        guard let storageKey = record.attachmentsKey else { return [] }
        return try await attachmentStore.loadComposeAttachments(draftID: storageKey)
    }

    // MARK: - Server draft

    private func scheduleSave(_ key: AssistantDraftKey) {
        let id = key.storageID
        pendingSaveIDs.insert(id)
        debounceTasks[id]?.cancel()
        debounceTasks[id] = Task { [weak self, saveDelay] in
            do { try await Task.sleep(for: saveDelay) } catch { return }
            guard !Task.isCancelled else { return }
            self?.enqueueSave(key)
        }
    }

    private func enqueueSave(_ key: AssistantDraftKey) {
        let id = key.storageID
        pendingSaveIDs.remove(id)
        let previous = saveChains[id]
        saveChains[id] = Task { [weak self] in
            await previous?.value
            await self?.persistServerDraft(key)
        }
    }

    /// Runs any debounced save now and waits for the chain to settle.
    func flushSaves(for key: AssistantDraftKey) async {
        let id = key.storageID
        if pendingSaveIDs.contains(id) {
            debounceTasks[id]?.cancel()
            enqueueSave(key)
        }
        await saveChains[id]?.value
    }

    private func persistServerDraft(_ key: AssistantDraftKey) async {
        let id = key.storageID
        guard let record = records[id], record.delivery.isEditable,
              !record.accountID.isEmpty, record.hasMeaningfulContent else { return }
        saveStates[id] = .saving
        do {
            let draftID = try await transport.saveDraft(
                id: record.serverDraftID,
                accountID: record.accountID,
                threadID: nil,
                messageID: nil,
                to: record.to,
                cc: record.cc,
                bcc: record.bcc,
                subject: record.subject,
                body: record.body,
                scheduledFor: nil
            )
            // Only the server identity lands here; the text is the person's.
            // A record cleared or replaced by another owner meanwhile is
            // left alone.
            guard var latest = records[id], latest.ownerID == record.ownerID,
                  latest.accountID == record.accountID else { return }
            if latest.serverDraftID != draftID {
                latest.serverDraftID = draftID
                records[id] = latest
                persist()
            }
            saveStates[id] = .saved(now())
        } catch {
            guard let latest = records[id], latest.ownerID == record.ownerID,
                  latest.accountID == record.accountID else { return }
            saveStates[id] = .failed(error.localizedDescription)
        }
    }

    // MARK: - Sending

    /// Explicit send. A second tap while one is in flight does nothing, and
    /// the artifact is locked until the outcome is known, so what the
    /// person sees afterwards is exactly what went out. A definitive
    /// rejection keeps the draft editable with the reason; a failure after
    /// the request may have reached the server leaves it unconfirmed.
    /// Nothing retries by itself.
    func send(
        _ key: AssistantDraftKey,
        ownerID: String?,
        pendingSends: PendingSendCoordinator,
        undoSeconds: Int
    ) async {
        guard let ownerID, let current = record(for: key, ownerID: ownerID) else { return }
        let id = current.id
        guard current.delivery.isEditable, !sendingIDs.contains(id) else { return }
        guard current.canSend else {
            sendErrors[id] = current.accountID.isEmpty
                ? "Choose a sending account."
                : "Add a recipient and a subject before sending."
            return
        }
        // The lock is taken at the tap: it dedupes a second tap and refuses
        // every new edit from here on. The body then waits its turn behind
        // any attachment operation that had already begun.
        sendingIDs.insert(id)
        sendErrors[id] = nil
        defer { sendingIDs.remove(id) }
        await serializedWork(id) { [self] in
            await performSend(key, ownerID: ownerID, pendingSends: pendingSends, undoSeconds: undoSeconds)
        }
    }

    /// The send body, already holding the lock and at the head of the
    /// artifact's work queue. After every await it re-reads the record and
    /// checks the owner: a record cleared by sign-out, or replaced under the
    /// same key by another account, is never written to or resurrected.
    private func performSend(
        _ key: AssistantDraftKey,
        ownerID: String,
        pendingSends: PendingSendCoordinator,
        undoSeconds: Int
    ) async {
        let id = key.storageID
        // Settle the server draft first so the receipt carries the right
        // draft id. A failed save is not a reason to hold the send.
        await flushSaves(for: key)
        // From here on the lock keeps the record identical to `submitted`.
        guard let submitted = record(for: key, ownerID: ownerID), submitted.delivery.isEditable else { return }
        let files: [ComposeAttachment]
        do {
            files = try await loadAttachments(submitted)
        } catch {
            // Nothing left the device.
            guard record(for: key, ownerID: ownerID) != nil else { return }
            sendErrors[id] = "Couldn’t read the attachments, so nothing was sent. \(error.localizedDescription)"
            return
        }
        guard var current = record(for: key, ownerID: ownerID) else { return }
        // A streamed AI revision may arrive while files load. It is only a
        // suggestion, not an edit to the submitted email, and must not make
        // an explicit Send silently disappear.
        current.suggestion = submitted.suggestion
        guard current == submitted else { return }
        let submission: ComposeSubmission
        do {
            submission = try await transport.sendCompose(
                mode: "new",
                accountID: submitted.accountID,
                threadID: nil,
                messageID: nil,
                to: submitted.to,
                cc: submitted.cc,
                bcc: submitted.bcc,
                subject: submitted.subject,
                body: submitted.body,
                attachments: files,
                sendAt: nil,
                undoSeconds: undoSeconds
            )
        } catch {
            // The owner signed out while the request was out: the draft is
            // gone by their choice and nothing here may bring it back.
            guard var latest = record(for: key, ownerID: ownerID) else { return }
            switch ComposeTransportFailure(error) {
            case .rejected(let message):
                sendErrors[id] = message
            case .ambiguous(let message):
                latest.delivery = .unconfirmed(pendingID: nil)
                latest.note = "\(message) Albatross couldn’t confirm whether this was sent. Check Sent before sending again."
                records[id] = latest
                persist()
            }
            return
        }
        // Same boundary on success: a cleared owner gets no receipt, no
        // record, and no pending-send registration to undo into.
        guard var latest = record(for: key, ownerID: ownerID) else { return }
        switch submission {
        case .pending(let receipt):
            // The receipt describes the submitted content, never a later edit.
            pendingSends.register(
                receipt: receipt,
                ownerID: ownerID,
                snapshot: ComposeDraftSnapshot(
                    recipient: submitted.to,
                    cc: submitted.cc,
                    bcc: submitted.bcc,
                    subject: submitted.subject,
                    body: submitted.body,
                    mode: "new",
                    accountID: submitted.accountID,
                    threadID: nil,
                    messageID: nil,
                    replyAll: false,
                    attachmentsKey: submitted.attachmentsKey,
                    draftID: submitted.serverDraftID,
                    assistantDraftKey: id
                )
            )
            latest.delivery = .pending(id: receipt.id, fireAt: receipt.fireAt)
            latest.note = nil
        case .scheduled(let sendAt):
            latest.delivery = .scheduled(sendAt: sendAt)
            latest.note = nil
            await releaseServerCopies(of: submitted)
            latest.serverDraftID = nil
        case .sent(_, _, let messageID):
            latest.delivery = .sent(messageID: messageID)
            latest.note = nil
            await releaseServerCopies(of: submitted)
            latest.serverDraftID = nil
        case .unconfirmed:
            latest.delivery = .unconfirmed(pendingID: nil)
            latest.note = "Albatross couldn’t confirm this was sent. Check Sent before sending again."
        }
        // `releaseServerCopies` awaited; the owner may have left meanwhile.
        guard let resolvedRecord = record(for: key, ownerID: ownerID) else { return }
        latest.suggestion = resolvedRecord.suggestion
        records[id] = latest
        persist()
    }

    /// A message held for its undo window resolves through the pending-send
    /// coordinator. Reads only; a missing answer stays unconfirmed.
    func syncPendingDelivery(
        _ key: AssistantDraftKey,
        ownerID: String?,
        pendingSends: PendingSendCoordinator
    ) async {
        guard let record = record(for: key, ownerID: ownerID),
              case .pending(let pendingID, _) = record.delivery else { return }
        if pendingSends.records.contains(where: { $0.id == pendingID }) { return }
        let resolution: PendingSendResolution?
        if let known = pendingSends.resolutions[pendingID] {
            resolution = known
        } else {
            resolution = await pendingSends.confirm(pendingID: pendingID)
        }
        guard var latest = self.record(for: key, ownerID: ownerID), latest.delivery == record.delivery else { return }
        await apply(resolution, pendingID: pendingID, to: &latest)
        guard self.record(for: key, ownerID: ownerID)?.delivery == record.delivery else { return }
        records[record.id] = latest
        persist()
    }

    /// The person asked how an unconfirmed message ended. Only an artifact
    /// that still knows its receipt can be looked up; without one there is
    /// nothing to ask the server, and the answer stays "check Sent".
    func checkUnconfirmedDelivery(
        _ key: AssistantDraftKey,
        ownerID: String?,
        pendingSends: PendingSendCoordinator
    ) async {
        guard let record = record(for: key, ownerID: ownerID),
              case .unconfirmed(let pendingID?) = record.delivery else { return }
        let resolution = await pendingSends.confirm(pendingID: pendingID)
        guard var latest = self.record(for: key, ownerID: ownerID), latest.delivery == record.delivery else { return }
        await apply(resolution, pendingID: pendingID, to: &latest)
        guard self.record(for: key, ownerID: ownerID)?.delivery == record.delivery else { return }
        records[record.id] = latest
        persist()
    }

    private func apply(
        _ resolution: PendingSendResolution?,
        pendingID: String,
        to latest: inout AssistantDraftRecord
    ) async {
        switch resolution {
        case .sent:
            latest.delivery = .sent(messageID: nil)
            latest.note = nil
            await releaseServerCopies(of: latest)
            latest.serverDraftID = nil
        case .undone:
            latest.delivery = .editable
            latest.note = "Send undone. The draft is back here."
        case .cancelled:
            latest.delivery = .editable
            latest.note = "The held message was cancelled. The draft is back here."
        case .failed:
            latest.delivery = .editable
            latest.note = "The server couldn’t send this. Your draft is intact."
        case nil:
            latest.delivery = .unconfirmed(pendingID: pendingID)
            latest.note = "Albatross couldn’t confirm whether this was sent. Check Sent before sending again."
        }
    }

    private func releaseServerCopies(of record: AssistantDraftRecord) async {
        if let draftID = record.serverDraftID {
            try? await transport.deleteDraft(id: draftID)
        }
        if let storageKey = record.attachmentsKey {
            try? await attachmentStore.remove(draftID: storageKey)
        }
    }

    // MARK: - Account boundary

    func clear(ownerID: String?) async {
        let removed = records.values.filter { ownerID == nil || $0.ownerID == ownerID }
        for record in removed {
            debounceTasks[record.id]?.cancel()
            debounceTasks[record.id] = nil
            saveChains[record.id] = nil
            workChains[record.id] = nil
            pendingSaveIDs.remove(record.id)
            saveStates[record.id] = nil
            sendErrors[record.id] = nil
            records[record.id] = nil
        }
        persist()
        for record in removed {
            if let storageKey = record.attachmentsKey {
                try? await attachmentStore.remove(draftID: storageKey)
            }
        }
    }

    private func persist() {
        if records.isEmpty {
            defaults.removeObject(forKey: persistenceKey)
            return
        }
        if let data = try? JSONEncoder().encode(Array(records.values)) {
            defaults.set(data, forKey: persistenceKey)
        }
    }
}
