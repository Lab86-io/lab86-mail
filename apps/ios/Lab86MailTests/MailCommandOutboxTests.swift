import Foundation
import Testing
@testable import Lab86Mail

// NAT-10 (audit 2026-09-26): the mail list actions go through the durable
// command outbox. A change shows at once, stays while the outbox waits for
// the network, and rolls back only on a final failure.
@MainActor
struct MailCommandOutboxTests {
    private struct NoopSpotlight: MailSpotlightIndexing {
        func replace(owner: String, accounts: [AccountSummary], threads: [MailThreadSummary]) async {}
        func remove(owner: String) async {}
    }

    private actor StaticMailPages: MailPageFetching {
        private let items: [MailThreadSummary]

        init(_ items: [MailThreadSummary]) {
            self.items = items
        }

        func fetchMailThreads(
            accountID: String?,
            category: String?,
            cursor: String?,
            limit: Int
        ) async throws -> MailListPage {
            MailListPage(items: items, nextCursor: nil, hasMore: false)
        }
    }

    private actor SequencedSubmitter: MobileCommandSubmitting {
        enum Step: Sendable {
            case offline
            case applied
            case refused
        }

        private var steps: [Step]
        private(set) var submissions = 0

        init(_ steps: [Step]) {
            self.steps = steps
        }

        func submit(_ snapshot: PendingCommandSnapshot) async throws -> OutboxCommandReceipt {
            submissions += 1
            let step = steps.isEmpty ? Step.applied : steps.removeFirst()
            switch step {
            case .offline:
                throw URLError(.notConnectedToInternet)
            case .applied:
                return Self.receipt(status: .applied, message: nil)
            case .refused:
                return Self.receipt(status: .failed, message: "This conversation has no message to change.")
            }
        }

        private static func receipt(status: OutboxCommandStatus, message: String?) -> OutboxCommandReceipt {
            OutboxCommandReceipt(
                commandID: "server-command",
                status: status,
                entityRevision: nil,
                operationID: nil,
                approvalID: nil,
                undoExpiresAt: nil,
                errorCode: message == nil ? nil : "NOT_FOUND",
                errorMessage: message,
                retryable: false
            )
        }
    }

    @MainActor
    private final class TestClock {
        var now = Date.now
    }

    private static let target = MailThreadCommandTarget(accountID: "account-1", threadID: "t1")

    private static func thread(
        _ id: String,
        epoch: TimeInterval = 2_000,
        unread: Bool = false,
        starred: Bool = false
    ) -> MailThreadSummary {
        MailThreadSummary(
            id: id,
            accountID: "account-1",
            subject: "Subject \(id)",
            sender: "Sender <sender@example.com>",
            snippet: "Snippet",
            date: Date(timeIntervalSince1970: epoch),
            unread: unread,
            starred: starred
        )
    }

    private static let accountTools = RecordingTools { name, _ in
        switch name {
        case "list_accounts":
            return .object(["accounts": .array([
                .object([
                    "email": .string("owner@example.com"),
                    "provider": .string("google"),
                    "authed": .bool(true),
                    "accountId": .string("account-1"),
                ]),
            ])])
        default:
            return .object([:])
        }
    }

    private static func store(
        _ queue: any MailCommandQueueing,
        tools: RecordingTools? = nil,
        pages: (any MailPageFetching)? = nil
    ) -> ProductStore {
        ProductStore(
            tools: tools ?? accountTools,
            backend: BackendClient(baseURL: nil),
            spotlight: NoopSpotlight(),
            mailPages: pages,
            mailCommands: queue
        )
    }

    // MARK: - Store

    @Test
    func anArchiveGoesThroughTheOutboxAndHidesTheThreadAtOnce() async {
        let queue = FakeMailCommandQueue()
        let store = Self.store(queue)
        let archived = Self.thread("t1")
        let kept = Self.thread("t2", epoch: 1_000)
        store.threads = [archived, kept]
        store.searchedThreads = [archived]

        await store.archive(archived)

        #expect(queue.sentCommands == [.mailArchive(Self.target)])
        #expect(queue.entries.allSatisfy { $0.key.hasPrefix(MailCommandKey.prefix) })
        #expect(store.threads == [kept])
        #expect(store.searchedThreads.isEmpty)
        #expect(store.mailErrorMessage == nil)
    }

    @Test
    func eachListActionSendsItsCommand() async {
        let queue = FakeMailCommandQueue()
        let store = Self.store(queue)
        let row = Self.thread("t1", unread: true)
        let until = Date(timeIntervalSinceNow: 3_600)

        await store.trash(row)
        await store.restore(row)
        await store.markRead(row)
        await store.markUnread(row)
        await store.setStarred(true, thread: row)
        await store.setStarred(false, thread: row)
        await store.snooze(row, until: until)
        await store.performMailNotificationAction(action: "archive", accountID: "account-1", threadID: "t1")
        await store.performMailNotificationAction(action: "mark_read", accountID: "account-1", threadID: "t1")
        await store.performMailNotificationAction(action: "reply", accountID: "account-1", threadID: "t1")

        let message = MailThreadMessageCommandTarget(accountID: "account-1", threadID: "t1")
        #expect(queue.sentCommands == [
            .mailTrash(Self.target),
            .mailRestore(Self.target),
            .mailMarkRead(Self.target),
            .mailMarkUnread(message),
            .mailStar(message),
            .mailUnstar(message),
            .mailSnooze(MailSnoozeCommandPayload(accountID: "account-1", threadID: "t1", untilAt: until)),
            .mailArchive(Self.target),
            .mailMarkRead(Self.target),
        ])
    }

    @Test
    func bulkActionsSendOneCommandForEachThreadAndFlushOnce() async {
        let queue = FakeMailCommandQueue()
        let store = Self.store(queue)
        let first = Self.thread("t1", epoch: 3_000)
        let second = Self.thread("t2", epoch: 2_000)
        store.threads = [first, second]

        await store.bulkArchive([first, second])
        #expect(store.threads.isEmpty)
        #expect(queue.sentCommands.count == 2)

        await store.bulkRestore([first, second])
        #expect(store.threads == [first, second])
        #expect(queue.sentCommands.count == 4)
    }

    @Test
    func anOfflineActionKeepsItsChangeUntilTheOutboxSettlesIt() async {
        let queue = FakeMailCommandQueue()
        queue.flushResult = (.failed, true, "The Internet connection appears to be offline.")
        let store = Self.store(queue)
        let archived = Self.thread("t1")
        store.threads = [archived]

        await store.archive(archived)
        #expect(store.threads.isEmpty)
        #expect(store.mailErrorMessage == nil)

        // A later drain sends it.
        await store.reconcileMailCommands(queue.settleWaiting(status: .applied))
        #expect(store.threads.isEmpty)
        #expect(store.mailErrorMessage == nil)
    }

    @Test
    func aFinalFailureRollsTheChangeBackOnceAndSaysWhy() async {
        let queue = FakeMailCommandQueue()
        queue.flushResult = (.pending, false, nil)
        let store = Self.store(queue)
        let archived = Self.thread("t1")
        let kept = Self.thread("t2", epoch: 1_000)
        store.threads = [archived, kept]
        store.searchedThreads = [archived]

        await store.archive(archived)
        #expect(store.threads == [kept])

        let failed = queue.settleWaiting(status: .failed, message: "This conversation is gone.")
        await store.reconcileMailCommands(failed)
        #expect(store.threads == [archived, kept])
        #expect(store.searchedThreads == [archived])
        #expect(store.mailErrorMessage == "This conversation is gone.")
        #expect(store.errorMessage == nil)

        // The same receipt again changes nothing.
        store.clearMailError()
        await store.reconcileMailCommands(failed)
        #expect(store.threads == [archived, kept])
        #expect(store.mailErrorMessage == nil)
    }

    @Test
    func aFailureWithoutAServerMessageUsesPlainCopy() async {
        let queue = FakeMailCommandQueue()
        queue.flushResult = (.conflicted, false, nil)
        let store = Self.store(queue)
        store.threads = [Self.thread("t1")]

        await store.trash(Self.thread("t1"))

        #expect(store.threads.map(\.id) == ["t1"])
        #expect(store.mailErrorMessage == MailCommandPhase.failureCopy)
    }

    @Test
    func starAndUnreadShowAtOnceAndRollBackTogether() async {
        let queue = FakeMailCommandQueue()
        queue.flushResult = (.pending, false, nil)
        let store = Self.store(queue)
        let row = Self.thread("t1", unread: false, starred: false)
        store.threads = [row]
        store.searchedThreads = [row]

        await store.setStarred(true, thread: row)
        await store.markUnread(row)
        #expect(store.threads.first?.starred == true)
        #expect(store.threads.first?.unread == true)
        #expect(store.searchedThreads.first?.unread == true)

        await store.reconcileMailCommands(queue.settleWaiting(status: .conflicted, message: "Changed elsewhere."))
        #expect(store.threads.first?.starred == false)
        #expect(store.threads.first?.unread == false)
        #expect(store.searchedThreads.first?.starred == false)
    }

    @Test
    func aReadStateTheServerHasNotCaughtUpWithStaysOnScreen() async {
        let queue = FakeMailCommandQueue()
        queue.flushResult = (.pending, false, nil)
        let row = Self.thread("t1", unread: true)
        let store = Self.store(queue, pages: StaticMailPages([row]))
        await store.refreshMail()
        #expect(store.threads.first?.unread == true)

        await store.markRead(row)
        // The server copy is still unread; the pending change wins.
        await store.refreshMail()
        #expect(store.threads.first?.unread == false)
    }

    @Test
    func anActionThatCannotBeStoredRollsBackAtOnce() async {
        let queue = FakeMailCommandQueue()
        queue.enqueueError = BackendError.server(status: 500, message: "Storage is full.")
        let store = Self.store(queue)
        let row = Self.thread("t1")
        store.threads = [row]

        await store.archive(row)

        #expect(store.threads == [row])
        #expect(store.mailErrorMessage == "Storage is full.")
        #expect(queue.sentCommands.isEmpty)
    }

    @Test
    func withoutAnOutboxAMailActionReportsInsteadOfPretending() async {
        let store = ProductStore(tools: RecordingTools(), backend: BackendClient(baseURL: nil))
        let row = Self.thread("t1")
        store.threads = [row]

        await store.archive(row)

        #expect(store.threads == [row])
        #expect(store.mailErrorMessage == BackendError.configuration.localizedDescription)
    }

    @Test
    func aRelaunchShowsAnActionThatStillWaitsAgain() async {
        let archived = Self.thread("t1", epoch: 3_000)
        let kept = Self.thread("t2", epoch: 1_000)
        let before = FakeMailCommandQueue()
        before.flushResult = (.failed, true, "Offline")
        let first = Self.store(before)
        first.threads = [archived, kept]
        await first.archive(archived)

        // A new store reads the outbox before the list loads.
        let relaunched = Self.store(FakeMailCommandQueue(), pages: StaticMailPages([archived, kept]))
        await relaunched.reconcileMailCommands(before.snapshots())
        await relaunched.refreshMail()
        #expect(relaunched.threads == [kept])

        // The action fails for good later: the thread comes back.
        await relaunched.reconcileMailCommands(before.settleWaiting(status: .failed, message: "Refused."))
        #expect(relaunched.mailErrorMessage == "Refused.")
        await relaunched.refreshMail()
        #expect(relaunched.threads == [archived, kept])
    }

    @Test
    func aSnoozedThreadStaysHiddenUntilItsTime() async {
        let row = Self.thread("s1")
        let queue = FakeMailCommandQueue()
        let store = Self.store(queue, pages: StaticMailPages([row]))
        await store.refreshMail()

        await store.snooze(row, until: .now.addingTimeInterval(3_600))
        #expect(store.threads.isEmpty)
        await store.refreshMail()
        #expect(store.threads.isEmpty)
        #expect(store.mailErrorMessage == nil)
    }

    // MARK: - Snoozed mailbox

    @Test
    func theSnoozedMailboxReadsListSnoozed() async {
        let tools = RecordingTools { name, _ in
            name == "list_snoozed" ? snoozedJSON : .object([:])
        }
        let store = Self.store(FakeMailCommandQueue(), tools: tools)

        await store.refreshSnoozed()

        #expect(store.snoozedDidLoad)
        #expect(store.snoozedError == nil)
        #expect(store.snoozedThreads.map(\.id) == ["snooze-1", "snooze-2"])
        let first = store.snoozedThreads[0]
        #expect(first.subject == "Quarterly numbers")
        #expect(first.senderDisplayName == "Ari Lane")
        #expect(first.messageID == nil)
        #expect(first.accountEmail == "owner@example.com")
        #expect(first.until == Date(timeIntervalSince1970: 4_102_444_800))
        #expect(store.snoozedThreads[1].subject == "(No subject)")
        #expect(store.snoozedThreads[1].messageID == "m2")
        let calls = await tools.arguments(of: "list_snoozed")
        #expect(calls == [["limit": .number(200)]])
    }

    @Test
    func aFailedSnoozedReadSaysSoAndKeepsTheLastList() async {
        let tools = RecordingTools { name, _ in
            name == "list_snoozed" ? snoozedJSON : .object([:])
        }
        let store = Self.store(FakeMailCommandQueue(), tools: tools)
        await store.refreshSnoozed()

        let failing = ProductStore(
            tools: FailingTools(),
            backend: BackendClient(baseURL: nil),
            mailCommands: FakeMailCommandQueue()
        )
        await failing.refreshSnoozed()
        #expect(!failing.snoozedDidLoad)
        #expect(failing.snoozedError != nil)
        #expect(store.snoozedThreads.count == 2)
    }

    @Test
    func unsnoozeTakesTheRowOffAndPutsTheThreadBackInTheInbox() async {
        let tools = RecordingTools { name, _ in
            name == "list_snoozed" ? snoozedJSON : .object([:])
        }
        let queue = FakeMailCommandQueue()
        queue.flushResult = (.pending, false, nil)
        let store = Self.store(queue, tools: tools)
        await store.refreshSnoozed()
        let row = store.snoozedThreads[0]

        await store.unsnooze(row)

        #expect(queue.sentCommands == [
            .mailUnsnooze(MailUnsnoozeCommandPayload(accountID: "account-1", threadID: "t1", messageID: nil)),
        ])
        #expect(store.snoozedThreads.map(\.id) == ["snooze-2"])
        #expect(store.threads.map(\.id) == ["t1"])

        // A reload while the wake waits keeps the row off the list.
        await store.refreshSnoozed()
        #expect(store.snoozedThreads.map(\.id) == ["snooze-2"])

        // A final failure puts the row back and takes the thread out again.
        await store.reconcileMailCommands(queue.settleWaiting(status: .failed, message: "Could not wake it."))
        #expect(store.snoozedThreads.map(\.id) == ["snooze-1", "snooze-2"])
        #expect(store.threads.isEmpty)
        #expect(store.mailErrorMessage == "Could not wake it.")
    }

    @Test
    func theSnoozedMailboxHasNoQuery() {
        #expect(MailboxScope.snoozed.query == nil)
        #expect(MailboxScope.snoozed.title == "Snoozed")
        #expect(MailboxScope.allCases.contains(.snoozed))
        #expect(!MailboxScope.allCases.compactMap(\.query).contains("label:SNOOZED"))
    }

    @Test
    func theSnoozedFilterFollowsTheAccountScopeAndTheSearch() {
        let rows = [
            MailSnoozedThread(id: "1", accountID: "a", threadID: "t1", until: .now, subject: "Invoice", sender: "Billing"),
            MailSnoozedThread(id: "2", accountID: "b", threadID: "t2", until: .now, subject: "Lunch", sender: "Ari", snippet: "Friday?"),
        ]
        #expect(MailSnoozedThread.filter(rows, accounts: [], query: "").map(\.id) == ["1", "2"])
        #expect(MailSnoozedThread.filter(rows, accounts: ["b"], query: "").map(\.id) == ["2"])
        #expect(MailSnoozedThread.filter(rows, accounts: [], query: " friday ").map(\.id) == ["2"])
        #expect(MailSnoozedThread.filter(rows, accounts: [], query: "billing").map(\.id) == ["1"])
        #expect(MailSnoozedThread.filter(rows, accounts: ["a"], query: "lunch").isEmpty)
    }

    @Test
    func theReturnLabelSaysWhenTheThreadComesBack() throws {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = try #require(TimeZone(identifier: "UTC"))
        utc.locale = Locale(identifier: "en_US")
        let calendar = utc
        let now = try #require(calendar.date(from: DateComponents(year: 2026, month: 9, day: 26, hour: 9)))
        let label = { (components: DateComponents) -> String in
            let until = calendar.date(from: components) ?? .distantPast
            let row = MailSnoozedThread(id: "1", accountID: "a", threadID: "t", until: until, subject: "s", sender: "x")
            return row.returnLabel(now: now, calendar: calendar)
        }

        #expect(label(DateComponents(year: 2026, month: 9, day: 26, hour: 17)).hasPrefix("Back today at "))
        #expect(label(DateComponents(year: 2026, month: 9, day: 27, hour: 9)).hasPrefix("Back tomorrow at "))
        #expect(label(DateComponents(year: 2026, month: 10, day: 2, hour: 9)).hasPrefix("Back Fri, Oct 2"))
        #expect(label(DateComponents(year: 2027, month: 1, day: 4, hour: 9)).contains("2027"))
        #expect(label(DateComponents(year: 2026, month: 9, day: 26, hour: 8)) == "Due back now")
    }

    // MARK: - Outbox queue

    @Test
    func theOutboxQueueRetriesAfterANetworkFailureAndThenSettles() async throws {
        let outbox = CommandOutbox(modelContainer: MobilePersistence.makeContainer(inMemory: true))
        let submitter = SequencedSubmitter([.offline, .applied])
        let processor = CommandOutboxProcessor(outbox: outbox, submitter: submitter)
        let clock = TestClock()
        let queue = OutboxMailCommandQueue(
            outbox: outbox,
            ownerID: { "owner-1" },
            drain: { ownerID in
                let result = await processor.drain(ownerID: ownerID, now: clock.now)
                return result.deferred == 0 && result.permanentlyFailed == 0
            }
        )
        let store = Self.store(queue)
        let archived = Self.thread("t1")
        store.threads = [archived]

        await store.archive(archived)
        #expect(store.threads.isEmpty)
        #expect(store.mailErrorMessage == nil)
        let waiting = try await outbox.commands(ownerID: "owner-1", keyPrefix: MailCommandKey.prefix)
        #expect(waiting.count == 1)
        #expect(waiting.first?.status == .failed)
        #expect(waiting.first?.lastErrorRetryable == true)
        #expect(OutboxMailCommandQueue.retryDelay(for: waiting, now: clock.now) != nil)

        clock.now = clock.now.addingTimeInterval(600)
        await store.reconcileMailCommands(await queue.flush())
        let settled = try await outbox.commands(ownerID: "owner-1", keyPrefix: MailCommandKey.prefix)
        #expect(settled.first?.status == .applied)
        #expect(store.threads.isEmpty)
        #expect(store.mailErrorMessage == nil)
        #expect(await submitter.submissions == 2)
        #expect(OutboxMailCommandQueue.retryDelay(for: settled, now: clock.now) == nil)
    }

    @Test
    func theOutboxQueueRollsBackARefusedCommand() async throws {
        let outbox = CommandOutbox(modelContainer: MobilePersistence.makeContainer(inMemory: true))
        let processor = CommandOutboxProcessor(outbox: outbox, submitter: SequencedSubmitter([.refused]))
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

        await store.setStarred(true, thread: row)

        #expect(store.threads.first?.starred == false)
        #expect(store.mailErrorMessage == "This conversation has no message to change.")
    }

    @Test
    func theOutboxQueueNeedsASignedInOwner() async {
        let outbox = CommandOutbox(modelContainer: MobilePersistence.makeContainer(inMemory: true))
        let queue = OutboxMailCommandQueue(outbox: outbox, ownerID: { nil }, drain: { _ in true })

        await #expect(throws: BackendError.self) {
            try await queue.enqueue(.mailArchive(Self.target), idempotencyKey: MailCommandKey.make())
        }
        #expect(await queue.flush().isEmpty)
    }

    @Test
    func settledListActionsArePrunedAndOtherCommandsStay() async throws {
        let outbox = CommandOutbox(modelContainer: MobilePersistence.makeContainer(inMemory: true))
        let archive = DurableMobileCommand.mailArchive(Self.target)
        _ = try await outbox.enqueue(ownerID: "o", command: archive, idempotencyKey: "mail-list-applied")
        _ = try await outbox.enqueue(ownerID: "o", command: archive, idempotencyKey: "mail-list-waiting")
        _ = try await outbox.enqueue(ownerID: "o", command: archive, idempotencyKey: "mail-list-refused")
        _ = try await outbox.enqueue(ownerID: "o", command: archive, idempotencyKey: "chat-applied")
        let applied = OutboxCommandReceipt(
            commandID: "c", status: .applied, entityRevision: nil, operationID: nil, approvalID: nil,
            undoExpiresAt: nil, errorCode: nil, errorMessage: nil, retryable: false
        )
        try await outbox.apply(ownerID: "o", idempotencyKey: "mail-list-applied", receipt: applied)
        try await outbox.apply(ownerID: "o", idempotencyKey: "chat-applied", receipt: applied)
        try await outbox.fail(ownerID: "o", idempotencyKey: "mail-list-refused", code: "X", message: "No", retryable: false)

        // Not old enough yet.
        try await outbox.pruneSettledCommands(ownerID: "o", keyPrefix: MailCommandKey.prefix, before: .distantPast)
        #expect(try await outbox.commands(ownerID: "o", keyPrefix: MailCommandKey.prefix).count == 3)

        try await outbox.pruneSettledCommands(ownerID: "o", keyPrefix: MailCommandKey.prefix, before: .distantFuture)
        let left = try await outbox.commands(ownerID: "o", keyPrefix: MailCommandKey.prefix)
        #expect(left.map(\.idempotencyKey) == ["mail-list-waiting"])
        #expect(try await outbox.commands(ownerID: "o").map(\.idempotencyKey).contains("chat-applied"))
    }

    // MARK: - Phases and retry timing

    @Test
    func aCommandPhaseFollowsItsOutboxState() {
        func phase(_ status: OutboxCommandStatus, retryable: Bool = false, message: String? = nil) -> MailCommandPhase {
            MailCommandPhase(FakeMailCommandQueue.snapshot(
                .init(key: "k", command: .mailArchive(Self.target), status: status, retryable: retryable, message: message)
            ))
        }
        #expect(phase(.pending) == .waiting)
        #expect(phase(.submitting) == .waiting)
        #expect(phase(.queued) == .waiting)
        #expect(phase(.failed, retryable: true) == .waiting)
        #expect(phase(.applied) == .confirmed)
        #expect(phase(.needsApproval) == .confirmed)
        #expect(phase(.failed, message: "No.") == .failed(message: "No."))
        #expect(phase(.conflicted, message: "  ") == .failed(message: MailCommandPhase.failureCopy))
    }

    @Test
    func theNextTryIsDueWhenTheEarliestWaitingCommandIs() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        func snapshot(_ status: OutboxCommandStatus, retryable: Bool = true, next: Date?) -> PendingCommandSnapshot {
            PendingCommandSnapshot(
                idempotencyKey: UUID().uuidString, ownerID: "o", command: .mailArchive(Self.target),
                baseRevision: nil, clientCreatedAt: now, status: status, serverCommandID: nil,
                attemptCount: 1, nextAttemptAt: next, lastErrorCode: nil, lastErrorMessage: nil,
                lastErrorRetryable: retryable
            )
        }
        #expect(OutboxMailCommandQueue.retryDelay(for: [], now: now) == nil)
        #expect(OutboxMailCommandQueue.retryDelay(for: [snapshot(.applied, next: nil)], now: now) == nil)
        #expect(OutboxMailCommandQueue.retryDelay(for: [snapshot(.failed, next: now.addingTimeInterval(30))], now: now) == 30)
        #expect(OutboxMailCommandQueue.retryDelay(for: [snapshot(.pending, next: nil)], now: now) == 2)
        #expect(OutboxMailCommandQueue.retryDelay(for: [snapshot(.submitting, next: nil)], now: now) == 30)
        #expect(OutboxMailCommandQueue.retryDelay(for: [snapshot(.failed, next: now.addingTimeInterval(9_000))], now: now) == 300)
        #expect(OutboxMailCommandQueue.retryDelay(
            for: [snapshot(.failed, next: now.addingTimeInterval(90)), snapshot(.queued, next: now.addingTimeInterval(20))],
            now: now
        ) == 20)
    }
}

// `list_snoozed` rows: a full one, a sparse one, and one that cannot be read.
private let snoozedJSON: JSONValue = .object([
    "snoozed": .array([
        .object([
            "id": .string("snooze-1"),
            "account": .string("account-1"),
            "accountEmail": .string("owner@example.com"),
            "threadId": .string("t1"),
            "messageId": .null,
            "untilTs": .number(4_102_444_800_000),
            "untilIso": .string("2100-01-01T00:00:00.000Z"),
            "snoozedAt": .number(1_790_000_000_000),
            "subject": .string("Quarterly numbers"),
            "fromAddress": .string("Ari Lane <ari@example.com>"),
            "snippet": .string("See the attached sheet."),
            "lastDate": .number(1_789_000_000_000),
        ]),
        .object([
            "id": .string("snooze-2"),
            "account": .string("account-1"),
            "threadId": .string("t2"),
            "messageId": .string("m2"),
            "untilTs": .number(4_102_444_800_000),
            "subject": .string(""),
            "fromAddress": .string(""),
        ]),
        .object(["id": .string("broken")]),
    ]),
])

private actor FailingTools: ToolInvoking {
    func invoke(_ name: String, arguments: [String: JSONValue]) async throws -> JSONValue {
        throw BackendError.server(status: 503, message: "Try again shortly.")
    }
}
