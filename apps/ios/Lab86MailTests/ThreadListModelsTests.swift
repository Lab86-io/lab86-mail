import Foundation
import Testing
@testable import Lab86Mail

// The thread list on the wire (docs/albatross-threads.md, "Server contract"):
// a row with every field, a row with the least, the list envelope, the
// server clock, the notes a run carries, and the optimistic rows.
struct ThreadListModelsTests {
    private static let fullRow: JSONValue = .object([
        "workId": .string("w-water"),
        "title": .string("Pay the water bill"),
        "areaName": .string("Household"),
        "status": .string("in_progress"),
        "statusLabel": .string("In progress"),
        "preview": .string("Typed your saved account number on springfield.example"),
        "stepTitle": .string("Pay the bill on the city site"),
        "needsYou": .bool(false),
        "working": .bool(true),
        "latestRunId": .string("run-2"),
        "workingRunId": .string("run-2"),
        "runStartedAt": .number(1_760_000_000_000),
        "lastActivityAt": .number(1_760_000_240_000),
        "seenAt": .number(1_760_000_100_000),
        "unread": .bool(true),
        "closed": .bool(false),
    ])

    @Test("A full row reads every field")
    func fullRow() throws {
        let row = try #require(ThreadRow(json: Self.fullRow))
        #expect(row.id == "w-water")
        #expect(row.title == "Pay the water bill")
        #expect(row.areaName == "Household")
        #expect(row.status == .inProgress)
        #expect(row.statusLabel == "In progress")
        #expect(row.preview?.hasPrefix("Typed") == true)
        #expect(row.stepTitle == "Pay the bill on the city site")
        #expect(row.needsYou == false)
        #expect(row.working)
        #expect(row.latestRunID == "run-2")
        #expect(row.workingRunID == "run-2")
        #expect(row.runStartedAt == Date(timeIntervalSince1970: 1_760_000_000))
        #expect(row.lastActivityAt == Date(timeIntervalSince1970: 1_760_000_240))
        #expect(row.seenAt == Date(timeIntervalSince1970: 1_760_000_100))
        #expect(row.unread)
        #expect(!row.closed)
    }

    @Test("A bare row reads as idle with safe defaults")
    func bareRow() throws {
        let row = try #require(ThreadRow(json: .object(["workId": .string("w-1")])))
        #expect(row.status == .idle)
        #expect(row.title == "Something you asked for")
        #expect(row.word == nil)
        #expect(!row.needsYou)
        #expect(!row.working)
        #expect(!row.unread)
        #expect(row.lastActivityAt == nil)
    }

    @Test("A row without a Work id is dropped")
    func noID() {
        #expect(ThreadRow(json: .object(["title": .string("x")])) == nil)
    }

    @Test("An unknown status reads as idle; the status fills needsYou and working")
    func statusDefaults() throws {
        let unknown = try #require(ThreadRow(json: .object(["workId": .string("w"), "status": .string("hologram")])))
        #expect(unknown.status == .idle)
        let needs = try #require(ThreadRow(json: .object(["workId": .string("w"), "status": .string("needs_answer")])))
        #expect(needs.needsYou)
        #expect(!needs.working)
        let reply = try #require(ThreadRow(json: .object(["workId": .string("w"), "status": .string("answering")])))
        #expect(reply.working)
        #expect(reply.word == "Reply in progress")
    }

    @Test("The server's status label wins over this build's word")
    func statusLabelWins() throws {
        let row = try #require(ThreadRow(json: .object([
            "workId": .string("w"), "status": .string("stopped"), "statusLabel": .string("Stopped by you"),
        ])))
        #expect(row.word == "Stopped by you")
        let plain = try #require(ThreadRow(json: .object(["workId": .string("w"), "status": .string("stopped")])))
        #expect(plain.word == "Stopped")
    }

    @Test("The words of each status")
    func words() {
        #expect(ThreadRowStatus.inProgress.word == "In progress")
        #expect(ThreadRowStatus.startsSoon.word == "Starts soon")
        #expect(ThreadRowStatus.answering.word == "Reply in progress")
        #expect(ThreadRowStatus.needsAnswer.word == "Needs your answer")
        #expect(ThreadRowStatus.yourTurn.word == "Your turn")
        #expect(ThreadRowStatus.readyForYou.word == "Ready for you")
        #expect(ThreadRowStatus.didNotFinish.word == "Did not finish")
        #expect(ThreadRowStatus.stopped.word == "Stopped")
        #expect(ThreadRowStatus.done.word == "Done")
        #expect(ThreadRowStatus.waiting.word == nil)
        #expect(ThreadRowStatus.paused.word == nil)
        #expect(ThreadRowStatus.idle.word == nil)
    }

    @Test("Did not finish needs you; the three live states are in motion")
    func groupsOfStatuses() {
        #expect(ThreadRowStatus.didNotFinish.needsYou)
        #expect(ThreadRowStatus.needsAnswer.needsYou)
        #expect(!ThreadRowStatus.done.needsYou)
        #expect(ThreadRowStatus.inProgress.inMotion)
        #expect(ThreadRowStatus.startsSoon.inMotion)
        #expect(ThreadRowStatus.answering.inMotion)
        #expect(!ThreadRowStatus.stopped.inMotion)
    }

    @Test("The list envelope and the server clock")
    func envelope() {
        let json: JSONValue = .object([
            "ok": .bool(true),
            "now": .number(1_760_000_300_000),
            "threads": .array([Self.fullRow, .object(["workId": .string("w-2")]), .object(["title": .string("no id")])]),
        ])
        let rows = ThreadRow.list(from: json)
        #expect(rows.map(\.id) == ["w-water", "w-2"])
        #expect(ThreadRow.serverNow(from: json) == Date(timeIntervalSince1970: 1_760_000_300))
        #expect(ThreadRow.list(from: .array([Self.fullRow])).count == 1)
    }

    @Test("The optimistic rows keep the rest")
    func optimisticRows() throws {
        let row = try #require(ThreadRow(json: Self.fullRow))
        let seen = row.with(unread: false)
        #expect(!seen.unread)
        #expect(seen.status == .inProgress)
        #expect(seen.latestRunID == "run-2")
        let stopped = row.with(status: .stopped, statusLabel: "Stopped by you", preview: "Next: Pay the bill on the city site")
        #expect(stopped.status == .stopped)
        #expect(stopped.word == "Stopped by you")
        #expect(stopped.preview == "Next: Pay the bill on the city site")
        #expect(!stopped.working)
        #expect(!stopped.needsYou)
        #expect(stopped.workingRunID == nil)
        #expect(stopped.latestRunID == "run-2")
        #expect(stopped.unread)
    }

    @Test("A run's notes read with their ids and read times")
    func notes() throws {
        let json: JSONValue = .object([
            "id": .string("run-1"),
            "workId": .string("w-water"),
            "stepKey": .string("step-pay"),
            "stepTitle": .string("Pay the bill"),
            "state": .string("running"),
            "notes": .array([
                .object(["id": .string("msg-a"), "at": .number(1_760_000_000_000), "text": .string("Use the checking account"), "readAt": .number(1_760_000_060_000)]),
                .object(["id": .string("msg-b"), "text": .string("Skip the paperless option")]),
                .object(["text": .string("no id")]),
            ]),
        ])
        let view = try #require(ThreadRunView(json: json))
        #expect(view.notes.map(\.id) == ["msg-a", "msg-b"])
        #expect(view.note(id: "msg-a")?.isRead == true)
        #expect(view.note(id: "msg-b")?.isRead == false)
        #expect(view.note(id: "msg-b")?.readAt == nil)
        #expect(view.note(id: "msg-c") == nil)
    }

    @Test("A run without notes reads as before")
    func noNotes() throws {
        let view = try #require(ThreadRunView(json: .object([
            "id": .string("run-1"), "workId": .string("w"), "stepKey": .string("s"), "stepTitle": .string("S"), "state": .string("done"),
        ])))
        #expect(view.notes.isEmpty)
    }

    @Test("A note id has the shape of a message id")
    func noteID() {
        let id = ThreadNoteID.make()
        #expect(id.hasPrefix("msg-"))
        #expect(id.count == 36)
        #expect(ThreadNoteID.make() != id)
    }
}
