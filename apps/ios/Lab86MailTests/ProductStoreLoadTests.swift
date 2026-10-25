import Foundation
import Testing
@testable import Lab86Mail

// Load reliability in the store (iOS refresh, 2026-10-24): cancellations are
// not errors (K1), the newest mail refresh wins and keeps paged rows (K10), a
// return to the app reads only when stale (K3), a push refreshes only its
// domain (K2), the cache writes once after a burst (K8), and the brief polls
// while the server writes it (B1).
@MainActor
struct ProductStoreLoadTests {
    private struct NoopSpotlight: MailSpotlightIndexing {
        func replace(owner: String, accounts: [AccountSummary], threads: [MailThreadSummary]) async {}
        func remove(owner: String) async {}
    }

    // Answers each tool from a closure that sees how many times that tool
    // was called, so an answer can change between calls.
    private actor ScriptedTools: ToolInvoking {
        typealias Responder = @Sendable (_ name: String, _ arguments: [String: JSONValue], _ call: Int) throws -> JSONValue
        private(set) var calls: [(name: String, arguments: [String: JSONValue])] = []
        private var responder: Responder

        init(_ responder: @escaping Responder) {
            self.responder = responder
        }

        func invoke(_ name: String, arguments: [String: JSONValue]) async throws -> JSONValue {
            calls.append((name, arguments))
            let call = calls.filter { $0.name == name }.count
            return try responder(name, arguments, call)
        }

        func count(of name: String) -> Int { calls.filter { $0.name == name }.count }

        func arguments(of name: String) -> [[String: JSONValue]] {
            calls.filter { $0.name == name }.map(\.arguments)
        }

        func answer(_ responder: @escaping Responder) { self.responder = responder }
    }

    // Serves pages in order. One fetch can be held open until the test
    // releases it, to order two refreshes.
    private actor PagedMail: MailPageFetching {
        private var pages: [MailListPage]
        private let heldFetch: Int?
        private var held: CheckedContinuation<MailListPage, any Error>?
        private var waiters: [CheckedContinuation<Void, Never>] = []
        private(set) var fetches = 0

        init(pages: [MailListPage], holdingFetch heldFetch: Int? = nil) {
            self.pages = pages
            self.heldFetch = heldFetch
        }

        func fetchMailThreads(accountID: String?, category: String?, cursor: String?, limit: Int) async throws -> MailListPage {
            let index = fetches
            fetches += 1
            if index == heldFetch {
                return try await withCheckedThrowingContinuation { continuation in
                    held = continuation
                    for waiter in waiters { waiter.resume() }
                    waiters = []
                }
            }
            guard !pages.isEmpty else { return MailListPage(items: [], nextCursor: nil, hasMore: false) }
            return pages.removeFirst()
        }

        func waitUntilHeld() async {
            if held != nil { return }
            await withCheckedContinuation { waiters.append($0) }
        }

        func release(_ page: MailListPage) {
            held?.resume(returning: page)
            held = nil
        }
    }

    nonisolated private static let accountJSON: JSONValue = .object([
        "accounts": .array([
            .object([
                "email": .string("owner@example.com"),
                "provider": .string("google"),
                "authed": .bool(true),
                "accountId": .string("acct-1"),
            ]),
        ]),
    ])

    nonisolated private static let emptyBoard: JSONValue = .object([
        "board": .object(["columns": .array([]), "cards": .array([]), "role": .string("owner")]),
    ])

    nonisolated private static func report(_ id: String, generatedAt: Double, status: String) -> JSONValue {
        .object([
            "report": .object([
                "_id": .string(id),
                "generatedAt": .number(generatedAt),
                "status": .string(status),
                "title": .string("Daily Report"),
                "narrative": .string("Text"),
            ]),
        ])
    }

    private func thread(_ id: String, epoch: TimeInterval) -> MailThreadSummary {
        MailThreadSummary(
            id: id, accountID: "acct-1", subject: "Subject \(id)", sender: "a@example.com", snippet: "",
            date: Date(timeIntervalSince1970: epoch), unread: false, starred: false
        )
    }

    private func page(_ threads: [MailThreadSummary], hasMore: Bool = false) -> MailListPage {
        MailListPage(items: threads, nextCursor: hasMore ? "cursor" : nil, hasMore: hasMore)
    }

    // The usual happy tools: one account, an empty board, a ready brief.
    private static func quietTools() -> ScriptedTools {
        ScriptedTools { name, _, _ in
            switch name {
            case "list_accounts": return accountJSON
            case "tasks_get_board": return emptyBoard
            case "get_latest_daily_report": return report("rep-1", generatedAt: 1_000, status: "ready")
            default: return .object([:])
            }
        }
    }

    private func makeStore(
        tools: any ToolInvoking,
        cache: ProductCache = ProductCache(directory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)),
        mailPages: (any MailPageFetching)? = nil
    ) -> ProductStore {
        let store = ProductStore(
            tools: tools,
            backend: BackendClient(baseURL: nil),
            cache: cache,
            spotlight: NoopSpotlight(),
            mailPages: mailPages
        )
        store.cacheWriteDelay = .zero
        return store
    }

    // MARK: - Cancellation (K1)

    @Test
    func aCancelledReadIsNotAnError() async {
        let tools = ScriptedTools { _, _, _ in throw URLError(.cancelled) }
        let store = makeStore(tools: tools)

        await store.refreshMail()
        await store.refreshToday()
        await store.refreshWork()
        await store.refreshSnoozed()
        await store.searchMail("invoice")

        #expect(store.mailErrorMessage == nil)
        #expect(store.errorMessage == nil)
        #expect(store.taskError == nil)
        #expect(store.calendarError == nil)
        #expect(store.briefError == nil)
        #expect(store.workError == nil)
        #expect(store.snoozedError == nil)
        // The pages still leave their loading state.
        #expect(store.mailDidLoad)
        #expect(store.briefDidLoad)
    }

    @Test
    func aReadFailureStaysOnItsOwnSurface() async {
        let tools = ScriptedTools { name, _, _ in
            switch name {
            case "tasks_get_board", "albatross_list_approval_queue", "calendar_list_events", "get_latest_daily_report":
                throw BackendError.server(status: 500, message: "boom")
            default:
                return .object([:])
            }
        }
        let store = makeStore(tools: tools)
        store.activeBoardID = nil

        await store.refreshToday()

        #expect(store.taskError == "boom")
        #expect(store.calendarError == "boom")
        #expect(store.briefError == "boom")
        #expect(store.todayError != nil)
        // No app-wide alert for a read (K11).
        #expect(store.errorMessage == nil)
    }

    // MARK: - Mail refresh (K10)

    @Test
    func theNewestMailRefreshWinsOverAnOlderResponse() async {
        let pages = PagedMail(
            pages: [page([thread("t5", epoch: 500), thread("t4", epoch: 400)])],
            holdingFetch: 0
        )
        let store = makeStore(tools: Self.quietTools(), mailPages: pages)

        let first = Task { await store.refreshMail() }
        await pages.waitUntilHeld()
        await store.refreshMail()
        #expect(store.threads.map(\.id) == ["t5", "t4"])

        await pages.release(page([thread("t9", epoch: 900)]))
        await first.value

        #expect(store.threads.map(\.id) == ["t5", "t4"])
        #expect(store.mailErrorMessage == nil)
    }

    @Test
    func aRefreshKeepsTheRowsPagedInBeneathTheFirstPage() async {
        let pages = PagedMail(pages: [
            page([thread("t1", epoch: 300), thread("t2", epoch: 200)], hasMore: true),
            page([thread("t3", epoch: 100)]),
            page([thread("t0", epoch: 400), thread("t1", epoch: 300)], hasMore: true),
        ])
        let store = makeStore(tools: Self.quietTools(), mailPages: pages)

        await store.refreshMail()
        await store.loadMoreMail()
        #expect(store.threads.map(\.id) == ["t1", "t2", "t3"])

        await store.refreshMail()
        #expect(store.threads.map(\.id) == ["t0", "t1", "t2", "t3"])
        #expect(store.hasMoreMail)
    }

    // MARK: - Cache (K8, flags)

    @Test
    func cachedMailAndABriefCountAsLoadedWhenTheNetworkIsDown() async throws {
        let cache = ProductCache(directory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
        let snapshot = ProductSnapshot(
            accounts: [],
            threads: [thread("t1", epoch: 300)],
            events: [],
            tasks: [],
            areas: [],
            approvals: [],
            suggestions: [],
            dailyBrief: "Cached brief",
            savedAt: Date(timeIntervalSince1970: 1_800_000_000)
        )
        try await cache.save(snapshot, owner: "user-1")
        let tools = ScriptedTools { _, _, _ in throw URLError(.notConnectedToInternet) }
        let store = makeStore(tools: tools, cache: cache)

        await store.bootstrap(cacheOwner: "user-1")

        #expect(store.threads.map(\.id) == ["t1"])
        #expect(store.dailyBrief == "Cached brief")
        #expect(store.mailDidLoad)
        #expect(store.briefDidLoad)
        #expect(store.mailErrorMessage != nil)
        #expect(store.errorMessage == nil)
        // Sign-out forgets the flags with the data.
        await store.clearForSignOut()
        #expect(!store.mailDidLoad)
        #expect(!store.briefDidLoad)
        #expect(store.threads.isEmpty)
    }

    @Test
    func theCacheWritesOnceAfterABurstAndOnFlush() async throws {
        let cache = ProductCache(directory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
        let pages = PagedMail(pages: [page([thread("t1", epoch: 300)]), page([thread("t2", epoch: 200)])])
        let store = makeStore(tools: Self.quietTools(), cache: cache, mailPages: pages)
        store.cacheWriteDelay = .seconds(30)

        // The bootstrap ends with one write.
        await store.bootstrap(cacheOwner: "user-1")
        #expect(try await cache.load(owner: "user-1")?.threads.map(\.id) == ["t1"])

        // A loader asks for a write; it waits for the burst to end.
        await store.refreshMail()
        #expect(store.threads.map(\.id) == ["t2"])
        #expect(try await cache.load(owner: "user-1")?.threads.map(\.id) == ["t1"])

        await store.flushCacheWrite()
        #expect(try await cache.load(owner: "user-1")?.threads.map(\.id) == ["t2"])
    }

    // MARK: - Return to the app (K3) and pushes (K2)

    @Test
    func aReturnToTheAppReadsAgainOnlyWhenTheDataIsStale() async {
        let tools = Self.quietTools()
        let store = makeStore(tools: tools)

        let firstRun = await store.refreshIfStale()
        #expect(firstRun)
        var reads = await tools.count(of: "list_accounts")
        #expect(reads == 1)
        #expect(store.lastRefresh != nil)

        let secondRun = await store.refreshIfStale()
        #expect(!secondRun)
        reads = await tools.count(of: "list_accounts")
        #expect(reads == 1)

        let agedRun = await store.refreshIfStale(maxAge: 0, now: Date().addingTimeInterval(1))
        #expect(agedRun)
        reads = await tools.count(of: "list_accounts")
        #expect(reads == 2)
    }

    @Test
    func aPushRefreshesOnlyItsDomainAndSkipsAFreshOneWhileActive() async {
        let tools = Self.quietTools()
        let store = makeStore(tools: tools)
        await store.refreshMail()
        var mailReads = await tools.count(of: "list_accounts")
        #expect(mailReads == 1)

        await store.refresh(for: RemoteRefreshPlan(domains: [.mail]), appIsActive: true)
        mailReads = await tools.count(of: "list_accounts")
        #expect(mailReads == 1)

        await store.refresh(for: RemoteRefreshPlan(domains: [.mail]), appIsActive: false)
        mailReads = await tools.count(of: "list_accounts")
        #expect(mailReads == 2)

        await store.refresh(for: RemoteRefreshPlan(domains: [.brief]), appIsActive: true)
        let briefReads = await tools.count(of: "get_latest_daily_report")
        mailReads = await tools.count(of: "list_accounts")
        let boardReads = await tools.count(of: "tasks_get_board")
        #expect(briefReads == 1)
        #expect(mailReads == 2)
        #expect(boardReads == 0)
    }

    // MARK: - Brief (B1, B2, B3)

    @Test
    func aNewerSelectedEditionBecomesTheLatest() async {
        let tools = ScriptedTools { name, arguments, _ in
            switch name {
            case "get_latest_daily_report":
                return Self.report("a", generatedAt: 1_000, status: "ready")
            case "get_daily_report":
                let id = arguments["id"]?.stringValue ?? ""
                return Self.report(id, generatedAt: id == "b" ? 2_000 : 500, status: "ready")
            default:
                return .object([:])
            }
        }
        let store = makeStore(tools: tools)

        await store.refreshBrief()
        #expect(store.latestDailyReportID == "a")

        await store.selectDailyReport(id: "b")
        #expect(store.dailyReport?.id == "b")
        #expect(store.latestDailyReportID == "b")
        #expect(store.showsLatestDailyReport)

        await store.selectDailyReport(id: "c")
        #expect(store.dailyReport?.id == "c")
        #expect(store.latestDailyReportID == "b")
        #expect(!store.showsLatestDailyReport)
    }

    @Test
    func theShownEditionIsReadAgainWhileTheServerStillWritesIt() async {
        let tools = ScriptedTools { name, _, _ in
            switch name {
            case "get_latest_daily_report", "get_daily_report":
                return Self.report("p", generatedAt: 1_000, status: "partial")
            default:
                return .object([:])
            }
        }
        let store = makeStore(tools: tools)

        await store.refreshBrief()
        await store.selectDailyReport(id: "p")
        let reads = await tools.count(of: "get_daily_report")
        #expect(reads == 1)
    }

    @Test
    func theHistoryListTellsAFailureFromAnEmptyList() async {
        let failing = ScriptedTools { name, _, _ in
            guard name == "list_daily_reports" else { return .object([:]) }
            throw BackendError.server(status: 500, message: "history down")
        }
        let store = makeStore(tools: failing)

        await store.loadDailyReportHistory()
        #expect(store.historyError == "history down")
        #expect(!store.historyDidLoad)
        #expect(store.dailyReportHistory.isEmpty)
        // The brief page is not told about the list.
        #expect(store.briefError == nil)

        let empty = makeStore(tools: ScriptedTools { _, _, _ in .object(["reports": .array([])]) })
        await empty.loadDailyReportHistory()
        #expect(empty.historyError == nil)
        #expect(empty.historyDidLoad)
        #expect(empty.dailyReportHistory.isEmpty)

        let cancelled = makeStore(tools: ScriptedTools { _, _, _ in throw URLError(.cancelled) })
        await cancelled.loadDailyReportHistory()
        #expect(cancelled.historyError == nil)
    }

    // MARK: - Feature audit items

    @Test
    func bulkTriageNamesTheMailboxOfEachThread() async {
        let tools = ScriptedTools { _, _, _ in .object(["verdicts": .array([])]) }
        let store = makeStore(tools: tools)

        _ = await store.bulkTriage([thread("t1", epoch: 300)])

        let items = await tools.arguments(of: "bulk_triage").first?["items"]?.arrayValue
        #expect(items?.first?["account"] == .string("acct-1"))
        #expect(items?.first?["id"] == .string("acct-1:t1"))
    }

    @Test
    func aSavedBoardTheServerNoLongerHasIsForgotten() async {
        let key = "albatross.tasks.active-board"
        let tools = ScriptedTools { name, arguments, _ in
            guard name == "tasks_get_board" else { return .object([:]) }
            if arguments["boardId"] != nil {
                throw BackendError.server(status: 500, message: "Board not found or access denied.")
            }
            return Self.emptyBoard
        }
        let store = makeStore(tools: tools)
        store.activeBoardID = "gone-board"
        UserDefaults.standard.set("gone-board", forKey: key)

        await store.refreshToday()

        #expect(store.activeBoardID == nil)
        #expect(UserDefaults.standard.string(forKey: key) == nil)
        #expect(store.tasksDidLoad)
        #expect(store.taskError == nil)
        let boardReads = await tools.count(of: "tasks_get_board")
        #expect(boardReads == 2)
    }

    @Test
    func anotherBoardFailureKeepsTheBoardAndRecordsIt() async {
        let tools = ScriptedTools { name, _, _ in
            guard name == "tasks_get_board" else { return .object([:]) }
            throw BackendError.server(status: 500, message: "Rate limited.")
        }
        let store = makeStore(tools: tools)
        store.activeBoardID = "board-1"

        await store.refreshToday()

        #expect(store.activeBoardID == "board-1")
        #expect(store.taskError == "Rate limited.")
        #expect(TaskBoardRecovery.isBoardGone(BackendError.server(status: 404, message: "x")))
        #expect(!TaskBoardRecovery.isBoardGone(URLError(.timedOut)))
    }

    @Test
    func theCalendarMirrorIsStaleUntilReadAndAfterItsAge() async {
        let store = makeStore(tools: Self.quietTools())
        #expect(store.isCalendarMirrorStale())

        await store.refreshCalendar()
        #expect(!store.isCalendarMirrorStale())
        #expect(store.calendarDidLoad)

        store.calendarMirrorMaxAge = 0
        #expect(store.isCalendarMirrorStale(now: Date().addingTimeInterval(1)))
    }
}
