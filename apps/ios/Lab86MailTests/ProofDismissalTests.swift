import Foundation
import Testing
@testable import Lab86Mail

// "Not related" on a mail proof offer calls the dismissal route, so the
// server leaves the Work and thread pair out of later proof matches on
// every device (round 2, native item 4).
@MainActor
struct ProofDismissalTests {
    @Test
    func theBodyHoldsOnePairForEachWorkTheOfferShowed() {
        let body = ProofDismissalRequest.body(
            accountID: "account-1",
            threadID: "thread-1",
            workIDs: ["work-1", "work-2", "work-1", "  "]
        )
        let pairs = body?["dismissals"]?.arrayValue ?? []
        #expect(pairs.count == 2)
        #expect(pairs.first == .object([
            "accountId": .string("account-1"),
            "providerThreadId": .string("thread-1"),
            "workId": .string("work-1"),
        ]))
        #expect(pairs.last?["workId"] == .string("work-2"))
    }

    @Test
    func thereIsNothingToSendWithoutAPairOrAThread() {
        #expect(ProofDismissalRequest.body(accountID: "account-1", threadID: "thread-1", workIDs: []) == nil)
        #expect(ProofDismissalRequest.body(accountID: " ", threadID: "thread-1", workIDs: ["work-1"]) == nil)
        #expect(ProofDismissalRequest.body(accountID: "account-1", threadID: "", workIDs: ["work-1"]) == nil)
        let many = (0..<150).map { "work-\($0)" }
        let capped = ProofDismissalRequest.body(accountID: "a", threadID: "t", workIDs: many)
        #expect(capped?["dismissals"]?.arrayValue?.count == ProofDismissalRequest.batchLimit)
    }

    @Test
    func notRelatedPostsTheDismissalsToTheServer() async {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[ProofDismissalRequest.path] = .object(["ok": .bool(true), "saved": .number(2)])
        let store = ProductStore(tools: RecordingTools(), backend: server.backend)

        let saved = await store.dismissProofOffer(accountID: "account-1", threadID: "thread-1", workIDs: ["w1", "w2"])

        #expect(saved)
        let request = server.recorded.first
        #expect(request?.method == "POST")
        #expect(request?.path == "/api/albatross/proof-matches/dismissals")
        #expect(request?.body?["dismissals"]?.arrayValue?.compactMap { $0["workId"]?.stringValue } == ["w1", "w2"])
    }

    @Test
    func aFailedSaveReportsFalseAndAnEmptyOfferSendsNothing() async {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[ProofDismissalRequest.path] = .object(["ok": .bool(false), "error": .string("The dismissal could not be saved.")])
        server.statuses[ProofDismissalRequest.path] = 500
        let store = ProductStore(tools: RecordingTools(), backend: server.backend)

        #expect(await store.dismissProofOffer(accountID: "account-1", threadID: "thread-1", workIDs: ["w1"]) == false)
        #expect(await store.dismissProofOffer(accountID: "account-1", threadID: "thread-1", workIDs: []))
        #expect(server.recorded.count == 1)
    }
}
