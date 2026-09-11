import Foundation
import Testing

@testable import Lab86Mail

// The inline email draft: one artifact per conversation + tool call, edited
// in place, sent explicitly through the shared compose transport.
@Suite("Assistant inline drafts")
struct AssistantDraftArtifactTests {
    private static let seed = AssistantDraftSeed(
        fromEmail: "me@example.com",
        to: "ari@example.com",
        cc: "",
        bcc: "",
        subject: "Lake plans",
        body: "Bring sunscreen."
    )

    private static let accounts: [AccountSummary] = [
        .object(["accountId": .string("acct-2"), "email": .string("other@example.com"), "primary": .bool(true)]),
        .object(["accountId": .string("acct-1"), "email": .string("me@example.com"), "primary": .bool(false)]),
    ].compactMap(AccountSummary.init(json:))

    private static func file(_ name: String) -> ComposeAttachment {
        ComposeAttachment(filename: name, contentType: "text/plain", data: Data(name.utf8))
    }

    @Test
    func parsesMessageDraftWithIdentityAndCopyFields() {
        let card = AssistantToolCard.parse(
            toolName: "show_message_draft",
            output: .object([
                "ok": .bool(true),
                "payload": .object([
                    "to": .strings(["ari@example.com", "sam@example.com"]),
                    "cc": .strings(["cc@example.com"]),
                    "from": .string("me@example.com"),
                    "subject": .string("Lake plans"),
                    "body": .string("Bring sunscreen."),
                ]),
            ]),
            toolCallID: "call-1"
        )
        guard case .draft(let draft) = card else {
            Issue.record("Expected a draft card")
            return
        }
        #expect(draft.toolCallID == "call-1")
        #expect(draft.to == "ari@example.com, sam@example.com")
        #expect(draft.cc == "cc@example.com")
        #expect(draft.bcc == "")
        #expect(draft.from == "me@example.com")
        #expect(draft.seed.subject == "Lake plans")
    }

    @Test @MainActor
    func streamedDraftBecomesAnArtifactThatSurvivesTranscriptRoundTrip() throws {
        let fixture = Fixture()
        defer { fixture.tearDown() }
        let model = AssistantChatModel(
            backend: BackendClient(baseURL: nil),
            baseURL: nil,
            sessionID: "session-1",
            draftStore: fixture.store,
            ownerIDProvider: { "user-1" }
        )
        let replyID = model.appendAssistantReply()
        let output: JSONValue = .object([
            "ok": .bool(true),
            "component": .string("message-draft"),
            "payload": .object([
                "to": .strings(["ari@example.com"]),
                "subject": .string("Lake plans"),
                "body": .string("Bring sunscreen."),
            ]),
        ])
        model.apply(event: .object([
            "type": .string("tool-input-available"),
            "toolCallId": .string("call-1"),
            "toolName": .string("show_message_draft"),
            "input": .object(["subject": .string("Lake plans")]),
        ]), to: replyID)
        model.apply(event: .object([
            "type": .string("tool-output-available"),
            "toolCallId": .string("call-1"),
            "output": output,
        ]), to: replyID)

        let key = AssistantDraftKey(sessionID: "session-1", toolCallID: "call-1")
        let record = try #require(fixture.store.record(for: key, ownerID: "user-1"))
        #expect(record.to == "ari@example.com")
        #expect(record.subject == "Lake plans")
        #expect(record.body == "Bring sunscreen.")
        #expect(record.delivery == .editable)

        // A second identical output (a replay) changes nothing.
        model.apply(event: .object([
            "type": .string("tool-output-available"),
            "toolCallId": .string("call-1"),
            "output": output,
        ]), to: replyID)
        #expect(fixture.store.record(for: key, ownerID: "user-1") == record)

        // The saved transcript carries the card, and restoring it yields the
        // same tool call identity, so reopening the chat finds the same draft.
        let transcript = model.transcriptJSON()
        let assistant = try #require(transcript.arrayValue?.first { $0["role"]?.stringValue == "assistant" })
        let toolPart = try #require(assistant["parts"]?.arrayValue?.first { $0["type"]?.stringValue == "dynamic-tool" })
        #expect(toolPart["toolCallId"]?.stringValue == "call-1")
        #expect(toolPart["state"]?.stringValue == "output-available")
        let restored = try #require(AssistantChatModel.message(from: assistant))
        guard case .toolRow(let row)? = restored.parts.first, case .draft(let restoredDraft)? = row.card else {
            Issue.record("Expected the restored message to carry the draft card")
            return
        }
        #expect(restoredDraft.toolCallID == "call-1")
        #expect(row.cardSource?.toolCallID == "call-1")
        #expect(AssistantDraftKey(sessionID: "session-1", toolCallID: restoredDraft.toolCallID ?? "") == key)
    }

    @Test @MainActor
    func replayedAgentOutputNeverOverwritesTyping() {
        let fixture = Fixture()
        defer { fixture.tearDown() }
        let key = AssistantDraftKey(sessionID: "s", toolCallID: "c")
        fixture.store.receive(Self.seed, key: key, ownerID: "user-1")
        fixture.store.update(key, ownerID: "user-1") { $0.body = "My own words." }

        fixture.store.receive(Self.seed, key: key, ownerID: "user-1")
        var record = fixture.store.record(for: key, ownerID: "user-1")
        #expect(record?.body == "My own words.")
        #expect(record?.suggestion == nil)
        #expect(record?.isEdited == true)

        var revision = Self.seed
        revision.body = "Shorter."
        fixture.store.receive(revision, key: key, ownerID: "user-1")
        record = fixture.store.record(for: key, ownerID: "user-1")
        #expect(record?.body == "My own words.")
        #expect(record?.suggestion == revision)

        fixture.store.dismissSuggestion(key, ownerID: "user-1")
        #expect(fixture.store.record(for: key, ownerID: "user-1")?.suggestion == nil)

        fixture.store.receive(revision, key: key, ownerID: "user-1")
        fixture.store.applySuggestion(key, ownerID: "user-1")
        record = fixture.store.record(for: key, ownerID: "user-1")
        #expect(record?.body == "Shorter.")
        #expect(record?.suggestion == nil)
        #expect(record?.isEdited == false)

        // The original card replays on every render; it never comes back as
        // a suggestion once a revision was accepted.
        fixture.store.receive(Self.seed, key: key, ownerID: "user-1")
        #expect(fixture.store.record(for: key, ownerID: "user-1")?.suggestion == nil)
    }

    @Test @MainActor
    func draftsPersistAcrossRelaunchAndStayPerOwner() async {
        let fixture = Fixture()
        defer { fixture.tearDown() }
        let key = AssistantDraftKey(sessionID: "s", toolCallID: "c")
        fixture.store.receive(Self.seed, key: key, ownerID: "user-1")
        fixture.store.update(key, ownerID: "user-1") { $0.subject = "Edited subject" }

        let relaunched = fixture.makeStore()
        #expect(relaunched.record(for: key, ownerID: "user-1")?.subject == "Edited subject")
        #expect(relaunched.record(for: key, ownerID: "user-2") == nil)
        #expect(relaunched.record(for: key, ownerID: nil) == nil)

        relaunched.update(key, ownerID: "user-2") { $0.subject = "Should not apply" }
        #expect(relaunched.record(for: key, ownerID: "user-1")?.subject == "Edited subject")

        await relaunched.clear(ownerID: "user-1")
        #expect(fixture.makeStore().record(for: key, ownerID: "user-1") == nil)
    }

    @Test @MainActor
    func serverDraftSaveKeepsOneIdentityAndNeverRewritesText() async {
        let fixture = Fixture()
        defer { fixture.tearDown() }
        let key = AssistantDraftKey(sessionID: "s", toolCallID: "c")
        fixture.store.receive(Self.seed, key: key, ownerID: "user-1")
        fixture.store.resolveAccountIfNeeded(key, ownerID: "user-1", accounts: Self.accounts)
        // The agent's `from` wins over the primary account.
        #expect(fixture.store.record(for: key, ownerID: "user-1")?.accountID == "acct-1")

        await fixture.store.flushSaves(for: key)
        #expect(fixture.transport.saveCalls.first?.id == nil)
        #expect(fixture.store.record(for: key, ownerID: "user-1")?.serverDraftID == "draft-1")
        if case .saved = fixture.store.saveState(for: key) {} else {
            Issue.record("Expected a saved state, got \(fixture.store.saveState(for: key))")
        }

        fixture.store.update(key, ownerID: "user-1") { $0.body = "Typed after the first save." }
        await fixture.store.flushSaves(for: key)
        #expect(fixture.transport.saveCalls.last?.id == "draft-1")
        #expect(fixture.transport.saveCalls.last?.body == "Typed after the first save.")

        fixture.transport.saveResult = .failure(StubFailure.offline)
        fixture.store.update(key, ownerID: "user-1") { $0.body = "Kept even when saving fails." }
        await fixture.store.flushSaves(for: key)
        if case .failed = fixture.store.saveState(for: key) {} else {
            Issue.record("Expected a failed save state")
        }
        #expect(fixture.store.record(for: key, ownerID: "user-1")?.body == "Kept even when saving fails.")
        #expect(fixture.store.record(for: key, ownerID: "user-1")?.serverDraftID == "draft-1")
    }

    @Test @MainActor
    func sendRejectsDuplicateTapsAndConfirmsOnlyAnExplicitSentResult() async {
        let fixture = Fixture()
        defer { fixture.tearDown() }
        let key = AssistantDraftKey(sessionID: "s", toolCallID: "c")
        fixture.store.receive(Self.seed, key: key, ownerID: "user-1")
        fixture.store.resolveAccountIfNeeded(key, ownerID: "user-1", accounts: Self.accounts)
        fixture.transport.holdSends = true
        fixture.transport.sendResult = .success(.sent(accountID: "acct-1", threadID: nil, messageID: "m-1"))

        let store = fixture.store
        let pendingSends = fixture.pendingSends
        let first = Task { @MainActor in
            await store.send(key, ownerID: "user-1", pendingSends: pendingSends, undoSeconds: 0)
        }
        await fixture.transport.waitForSendStart()
        #expect(store.isSending(key))
        await store.send(key, ownerID: "user-1", pendingSends: pendingSends, undoSeconds: 0)
        fixture.transport.releaseSends()
        await first.value

        #expect(fixture.transport.sendCalls.count == 1)
        #expect(store.record(for: key, ownerID: "user-1")?.delivery == .sent(messageID: "m-1"))
        #expect(!store.isSending(key))

        // A sent artifact is closed: more taps and more agent output do nothing.
        await store.send(key, ownerID: "user-1", pendingSends: pendingSends, undoSeconds: 0)
        #expect(fixture.transport.sendCalls.count == 1)
        store.update(key, ownerID: "user-1") { $0.body = "late edit" }
        #expect(store.record(for: key, ownerID: "user-1")?.body == Self.seed.body)
    }

    // While the request is in flight nothing the view can issue changes the
    // artifact, and the receipt describes exactly what went out.
    @Test @MainActor
    func inFlightSendLocksEveryMutationAndTheReceiptDescribesWhatWasSent() async throws {
        let fixture = Fixture()
        defer { fixture.tearDown() }
        let key = AssistantDraftKey(sessionID: "s", toolCallID: "c")
        let store = fixture.store
        let pendingSends = fixture.pendingSends
        store.receive(Self.seed, key: key, ownerID: "user-1")
        store.resolveAccountIfNeeded(key, ownerID: "user-1", accounts: Self.accounts)
        await store.addAttachments([Self.file("agenda.txt")], to: key, ownerID: "user-1")
        await store.flushSaves(for: key)
        let before = try #require(store.record(for: key, ownerID: "user-1"))
        let storageKey = try #require(before.attachmentsKey)
        #expect(before.attachments.map(\.filename) == ["agenda.txt"])
        #expect(before.serverDraftID == "draft-1")
        #expect(store.canEdit(key, ownerID: "user-1"))

        let fireAt = Date().addingTimeInterval(10)
        fixture.transport.holdSends = true
        fixture.transport.sendResult = .success(.pending(
            PendingSendReceipt(id: "pending-1", fireAt: fireAt, undoSeconds: 10, accountID: "acct-1", threadID: nil)
        ))
        let sending = Task { @MainActor in
            await store.send(key, ownerID: "user-1", pendingSends: pendingSends, undoSeconds: 10)
        }
        await fixture.transport.waitForSendStart()
        #expect(store.isSending(key))
        #expect(!store.canEdit(key, ownerID: "user-1"))

        // Everything the artifact's controls can do, attempted mid-flight.
        store.update(key, ownerID: "user-1") { $0.body = "Typed while sending." }
        store.update(key, ownerID: "user-1") { $0.subject = "Changed subject" }
        store.update(key, ownerID: "user-1") { $0.to = "someone-else@example.com" }
        store.update(key, ownerID: "user-1") { $0.cc = "cc@example.com" }
        store.update(key, ownerID: "user-1") { $0.accountID = "acct-2" }
        var revision = Self.seed
        revision.body = "Agent revision while sending."
        store.receive(revision, key: key, ownerID: "user-1")
        store.applySuggestion(key, ownerID: "user-1")
        store.dismissSuggestion(key, ownerID: "user-1")
        await store.addAttachments([Self.file("late.txt")], to: key, ownerID: "user-1")
        await store.removeAttachment(at: 0, from: key, ownerID: "user-1")
        store.resumeEditing(key, ownerID: "user-1")

        let locked = try #require(store.record(for: key, ownerID: "user-1"))
        #expect(locked.to == before.to)
        #expect(locked.cc == before.cc)
        #expect(locked.subject == before.subject)
        #expect(locked.body == before.body)
        #expect(locked.accountID == "acct-1")
        #expect(locked.attachments == before.attachments)
        #expect(locked.attachmentsKey == storageKey)
        #expect(locked.serverDraftID == "draft-1")
        #expect(locked.delivery == .editable)
        // The revision waits as a suggestion instead of touching the text.
        #expect(locked.suggestion == revision)
        let onDisk = try await fixture.attachments.loadComposeAttachments(draftID: storageKey)
        #expect(onDisk.map(\.filename) == ["agenda.txt"])

        fixture.transport.releaseSends()
        await sending.value

        let call = try #require(fixture.transport.sendCalls.first)
        #expect(fixture.transport.sendCalls.count == 1)
        #expect(call.accountID == "acct-1")
        #expect(call.to == Self.seed.to)
        #expect(call.cc == "")
        #expect(call.subject == Self.seed.subject)
        #expect(call.body == Self.seed.body)
        #expect(call.attachments == ["agenda.txt"])

        let after = try #require(store.record(for: key, ownerID: "user-1"))
        #expect(after.delivery == .pending(id: "pending-1", fireAt: fireAt))
        #expect(after.body == Self.seed.body)
        #expect(after.subject == Self.seed.subject)
        #expect(after.accountID == "acct-1")
        #expect(!store.canEdit(key, ownerID: "user-1"))

        let held = try #require(pendingSends.records.first { $0.id == "pending-1" })
        #expect(held.ownerID == "user-1")
        #expect(held.snapshot.recipient == Self.seed.to)
        #expect(held.snapshot.cc == "")
        #expect(held.snapshot.subject == Self.seed.subject)
        #expect(held.snapshot.body == Self.seed.body)
        #expect(held.snapshot.accountID == "acct-1")
        #expect(held.snapshot.attachmentsKey == storageKey)
        #expect(held.snapshot.draftID == "draft-1")
        #expect(held.snapshot.assistantDraftKey == key.storageID)

        // Held is still closed to edits.
        store.update(key, ownerID: "user-1") { $0.body = "After the receipt." }
        #expect(store.record(for: key, ownerID: "user-1")?.body == Self.seed.body)
    }

    @Test @MainActor
    func rejectedSendRestoresEditabilityWithTheOriginalContents() async throws {
        let fixture = Fixture()
        defer { fixture.tearDown() }
        let key = AssistantDraftKey(sessionID: "s", toolCallID: "c")
        let store = fixture.store
        let pendingSends = fixture.pendingSends
        store.receive(Self.seed, key: key, ownerID: "user-1")
        store.resolveAccountIfNeeded(key, ownerID: "user-1", accounts: Self.accounts)
        store.update(key, ownerID: "user-1") { $0.body = "Final wording." }
        fixture.transport.holdSends = true
        fixture.transport.sendResult = .failure(BackendError.server(status: 422, message: "Recipient rejected."))

        let sending = Task { @MainActor in
            await store.send(key, ownerID: "user-1", pendingSends: pendingSends, undoSeconds: 10)
        }
        await fixture.transport.waitForSendStart()
        store.update(key, ownerID: "user-1") { $0.body = "Typed while sending." }
        store.update(key, ownerID: "user-1") { $0.accountID = "acct-2" }
        await store.send(key, ownerID: "user-1", pendingSends: pendingSends, undoSeconds: 10)
        fixture.transport.releaseSends()
        await sending.value

        #expect(fixture.transport.sendCalls.count == 1)
        #expect(store.sendError(for: key) == "Recipient rejected.")
        let record = try #require(store.record(for: key, ownerID: "user-1"))
        #expect(record.delivery == .editable)
        #expect(record.body == "Final wording.")
        #expect(record.accountID == "acct-1")
        #expect(pendingSends.records.isEmpty)
        #expect(store.canEdit(key, ownerID: "user-1"))

        // Editing works again, and only an explicit tap sends.
        store.update(key, ownerID: "user-1") { $0.body = "Second attempt." }
        #expect(store.record(for: key, ownerID: "user-1")?.body == "Second attempt.")
        #expect(fixture.transport.sendCalls.count == 1)
    }

    // The true in-flight boundary: an attachment operation that passed its
    // lock check and is writing the file when Send is tapped. The send waits
    // behind it; the operation commits its chips; the transmitted content,
    // the chips, the receipt, and the file on disk all agree.
    @Test @MainActor
    func attachmentAddBegunBeforeSendCommitsAndIsWhatGoesOut() async throws {
        let gate = GatedAttachmentStore()
        let fixture = Fixture(attachmentStore: gate)
        defer { fixture.tearDown() }
        let key = AssistantDraftKey(sessionID: "s", toolCallID: "c")
        let store = fixture.store
        let pendingSends = fixture.pendingSends
        store.receive(Self.seed, key: key, ownerID: "user-1")
        store.resolveAccountIfNeeded(key, ownerID: "user-1", accounts: Self.accounts)
        await store.flushSaves(for: key)
        #expect(store.record(for: key, ownerID: "user-1")?.attachmentsKey == nil)

        gate.holdSaves = true
        let adding = Task { @MainActor in
            await store.addAttachments([Self.file("agenda.txt")], to: key, ownerID: "user-1")
        }
        await gate.waitForSaveStart()
        // The add has begun (lock check passed, file being written); no chip yet.
        #expect(store.record(for: key, ownerID: "user-1")?.attachments.isEmpty == true)

        let fireAt = Date().addingTimeInterval(10)
        fixture.transport.sendResult = .success(.pending(
            PendingSendReceipt(id: "pending-1", fireAt: fireAt, undoSeconds: 10, accountID: "acct-1", threadID: nil)
        ))
        let sending = Task { @MainActor in
            await store.send(key, ownerID: "user-1", pendingSends: pendingSends, undoSeconds: 10)
        }
        await settle { store.isSending(key) }
        #expect(store.isSending(key))
        #expect(!store.canEdit(key, ownerID: "user-1"))
        // New edits and a second attachment operation are refused from the tap.
        store.update(key, ownerID: "user-1") { $0.body = "Typed after the tap." }
        await store.addAttachments([Self.file("late.txt")], to: key, ownerID: "user-1")
        #expect(fixture.transport.sendCalls.isEmpty)

        gate.releaseSaves()
        await adding.value
        await sending.value

        let record = try #require(store.record(for: key, ownerID: "user-1"))
        let storageKey = try #require(record.attachmentsKey)
        #expect(record.attachments.map(\.filename) == ["agenda.txt"])
        #expect(record.body == Self.seed.body)
        #expect(record.delivery == .pending(id: "pending-1", fireAt: fireAt))
        let call = try #require(fixture.transport.sendCalls.first)
        #expect(fixture.transport.sendCalls.count == 1)
        #expect(call.attachments == ["agenda.txt"])
        let held = try #require(pendingSends.records.first { $0.id == "pending-1" })
        #expect(held.snapshot.attachmentsKey == storageKey)
        // Exactly one file on disk, the one the chip and the receipt name.
        let persistedAttachments = try await fixture.attachments.loadComposeAttachments(draftID: storageKey)
        #expect(persistedAttachments.map(\.filename) == ["agenda.txt"])
        #expect(fixture.attachmentFileCount() == 1)
    }

    @Test @MainActor
    func attachmentRemovalBegunBeforeSendCommitsAndIsNotTransmitted() async throws {
        let gate = GatedAttachmentStore()
        let fixture = Fixture(attachmentStore: gate)
        defer { fixture.tearDown() }
        let key = AssistantDraftKey(sessionID: "s", toolCallID: "c")
        let store = fixture.store
        let pendingSends = fixture.pendingSends
        store.receive(Self.seed, key: key, ownerID: "user-1")
        store.resolveAccountIfNeeded(key, ownerID: "user-1", accounts: Self.accounts)
        await store.addAttachments([Self.file("a.txt"), Self.file("b.txt")], to: key, ownerID: "user-1")
        let storageKey = try #require(store.record(for: key, ownerID: "user-1")?.attachmentsKey)

        gate.holdSaves = true
        let removing = Task { @MainActor in
            await store.removeAttachment(at: 0, from: key, ownerID: "user-1")
        }
        await gate.waitForSaveStart()
        // Still visible while the file is being rewritten.
        #expect(store.record(for: key, ownerID: "user-1")?.attachments.map(\.filename) == ["a.txt", "b.txt"])

        fixture.transport.sendResult = .success(.sent(accountID: "acct-1", threadID: nil, messageID: "m-1"))
        let sending = Task { @MainActor in
            await store.send(key, ownerID: "user-1", pendingSends: pendingSends, undoSeconds: 0)
        }
        await settle { store.isSending(key) }
        #expect(store.isSending(key))
        #expect(fixture.transport.sendCalls.isEmpty)

        gate.releaseSaves()
        await removing.value
        await sending.value

        let call = try #require(fixture.transport.sendCalls.first)
        #expect(fixture.transport.sendCalls.count == 1)
        #expect(call.attachments == ["b.txt"])
        let record = try #require(store.record(for: key, ownerID: "user-1"))
        #expect(record.delivery == .sent(messageID: "m-1"))
        #expect(record.attachments.map(\.filename) == ["b.txt"])
        // A confirmed send releases the file; nothing is left behind.
        let releasedAttachments = try await fixture.attachments.loadComposeAttachments(draftID: storageKey)
        #expect(releasedAttachments.isEmpty)
        #expect(fixture.attachmentFileCount() == 0)
    }

    // Signing out while the request is out: the owner's choice stands. The
    // outcome writes nothing back and registers no receipt to undo into.
    @Test @MainActor
    func signOutDuringAnInFlightSendResurrectsNothing() async throws {
        let fixture = Fixture()
        defer { fixture.tearDown() }
        let key = AssistantDraftKey(sessionID: "s", toolCallID: "c")
        let store = fixture.store
        let pendingSends = fixture.pendingSends
        store.receive(Self.seed, key: key, ownerID: "user-1")
        store.resolveAccountIfNeeded(key, ownerID: "user-1", accounts: Self.accounts)
        await store.addAttachments([Self.file("agenda.txt")], to: key, ownerID: "user-1")
        fixture.transport.holdSends = true
        fixture.transport.sendResult = .success(.pending(
            PendingSendReceipt(id: "pending-1", fireAt: Date().addingTimeInterval(10), undoSeconds: 10, accountID: "acct-1", threadID: nil)
        ))
        let sending = Task { @MainActor in
            await store.send(key, ownerID: "user-1", pendingSends: pendingSends, undoSeconds: 10)
        }
        await fixture.transport.waitForSendStart()

        await store.clear(ownerID: "user-1")
        await pendingSends.clear(ownerID: "user-1")
        fixture.transport.releaseSends()
        await sending.value

        #expect(store.record(for: key, ownerID: "user-1") == nil)
        #expect(fixture.makeStore().record(for: key, ownerID: "user-1") == nil)
        #expect(pendingSends.records.isEmpty)
        #expect(!store.isSending(key))
        #expect(fixture.attachmentFileCount() == 0)
    }

    @Test @MainActor
    func ambiguousTransportFailureStaysUnconfirmedAndNeverRetries() async throws {
        let fixture = Fixture()
        defer { fixture.tearDown() }
        let key = AssistantDraftKey(sessionID: "s", toolCallID: "c")
        let store = fixture.store
        let pendingSends = fixture.pendingSends
        store.receive(Self.seed, key: key, ownerID: "user-1")
        store.resolveAccountIfNeeded(key, ownerID: "user-1", accounts: Self.accounts)
        store.update(key, ownerID: "user-1") { $0.body = "Final wording." }
        fixture.transport.sendResult = .failure(URLError(.timedOut))

        await store.send(key, ownerID: "user-1", pendingSends: pendingSends, undoSeconds: 10)

        let record = try #require(store.record(for: key, ownerID: "user-1"))
        #expect(record.delivery == .unconfirmed(pendingID: nil))
        #expect(record.body == "Final wording.")
        #expect(record.note?.contains("Check Sent") == true)
        #expect(store.sendError(for: key) == nil)
        #expect(fixture.transport.sendCalls.count == 1)
        #expect(fixture.transport.deletedDraftIDs.isEmpty)

        // Closed until the person decides: no second send, no edits, and
        // nothing to look up without a receipt.
        await store.send(key, ownerID: "user-1", pendingSends: pendingSends, undoSeconds: 10)
        store.update(key, ownerID: "user-1") { $0.body = "Should not apply." }
        await store.checkUnconfirmedDelivery(key, ownerID: "user-1", pendingSends: pendingSends)
        #expect(fixture.transport.sendCalls.count == 1)
        #expect(store.record(for: key, ownerID: "user-1")?.delivery == .unconfirmed(pendingID: nil))
        #expect(store.record(for: key, ownerID: "user-1")?.body == "Final wording.")

        store.resumeEditing(key, ownerID: "user-1")
        #expect(store.record(for: key, ownerID: "user-1")?.delivery == .editable)
        #expect(store.record(for: key, ownerID: "user-1")?.note == nil)
        fixture.transport.sendResult = .success(.sent(accountID: "acct-1", threadID: nil, messageID: "m-2"))
        await store.send(key, ownerID: "user-1", pendingSends: pendingSends, undoSeconds: 10)
        #expect(fixture.transport.sendCalls.count == 2)
        #expect(store.record(for: key, ownerID: "user-1")?.delivery == .sent(messageID: "m-2"))
    }

    @Test
    func transportFailuresAreOnlyDefinitiveBeforeTheRequestCouldReachTheServer() {
        #expect(ComposeTransportFailure(BackendError.server(status: 400, message: "Bad recipient.")) == .rejected("Bad recipient."))
        #expect(ComposeTransportFailure(BackendError.unauthorized) == .rejected(BackendError.unauthorized.localizedDescription))
        #expect(ComposeTransportFailure(BackendError.configuration) == .rejected(BackendError.configuration.localizedDescription))
        #expect(ComposeTransportFailure(SessionAuthenticationError.tokenUnavailable) == .rejected(SessionAuthenticationError.tokenUnavailable.localizedDescription))
        #expect(ComposeTransportFailure(URLError(.notConnectedToInternet)) == .rejected(URLError(.notConnectedToInternet).localizedDescription))
        #expect(ComposeTransportFailure(URLError(.cannotConnectToHost)) == .rejected(URLError(.cannotConnectToHost).localizedDescription))

        #expect(ComposeTransportFailure(URLError(.timedOut)) == .ambiguous(URLError(.timedOut).localizedDescription))
        #expect(ComposeTransportFailure(URLError(.networkConnectionLost)) == .ambiguous(URLError(.networkConnectionLost).localizedDescription))
        #expect(ComposeTransportFailure(BackendError.server(status: 502, message: "Bad gateway")) == .ambiguous("Bad gateway"))
        #expect(ComposeTransportFailure(BackendError.invalidResponse) == .ambiguous(BackendError.invalidResponse.localizedDescription))
        #expect(ComposeTransportFailure(StubFailure.offline) == .ambiguous(StubFailure.offline.localizedDescription))
    }

    @Test @MainActor
    func sendFailurePreservesTheDraftAndDoesNotRetry() async {
        let fixture = Fixture()
        defer { fixture.tearDown() }
        let key = AssistantDraftKey(sessionID: "s", toolCallID: "c")
        fixture.store.receive(Self.seed, key: key, ownerID: "user-1")
        fixture.store.resolveAccountIfNeeded(key, ownerID: "user-1", accounts: Self.accounts)
        fixture.store.update(key, ownerID: "user-1") { $0.body = "Final wording." }
        fixture.transport.sendResult = .failure(BackendError.server(status: 400, message: "Missing recipient."))

        await fixture.store.send(key, ownerID: "user-1", pendingSends: fixture.pendingSends, undoSeconds: 10)

        #expect(fixture.transport.sendCalls.count == 1)
        #expect(fixture.store.sendError(for: key) == "Missing recipient.")
        let record = fixture.store.record(for: key, ownerID: "user-1")
        #expect(record?.delivery == .editable)
        #expect(record?.body == "Final wording.")
        #expect(fixture.pendingSends.records.isEmpty)
    }

    @Test @MainActor
    func unconfirmedSubmissionIsNeverCalledSent() async {
        let fixture = Fixture()
        defer { fixture.tearDown() }
        let key = AssistantDraftKey(sessionID: "s", toolCallID: "c")
        fixture.store.receive(Self.seed, key: key, ownerID: "user-1")
        fixture.store.resolveAccountIfNeeded(key, ownerID: "user-1", accounts: Self.accounts)
        await fixture.store.flushSaves(for: key)
        fixture.transport.sendResult = .success(.unconfirmed)

        await fixture.store.send(key, ownerID: "user-1", pendingSends: fixture.pendingSends, undoSeconds: 0)

        let record = fixture.store.record(for: key, ownerID: "user-1")
        #expect(record?.delivery == .unconfirmed(pendingID: nil))
        #expect(record?.serverDraftID == "draft-1")
        #expect(fixture.transport.deletedDraftIDs.isEmpty)
        #expect(fixture.transport.sendCalls.count == 1)

        // Only the person reopens it for editing.
        await fixture.store.send(key, ownerID: "user-1", pendingSends: fixture.pendingSends, undoSeconds: 0)
        #expect(fixture.transport.sendCalls.count == 1)
        fixture.store.resumeEditing(key, ownerID: "user-1")
        #expect(fixture.store.record(for: key, ownerID: "user-1")?.delivery == .editable)
    }

    @Test @MainActor
    func pendingSendRegistersTheReceiptAndAnUnreachableStatusStaysUnconfirmed() async {
        let fixture = Fixture()
        defer { fixture.tearDown() }
        let key = AssistantDraftKey(sessionID: "s", toolCallID: "c")
        fixture.store.receive(Self.seed, key: key, ownerID: "user-1")
        fixture.store.resolveAccountIfNeeded(key, ownerID: "user-1", accounts: Self.accounts)
        let fireAt = Date().addingTimeInterval(10)
        fixture.transport.sendResult = .success(.pending(
            PendingSendReceipt(id: "pending-1", fireAt: fireAt, undoSeconds: 10, accountID: "acct-1", threadID: nil)
        ))

        await fixture.store.send(key, ownerID: "user-1", pendingSends: fixture.pendingSends, undoSeconds: 10)

        #expect(fixture.store.record(for: key, ownerID: "user-1")?.delivery == .pending(id: "pending-1", fireAt: fireAt))
        let held = fixture.pendingSends.records.first { $0.id == "pending-1" }
        #expect(held?.ownerID == "user-1")
        #expect(held?.snapshot.assistantDraftKey == key.storageID)
        #expect(held?.snapshot.subject == Self.seed.subject)

        // While the coordinator still holds the receipt nothing changes.
        await fixture.store.syncPendingDelivery(key, ownerID: "user-1", pendingSends: fixture.pendingSends)
        #expect(fixture.store.record(for: key, ownerID: "user-1")?.delivery == .pending(id: "pending-1", fireAt: fireAt))

        // The receipt is gone and the server cannot be asked: that is not a
        // send, but the receipt id stays so the person can ask again.
        await fixture.pendingSends.clear(ownerID: "user-1")
        await fixture.store.syncPendingDelivery(key, ownerID: "user-1", pendingSends: fixture.pendingSends)
        #expect(fixture.store.record(for: key, ownerID: "user-1")?.delivery == .unconfirmed(pendingID: "pending-1"))
        await fixture.store.checkUnconfirmedDelivery(key, ownerID: "user-1", pendingSends: fixture.pendingSends)
        #expect(fixture.store.record(for: key, ownerID: "user-1")?.delivery == .unconfirmed(pendingID: "pending-1"))
        #expect(fixture.transport.sendCalls.count == 1)
    }

    // The held message's outcome comes from the server through the real
    // coordinator paths (`/api/compose/status`, `/api/compose/undo`).
    @Test @MainActor
    func heldMessageReportedSentByTheServerClosesTheArtifact() async throws {
        let server = StubBackendServer()
        server.routes["/api/compose/status"] = .object(["status": .string("sent")])
        server.routes["/api/tools/delete_draft"] = .object(["ok": .bool(true), "result": .object([:])])
        let fixture = Fixture(backend: server.backend)
        defer {
            fixture.tearDown()
            server.tearDown()
        }
        let key = AssistantDraftKey(sessionID: "s", toolCallID: "c")
        let store = fixture.store
        let pendingSends = fixture.pendingSends
        store.receive(Self.seed, key: key, ownerID: "user-1")
        store.resolveAccountIfNeeded(key, ownerID: "user-1", accounts: Self.accounts)
        await store.flushSaves(for: key)
        let fireAt = Date().addingTimeInterval(-1)
        fixture.transport.sendResult = .success(.pending(
            PendingSendReceipt(id: "pending-1", fireAt: fireAt, undoSeconds: 10, accountID: "acct-1", threadID: nil)
        ))
        await store.send(key, ownerID: "user-1", pendingSends: pendingSends, undoSeconds: 10)
        #expect(store.record(for: key, ownerID: "user-1")?.delivery == .pending(id: "pending-1", fireAt: fireAt))

        await pendingSends.reconcile(ownerID: "user-1")
        #expect(pendingSends.records.isEmpty)
        #expect(pendingSends.resolutions["pending-1"] == .sent)
        #expect(server.requests.contains { $0.hasPrefix("/api/compose/status?pendingId=pending-1") })

        await store.syncPendingDelivery(key, ownerID: "user-1", pendingSends: pendingSends)
        let record = try #require(store.record(for: key, ownerID: "user-1"))
        #expect(record.delivery == .sent(messageID: nil))
        #expect(record.serverDraftID == nil)
        #expect(!store.canEdit(key, ownerID: "user-1"))
        #expect(fixture.transport.sendCalls.count == 1)
    }

    @Test @MainActor
    func undoSendReturnsTheHeldMessageToTheArtifactForEditing() async throws {
        let server = StubBackendServer()
        server.routes["/api/compose/undo"] = .object(["undone": .bool(true)])
        let fixture = Fixture(backend: server.backend)
        defer {
            fixture.tearDown()
            server.tearDown()
        }
        let key = AssistantDraftKey(sessionID: "s", toolCallID: "c")
        let store = fixture.store
        let pendingSends = fixture.pendingSends
        store.receive(Self.seed, key: key, ownerID: "user-1")
        store.resolveAccountIfNeeded(key, ownerID: "user-1", accounts: Self.accounts)
        let fireAt = Date().addingTimeInterval(10)
        fixture.transport.sendResult = .success(.pending(
            PendingSendReceipt(id: "pending-1", fireAt: fireAt, undoSeconds: 10, accountID: "acct-1", threadID: nil)
        ))
        await store.send(key, ownerID: "user-1", pendingSends: pendingSends, undoSeconds: 10)
        let held = try #require(pendingSends.records.first { $0.id == "pending-1" })

        let prefill = await pendingSends.undo(held)
        #expect(prefill != nil)
        #expect(pendingSends.resolutions["pending-1"] == .undone)
        #expect(server.requests.contains("/api/compose/undo"))

        await store.syncPendingDelivery(key, ownerID: "user-1", pendingSends: pendingSends)
        let record = try #require(store.record(for: key, ownerID: "user-1"))
        #expect(record.delivery == .editable)
        #expect(record.note == "Send undone. The draft is back here.")
        #expect(record.body == Self.seed.body)
        #expect(store.canEdit(key, ownerID: "user-1"))

        // The person edits and sends again; only that tap reaches the transport.
        store.update(key, ownerID: "user-1") { $0.body = "Second wording." }
        #expect(fixture.transport.sendCalls.count == 1)
        fixture.transport.sendResult = .success(.sent(accountID: "acct-1", threadID: nil, messageID: "m-2"))
        await store.send(key, ownerID: "user-1", pendingSends: pendingSends, undoSeconds: 10)
        #expect(fixture.transport.sendCalls.count == 2)
        #expect(fixture.transport.sendCalls.last?.body == "Second wording.")
        #expect(store.record(for: key, ownerID: "user-1")?.delivery == .sent(messageID: "m-2"))
    }

    @Test
    func composeSubmissionRequiresAnExplicitSentObject() {
        let sent = ComposeSubmission.parse(
            .object(["ok": .bool(true), "sent": .object(["account": .string("a"), "messageId": .string("m")])]),
            accountID: "fallback",
            threadID: nil,
            undoSeconds: 0
        )
        #expect(sent == .sent(accountID: "a", threadID: nil, messageID: "m"))

        let pending = ComposeSubmission.parse(
            .object(["ok": .bool(true), "pending": .object(["id": .string("p"), "fireAt": .number(1_000)])]),
            accountID: "a",
            threadID: nil,
            undoSeconds: 7
        )
        guard case .pending(let receipt) = pending else {
            Issue.record("Expected a pending receipt")
            return
        }
        #expect(receipt.id == "p")
        #expect(receipt.undoSeconds == 7)

        let scheduled = ComposeSubmission.parse(
            .object(["ok": .bool(true), "scheduled": .object(["sendAt": .number(2_000)])]),
            accountID: "a",
            threadID: nil,
            undoSeconds: 0
        )
        #expect(scheduled == .scheduled(sendAt: Date(timeIntervalSince1970: 2)))

        #expect(ComposeSubmission.parse(.object(["ok": .bool(true)]), accountID: "a", threadID: nil, undoSeconds: 0) == .unconfirmed)
        #expect(ComposeSubmission.parse(.object(["ok": .bool(true), "sent": .bool(true)]), accountID: "a", threadID: nil, undoSeconds: 0) == .unconfirmed)
        #expect(ComposeSubmission.parse(.object(["ok": .bool(false), "sent": .object([:])]), accountID: "a", threadID: nil, undoSeconds: 0) == .unconfirmed)
        #expect(ComposeSubmission.parse(.null, accountID: "a", threadID: nil, undoSeconds: 0) == .unconfirmed)
    }

    @Test @MainActor
    func anEmptyFieldKeepsTheRouteThePersonChose() {
        let model = AssistantChatModel(backend: BackendClient(baseURL: nil), baseURL: nil)
        #expect(model.route == .ask)
        model.flipRoute()
        #expect(model.route == .hold)
        #expect(model.routePinned)
        model.updateDraft("")
        #expect(model.route == .hold)
        model.updateDraft("   ")
        #expect(model.route == .hold)
        model.clearRoute()
        #expect(model.route == .ask)
        #expect(!model.routePinned)
        // Without a pin, an emptied field returns to Ask.
        model.presetRoute(.hold)
        model.clearRoute()
        model.updateDraft("")
        #expect(model.route == .ask)
    }

    @Test @MainActor
    func fromAccountChangeNeverReusesAnotherMailboxesServerDraft() async throws {
        let fixture = Fixture()
        defer { fixture.tearDown() }
        let key = AssistantDraftKey(sessionID: "from-change", toolCallID: "draft")
        fixture.store.receive(Self.seed, key: key, ownerID: "user-1")
        fixture.store.resolveAccountIfNeeded(key, ownerID: "user-1", accounts: Self.accounts)
        await fixture.store.flushSaves(for: key)
        #expect(fixture.store.record(for: key, ownerID: "user-1")?.serverDraftID == "draft-1")
        fixture.store.update(key, ownerID: "user-1") { $0.accountID = "acct-2" }
        #expect(fixture.store.record(for: key, ownerID: "user-1")?.serverDraftID == nil)
        await fixture.store.flushSaves(for: key)
        let saved = try #require(fixture.transport.saveCalls.last)
        #expect(saved.accountID == "acct-2")
        #expect(saved.id == nil)
    }

    @Test @MainActor
    func aiSuggestionDuringAttachmentReadDoesNotCancelExplicitSend() async {
        let gate = GatedAttachmentStore()
        let fixture = Fixture(attachmentStore: gate)
        defer { fixture.tearDown() }
        let key = AssistantDraftKey(sessionID: "suggestion-race", toolCallID: "draft")
        fixture.store.receive(Self.seed, key: key, ownerID: "user-1")
        fixture.store.resolveAccountIfNeeded(key, ownerID: "user-1", accounts: Self.accounts)
        await fixture.store.addAttachments([Self.file("notes.txt")], to: key, ownerID: "user-1")
        var revision = Self.seed
        revision.body = "A newer suggested wording."
        gate.onLoad = { fixture.store.receive(revision, key: key, ownerID: "user-1") }
        fixture.transport.sendResult = .success(.sent(accountID: "acct-1", threadID: nil, messageID: "message"))
        await fixture.store.send(key, ownerID: "user-1", pendingSends: fixture.pendingSends, undoSeconds: 0)
        gate.onLoad = nil
        #expect(fixture.transport.sendCalls.count == 1)
        #expect(fixture.transport.sendCalls.first?.body == Self.seed.body)
        #expect(fixture.store.record(for: key, ownerID: "user-1")?.suggestion == revision)
        #expect(fixture.store.record(for: key, ownerID: "user-1")?.delivery == .sent(messageID: "message"))
    }

    @Test @MainActor
    func changingFromDuringSaveCannotLandOldMailboxDraftIdentity() async {
        let fixture = Fixture()
        defer { fixture.tearDown() }
        let key = AssistantDraftKey(sessionID: "from-race", toolCallID: "draft")
        fixture.transport.holdDraftSaves = true
        fixture.store.receive(Self.seed, key: key, ownerID: "user-1")
        fixture.store.resolveAccountIfNeeded(key, ownerID: "user-1", accounts: Self.accounts)
        let saving = Task { await fixture.store.flushSaves(for: key) }
        await fixture.transport.waitForDraftSaveStart()
        fixture.store.update(key, ownerID: "user-1") { $0.accountID = "acct-2" }
        fixture.transport.releaseDraftSaves()
        await saving.value
        await fixture.store.flushSaves(for: key)
        #expect(fixture.transport.saveCalls.last?.accountID == "acct-2")
        #expect(fixture.transport.saveCalls.last?.id == nil)
    }

    @Test @MainActor
    func clearedOwnerDoesNotRegainSaveStatusOrAttachmentError() async {
        let fixture = Fixture()
        defer { fixture.tearDown() }
        let key = AssistantDraftKey(sessionID: "clear-save", toolCallID: "draft")
        fixture.transport.holdDraftSaves = true
        fixture.store.receive(Self.seed, key: key, ownerID: "user-1")
        fixture.store.resolveAccountIfNeeded(key, ownerID: "user-1", accounts: Self.accounts)
        let saving = Task { await fixture.store.flushSaves(for: key) }
        await fixture.transport.waitForDraftSaveStart()
        await fixture.store.clear(ownerID: "user-1")
        fixture.transport.releaseDraftSaves()
        await saving.value
        fixture.store.reportAttachmentError("Old owner's failure", for: key, ownerID: "user-1")
        #expect(fixture.store.record(for: key, ownerID: "user-1") == nil)
        #expect(fixture.store.saveStates[key.storageID] == nil)
        #expect(fixture.store.sendError(for: key) == nil)
    }

    // MARK: - Doubles

    private enum StubFailure: Error {
        case offline
    }

    /// Yields the main actor until `condition` holds or a bounded number of
    /// turns pass. The store takes its send lock before its first await, so
    /// one turn is normally enough; the bound only keeps a wrong assertion
    /// from hanging the run.
    @MainActor
    private func settle(_ condition: @MainActor () -> Bool) async {
        for _ in 0 ..< 200 where !condition() {
            await Task.yield()
        }
    }

    /// The production file store with a gate at the write, so a test can
    /// hold an add or remove exactly where its lock check has passed and its
    /// chips are not yet committed.
    @MainActor
    private final class GatedAttachmentStore: AssistantDraftAttachmentStoring {
        var backing: MailIntentAttachmentStore?
        var holdSaves = false
        var onLoad: (@MainActor () -> Void)?
        private var startWaiters: [CheckedContinuation<Void, Never>] = []
        private var gateWaiters: [CheckedContinuation<Void, Never>] = []
        private var saveStarts = 0

        func saveComposeAttachments(_ attachments: [ComposeAttachment], draftID: String) async throws {
            saveStarts += 1
            let started = startWaiters
            startWaiters = []
            for waiter in started { waiter.resume() }
            if holdSaves {
                await withCheckedContinuation { gateWaiters.append($0) }
            }
            try await backing?.saveComposeAttachments(attachments, draftID: draftID)
        }

        func loadComposeAttachments(draftID: String) async throws -> [ComposeAttachment] {
            onLoad?()
            return try await backing?.loadComposeAttachments(draftID: draftID) ?? []
        }

        func remove(draftID: String) async throws {
            try await backing?.remove(draftID: draftID)
        }

        func waitForSaveStart() async {
            let seen = saveStarts
            if saveStarts > seen { return }
            await withCheckedContinuation { startWaiters.append($0) }
        }

        func releaseSaves() {
            holdSaves = false
            let waiting = gateWaiters
            gateWaiters = []
            for waiter in waiting { waiter.resume() }
        }
    }

    @MainActor
    private final class ScriptedTransport: AssistantDraftTransport {
        struct SaveCall: Equatable {
            let id: String?
            let accountID: String
            let to: String
            let subject: String
            let body: String
        }

        struct SendCall: Equatable {
            let accountID: String
            let to: String
            let cc: String
            let bcc: String
            let subject: String
            let body: String
            let attachments: [String]
        }

        var saveCalls: [SaveCall] = []
        var saveResult: Result<String, Error> = .success("draft-1")
        var sendCalls: [SendCall] = []
        var sendResult: Result<ComposeSubmission, Error> = .success(.unconfirmed)
        var deletedDraftIDs: [String] = []
        var holdSends = false
        var holdDraftSaves = false
        private var draftStartWaiters: [CheckedContinuation<Void, Never>] = []
        private var draftGateWaiters: [CheckedContinuation<Void, Never>] = []
        private var startWaiters: [CheckedContinuation<Void, Never>] = []
        private var gateWaiters: [CheckedContinuation<Void, Never>] = []

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
        ) async throws -> String {
            saveCalls.append(SaveCall(id: id, accountID: accountID, to: to, subject: subject, body: body))
            let started = draftStartWaiters
            draftStartWaiters = []
            for waiter in started { waiter.resume() }
            if holdDraftSaves {
                await withCheckedContinuation { draftGateWaiters.append($0) }
            }
            return try saveResult.get()
        }

        func waitForDraftSaveStart() async {
            guard saveCalls.isEmpty else { return }
            await withCheckedContinuation { draftStartWaiters.append($0) }
        }

        func releaseDraftSaves() {
            holdDraftSaves = false
            let waiting = draftGateWaiters
            draftGateWaiters = []
            for waiter in waiting { waiter.resume() }
        }

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
        ) async throws -> ComposeSubmission {
            sendCalls.append(
                SendCall(
                    accountID: accountID,
                    to: to,
                    cc: cc,
                    bcc: bcc,
                    subject: subject,
                    body: body,
                    attachments: attachments.map(\.filename)
                )
            )
            let started = startWaiters
            startWaiters = []
            for waiter in started { waiter.resume() }
            if holdSends {
                await withCheckedContinuation { gateWaiters.append($0) }
            }
            return try sendResult.get()
        }

        func deleteDraft(id: String) async throws {
            deletedDraftIDs.append(id)
        }

        func waitForSendStart() async {
            guard sendCalls.isEmpty else { return }
            await withCheckedContinuation { startWaiters.append($0) }
        }

        func releaseSends() {
            holdSends = false
            let waiting = gateWaiters
            gateWaiters = []
            for waiter in waiting { waiter.resume() }
        }
    }

    @MainActor
    private final class Fixture {
        let suiteName = "AssistantDraftArtifactTests-\(UUID().uuidString)"
        let defaults: UserDefaults
        let directory: URL
        let transport = ScriptedTransport()
        let attachments: MailIntentAttachmentStore
        let pendingSends: PendingSendCoordinator
        let store: AssistantDraftStore

        init(backend: BackendClient = BackendClient(baseURL: nil), attachmentStore gate: GatedAttachmentStore? = nil) {
            defaults = UserDefaults(suiteName: suiteName)!
            directory = FileManager.default.temporaryDirectory
                .appending(path: suiteName, directoryHint: .isDirectory)
            attachments = MailIntentAttachmentStore(directory: directory)
            gate?.backing = attachments
            let files: any AssistantDraftAttachmentStoring = gate ?? attachments
            pendingSends = PendingSendCoordinator(
                backend: backend,
                tools: ToolClient(backend: backend),
                defaults: defaults
            )
            store = AssistantDraftStore(
                transport: transport,
                attachmentStore: files,
                defaults: defaults,
                saveDelay: .zero
            )
        }

        /// A fresh store over the same defaults, as after a relaunch.
        func makeStore() -> AssistantDraftStore {
            AssistantDraftStore(
                transport: transport,
                attachmentStore: attachments,
                defaults: defaults,
                saveDelay: .zero
            )
        }

        /// Files the store left in its directory; orphans count too.
        func attachmentFileCount() -> Int {
            (try? FileManager.default.contentsOfDirectory(atPath: directory.path))?.count ?? 0
        }

        func tearDown() {
            defaults.removePersistentDomain(forName: suiteName)
            try? FileManager.default.removeItem(at: directory)
        }
    }
}
