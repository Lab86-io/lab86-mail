import Foundation
import Testing
@testable import Lab86Mail

// NAT-2, NAT-3, NAT-4, CLS-9, MUT-1 (audit 2026-09-26): category, label, and
// account views page from the server with one cursor each; Codes and Orders
// follow the web rule; labels are mail views; Noise is a correction; a
// snoozed thread stays hidden.
@MainActor
struct MailScopeTests {
    private struct Request: Equatable, Sendable {
        let accountID: String?
        let category: String?
        let cursor: String?
    }

    private actor ScopedPages: MailPageFetching {
        private let pages: [String: [MailListPage]]
        private var served: [String: Int] = [:]
        private(set) var requests: [Request] = []

        init(pages: [String: [MailListPage]]) {
            self.pages = pages
        }

        func fetchMailThreads(
            accountID: String?,
            category: String?,
            cursor: String?,
            limit: Int
        ) async throws -> MailListPage {
            requests.append(Request(accountID: accountID, category: category, cursor: cursor))
            let key = "\(accountID ?? "*")/\(category ?? "*")"
            let index = served[key, default: 0]
            served[key] = index + 1
            let list = pages[key] ?? []
            return index < list.count ? list[index] : MailListPage(items: [], nextCursor: nil, hasMore: false)
        }

        func all() -> [Request] { requests }
    }

    private struct NoopSpotlight: MailSpotlightIndexing {
        func replace(owner: String, accounts: [AccountSummary], threads: [MailThreadSummary]) async {}
        func remove(owner: String) async {}
    }

    private static func thread(
        _ id: String,
        epoch: TimeInterval,
        category: String? = nil,
        secondary: [String]? = nil,
        labels: [String]? = nil,
        account: String = "account-1"
    ) -> MailThreadSummary {
        MailThreadSummary(
            id: id,
            accountID: account,
            subject: "Subject \(id)",
            sender: "Sender <sender@example.com>",
            snippet: "Snippet",
            date: Date(timeIntervalSince1970: epoch),
            unread: false,
            starred: false,
            category: category,
            secondaryCategories: secondary,
            labelIDs: labels
        )
    }

    private static let accountsAndLabels = RecordingTools { name, _ in
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
        case "list_smart_labels":
            return .object(["custom": .array([
                .object(["_id": .string("dev"), "name": .string("Dev/Ops"), "enabled": .bool(true), "sidebarVisible": .bool(true)]),
                .object(["_id": .string("hidden"), "name": .string("Hidden"), "sidebarVisible": .bool(false)]),
                .object(["_id": .string("off"), "name": .string("Off"), "enabled": .bool(false)]),
            ])])
        default:
            return .object([:])
        }
    }

    @Test
    func aCategoryScopePagesTheServerWithItsOwnCursor() async {
        let pages = ScopedPages(pages: [
            "*/*": [MailListPage(items: [Self.thread("u1", epoch: 3_000, category: "main")], nextCursor: "3000000", hasMore: true)],
            "*/codes": [
                MailListPage(items: [Self.thread("c1", epoch: 1_000, category: "codes")], nextCursor: "1000000", hasMore: true),
                MailListPage(items: [Self.thread("c2", epoch: 500, category: "codes")], nextCursor: nil, hasMore: false),
            ],
        ])
        let store = ProductStore(
            tools: Self.accountsAndLabels,
            backend: BackendClient(baseURL: nil),
            spotlight: NoopSpotlight(),
            mailPages: pages
        )
        await store.refreshMail()
        let codes = MailScopeSelection(category: .codes).listScope(accountScope: [])
        #expect(codes == MailListScope(accountID: nil, category: "codes"))

        await store.loadMailScope(codes)
        #expect(store.hasMoreMail(in: codes))
        // The unified cursor is its own; the category page does not move it.
        #expect(store.hasMoreMail(in: .unified))
        await store.loadMoreMail(in: codes)
        #expect(!store.hasMoreMail(in: codes))

        let requests = await pages.all()
        #expect(requests == [
            Request(accountID: nil, category: nil, cursor: nil),
            Request(accountID: nil, category: "codes", cursor: nil),
            Request(accountID: nil, category: "codes", cursor: "1000000"),
        ])
        let selection = MailScopeSelection(category: .codes)
        #expect(store.threads.filter(selection.includes).map(\.id) == ["c1", "c2"])

        // A loaded scope does not ask for its first page again.
        await store.loadMailScope(codes)
        #expect(await pages.all().count == 3)
    }

    @Test
    func oneAccountAndALabelSendTheirScopeToTheServer() async {
        let pages = ScopedPages(pages: [:])
        let store = ProductStore(
            tools: Self.accountsAndLabels,
            backend: BackendClient(baseURL: nil),
            spotlight: NoopSpotlight(),
            mailPages: pages
        )
        let mainOneAccount = MailScopeSelection(category: .main).listScope(accountScope: ["account-1"])
        #expect(mainOneAccount == MailListScope(accountID: "account-1", category: nil))
        let label = MailScopeSelection.from(raw: "custom:dev").listScope(accountScope: [])
        #expect(label == MailListScope(accountID: nil, category: "custom:dev"))
        // Several accounts stay a local filter over the unified list.
        #expect(MailScopeSelection(category: .main).listScope(accountScope: ["a", "b"]) == .unified)

        await store.loadMailScope(mainOneAccount)
        await store.loadMailScope(label)
        await store.loadMailScope(.unified)
        let requests = await pages.all()
        #expect(requests == [
            Request(accountID: "account-1", category: nil, cursor: nil),
            Request(accountID: nil, category: "custom:dev", cursor: nil),
        ])
    }

    @Test
    func refreshResetsEveryScopeCursor() async {
        let pages = ScopedPages(pages: [
            "*/orders": [
                MailListPage(items: [Self.thread("o1", epoch: 100, category: "orders")], nextCursor: "100000", hasMore: true),
            ],
        ])
        let store = ProductStore(
            tools: Self.accountsAndLabels,
            backend: BackendClient(baseURL: nil),
            spotlight: NoopSpotlight(),
            mailPages: pages
        )
        let orders = MailListScope(accountID: nil, category: "orders")
        await store.loadMailScope(orders)
        let token = store.mailCursorToken(in: orders)
        #expect(store.hasMoreMail(in: orders))
        await store.refreshMail()
        #expect(!store.hasMoreMail(in: orders))
        #expect(store.mailCursorToken(in: orders) != token)
    }

    @Test
    func sidebarLabelsAreEnabledAndVisibleOnly() async {
        let store = ProductStore(tools: Self.accountsAndLabels, backend: BackendClient(baseURL: nil))
        await store.refreshMailLabels()
        #expect(store.mailLabels == [MailLabelSummary(id: "dev", name: "Dev/Ops")])
        #expect(store.mailLabels.first?.rawCategory == "custom:dev")
    }

    @Test
    func codesAndOrdersFollowTheWebRuleIncludingSecondary() {
        let receipt = Self.thread("r", epoch: 1, category: "main", secondary: ["orders"])
        #expect(MailScopeSelection(category: .orders).includes(receipt))
        #expect(MailScopeSelection(category: .main).includes(receipt))
        #expect(!MailScopeSelection(category: .codes).includes(receipt))
        // Filed mail leaves every built-in view except All Mail.
        let filed = Self.thread("f", epoch: 1, category: "custom:dev", secondary: ["codes"])
        #expect(!MailScopeSelection(category: .codes).includes(filed))
        #expect(MailScopeSelection(category: .all).includes(filed))
    }

    @Test
    func aLabelViewShowsFiledAndTaggedMail() {
        let label = MailScopeSelection.from(raw: "custom:dev")
        #expect(label.labelID == "dev")
        #expect(label.includes(Self.thread("f", epoch: 1, category: "custom:dev")))
        #expect(label.includes(Self.thread("t", epoch: 1, category: "main", labels: ["dev"])))
        #expect(!label.includes(Self.thread("o", epoch: 1, category: "main", labels: ["other"])))
        #expect(MailScopeSelection.from(raw: "orders") == MailScopeSelection(category: .orders))
        #expect(MailScopeSelection.from(raw: "custom:") == MailScopeSelection(category: .main))
    }

    @Test
    func liveAndToolRowsReadFiledUnderSecondaryAndLabels() throws {
        let json: JSONValue = .object([
            "providerThreadId": .string("t1"),
            "accountId": .string("account-1"),
            "smartCategory": .object([
                "primary": .string("main"),
                "filedUnder": .string("dev"),
                "secondary": .array([.string("orders")]),
                "customLabels": .array([.string("dev")]),
            ]),
        ])
        let summary = try #require(MailThreadSummary(json: json))
        #expect(summary.category == "custom:dev")
        #expect(summary.secondaryCategories == ["orders"])
        #expect(summary.labelIDs == ["dev"])

        let live = try JSONDecoder().decode(
            LiveMailThreadPayload.self,
            from: Data(#"{"accountId":"a","providerThreadId":"t","smartCategory":{"primary":"main","secondary":["codes"],"customLabels":["x"]}}"#.utf8)
        ).summary
        #expect(live.category == "main")
        #expect(live.secondaryCategories == ["codes"])
        #expect(live.labelIDs == ["x"])
        #expect(MailScopeSelection(category: .codes).includes(live))
    }

    @Test
    func noiseCorrectionSendsAlwaysNoise() {
        let noise = MailCategoryCorrection.noise.arguments(accountID: "a", threadID: "t")
        #expect(noise["action"] == .string("always_noise"))
        #expect(noise["category"] == nil)
        let orders = MailCategoryCorrection.orders.arguments(accountID: "a", threadID: "t")
        #expect(orders["action"] == .string("move_to"))
        #expect(orders["category"] == .string("orders"))
        #expect(orders["scope"] == .string("sender"))
    }

    @Test
    func aSnoozedThreadStaysHiddenWhenTheListRefreshes() async throws {
        let target = Self.thread("s1", epoch: 2_000)
        let pages = ScopedPages(pages: [
            "*/*": [
                MailListPage(items: [target], nextCursor: nil, hasMore: false),
                MailListPage(items: [target], nextCursor: nil, hasMore: false),
            ],
        ])
        let queue = FakeMailCommandQueue()
        let store = ProductStore(
            tools: Self.accountsAndLabels,
            backend: BackendClient(baseURL: nil),
            spotlight: NoopSpotlight(),
            mailPages: pages,
            mailCommands: queue
        )
        await store.refreshMail()
        #expect(store.threads.map(\.id) == ["s1"])
        let until = Date.now.addingTimeInterval(3_600)
        await store.snooze(target, until: until)
        // Snooze needs no message: the server acts on the whole thread.
        #expect(queue.sentCommands == [
            .mailSnooze(MailSnoozeCommandPayload(accountID: "account-1", threadID: "s1", untilAt: until)),
        ])
        #expect(store.mailErrorMessage == nil)
        #expect(store.threads.isEmpty)
        await store.refreshMail()
        #expect(store.threads.isEmpty)
    }

    @Test
    func aSnoozedThreadComesBackWhenItsTimePasses() async throws {
        let target = Self.thread("s2", epoch: 2_000)
        let pages = ScopedPages(pages: [
            "*/*": [
                MailListPage(items: [target], nextCursor: nil, hasMore: false),
                MailListPage(items: [target], nextCursor: nil, hasMore: false),
            ],
        ])
        let store = ProductStore(
            tools: Self.accountsAndLabels,
            backend: BackendClient(baseURL: nil),
            spotlight: NoopSpotlight(),
            mailPages: pages,
            mailCommands: FakeMailCommandQueue()
        )
        await store.refreshMail()
        // The server brings the thread back at its time; after that the list shows it.
        await store.snooze(target, until: .now.addingTimeInterval(-1))
        #expect(store.threads.isEmpty)
        await store.refreshMail()
        #expect(store.threads.map(\.id) == ["s2"])
    }

    @Test
    func aMailboxThatNeedsToReconnectIsNotAMailAccount() async {
        let tools = RecordingTools { name, _ in
            switch name {
            case "list_accounts":
                return .object(["accounts": .array([
                    .object(["email": .string("live@example.com"), "provider": .string("google"), "authed": .bool(true), "accountId": .string("live")]),
                    .object([
                        "email": .string("dead@example.com"), "provider": .string("microsoft"), "authed": .bool(false),
                        "accountId": .string("dead"), "reconnectReason": .string("Grant expired"),
                    ]),
                ])])
            default:
                return .object(["threads": .array([])])
            }
        }
        let store = ProductStore(tools: tools, backend: BackendClient(baseURL: nil))
        await store.refreshMail()
        #expect(store.accounts.map(\.id) == ["live"])
        #expect(store.reconnectAccounts.map(\.id) == ["dead"])
        #expect(store.reconnectAccounts.first?.reconnectReason == "Grant expired")
        // The dead mailbox is not read.
        let reads = await tools.arguments(of: "list_account_threads")
        #expect(reads.map { $0["account"] } == [.string("live")])
    }
}
