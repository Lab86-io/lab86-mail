import Foundation
import Testing
@testable import Lab86Mail

private struct NoopSpotlight: MailSpotlightIndexing {
    func replace(owner: String, accounts: [AccountSummary], threads: [MailThreadSummary]) async {}
    func remove(owner: String) async {}
}

// The typed unified-inbox pages: first page replaces, later pages append
// beneath, and the legacy per-account tool path stays the fallback.
@MainActor
struct MailPagingTests {
    private actor PagedMailStub: MailPageFetching {
        private var pages: [MailListPage]
        private(set) var requestedCursors: [String?] = []

        init(pages: [MailListPage]) {
            self.pages = pages
        }

        func fetchMailThreads(
            accountID: String?,
            category: String?,
            cursor: String?,
            limit: Int
        ) async throws -> MailListPage {
            requestedCursors.append(cursor)
            guard !pages.isEmpty else {
                return MailListPage(items: [], nextCursor: nil, hasMore: false)
            }
            return pages.removeFirst()
        }

        func cursors() -> [String?] { requestedCursors }
    }

    private actor AccountsOnlyTools: ToolInvoking {
        let threadsByAccount: [String: JSONValue]

        init(threadsByAccount: [String: JSONValue] = [:]) {
            self.threadsByAccount = threadsByAccount
        }

        func invoke(_ name: String, arguments: [String: JSONValue]) async throws -> JSONValue {
            switch name {
            case "list_accounts":
                return .object([
                    "accounts": .array([
                        .object([
                            "email": .string("owner@example.com"),
                            "provider": .string("google"),
                            "authed": .bool(true),
                            "accountId": .string("account-1"),
                        ])
                    ])
                ])
            case "list_account_threads":
                let account = arguments["account"]?.stringValue ?? ""
                return threadsByAccount[account] ?? .object(["threads": .array([])])
            default:
                return .object([:])
            }
        }
    }

    private func summary(_ id: String, epoch: TimeInterval) -> MailThreadSummary {
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

    @Test
    func refreshUsesTheTypedPageAndKeepsTheCursor() async {
        let pages = PagedMailStub(pages: [
            MailListPage(
                items: [summary("t1", epoch: 2_000_000_100), summary("t2", epoch: 2_000_000_000)],
                nextCursor: "2000000000000",
                hasMore: true
            )
        ])
        let store = ProductStore(
            tools: AccountsOnlyTools(),
            backend: BackendClient(baseURL: nil),
            spotlight: NoopSpotlight(),
            mailPages: pages
        )

        await store.refreshMail()

        #expect(store.threads.map(\.id) == ["t1", "t2"])
        #expect(store.hasMoreMail)
        #expect(store.mailErrorMessage == nil)
    }

    @Test
    func loadMoreAppendsDedupesAndAdvancesTheCursor() async {
        let pages = PagedMailStub(pages: [
            MailListPage(
                items: [summary("t1", epoch: 2_000_000_100), summary("t2", epoch: 2_000_000_000)],
                nextCursor: "2000000000000",
                hasMore: true
            ),
            MailListPage(
                items: [summary("t2", epoch: 2_000_000_000), summary("t3", epoch: 1_999_999_900)],
                nextCursor: nil,
                hasMore: false
            ),
        ])
        let store = ProductStore(
            tools: AccountsOnlyTools(),
            backend: BackendClient(baseURL: nil),
            spotlight: NoopSpotlight(),
            mailPages: pages
        )

        await store.refreshMail()
        await store.loadMoreMail()

        #expect(store.threads.map(\.id) == ["t1", "t2", "t3"])
        #expect(!store.hasMoreMail)
        let cursors = await pages.cursors()
        #expect(cursors == [nil, "2000000000000"])

        // The cursor is spent; another call must not fetch again.
        await store.loadMoreMail()
        #expect(store.threads.count == 3)
    }

    @Test
    func anEmptyFirstPageFallsBackToThePerAccountRead() async {
        let pages = PagedMailStub(pages: [
            MailListPage(items: [], nextCursor: nil, hasMore: false)
        ])
        let legacyRows = JSONValue.object([
            "threads": .array([
                .object([
                    "_id": .string("legacy-1"),
                    "subject": .string("From the fallback path"),
                    "fromAddress": .string("Sender <sender@example.com>"),
                    "lastDate": .number(2_000_000_000_000),
                    "snippet": .string("Snippet"),
                    "unread": .bool(true),
                ])
            ])
        ])
        let store = ProductStore(
            tools: AccountsOnlyTools(threadsByAccount: ["account-1": legacyRows]),
            backend: BackendClient(baseURL: nil),
            spotlight: NoopSpotlight(),
            mailPages: pages
        )

        await store.refreshMail()

        #expect(store.threads.map(\.id) == ["legacy-1"])
        #expect(!store.hasMoreMail)
    }


    @Test
    func anEmptyLiveTickKeepsThePagedList() async {
        let pages = PagedMailStub(pages: [
            MailListPage(
                items: [summary("t1", epoch: 2_000_000_100)],
                nextCursor: "2000000100000",
                hasMore: true
            ),
            MailListPage(
                items: [summary("t2", epoch: 2_000_000_000)],
                nextCursor: nil,
                hasMore: false
            ),
        ])
        let store = ProductStore(
            tools: AccountsOnlyTools(),
            backend: BackendClient(baseURL: nil),
            spotlight: NoopSpotlight(),
            mailPages: pages
        )
        await store.refreshMail()
        await store.loadMoreMail()
        #expect(store.threads.map(\.id) == ["t1", "t2"])

        // A live window with no rows must not blank a partially paged inbox.
        await store.applyLiveMail(LiveMailThreadsPayload(items: []))
        #expect(store.threads.map(\.id) == ["t1", "t2"])
    }

    @Test
    func theLoadMoreRowOnlyPagesTheUnfilteredUnifiedList() {
        #expect(MailView.showsLoadMoreRow(hasMore: true, accountScope: [], query: ""))
        #expect(!MailView.showsLoadMoreRow(hasMore: false, accountScope: [], query: ""))
        // A single-account filter narrows locally; unified pages may add nothing visible.
        #expect(!MailView.showsLoadMoreRow(hasMore: true, accountScope: ["account-1"], query: ""))
        // Mailbox scopes (Unread, Starred) and search ride the query, not just the search field.
        #expect(!MailView.showsLoadMoreRow(hasMore: true, accountScope: [], query: "is:unread"))
    }
}
