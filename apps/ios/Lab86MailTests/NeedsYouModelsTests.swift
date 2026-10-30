import Foundation
import Testing
@testable import Lab86Mail

// Needs you on the wire (phase 5): the snapshot, the rows, the action
// bodies, and the responses. Unknown words never drop the list. Invented
// people only: "Dana Whitfield", "Northwind Bank", example.com.
struct NeedsYouModelsTests {
    private let now: ObligationMillis = 1_793_210_700_000

    private func row(_ overrides: [String: JSONValue]) -> JSONValue {
        var object: [String: JSONValue] = [
            "id": .string("ob_1"),
            "kind": .string("reply"),
            "state": .string("open"),
            "source": .string("mail"),
            "sourceKey": .string("mail:acct_1:thread_1"),
            "accountId": .string("acct_1"),
            "threadId": .string("thread_1"),
            "messageId": .string("msg_1"),
            "title": .string("Asks you to confirm the revised start date."),
            "asker": .string("Dana Whitfield"),
            "askerAddress": .string("dana@northwindlegal.example.com"),
            "why": .string("Dana asked a direct question and named Friday."),
            "excerpt": .string("Can you confirm by Friday?"),
            "due": .string("soon"),
            "dueAt": .number(now + 2 * 86_400_000),
            "pushLevel": .string("normal"),
            "probability": .number(0.92),
            "draftReady": .bool(true),
            "createdAt": .number(now - 3_600_000),
            "updatedAt": .number(now - 3_600_000),
        ]
        for (key, value) in overrides { object[key] = value }
        return .object(object)
    }

    @Test func aFullRowDecodes() throws {
        let item = try #require(ObligationView(json: row([:])))
        #expect(item.id == "ob_1")
        #expect(item.kind == .reply)
        #expect(item.state == .open)
        #expect(item.source == .mail)
        #expect(item.source.label == "Mail")
        #expect(item.accountID == "acct_1")
        #expect(item.threadID == "thread_1")
        #expect(item.messageID == "msg_1")
        #expect(item.hasMailThread)
        #expect(item.asker == "Dana Whitfield")
        #expect(item.askerAddress == "dana@northwindlegal.example.com")
        #expect(item.due == .soon)
        #expect(item.dueAt == now + 2 * 86_400_000)
        #expect(item.pushLevel == .normal)
        #expect(item.probability == 0.92)
        #expect(item.draftReady)
        #expect(item.createdAt == now - 3_600_000)
        #expect(item.closeReason == nil)
        #expect(!item.isClosed)
    }

    @Test func unknownWordsKeepTheRow() throws {
        let item = try #require(ObligationView(json: row([
            "kind": .string("ransom_note"),
            "source": .string("carrier_pigeon"),
            "state": .string("done"),
            "closeReason": .string("flew_away"),
            "due": .string("whenever"),
            "pushLevel": .string("loud"),
            "closedAt": .number(now),
        ])))
        #expect(item.kind == .unknown)
        #expect(item.source == .other("carrier_pigeon"))
        #expect(item.source.label == "Carrier_pigeon")
        #expect(item.state == .done)
        #expect(item.isClosed)
        #expect(item.closeReason == .unknown)
        #expect(NeedsYouLabels.closeReasonLabel(item.closeReason) == "Closed")
        #expect(item.due == .none)
        #expect(item.pushLevel == .normal)
        #expect(NeedsYouLabels.kindLabel(item) == "Item")
    }

    @Test func aRowWithoutAnIdOrATitleIsLeftOutAndTheRestStay() throws {
        let snapshot = try #require(NeedsYouSnapshot(json: .object([
            "enabled": .bool(true),
            "timezone": .string("America/Los_Angeles"),
            "items": .array([
                row([:]),
                row(["id": .null]),
                row(["id": .string("ob_2"), "title": .string("   ")]),
                row(["id": .string("ob_3"), "createdAt": .null]),
                .string("not a row"),
                row(["id": .string("ob_4"), "kind": .string("code")]),
            ]),
        ])))
        #expect(snapshot.enabled)
        #expect(snapshot.timezone == "America/Los_Angeles")
        #expect(snapshot.items.map(\.id) == ["ob_1", "ob_4"])
    }

    @Test func aSnapshotNeedsTheFlagAndFallsBackToTheDeviceZone() throws {
        #expect(NeedsYouSnapshot(json: .object(["items": .array([])])) == nil)
        let snapshot = try #require(NeedsYouSnapshot(json: .object(["enabled": .bool(false)])))
        #expect(!snapshot.enabled)
        #expect(snapshot.timezone == TimeZone.current.identifier)
        #expect(snapshot.items.isEmpty)
    }

    @Test func aCodeRowCarriesItsCodeAndAnHttpsLinkOnlyOpens() throws {
        let code = try #require(ObligationView(json: row([
            "kind": .string("code"),
            "code": .object(["value": .string("482913"), "issuer": .string("Northwind Bank"), "expiresAt": .number(now + 480_000)]),
            "url": .string("http://insecure.example.com/x"),
        ])))
        #expect(code.code == ObligationCode(value: "482913", issuer: "Northwind Bank", expiresAt: now + 480_000))
        #expect(code.url == nil)
        let linked = try #require(ObligationView(json: row([
            "source": .string("slack"),
            "sourceLabel": .string("#release"),
            "url": .string("https://northwind.slack.example.com/archives/C1/p2"),
            "code": .object(["issuer": .string("no value")]),
        ])))
        #expect(linked.url?.host == "northwind.slack.example.com")
        #expect(linked.code == nil)
        #expect(linked.sourceLabel == "#release")
        #expect(linked.source.label == "Slack")
    }

    @Test func everySourceHasItsLabel() {
        #expect(ObligationSource.from("atlassian").label == "Jira")
        #expect(ObligationSource.from("github").label == "GitHub")
        #expect(ObligationSource.from("bitbucket").label == "Bitbucket")
        #expect(ObligationSource.from("granola").label == "Granola")
        #expect(ObligationSource.from("drive").label == "Drive")
        #expect(ObligationSource.from("calendar").label == "Calendar")
        #expect(ObligationSource.from(nil).label == "Source")
        #expect(ObligationSource.from("slack").rawValue == "slack")
        #expect(ObligationSource.other("x").rawValue == "x")
    }

    @Test func theActionBodiesMatchTheContract() {
        #expect(ObligationAction.done.body == .object(["action": .string("done")]))
        #expect(ObligationAction.later(until: 1_793_289_600_000).body == .object([
            "action": .string("later"), "until": .number(1_793_289_600_000),
        ]))
        #expect(ObligationAction.notMine.body == .object(["action": .string("not_mine")]))
        #expect(ObligationAction.undo.body == .object(["action": .string("undo")]))
        #expect(ObligationAction.rsvp(.maybe).body == .object(["action": .string("rsvp"), "response": .string("maybe")]))
        #expect(ObligationAction.done.noticeWord == "Done")
        #expect(ObligationAction.notMine.noticeWord == "Not mine")
        #expect(ObligationAction.rsvp(.yes).noticeWord == "Answered yes")
    }

    @Test func theResponsesDecode() throws {
        let acted = try #require(ObligationActionResult(json: .object([
            "obligation": row(["state": .string("done"), "closeReason": .string("user_done_no_reply")]),
            "undoUntil": .number(now + 10_000),
        ])))
        #expect(acted.obligation.state == .done)
        #expect(acted.obligation.closeReason == .userDoneNoReply)
        #expect(acted.undoUntil == now + 10_000)
        #expect(ObligationActionResult(json: .object(["ok": .bool(true)])) == nil)

        let draft = try #require(ObligationDraft(json: .object([
            "draft": .object([
                "to": .array([.string("dana@northwindlegal.example.com")]),
                "cc": .array([]),
                "subject": .string("Re: SOW"),
                "body": .string("Hi Dana,\nNovember 16 works."),
            ]),
        ])))
        #expect(draft.to == ["dana@northwindlegal.example.com"])
        #expect(draft.subject == "Re: SOW")
        #expect(draft.body.hasPrefix("Hi Dana"))
        #expect(ObligationDraft(json: .object(["draft": .object(["to": .array([])])])) == nil)

        let started = try #require(ObligationAlbatrossResult(json: .object([
            "workId": .string("work_9"),
            "created": .bool(true),
            "obligation": row(["workId": .string("work_9"), "workTitle": .string("Q3 review deck")]),
        ])))
        #expect(started.workID == "work_9")
        #expect(started.created)
        #expect(started.obligation.workTitle == "Q3 review deck")
        #expect(ObligationAlbatrossResult(json: .object(["workId": .string("w")])) == nil)
    }

    @Test func theGroupOrderAndLabelsMatchTheContract() {
        #expect(NeedsYouContract.groupOrder == [.now, .today, .thisWeek, .afterThisWeek, .noDate, .waiting, .closedToday])
        #expect(NeedsYouContract.groupOrder.map(\.label) == [
            "Now", "Today", "This week", "After this week", "No due date", "Waiting on others", "Closed today",
        ])
        #expect(NeedsYouContract.undoWindowMillis == 10_000)
        #expect(ObligationView.mailSourceKey(accountID: "acct", threadID: "thread") == "mail:acct:thread")
    }
}
