import Foundation
import Testing
@testable import Lab86Mail

// The thread list store against a scripted server: the read, the attention
// events, the seen mark, Mark as unread, and the verbs a row offers from
// the list (docs/albatross-threads.md, T1, T2, T10, T11).
@MainActor
struct ThreadsStoreTests {
    private static func row(_ id: String, status: String, needsYou: Bool = false, unread: Bool = false, working: Bool = false, runID: String? = nil) -> JSONValue {
        var object: [String: JSONValue] = [
            "workId": .string(id),
            "title": .string("Thread \(id)"),
            "status": .string(status),
            "needsYou": .bool(needsYou),
            "unread": .bool(unread),
            "working": .bool(working),
        ]
        if let runID {
            object["latestRunId"] = .string(runID)
            object["workingRunId"] = working ? .string(runID) : .null
        }
        return .object(object)
    }

    private static func list(_ rows: [JSONValue]) -> JSONValue {
        .object(["ok": .bool(true), "now": .number(1_760_000_000_000), "threads": .array(rows)])
    }

    @Test("A read fills the rows and the server clock")
    func load() async {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[ThreadsStore.path] = Self.list([Self.row("a", status: "in_progress", working: true), Self.row("b", status: "done")])
        let store = ThreadsStore()
        await store.load(server.backend)
        #expect(store.loaded)
        #expect(store.rows.map(\.id) == ["a", "b"])
        #expect(store.hasWorkingRows)
        #expect(store.pollInterval == ThreadsStore.workingInterval)
        #expect(store.serverNow == Date(timeIntervalSince1970: 1_760_000_000))
        #expect(store.failedPolls == 0)
        #expect(store.attention == nil)
    }

    @Test("Without a working row the poll slows down")
    func idleInterval() async {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[ThreadsStore.path] = Self.list([Self.row("b", status: "done")])
        let store = ThreadsStore()
        await store.load(server.backend)
        #expect(store.pollInterval == ThreadsStore.idleInterval)
    }

    @Test("Failed reads count up and the rows go stale after two")
    func failedPolls() async {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[ThreadsStore.path] = .object(["ok": .bool(false), "error": .string("down")])
        server.statuses[ThreadsStore.path] = 500
        let store = ThreadsStore()
        await store.load(server.backend)
        #expect(store.failedPolls == 1)
        #expect(!store.isStale)
        #expect(store.loadError == "down")
        await store.load(server.backend)
        #expect(store.isStale)
        server.statuses[ThreadsStore.path] = 200
        server.routes[ThreadsStore.path] = Self.list([])
        await store.load(server.backend)
        #expect(store.failedPolls == 0)
        #expect(store.loadError == nil)
    }

    @Test("A row that enters Needs you after the first read raises attention")
    func attention() {
        let store = ThreadsStore()
        store.apply([
            ThreadRow(workID: "a", title: "A", status: .inProgress),
            ThreadRow(workID: "b", title: "B", status: .needsAnswer, unread: true),
        ], now: nil)
        // The first read never raises attention: b already waited.
        #expect(store.attention == nil)
        store.apply([
            ThreadRow(workID: "a", title: "A", status: .yourTurn, unread: true),
            ThreadRow(workID: "b", title: "B", status: .needsAnswer, unread: true),
        ], now: nil)
        #expect(store.attention?.rows.map(\.id) == ["a"])
        #expect(store.attention?.id == 1)
        // The same rows again: nothing new.
        store.apply([
            ThreadRow(workID: "a", title: "A", status: .yourTurn, unread: true),
        ], now: nil)
        #expect(store.attention?.id == 1)
        // A seen row raises nothing.
        store.apply([
            ThreadRow(workID: "c", title: "C", status: .readyForYou, unread: false),
        ], now: nil)
        #expect(store.attention?.id == 1)
        #expect(store.needsYouCount == 1)
    }

    @Test("Seen clears the mark at once and posts it")
    func seen() async {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[ThreadsStore.seenPath] = .object(["ok": .bool(true)])
        let store = ThreadsStore()
        store.apply([ThreadRow(workID: "a", title: "A", status: .done, unread: true)], now: nil)
        await store.markSeen(workID: "a", transport: server.backend)
        #expect(store.row(for: "a")?.unread == false)
        let request = server.recorded.first { $0.path == ThreadsStore.seenPath }
        #expect(request?.method == "POST")
        #expect(request?.body?["workId"]?.stringValue == "a")
        #expect(request?.body?["unread"] == nil)
    }

    @Test("Mark as unread posts unread and keeps the mark; a failure puts it back")
    func markUnread() async {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[ThreadsStore.seenPath] = .object(["ok": .bool(true)])
        let store = ThreadsStore()
        store.apply([ThreadRow(workID: "a", title: "A", status: .done, unread: false)], now: nil)
        #expect(await store.markUnread(workID: "a", transport: server.backend))
        #expect(store.row(for: "a")?.unread == true)
        let request = server.recorded.last { $0.path == ThreadsStore.seenPath }
        #expect(request?.body?["unread"]?.boolValue == true)

        server.statuses[ThreadsStore.seenPath] = 500
        server.routes[ThreadsStore.seenPath] = .object(["ok": .bool(false), "error": .string("no")])
        store.apply([ThreadRow(workID: "b", title: "B", status: .done, unread: false)], now: nil)
        #expect(await store.markUnread(workID: "b", transport: server.backend) == false)
        #expect(store.row(for: "b")?.unread == false)
        #expect(store.notice == ThreadsStoreCopy.unreadFailed)
    }

    @Test("Stop on a run posts cancel and the row reads Stopped by you")
    func stopRun() async {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[ThreadsStore.runPath(workID: "a")] = .object(["ok": .bool(true)])
        let store = ThreadsStore()
        store.apply([ThreadRow(workID: "a", title: "A", status: .inProgress, stepTitle: "Pay the bill", workingRunID: "run-1")], now: nil)
        let row = store.row(for: "a")!
        #expect(await store.stop(row, transport: server.backend))
        let request = server.recorded.last { $0.path == ThreadsStore.runPath(workID: "a") }
        #expect(request?.body?["action"]?.stringValue == "cancel")
        #expect(request?.body?["runId"]?.stringValue == "run-1")
        let after = store.row(for: "a")
        #expect(after?.status == .stopped)
        #expect(after?.word == ThreadsStoreCopy.stoppedByYou)
        #expect(after?.preview == "Next: Pay the bill")
        #expect(after?.working == false)
    }

    @Test("Stop on a reply posts the agent stop with the thread session")
    func stopReply() async {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[ThreadsStore.agentStopPath] = .object(["ok": .bool(true)])
        let store = ThreadsStore()
        store.apply([ThreadRow(workID: "w-lisbon", title: "Plan the Lisbon trip", status: .answering)], now: nil)
        #expect(await store.stop(store.row(for: "w-lisbon")!, transport: server.backend))
        let request = server.recorded.last { $0.path == ThreadsStore.agentStopPath }
        #expect(request?.body?["sessionId"]?.stringValue == WorkThreadSession.id(for: "w-lisbon"))
        #expect(store.row(for: "w-lisbon")?.status == .idle)
        #expect(store.row(for: "w-lisbon")?.preview == ThreadsStoreCopy.replyStopped)
    }

    @Test("A failed stop leaves the row and keeps a notice")
    func stopFails() async {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[ThreadsStore.runPath(workID: "a")] = .object(["ok": .bool(false), "error": .string("The run is closed.")])
        server.statuses[ThreadsStore.runPath(workID: "a")] = 409
        let store = ThreadsStore()
        store.apply([ThreadRow(workID: "a", title: "A", status: .inProgress, workingRunID: "run-1")], now: nil)
        #expect(await store.stop(store.row(for: "a")!, transport: server.backend) == false)
        #expect(store.row(for: "a")?.status == .inProgress)
        #expect(store.notice == "The run is closed.")
    }

    @Test("Steer posts the note with a note id; redirect posts redirect without one")
    func steer() async {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[ThreadsStore.runPath(workID: "a")] = .object(["ok": .bool(true)])
        let store = ThreadsStore()
        store.apply([ThreadRow(workID: "a", title: "A", status: .inProgress, stepTitle: "Pay the bill", workingRunID: "run-1")], now: nil)
        let row = store.row(for: "a")!
        let outcome = await store.steer(row, note: "  Use the checking account  ", redirect: false, transport: server.backend)
        #expect(outcome == .sent)
        let steer = server.recorded.last { $0.path == ThreadsStore.runPath(workID: "a") }
        #expect(steer?.body?["action"]?.stringValue == "steer")
        #expect(steer?.body?["runId"]?.stringValue == "run-1")
        #expect(steer?.body?["note"]?.stringValue == "Use the checking account")
        #expect(steer?.body?["noteId"]?.stringValue?.hasPrefix("msg-") == true)
        #expect(store.row(for: "a")?.status == .inProgress)

        let redirected = await store.steer(row, note: "Go back and choose Saturday", redirect: true, transport: server.backend)
        #expect(redirected == .sent)
        let redirect = server.recorded.last { $0.path == ThreadsStore.runPath(workID: "a") }
        #expect(redirect?.body?["action"]?.stringValue == "redirect")
        #expect(redirect?.body?["noteId"] == nil)
        #expect(store.row(for: "a")?.status == .startsSoon)
        #expect(store.row(for: "a")?.preview == "Pay the bill")
    }

    @Test("Steer on a closed run reads as run ended; an empty note never posts")
    func steerEnded() async {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[ThreadsStore.runPath(workID: "a")] = .object(["ok": .bool(false), "error": .string("closed")])
        server.statuses[ThreadsStore.runPath(workID: "a")] = 409
        let store = ThreadsStore()
        store.apply([ThreadRow(workID: "a", title: "A", status: .inProgress, workingRunID: "run-1")], now: nil)
        let row = store.row(for: "a")!
        #expect(await store.steer(row, note: "x", redirect: false, transport: server.backend) == .runEnded)
        #expect(await store.steer(row, note: "   ", redirect: false, transport: server.backend) == .failed(ThreadsStoreCopy.emptyNote))
        #expect(server.recorded.filter { $0.path == ThreadsStore.runPath(workID: "a") }.count == 1)
        let noRun = ThreadRow(workID: "b", title: "B", status: .inProgress)
        #expect(await store.steer(noRun, note: "x", redirect: false, transport: server.backend) == .runEnded)
    }

    @Test("Continue posts resume and the row waits for a slot")
    func continueRun() async {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[ThreadsStore.runPath(workID: "a")] = .object(["ok": .bool(true)])
        let store = ThreadsStore()
        store.apply([ThreadRow(workID: "a", title: "A", status: .stopped, stepTitle: "Pay the bill", latestRunID: "run-1")], now: nil)
        #expect(await store.continueRun(store.row(for: "a")!, transport: server.backend))
        let request = server.recorded.last { $0.path == ThreadsStore.runPath(workID: "a") }
        #expect(request?.body?["action"]?.stringValue == "resume")
        #expect(request?.body?["runId"]?.stringValue == "run-1")
        #expect(store.row(for: "a")?.status == .startsSoon)
    }

    @Test("Viewers start and stop the poll together")
    func viewers() async {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[ThreadsStore.path] = Self.list([])
        let store = ThreadsStore()
        #expect(!store.isFollowing)
        store.beginFollowing(server.backend)
        store.beginFollowing(server.backend)
        #expect(store.isFollowing)
        #expect(store.viewers == 2)
        store.endFollowing()
        #expect(store.isFollowing)
        store.endFollowing()
        #expect(!store.isFollowing)
        #expect(store.viewers == 0)
        store.endFollowing()
        #expect(store.viewers == 0)
        // The app goes to the background with a viewer on screen, then back.
        store.beginFollowing(server.backend)
        store.pauseFollowing()
        #expect(!store.isFollowing)
        store.resumeFollowing(server.backend)
        #expect(store.isFollowing)
        store.endFollowing()
        #expect(!store.isFollowing)
        // Nobody on screen: a resume starts nothing.
        store.resumeFollowing(server.backend)
        #expect(!store.isFollowing)
    }
}
