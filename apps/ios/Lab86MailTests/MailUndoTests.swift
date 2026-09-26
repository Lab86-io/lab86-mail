import Foundation
import Testing
@testable import Lab86Mail

// Round 2 mail undo parity (FEATURES item 10): a mail action the server
// recorded shows a toast with Undo, Undo runs `undo_operation` by id, and
// native Activity lists each change with its reason and Undo.
@MainActor
struct MailUndoTests {
    private struct NoopSpotlight: MailSpotlightIndexing {
        func replace(owner: String, accounts: [AccountSummary], threads: [MailThreadSummary]) async {}
        func remove(owner: String) async {}
    }

    private actor RecordingSubmitter: MobileCommandSubmitting {
        let operationID: String?

        init(operationID: String?) { self.operationID = operationID }

        func submit(_ snapshot: PendingCommandSnapshot) async throws -> OutboxCommandReceipt {
            OutboxCommandReceipt(
                commandID: "server-command",
                status: .applied,
                entityRevision: nil,
                operationID: operationID,
                approvalID: nil,
                undoExpiresAt: nil,
                errorCode: nil,
                errorMessage: nil,
                retryable: false
            )
        }
    }

    /// The server copy after an Undo: the rows are back in the inbox.
    private actor StaticMailPages: MailPageFetching {
        private let items: [MailThreadSummary]

        init(_ items: [MailThreadSummary]) { self.items = items }

        func fetchMailThreads(accountID: String?, category: String?, cursor: String?, limit: Int) async throws -> MailListPage {
            MailListPage(items: items, nextCursor: nil, hasMore: false)
        }
    }

    private static func thread(_ id: String, epoch: TimeInterval = 2_000) -> MailThreadSummary {
        MailThreadSummary(
            id: id,
            accountID: "account-1",
            subject: "Subject \(id)",
            sender: "Sender <sender@example.com>",
            snippet: "Snippet",
            date: Date(timeIntervalSince1970: epoch),
            unread: false,
            starred: false
        )
    }

    private static func store(
        _ queue: any MailCommandQueueing,
        tools: RecordingTools = RecordingTools(),
        pages: (any MailPageFetching)? = nil
    ) -> ProductStore {
        ProductStore(
            tools: tools,
            backend: BackendClient(baseURL: nil),
            spotlight: NoopSpotlight(),
            mailPages: pages,
            mailCommands: queue
        )
    }

    private static func operationIDs(_ command: DurableMobileCommand) -> String? {
        switch command {
        case .mailArchive(let target), .mailTrash(let target), .mailRestore(let target): "op-\(target.threadID)"
        case .mailSnooze(let payload): "op-snooze-\(payload.threadID)"
        default: nil
        }
    }

    // MARK: - Toast

    @Test
    func anArchiveTheServerRecordedOffersUndo() async {
        let queue = FakeMailCommandQueue()
        queue.operationIDFor = Self.operationIDs
        let store = Self.store(queue)
        let row = Self.thread("t1")
        store.threads = [row]

        await store.archive(row)

        #expect(store.undoNotice?.summary == "Archived")
        #expect(store.undoNotice?.kind == .mail)
        #expect(store.undoNotice?.operationIDs == ["op-t1"])
        #expect(store.threads.isEmpty)
    }

    @Test
    func aBulkArchiveUndoesEveryConversationNewestFirst() async {
        let queue = FakeMailCommandQueue()
        queue.operationIDFor = Self.operationIDs
        let tools = RecordingTools()
        let first = Self.thread("t1", epoch: 3_000)
        let second = Self.thread("t2", epoch: 2_000)
        let store = Self.store(queue, tools: tools, pages: StaticMailPages([first, second]))
        store.threads = [first, second]

        await store.bulkArchive([first, second])
        #expect(store.undoNotice?.summary == "Archived 2 conversations")
        #expect(store.undoNotice?.operationIDs == ["op-t1", "op-t2"])
        #expect(store.threads.isEmpty)

        await store.undoLatestOperation()

        #expect(await tools.arguments(of: "undo_operation") == [
            ["operationId": .string("op-t2")],
            ["operationId": .string("op-t1")],
        ])
        #expect(store.undoNotice == nil)
        // The Undo lifts the local hide, so the server copy shows the rows
        // again; a hide left in place would drop them from the refresh.
        #expect(Set(store.threads.map(\.id)) == ["t1", "t2"])
    }

    @Test
    func anActionWithoutARecordedOperationShowsNoUndo() async {
        let queue = FakeMailCommandQueue()
        let store = Self.store(queue)
        let row = Self.thread("t1")
        store.threads = [row]

        await store.markRead(row)
        await store.archive(row)

        #expect(store.undoNotice == nil)
    }

    @Test
    func aFailedUndoSaysSoAndKeepsTheChange() async {
        let queue = FakeMailCommandQueue()
        queue.operationIDFor = Self.operationIDs
        let tools = RecordingToolsFailing(failing: "undo_operation")
        let store = ProductStore(
            tools: tools,
            backend: BackendClient(baseURL: nil),
            spotlight: NoopSpotlight(),
            mailCommands: queue
        )
        let row = Self.thread("t1")
        store.threads = [row]

        await store.trash(row)
        #expect(store.undoNotice?.summary == "Moved to Trash")
        await store.undoLatestOperation()

        #expect(store.undoNotice == nil)
        #expect(store.mailErrorMessage == "This change can no longer be undone.")
        #expect(store.threads.isEmpty)
    }

    @Test
    func theNoticeLeavesAfterItsLifetime() async throws {
        let queue = FakeMailCommandQueue()
        queue.operationIDFor = Self.operationIDs
        let store = Self.store(queue)
        store.undoNoticeLifetime = .milliseconds(20)
        let row = Self.thread("t1")
        store.threads = [row]

        await store.archive(row)
        #expect(store.undoNotice != nil)
        try await Task.sleep(for: .milliseconds(300))
        #expect(store.undoNotice == nil)
    }

    @Test
    func aSmartCorrectionOffersUndo() async {
        let tools = RecordingTools { name, _ in
            name == "apply_smart_correction" ? .object(["operationId": .string("op-rule")]) : .object([:])
        }
        let store = Self.store(FakeMailCommandQueue(), tools: tools)
        let saved = await store.correctCategory(Self.thread("t1"), to: .noise)
        #expect(saved)
        #expect(store.undoNotice?.summary == "Smart rule saved")
        #expect(store.undoNotice?.operationIDs == ["op-rule"])
        #expect(store.undoNotice?.kind == .mail)
    }

    @Test
    func theOutboxKeepsTheOperationOfAnAppliedCommand() async throws {
        let outbox = CommandOutbox(modelContainer: MobilePersistence.makeContainer(inMemory: true))
        let processor = CommandOutboxProcessor(outbox: outbox, submitter: RecordingSubmitter(operationID: "op-9"))
        let queue = OutboxMailCommandQueue(
            outbox: outbox,
            ownerID: { "owner-1" },
            drain: { ownerID in
                let result = await processor.drain(ownerID: ownerID)
                return result.permanentlyFailed == 0
            }
        )
        let store = Self.store(queue)
        let row = Self.thread("t1")
        store.threads = [row]

        await store.archive(row)

        let settled = try await outbox.commands(ownerID: "owner-1", keyPrefix: MailCommandKey.prefix)
        #expect(settled.first?.operationID == "op-9")
        #expect(store.undoNotice?.operationIDs == ["op-9"])
    }

    // MARK: - Copy

    @Test
    func theToastNamesWhatChanged() {
        let target = MailThreadCommandTarget(accountID: "a", threadID: "t")
        let now = Date(timeIntervalSince1970: 1_788_400_000)
        let calendar = Calendar.autoupdatingCurrent
        let tomorrowNine = calendar.date(
            bySettingHour: 9, minute: 0, second: 0,
            of: calendar.date(byAdding: .day, value: 1, to: now)!
        )!
        #expect(MailUndoCopy.summary(for: [.mailArchive(target)]) == "Archived")
        #expect(MailUndoCopy.summary(for: [.mailTrash(target), .mailTrash(target)]) == "Moved 2 conversations to Trash")
        #expect(MailUndoCopy.summary(for: [.mailRestore(target)]) == "Moved to Inbox")
        #expect(MailUndoCopy.summary(for: [.mailArchive(target), .mailTrash(target)]) == "Changed 2 conversations")
        let snooze = DurableMobileCommand.mailSnooze(
            MailSnoozeCommandPayload(accountID: "a", threadID: "t", untilAt: tomorrowNine)
        )
        #expect(MailUndoCopy.summary(for: [snooze], now: now).hasPrefix("Snoozed until tomorrow at "))
        #expect(MailUndoCopy.summary(for: [snooze, snooze], now: now) == "Snoozed 2 conversations")
        #expect(MailUndoCopy.summary(for: []) == "Changed")
    }

    // MARK: - Activity

    @Test
    func recentOperationsDecodeWithTheirReason() throws {
        let now = Date(timeIntervalSince1970: 1_788_400_000)
        let rows = RecentOperation.list(from: .object(["operations": .array([
            .object([
                "operationId": .string("op-1"), "tool": .string("block_sender"), "surface": .string("mail"),
                "summary": .string("Blocked news@example.com"), "reason": .string("You chose Block sender."),
                "agent": .string("user"), "status": .string("applied"), "undoable": .bool(true),
                "createdAt": .number(now.timeIntervalSince1970 * 1_000),
                "target": .object(["accountId": .string("acct-1")]),
            ]),
            .object([
                "operationId": .string("op-2"), "surface": .string("tasks"), "summary": .string("Moved a task"),
                "agent": .string("ai"), "status": .string("undone"), "undoable": .bool(true),
            ]),
            .object([
                "operationId": .string("op-3"), "surface": .string("calendar"), "summary": .string("Declined"),
                "status": .string("undo_failed"),
            ]),
            .object(["operationId": .string("op-4")]),
        ])]))
        #expect(rows.map(\.id) == ["op-1", "op-2", "op-3"])
        #expect(rows[0].reason == "You chose Block sender.")
        #expect(rows[0].undoable)
        #expect(rows[0].accountID == "acct-1")
        #expect(rows[0].metaLine(now: now).hasPrefix("You did this · Mail · "))
        #expect(rows[0].statusNote == nil)
        // Only an applied change can still be undone.
        #expect(!rows[1].undoable)
        #expect(rows[1].statusNote == "Undone")
        #expect(rows[1].metaLine(now: now) == "Albatross did this · Tasks")
        #expect(rows[2].statusNote == "Could not be undone")
    }

    @Test
    func activityUndoRunsTheOperationAndReadsTheLogAgain() async {
        let tools = RecordingTools { name, _ in
            guard name == "list_recent_operations" else { return .object(["ok": .bool(true)]) }
            return .object(["operations": .array([.object([
                "operationId": .string("op-1"), "surface": .string("mail"), "summary": .string("Archived Invoice"),
                "status": .string("applied"), "undoable": .bool(true),
            ])])])
        }
        let model = RecentChangesModel(client: OperationsClient(tools: tools))
        await model.load(limit: 500)
        #expect(model.didLoad)
        #expect(model.rows.count == 1)

        let undone = await model.undo(model.rows[0])

        #expect(undone)
        #expect(await tools.arguments(of: "undo_operation") == [["operationId": .string("op-1")]])
        #expect(await tools.arguments(of: "list_recent_operations") == [
            ["limit": .number(200)],
            ["limit": .number(50)],
        ])
    }
}

/// A tool invoker that fails one tool with the server's plain message.
actor RecordingToolsFailing: ToolInvoking {
    private let failing: String
    private(set) var calls: [String] = []

    init(failing: String) { self.failing = failing }

    func invoke(_ name: String, arguments: [String: JSONValue]) async throws -> JSONValue {
        calls.append(name)
        if name == failing {
            throw BackendError.server(status: 500, message: "This change can no longer be undone.")
        }
        return .object([:])
    }
}
