import Foundation
import Testing
@testable import Lab86Mail

// The mail list's states and row helpers (iOS refresh 2026-10-24): loading
// before the first read and while a search waits (M4, M5), Load more after a
// failed page (M8), account-qualified row identity, the status words, and
// the unread counts of the strip.
struct MailListStateTests {
    private static func thread(
        _ id: String,
        category: String? = "main",
        secondary: [String]? = nil,
        labels: [String]? = nil,
        starred: Bool = false,
        account: String = "acct-1"
    ) -> MailThreadSummary {
        MailThreadSummary(
            id: id,
            accountID: account,
            subject: "Subject",
            sender: "Sarah Chen <sarah.chen@northwind.example>",
            snippet: "Snippet",
            date: Date(timeIntervalSince1970: 1_000),
            unread: true,
            starred: starred,
            category: category,
            secondaryCategories: secondary,
            labelIDs: labels
        )
    }

    private static let labels = [
        MailLabelSummary(id: "label-receipts", name: "Receipts"),
        MailLabelSummary(id: "label-school", name: "School"),
    ]

    // MARK: - Placeholder

    @Test
    func anEmptyListLoadsUntilTheFirstMailReadEnds() {
        let before = MailListPlaceholder.resolve(
            mailDidLoad: false, searchPending: false, query: "", showsLoadMore: false, mailbox: .inbox, searchText: ""
        )
        #expect(before == .loading("Loading mail…"))
        let after = MailListPlaceholder.resolve(
            mailDidLoad: true, searchPending: false, query: "", showsLoadMore: false, mailbox: .inbox, searchText: ""
        )
        #expect(after == .empty(MailEmptyCopy(title: "No mail here", detail: "Pull down to refresh, or choose another account or view.")))
    }

    @Test
    func aQueryShowsSearchingUntilTheServerAnswers() {
        let pending = MailListPlaceholder.resolve(
            mailDidLoad: true, searchPending: true, query: "is:unread", showsLoadMore: false, mailbox: .unread, searchText: ""
        )
        #expect(pending == .loading("Searching…"))
        let answered = MailListPlaceholder.resolve(
            mailDidLoad: true, searchPending: false, query: "is:unread", showsLoadMore: false, mailbox: .unread, searchText: ""
        )
        #expect(answered == .empty(MailEmptyCopy(title: "Nothing unread", detail: "You have opened everything.")))
        // A mailbox query waits even when the first inbox read has not ended.
        let early = MailListPlaceholder.resolve(
            mailDidLoad: false, searchPending: true, query: "in:sent", showsLoadMore: false, mailbox: .sent, searchText: ""
        )
        #expect(early == .loading("Searching…"))
    }

    @Test
    func olderPagesKeepTheListAskingBeforeItIsCalledEmpty() {
        let placeholder = MailListPlaceholder.resolve(
            mailDidLoad: true, searchPending: false, query: "", showsLoadMore: true, mailbox: .inbox, searchText: ""
        )
        #expect(placeholder == .loadMore)
    }

    @Test
    func searchPendingEndsWithAnAnswerOrWithTheRequest() {
        #expect(!MailSearchPending.isPending(query: "", completedQuery: nil, answeredQuery: nil))
        #expect(MailSearchPending.isPending(query: "invoice", completedQuery: nil, answeredQuery: nil))
        #expect(MailSearchPending.isPending(query: "invoice", completedQuery: "inv", answeredQuery: "inv"))
        #expect(!MailSearchPending.isPending(query: "invoice", completedQuery: "invoice", answeredQuery: nil))
        // The request ended without an answer (a failure): not pending.
        #expect(!MailSearchPending.isPending(query: "invoice", completedQuery: nil, answeredQuery: "invoice"))
    }

    @Test
    func emptyCopyNamesTheViewAndTheNextAction() {
        #expect(MailEmptyCopy.make(mailbox: .inbox, searchText: "priya").title == "No matching mail")
        #expect(MailEmptyCopy.make(mailbox: .starred, searchText: "").title == "Nothing starred")
        #expect(MailEmptyCopy.make(mailbox: .drafts, searchText: "").title == "No drafts")
        #expect(MailEmptyCopy.make(mailbox: .trash, searchText: "").title == "Trash is empty")
        for mailbox in MailboxScope.allCases {
            let copy = MailEmptyCopy.make(mailbox: mailbox, searchText: "")
            #expect(!copy.title.isEmpty)
            #expect(!copy.detail.isEmpty)
            #expect(!copy.title.contains("·"))
        }
    }

    @Test
    func emptyCopyNamesACategoryViewAndWhatBelongsInIt() {
        let needsReply = MailEmptyCopy.make(mailbox: .inbox, selection: MailScopeSelection(category: .needsReply), searchText: "")
        #expect(needsReply == MailEmptyCopy(title: "Nothing in Needs reply", detail: "Mail that waits on your reply shows here."))
        let codes = MailEmptyCopy.make(mailbox: .inbox, selection: MailScopeSelection(category: .codes), searchText: "")
        #expect(codes.title == "Nothing in Codes")
        // Main is the inbox itself.
        #expect(MailEmptyCopy.make(mailbox: .inbox, selection: MailScopeSelection(category: .main), searchText: "").title == "No mail here")
        // A label view names the label.
        let label = MailEmptyCopy.make(
            mailbox: .inbox, selection: MailScopeSelection.from(raw: "custom:label-school"), labelName: "School", searchText: ""
        )
        #expect(label.title == "Nothing in School")
        // A mailbox comes before the view; a search comes before both.
        #expect(MailEmptyCopy.make(mailbox: .unread, selection: MailScopeSelection(category: .codes), searchText: "").title == "Nothing unread")
        #expect(MailEmptyCopy.make(mailbox: .inbox, selection: MailScopeSelection(category: .codes), searchText: "x").title == "No matching mail")
        for scope in MailCategoryScope.primary + MailCategoryScope.more where scope != .main {
            #expect(MailEmptyCopy.viewDetail(scope)?.isEmpty == false)
        }
    }

    // MARK: - Load more

    @Test
    func aPageThatMovesNoCursorWhileMoreRemainsIsAFailure() {
        #expect(MailLoadMoreOutcome.failed(tokenBefore: "a|1", tokenAfter: "a|1", hasMore: true, isLoading: false))
        // The cursor moved: the page arrived.
        #expect(!MailLoadMoreOutcome.failed(tokenBefore: "a|1", tokenAfter: "a|2", hasMore: true, isLoading: false))
        // The scope ended: nothing more to ask for.
        #expect(!MailLoadMoreOutcome.failed(tokenBefore: "a|1", tokenAfter: "a|1", hasMore: false, isLoading: false))
        // Another load still runs: wait for it.
        #expect(!MailLoadMoreOutcome.failed(tokenBefore: "a|1", tokenAfter: "a|1", hasMore: true, isLoading: true))
    }

    // MARK: - Row identity

    @Test
    func rowIdentityQualifiesTheThreadIDWithItsAccount() {
        let direct = Self.thread("t-1", account: "acct-google")
        let relay = Self.thread("t-1", account: "acct-nylas")
        #expect(direct.id == relay.id)
        #expect(direct.listKey != relay.listKey)
        #expect(direct.listKey == "acct-google|t-1")
    }

    // MARK: - Status words

    @Test
    func rowWordsSayWhatTheThreadNeedsAndCarries() {
        let main = MailScopeSelection(category: .main)
        let asked = Self.thread("a", secondary: ["needs_reply"], labels: ["label-receipts"], starred: true)
        #expect(MailRowBadges.labels(for: asked, selection: main, labels: Self.labels) == ["Needs reply", "Starred", "Receipts"])
        let primary = Self.thread("b", category: "needs_reply")
        #expect(MailRowBadges.labels(for: primary, selection: main, labels: Self.labels) == ["Needs reply"])
        let plain = Self.thread("c")
        #expect(MailRowBadges.labels(for: plain, selection: main, labels: Self.labels).isEmpty)
    }

    @Test
    func rowWordsLeaveOutWhatTheViewAlreadyStates() {
        let asked = Self.thread("a", secondary: ["needs_reply"], labels: ["label-school"])
        let needsReply = MailScopeSelection(category: .needsReply)
        #expect(MailRowBadges.labels(for: asked, selection: needsReply, labels: Self.labels) == ["School"])
        let school = MailScopeSelection.from(raw: "custom:label-school")
        #expect(MailRowBadges.labels(for: asked, selection: school, labels: Self.labels) == ["Needs reply"])
    }

    @Test
    func rowWordsNameAFiledLabelOnceAndSkipUnknownLabels() {
        let filed = Self.thread("f", category: "custom:label-receipts", labels: ["label-receipts", "label-gone"])
        let main = MailScopeSelection(category: .main)
        #expect(MailRowBadges.labels(for: filed, selection: main, labels: Self.labels) == ["Receipts"])
    }

    @Test
    func rowWordsStopAtThree() {
        let many = Self.thread("m", secondary: ["needs_reply"], labels: ["label-receipts", "label-school"], starred: true)
        let words = MailRowBadges.labels(for: many, selection: MailScopeSelection(category: .main), labels: Self.labels)
        #expect(words.count == MailRowBadges.limit)
        #expect(words == ["Needs reply", "Starred", "Receipts"])
    }

    // MARK: - Counts

    @Test
    func countBadgeFollowsTheWebRule() {
        #expect(MailCategoryCountBadge.label(nil) == nil)
        #expect(MailCategoryCountBadge.label(0) == nil)
        #expect(MailCategoryCountBadge.label(7.4) == "7")
        #expect(MailCategoryCountBadge.label(99) == "99")
        #expect(MailCategoryCountBadge.label(100) == nil)
        #expect(MailCategoryCountBadge.label(250) == nil)
    }

    @Test
    func countsPayloadDecodesTheConvexShape() throws {
        let json = #"{"counts":{"main":{"unread":3,"attention":true},"needs_reply":{"unread":1}},"cap":99}"#
        let payload = try JSONDecoder().decode(MailCategoryCountsPayload.self, from: Data(json.utf8))
        #expect(payload.counts["main"]?.unread == 3)
        #expect(payload.counts["main"]?.attention == true)
        #expect(payload.counts["needs_reply"]?.unread == 1)
        #expect(payload.counts["needs_reply"]?.attention == nil)
    }

    @Test @MainActor
    func countsModelAnswersByScope() throws {
        let json = #"{"counts":{"main":{"unread":3},"codes":{"unread":120},"noise":{"unread":0}}}"#
        let payload = try JSONDecoder().decode(MailCategoryCountsPayload.self, from: Data(json.utf8))
        let model = MailCategoryCountsModel()
        model.apply(payload)
        #expect(model.badge(for: .main) == "3")
        #expect(model.badge(for: .codes) == nil)
        #expect(model.badge(for: .noise) == nil)
        #expect(model.badge(for: .needsReply) == nil)
    }

    // MARK: - Avatar size

    @Test
    func avatarFollowsTheTextToACap() {
        #expect(SenderAvatar.resolvedSize(scaled: 40, base: 40) == 40)
        #expect(SenderAvatar.resolvedSize(scaled: 48, base: 40) == 48)
        // AX3 scales body text about three times; the mark stops at 1.4x.
        #expect(SenderAvatar.resolvedSize(scaled: 124, base: 40) == 56)
        #expect(SenderAvatar.resolvedSize(scaled: 124, base: 30) == 42)
    }
}
