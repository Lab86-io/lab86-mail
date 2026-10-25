import Foundation
import Testing
@testable import Lab86Mail

// The pending-send toast (K7): the countdown never sits on "0s", the follow
// polls with backoff, and `unknown` ends the toast with a note.
@MainActor
struct PendingSendFollowTests {
    private func snapshot() -> ComposeDraftSnapshot {
        ComposeDraftSnapshot(
            recipient: "a@example.com", cc: "", bcc: "", subject: "Hello", body: "Hi",
            mode: "new", accountID: "acct-1", threadID: nil, messageID: nil, replyAll: false,
            attachmentsKey: nil, draftID: nil
        )
    }

    private func receipt(id: String, fireIn seconds: TimeInterval) -> PendingSendReceipt {
        PendingSendReceipt(id: id, fireAt: Date().addingTimeInterval(seconds), undoSeconds: 10, accountID: "acct-1", threadID: nil)
    }

    @Test
    func theBackoffRunsAboutTwoMinutesThenStops() {
        var total: Duration = .zero
        var attempt = 0
        while let delay = PendingSendFollow.delay(attempt: attempt) {
            total += delay
            attempt += 1
        }
        #expect(attempt == PendingSendFollow.delays.count)
        #expect(total == .seconds(121))
        #expect(PendingSendFollow.delay(attempt: 0) == .seconds(2))
        #expect(PendingSendFollow.delay(attempt: -1) == nil)
    }

    @Test
    func thePhaseCountsDownThenSaysSending() {
        let fireAt = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(PendingSendPhase.make(fireAt: fireAt, now: fireAt.addingTimeInterval(-4.2), serverSending: false) == .holding(secondsLeft: 5))
        #expect(PendingSendPhase.make(fireAt: fireAt, now: fireAt, serverSending: false) == .sending)
        #expect(PendingSendPhase.make(fireAt: fireAt, now: fireAt.addingTimeInterval(30), serverSending: false) == .sending)
        #expect(PendingSendPhase.make(fireAt: fireAt, now: fireAt.addingTimeInterval(-9), serverSending: true) == .sending)
        #expect(PendingSendPhase.holding(secondsLeft: 3).title == "Sending in 3s")
        #expect(PendingSendPhase.sending.title == "Sending…")
    }

    @Test
    func serverStatusesMapToEndsAndResolutions() {
        #expect(PendingSendServerStatus.sent.resolution == .sent)
        #expect(PendingSendServerStatus.failed.resolution == .failed)
        #expect(PendingSendServerStatus.cancelled.resolution == .cancelled)
        #expect(PendingSendServerStatus.sending.resolution == nil)
        #expect(PendingSendServerStatus.unknown.resolution == nil)
        #expect(PendingSendServerStatus.sent.isEnd)
        #expect(PendingSendServerStatus.unknown.isEnd)
        #expect(!PendingSendServerStatus.pending.isEnd)
        #expect(!PendingSendServerStatus.sending.isEnd)
        #expect(PendingSendServerStatus(rawValue: "sending") == .sending)
        #expect(PendingSendServerStatus(rawValue: "weird") == nil)
    }

    @Test
    func aSendingAnswerShowsSendingAndASentAnswerEndsTheToast() async {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes["/api/compose/status"] = .object(["ok": .bool(true), "status": .string("sending")])
        let defaults = UserDefaults(suiteName: "PendingSendFollowTests.\(UUID().uuidString)")!
        let pending = PendingSendCoordinator(backend: server.backend, tools: ToolClient(backend: server.backend), defaults: defaults)
        pending.register(receipt: receipt(id: "outbox:1", fireIn: -1), ownerID: "user-1", snapshot: snapshot())
        let record = pending.records[0]

        await pending.reconcile(ownerID: "user-1")
        #expect(pending.records.count == 1)
        #expect(pending.phase(for: record) == .sending)

        server.routes["/api/compose/status"] = .object(["ok": .bool(true), "status": .string("sent")])
        let sent = await pending.follow(record)
        #expect(sent)
        #expect(pending.records.isEmpty)
        #expect(pending.resolutions["outbox:1"] == .sent)
    }

    @Test
    func anUnknownAnswerEndsTheToastWithANoteAndNoResolution() async {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes["/api/compose/status"] = .object(["ok": .bool(true), "status": .string("unknown")])
        let defaults = UserDefaults(suiteName: "PendingSendFollowTests.\(UUID().uuidString)")!
        let pending = PendingSendCoordinator(backend: server.backend, tools: ToolClient(backend: server.backend), defaults: defaults)
        pending.register(receipt: receipt(id: "outbox:2", fireIn: -1), ownerID: "user-1", snapshot: snapshot())

        let sent = await pending.follow(pending.records[0])
        #expect(!sent)
        #expect(pending.records.isEmpty)
        #expect(pending.resolutions["outbox:2"] == nil)
        #expect(pending.errorMessage?.contains("could not confirm") == true)
    }
}
