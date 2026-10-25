import AuthenticationServices
import Foundation
import Testing
@testable import Lab86Mail

// Small reliability rules from the crash and feature audits: the Siri send
// keeps its thread, the Spotlight delta, a number that must not trap, and
// the browser cancel that is not an error.
struct CoreReliabilityTests {
    @Test
    func aSiriSendOfAReplyDraftAnswersTheThread() {
        let reply = MailEntityReference(kind: .draft, accountID: "acct-1", threadID: "thr-1", messageID: "msg-1", localID: "d1")
        let fields = MailIntentService.sendFields(
            accountID: "acct-1", to: "a@example.com", cc: "", bcc: "", subject: "Re: Hi", body: "Yes",
            reference: reply, later: nil
        )
        #expect(fields["mode"] == "reply")
        #expect(fields["threadId"] == "thr-1")
        #expect(fields["messageId"] == "msg-1")
        #expect(fields["sendAt"] == nil)

        let fresh = MailEntityReference(kind: .draft, accountID: "acct-1", localID: "d2")
        let later = Date(timeIntervalSince1970: 1_800_000_000)
        let newFields = MailIntentService.sendFields(
            accountID: "acct-1", to: "a@example.com", cc: "", bcc: "", subject: "Hi", body: "Hello",
            reference: fresh, later: later
        )
        #expect(newFields["mode"] == "new")
        #expect(newFields["threadId"] == nil)
        #expect(newFields["sendAt"] == "1800000000000")
    }

    @Test
    func aDraftReferenceRoundTripsItsThread() throws {
        let reference = MailEntityReference(kind: .draft, accountID: "acct-1", threadID: "thr-1", messageID: "msg-1", localID: "d1")
        let decoded = try #require(MailEntityReference(identifier: reference.identifier))
        #expect(decoded.threadID == "thr-1")
        #expect(decoded.messageID == "msg-1")
        #expect(decoded.localID == "d1")
    }

    private func thread(_ id: String, epoch: TimeInterval, subject: String = "S") -> MailThreadSummary {
        MailThreadSummary(
            id: id, accountID: "acct-1", subject: subject, sender: "a@example.com", snippet: "",
            date: Date(timeIntervalSince1970: epoch), unread: false, starred: false
        )
    }

    @Test
    func theSpotlightDeltaWritesOnlyWhatChanged() throws {
        let account = try #require(AccountSummary(json: .object([
            "email": .string("owner@example.com"), "provider": .string("google"),
            "authed": .bool(true), "accountId": .string("acct-1"),
        ])))
        let first = MailSpotlightDelta.records(owner: "user-1", accounts: [account], threads: [
            thread("t1", epoch: 300), thread("t2", epoch: 200),
        ])
        let initial = MailSpotlightDelta.plan(previous: nil, next: first)
        #expect(initial.clearsDomain)
        #expect(initial.removedIdentifiers.isEmpty)
        #expect(initial.changed.count == 2)

        // The same list again writes nothing.
        #expect(MailSpotlightDelta.plan(previous: first, next: first).isEmpty)

        let second = MailSpotlightDelta.records(owner: "user-1", accounts: [account], threads: [
            thread("t1", epoch: 300, subject: "Renamed"), thread("t3", epoch: 100),
        ])
        let delta = MailSpotlightDelta.plan(previous: first, next: second)
        #expect(!delta.clearsDomain)
        #expect(delta.removedIdentifiers.count == 1)
        #expect(delta.changed.map(\.title) == ["Renamed", "S"])

        // A thread of an account that is not listed has no row.
        let orphan = MailSpotlightDelta.records(owner: "user-1", accounts: [], threads: [thread("t9", epoch: 1)])
        #expect(orphan.isEmpty)
    }

    @Test
    func aMetricValueNeverTraps() {
        #expect(PracticeReview.formatValue(12) == "12")
        #expect(PracticeReview.formatValue(12.34, unit: "km") == "12.3 km")
        #expect(PracticeReview.formatValue(-3.04) == "3")
        #expect(PracticeReview.formatValue(.infinity) == "0")
        #expect(PracticeReview.formatValue(.nan, unit: "kg") == "0 kg")
        #expect(PracticeReview.formatValue(1e18) == "1000000000000000000")
    }

    @Test
    func closingTheSignInSheetIsACancellationNotAFailure() {
        let cancel = NSError(
            domain: ASWebAuthenticationSessionError.errorDomain,
            code: ASWebAuthenticationSessionError.canceledLogin.rawValue
        )
        #expect(WebAuthenticationCoordinator.mapped(cancel).isCancellation)
        let real = NSError(domain: ASWebAuthenticationSessionError.errorDomain, code: ASWebAuthenticationSessionError.presentationContextInvalid.rawValue)
        #expect(!WebAuthenticationCoordinator.mapped(real).isCancellation)
        let other = WebAuthenticationError.couldNotStart
        // WebAuthenticationError carries a String case and is not Equatable.
        let mappedOther = WebAuthenticationCoordinator.mapped(other) as? WebAuthenticationError
        var keptCouldNotStart = false
        if case .couldNotStart? = mappedOther { keptCouldNotStart = true }
        #expect(keptCouldNotStart)
    }
}
