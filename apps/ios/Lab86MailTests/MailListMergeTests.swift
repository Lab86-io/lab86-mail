import Foundation
import Testing
@testable import Lab86Mail

// The first-page merge rule (K10) and the recent-key cap for cached details (K8).
struct MailListMergeTests {
    private func thread(_ id: String, epoch: TimeInterval, account: String = "acct") -> MailThreadSummary {
        MailThreadSummary(
            id: id,
            accountID: account,
            subject: "Subject \(id)",
            sender: "sender@example.com",
            snippet: "",
            date: Date(timeIntervalSince1970: epoch),
            unread: false,
            starred: false
        )
    }

    @Test
    func rowsPagedInBeneathTheFirstPageSurviveARefresh() {
        let existing = [thread("t1", epoch: 300), thread("t2", epoch: 200), thread("t3", epoch: 100)]
        let page = [thread("t0", epoch: 400), thread("t1", epoch: 300)]
        let merged = MailListMerge.replacingFirstPage(existing: existing, firstPage: page)
        #expect(merged.map(\.id) == ["t0", "t1", "t2", "t3"])
    }

    @Test
    func aRowInsideThePageWindowThatThePageLeftOutIsGone() {
        // t2 sits between the page's rows in time, so the page judged it: archived.
        let existing = [thread("t1", epoch: 300), thread("t2", epoch: 250), thread("t3", epoch: 100)]
        let page = [thread("t1", epoch: 300), thread("t4", epoch: 200)]
        let merged = MailListMerge.replacingFirstPage(existing: existing, firstPage: page)
        #expect(merged.map(\.id) == ["t1", "t4", "t3"])
    }

    @Test
    func anEmptyPageKeepsNothing() {
        let existing = [thread("t1", epoch: 300)]
        #expect(MailListMerge.pagedTail(existing: existing, firstPage: []).isEmpty)
        #expect(MailListMerge.replacingFirstPage(existing: existing, firstPage: []).isEmpty)
    }

    @Test
    func thePageWinsACollisionAndOtherAccountsKeepTheirRows() {
        let stale = thread("t1", epoch: 300)
        var fresh = thread("t1", epoch: 300)
        fresh.unread = true
        let other = thread("t1", epoch: 50, account: "other")
        let merged = MailListMerge.replacingFirstPage(existing: [stale, other], firstPage: [fresh])
        #expect(merged.count == 2)
        #expect(merged.first?.unread == true)
        #expect(merged.last?.accountID == "other")
    }

    @Test
    func recentKeysKeepTheNewestAndDropTheOldest() {
        var recent = RecentKeys(limit: 2)
        let droppedA = recent.touch("a")
        let droppedB = recent.touch("b")
        let droppedC = recent.touch("c")
        #expect(droppedA.isEmpty)
        #expect(droppedB.isEmpty)
        #expect(droppedC == ["a"])
        // Touching an old key moves it to the front.
        let droppedAgain = recent.touch("b")
        #expect(droppedAgain.isEmpty)
        #expect(recent.keys == ["c", "b"])
        let trimmed = recent.trimmed(["a": 1, "b": 2, "c": 3])
        #expect(trimmed == ["b": 2, "c": 3])
        // Under the limit nothing is dropped, known or not.
        #expect(recent.trimmed(["z": 9, "b": 2]) == ["z": 9, "b": 2])
    }
}
