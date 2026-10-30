import Foundation
import Testing
@testable import Lab86Mail

// The Needs you store against a scripted server: the read, the cached
// flag, the actions with their bodies, the Undo window, the draft, the
// reply, and Start in Albatross. Invented people only.
@MainActor
struct NeedsYouStoreTests {
    private static let now: ObligationMillis = 1_793_210_700_000

    private static func row(_ id: String, _ overrides: [String: JSONValue] = [:]) -> JSONValue {
        var object: [String: JSONValue] = [
            "id": .string(id),
            "kind": .string("reply"),
            "state": .string("open"),
            "source": .string("mail"),
            "sourceKey": .string("mail:acct_1:\(id)"),
            "accountId": .string("acct_1"),
            "threadId": .string("thread_\(id)"),
            "title": .string("Asks you to confirm the start date."),
            "asker": .string("Dana Whitfield"),
            "due": .string("soon"),
            "pushLevel": .string("normal"),
            "probability": .number(0.9),
            "createdAt": .number(now - 3_600_000),
            "updatedAt": .number(now - 3_600_000),
        ]
        for (key, value) in overrides { object[key] = value }
        return .object(object)
    }

    private static func snapshot(enabled: Bool = true, _ rows: [JSONValue]) -> JSONValue {
        .object(["enabled": .bool(enabled), "timezone": .string("America/Los_Angeles"), "items": .array(rows)])
    }

    private func makeDefaults() throws -> UserDefaults {
        let suite = "needs-you-store-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    @Test("A read fills the rows, the zone, and the cached flag")
    func load() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[NeedsYouStore.path] = Self.snapshot([
            Self.row("ob_1"),
            Self.row("ob_2", ["kind": .string("code"), "code": .object(["value": .string("482913"), "expiresAt": .number(Self.now + 480_000)])]),
        ])
        let defaults = try makeDefaults()
        let store = NeedsYouStore(defaults: defaults)
        store.activate(ownerID: "owner-1")
        #expect(!store.isEnabled)
        await store.load(server.backend, now: Date(timeIntervalSince1970: Self.now / 1_000))
        #expect(store.loaded)
        #expect(store.isEnabled)
        #expect(store.timezone == "America/Los_Angeles")
        #expect(store.items.map(\.id) == ["ob_1", "ob_2"])
        #expect(store.nowCount(now: Date(timeIntervalSince1970: Self.now / 1_000)) == 1)
        #expect(defaults.bool(forKey: NeedsYouStore.cacheKey(ownerID: "owner-1")))
        #expect(server.recorded.first?.method == "GET")
        // A second read inside the cache life makes no request.
        await store.load(server.backend, now: Date(timeIntervalSince1970: Self.now / 1_000 + 5))
        #expect(server.requests.count == 1)
        await store.load(server.backend, force: true)
        #expect(server.requests.count == 2)
    }

    @Test("The cached flag shows the row before the first read, and sign-out clears it")
    func cachedFlag() throws {
        let defaults = try makeDefaults()
        defaults.set(true, forKey: NeedsYouStore.cacheKey(ownerID: "owner-1"))
        let store = NeedsYouStore(defaults: defaults)
        store.activate(ownerID: "owner-1")
        #expect(store.isEnabled)
        store.activate(ownerID: "owner-2")
        #expect(!store.isEnabled)
        store.activate(ownerID: "owner-1")
        #expect(store.isEnabled)
        store.activate(ownerID: nil)
        #expect(!store.isEnabled)
        #expect(!store.loaded)
    }

    @Test("A failed read keeps the error and the page can retry")
    func loadError() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[NeedsYouStore.path] = .object(["ok": .bool(false), "error": .string("down")])
        server.statuses[NeedsYouStore.path] = 500
        let store = NeedsYouStore(defaults: try makeDefaults())
        await store.load(server.backend)
        #expect(!store.loaded)
        #expect(store.loadError == "down")
        #expect(!store.isEnabled)
        server.statuses[NeedsYouStore.path] = 200
        server.routes[NeedsYouStore.path] = Self.snapshot(enabled: false, [])
        await store.load(server.backend, force: true)
        #expect(store.loaded)
        #expect(store.loadError == nil)
        // A user outside the flag reads again only now and then.
        await store.refreshAfterPush(server.backend)
        #expect(server.requests.count == 2)
    }

    @Test("Done posts its body, replaces the row, and opens the Undo window")
    func done() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[NeedsYouStore.path] = Self.snapshot([Self.row("ob_1")])
        let actionPath = NeedsYouStore.actionPath(id: "ob_1")
        #expect(actionPath == "/api/mobile/v1/needs-you/ob_1")
        server.routes[actionPath] = .object([
            "obligation": Self.row("ob_1", ["state": .string("done"), "closeReason": .string("user_done_no_reply"), "closedAt": .number(Self.now)]),
            "undoUntil": .number(Self.now + 10_000),
        ])
        let store = NeedsYouStore(defaults: try makeDefaults())
        await store.load(server.backend)
        let at = Date(timeIntervalSince1970: Self.now / 1_000)
        #expect(await store.act(.done, on: "ob_1", transport: server.backend, now: at))
        let request = try #require(server.recorded.last { $0.path == actionPath })
        #expect(request.method == "POST")
        #expect(request.body == .object(["action": .string("done")]))
        #expect(store.item(id: "ob_1")?.state == .done)
        #expect(store.item(id: "ob_1")?.closeReason == .userDoneNoReply)
        #expect(store.undo?.obligationID == "ob_1")
        #expect(store.undo?.until == Self.now + 10_000)
        #expect(store.undo?.summary == "Done: Dana Whitfield")
        #expect(store.busyID == nil)

        // Undo posts its body and the row comes back.
        server.routes[actionPath] = .object(["obligation": Self.row("ob_1")])
        #expect(await store.undoLast(transport: server.backend, now: at))
        #expect(server.recorded.last?.body == .object(["action": .string("undo")]))
        #expect(store.item(id: "ob_1")?.state == .open)
        #expect(store.undo == nil)
    }

    @Test("Later, Not mine, and an RSVP send their bodies; the window closes when it passes")
    func otherActions() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[NeedsYouStore.path] = Self.snapshot([Self.row("ob_1"), Self.row("ob_2", ["kind": .string("rsvp"), "source": .string("calendar")])])
        let path1 = NeedsYouStore.actionPath(id: "ob_1")
        let path2 = NeedsYouStore.actionPath(id: "ob_2")
        server.routes[path1] = .object(["obligation": Self.row("ob_1", ["state": .string("snoozed"), "snoozedUntil": .number(Self.now + 3 * 3_600_000)])])
        server.routes[path2] = .object(["obligation": Self.row("ob_2", ["state": .string("done"), "closeReason": .string("event_passed")]), "undoUntil": .number(Self.now + 10_000)])
        let store = NeedsYouStore(defaults: try makeDefaults())
        await store.load(server.backend)
        let at = Date(timeIntervalSince1970: Self.now / 1_000)

        #expect(await store.act(.later(until: Self.now + 3 * 3_600_000), on: "ob_1", transport: server.backend, now: at))
        #expect(server.recorded.last?.body == .object(["action": .string("later"), "until": .number(Self.now + 3 * 3_600_000)]))
        #expect(store.item(id: "ob_1")?.state == .snoozed)
        // No undo offer without a window from the server.
        #expect(store.undo == nil)

        #expect(await store.act(.rsvp(.yes), on: "ob_2", transport: server.backend, now: at))
        #expect(server.recorded.last?.body == .object(["action": .string("rsvp"), "response": .string("yes")]))
        #expect(store.undo?.word == "Answered yes")
        store.expireUndo(now: Date(timeIntervalSince1970: (Self.now + 9_000) / 1_000))
        #expect(store.undo != nil)
        store.expireUndo(now: Date(timeIntervalSince1970: (Self.now + 11_000) / 1_000))
        #expect(store.undo == nil)
        // Undo after the window makes no request.
        #expect(await store.undoLast(transport: server.backend) == false)

        server.routes[path1] = .object(["obligation": Self.row("ob_1", ["state": .string("dismissed"), "closeReason": .string("not_mine")]), "undoUntil": .number(Self.now + 10_000)])
        #expect(await store.act(.notMine, on: "ob_1", transport: server.backend, now: at))
        #expect(server.recorded.last?.body == .object(["action": .string("not_mine")]))
        #expect(store.undo?.word == "Not mine")
        store.dismissUndo()
        #expect(store.undo == nil)
    }

    @Test("A gone item and a conflict say so, and the row stays as it was")
    func actionErrors() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[NeedsYouStore.path] = Self.snapshot([Self.row("ob_1")])
        let path = NeedsYouStore.actionPath(id: "ob_1")
        server.routes[path] = .object(["error": .string("Not found")])
        server.statuses[path] = 404
        let store = NeedsYouStore(defaults: try makeDefaults())
        await store.load(server.backend)
        #expect(await store.act(.done, on: "ob_1", transport: server.backend) == false)
        #expect(store.actionError == "This item is no longer on your list.")
        #expect(store.item(id: "ob_1")?.state == .open)
        store.clearActionError()
        #expect(store.actionError == nil)

        server.statuses[path] = 409
        server.routes[path] = .object(["error": .string("The reply already went out.")])
        #expect(await store.act(.undo, on: "ob_1", transport: server.backend) == false)
        #expect(store.actionError == "The reply already went out.")
    }

    @Test("The draft and the reply use their own routes")
    func draftAndReply() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[NeedsYouStore.path] = Self.snapshot([Self.row("ob_1", ["draftReady": .bool(true)])])
        let draftPath = NeedsYouStore.actionPath(id: "ob_1", suffix: "draft")
        let replyPath = NeedsYouStore.actionPath(id: "ob_1", suffix: "reply")
        #expect(draftPath == "/api/mobile/v1/needs-you/ob_1/draft")
        server.routes[draftPath] = .object([
            "draft": .object([
                "to": .array([.string("dana@northwindlegal.example.com")]),
                "cc": .array([]),
                "subject": .string("Re: SOW"),
                "body": .string("Hi Dana,\nNovember 16 works on our side."),
            ]),
        ])
        server.routes[replyPath] = .object([
            "obligation": Self.row("ob_1", ["state": .string("done"), "closeReason": .string("sent_reply"), "closedAt": .number(Self.now)]),
            "undoUntil": .number(Self.now + 10_000),
        ])
        let store = NeedsYouStore(defaults: try makeDefaults())
        await store.load(server.backend)
        let draft = try #require(await store.prepareDraft(id: "ob_1", transport: server.backend))
        #expect(draft.to == ["dana@northwindlegal.example.com"])
        #expect(server.recorded.last?.method == "POST")
        #expect(server.recorded.last?.path == draftPath)

        // An empty reply never leaves the device.
        #expect(await store.sendReply(id: "ob_1", body: "  \n", transport: server.backend) == false)
        #expect(store.actionError == "Write the reply first.")
        #expect(server.recorded.last?.path == draftPath)

        let at = Date(timeIntervalSince1970: Self.now / 1_000)
        #expect(await store.sendReply(id: "ob_1", body: " \(draft.body) ", transport: server.backend, now: at))
        #expect(server.recorded.last?.path == replyPath)
        #expect(server.recorded.last?.body == .object(["body": .string(draft.body)]))
        #expect(store.item(id: "ob_1")?.closeReason == .sentReply)
        #expect(store.undo?.word == "Reply sent")
    }

    @Test("Start in Albatross gives the Albatross and replaces the row")
    func startAlbatross() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[NeedsYouStore.path] = Self.snapshot([Self.row("ob_1", ["kind": .string("action")])])
        let path = NeedsYouStore.actionPath(id: "ob_1", suffix: "albatross")
        server.routes[path] = .object([
            "workId": .string("work_9"),
            "created": .bool(true),
            "obligation": Self.row("ob_1", ["kind": .string("action"), "workId": .string("work_9"), "workTitle": .string("Q3 review deck")]),
        ])
        let store = NeedsYouStore(defaults: try makeDefaults())
        await store.load(server.backend)
        let result = try #require(await store.startAlbatross(id: "ob_1", transport: server.backend))
        #expect(result.workID == "work_9")
        #expect(result.created)
        #expect(store.item(id: "ob_1")?.workTitle == "Q3 review deck")
        #expect(server.recorded.last?.path == path)
    }

    @Test("A push tap finds its item by the thread, the open one first")
    func itemByThread() throws {
        let store = NeedsYouStore(defaults: try makeDefaults())
        let snapshot = try #require(NeedsYouSnapshot(json: Self.snapshot([
            Self.row("old", ["threadId": .string("thread_x"), "state": .string("done"), "updatedAt": .number(Self.now)]),
            Self.row("live", ["threadId": .string("thread_x"), "updatedAt": .number(Self.now - 10)]),
            Self.row("other"),
        ])))
        store.apply(snapshot)
        #expect(store.item(accountID: "acct_1", threadID: "thread_x")?.id == "live")
        #expect(store.item(accountID: "acct_1", threadID: "thread_other")?.id == "other")
        #expect(store.item(accountID: "acct_2", threadID: "thread_x") == nil)
        store.clear()
        #expect(store.items.isEmpty)
        #expect(!store.loaded)
    }
}
