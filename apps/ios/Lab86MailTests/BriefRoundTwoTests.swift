import Foundation
import MobileAPI
import Testing
@testable import Lab86Mail

// Round 2 Brief parity (FEATURES items 3, 6, 7, 8, 9, 18): the "What
// Albatross did" region with Undo, per-item steering, the weekly review, the
// source health line, and the delivery preferences.
@MainActor
struct BriefRoundTwoTests {
    // MARK: - Fixtures

    private func decode(_ json: String) throws -> BriefDocumentV2 {
        try #require(BriefDocumentV2.decode(Data(json.utf8)))
    }

    private func document(title: String, regions: [String]) -> String {
        """
        {
          "version": 2,
          "title": "\(title)",
          "summary": "Summary.",
          "generatedAt": 1788400000000,
          "timezone": "America/New_York",
          "regions": [\(regions.joined(separator: ","))]
        }
        """
    }

    private let lede = """
    { "id": "lede", "summary": "Lede.", "tree": { "kind": "hero", "emphasis": "primary", "tone": "neutral", "surface": "plain",
      "children": [ { "kind": "text", "emphasis": "primary", "tone": "neutral", "role": "lede", "text": "Lede." } ] } }
    """

    private func lane(_ id: String, _ items: [String]) -> String {
        """
        { "id": "\(id)", "summary": "\(id).", "tree": { "kind": "entity_list", "emphasis": "standard", "tone": "neutral",
          "title": "\(id)", "variant": "rows", "items": [\(items.joined(separator: ","))] } }
        """
    }

    private let operationItem = """
    {
      "ref": { "kind": "derived", "id": "operation:op-1", "label": "Archived 3 newsletters" },
      "framing": { "lane": "since", "sender": "Mail · Fri 9:14 AM", "reason": "They matched your Noise rule." },
      "actions": [ { "action": "undo_operation", "label": "Undo", "payload": { "operationId": "op-1", "summary": "Archived 3 newsletters" }, "style": "quiet" } ]
    }
    """

    private let steeredThread = """
    {
      "ref": { "kind": "thread", "id": "t1", "account": "acct-1", "label": "Venue count" },
      "framing": { "lane": "answer", "sender": "Sarah Chen" },
      "actions": [
        { "action": "open_thread", "label": "Open", "payload": { "account": "acct-1", "threadId": "t1" }, "style": "quiet" },
        { "action": "draft_reply", "label": "Reply", "payload": { "account": "acct-1", "threadId": "t1" }, "style": "secondary" },
        { "action": "steer_item", "label": "Not for me", "payload": { "account": "acct-1", "threadId": "t1", "subject": "Venue count", "mode": "not_for_me" }, "style": "quiet" },
        { "action": "steer_item", "label": "Less from this sender", "payload": { "account": "acct-1", "threadId": "t1", "mode": "less_from_sender", "senderEmail": "sarah@example.com" }, "style": "quiet" },
        { "action": "steer_item", "label": "Keep showing", "payload": { "account": "acct-1", "threadId": "t1", "mode": "keep_showing" }, "style": "quiet" }
      ]
    }
    """

    private let openThread = """
    {
      "ref": { "kind": "thread", "id": "t2", "account": "acct-1", "label": "Deposit" },
      "framing": { "lane": "open", "sender": "Bank" },
      "actions": [
        { "action": "open_thread", "label": "Open", "payload": { "account": "acct-1", "threadId": "t2" }, "style": "quiet" },
        { "action": "defer_thread", "label": "Defer", "payload": { "account": "acct-1", "threadId": "t2", "until": 4102444800000 }, "style": "secondary" },
        { "action": "dismiss_thread", "label": "Drop", "payload": { "account": "acct-1", "threadId": "t2" }, "style": "quiet" }
      ]
    }
    """

    private let openTask = """
    {
      "ref": { "kind": "task", "id": "card-1", "label": "Book the tent" },
      "framing": { "lane": "open", "reason": "Due Friday" },
      "actions": [
        { "action": "toggle_task", "label": "Done", "payload": { "cardId": "card-1", "completed": true }, "style": "secondary" },
        { "action": "defer_task", "label": "Defer", "payload": { "cardId": "card-1", "dueAt": 4102444800000, "previousDueAt": 4102358400000 }, "style": "quiet" },
        { "action": "dismiss_task", "label": "Drop", "payload": { "cardId": "card-1" }, "style": "quiet" }
      ]
    }
    """

    private let doneWork = """
    { "ref": { "kind": "work", "id": "w1", "label": "Ship the deck" }, "framing": { "lane": "done", "reason": "Finished Tuesday" },
      "actions": [ { "action": "open_work", "label": "Open", "payload": { "workId": "w1" }, "style": "quiet" } ] }
    """

    private let nextEvent = """
    { "ref": { "kind": "event", "id": "e1", "account": "acct-1", "label": "Board meeting" }, "framing": { "lane": "next-week", "reason": "Mon 9:00 AM" },
      "actions": [ { "action": "open_event", "label": "Open", "payload": { "account": "acct-1", "eventId": "e1" }, "style": "quiet" } ] }
    """

    private func item(_ json: String) throws -> BriefEntityItem {
        try JSONDecoder().decode(BriefEntityItem.self, from: Data(json.utf8))
    }

    private func action(_ json: String) throws -> BriefDocumentAction {
        try JSONDecoder().decode(BriefDocumentAction.self, from: Data(json.utf8))
    }

    // MARK: - What Albatross did

    @Test
    func theSinceRegionReadsAsALaneAfterYesterday() throws {
        let doc = try decode(document(title: "The Friday Brief", regions: [
            lede,
            """
            { "id": "yesterday", "summary": "Moved.", "tree": { "kind": "text", "emphasis": "standard", "tone": "neutral", "role": "body", "text": "Moved." } }
            """,
            lane("since", [operationItem]),
            lane("answer", [steeredThread]),
        ]))
        let sections = BriefLetterLayout.sections(for: doc, includeLede: false)
        #expect(sections.map(\.regionID) == ["yesterday", "since", "answer"])
        guard case .lane(let since, let items) = sections[1] else {
            Issue.record("Expected the since lane.")
            return
        }
        #expect(since == .since)
        #expect(since.title == "What Albatross did")
        #expect(items.first?.ref.id == "operation:op-1")
        #expect(BriefLetterLayout.isLetter(doc))
    }

    @Test
    func anOperationRowNeverUndoesFromARowTap() throws {
        let row = try item(operationItem)
        let copy = BriefMailRowCopy(item: row, entity: nil)
        #expect(copy.isOperation)
        #expect(copy.sender == "Mail · Fri 9:14 AM")
        #expect(copy.subject == "Archived 3 newsletters")
        #expect(copy.line == "They matched your Noise rule.")
        #expect(copy.action == nil)
        #expect(copy.trailingActions == ["Undo"])
        let arranged = BriefRowActions.arrange(row.actions, fallback: BriefMailRowCopy.fallbackOpen(for: row.ref))
        #expect(arranged.tap == nil)
        #expect(arranged.trailing.map(\.action) == ["undo_operation"])

        // A look-back row without a sender still names who acted.
        let bare = BriefEntityItem(
            ref: BriefSourceRef(kind: "derived", id: "operation:op-2", label: "Snoozed Invoice"),
            framing: nil,
            actions: []
        )
        #expect(BriefMailRowCopy(item: bare, entity: nil).sender == "Albatross")
        #expect(!BriefMailRowCopy.isOperation(BriefSourceRef(kind: "derived", id: "brief:1")))
    }

    // MARK: - Steering

    @Test
    func steeringChoicesLeaveTheRowForTheOverflowMenu() throws {
        let row = try item(steeredThread)
        let arranged = BriefRowActions.arrange(row.actions, fallback: nil)
        #expect(arranged.tap?.action == "open_thread")
        #expect(arranged.trailing.map(\.label) == ["Reply"])
        #expect(BriefActionPolicy.steering(row.actions).map(\.label)
            == ["Not for me", "Less from this sender", "Keep showing"])
        let copy = BriefMailRowCopy(item: row, entity: nil)
        #expect(copy.steeringActions == ["Not for me", "Less from this sender", "Keep showing"])
        #expect(copy.accessibilityLabel.hasSuffix("action Keep showing"))
        #expect(BriefActionPolicy.tier("steer_item") == .immediate)
        #expect(BriefActionPolicy.known.isSuperset(of: BriefRoundTwoActions.names))
    }

    @Test
    func steeringSendsTheModeTheThreadAndTheSender() throws {
        let row = try item(steeredThread)
        let steering = BriefActionPolicy.steering(row.actions)
        let less = BriefActionPayload(action: steering[1], sourceRef: row.ref)
        let call = try BriefRoundTwoActions.call("steer_item", payload: less)
        #expect(call == BriefToolCall(name: "steer_brief_item", arguments: [
            "mode": .string("less_from_sender"),
            "account": .string("acct-1"),
            "threadId": .string("t1"),
            "subject": .string("Venue count"),
            "senderEmail": .string("sarah@example.com"),
        ]))
        #expect(BriefRoundTwoActions.hidesItem("steer_item", payload: less))
        let keep = BriefActionPayload(action: steering[2], sourceRef: row.ref)
        #expect(!BriefRoundTwoActions.hidesItem("steer_item", payload: keep))
        #expect(BriefRoundTwoActions.undoCall("steer_item", payload: less, operationID: "op-9")
            == BriefToolCall(name: "undo_operation", arguments: ["operationId": .string("op-9")]))
        #expect(BriefRoundTwoActions.undoCall("steer_item", payload: less, operationID: nil) == nil)
        #expect(BriefRoundTwoActions.message("steer_item", payload: less, resultSummary: "Less from Sarah") == "Less from Sarah")
        #expect(BriefRoundTwoActions.message("steer_item", payload: keep, resultSummary: nil) == "This conversation keeps showing")

        var missing = less
        missing.mode = nil
        #expect(throws: BackendError.self) { try BriefRoundTwoActions.call("steer_item", payload: missing) }
    }

    @Test
    func theLookBackUndoRunsByOperationAndHasNoUndoOfItsOwn() throws {
        let row = try item(operationItem)
        let undo = try #require(row.actions?.first)
        let payload = BriefActionPayload(action: undo, sourceRef: row.ref)
        #expect(payload.operationID == "op-1")
        #expect(try BriefRoundTwoActions.call("undo_operation", payload: payload)
            == BriefToolCall(name: "undo_operation", arguments: ["operationId": .string("op-1")]))
        #expect(BriefRoundTwoActions.undoCall("undo_operation", payload: payload, operationID: nil) == nil)
        #expect(BriefRoundTwoActions.hidesItem("undo_operation", payload: payload))
        #expect(BriefRoundTwoActions.message("undo_operation", payload: payload, resultSummary: nil) == "Undone")
    }

    // MARK: - Weekly review

    @Test
    func theWeeklyReviewRegionsReadInOrderWithTheirTitles() throws {
        let doc = try decode(document(title: "The Weekly Review", regions: [
            lede,
            lane("done", [doneWork]),
            lane("open", [openThread, openTask]),
            lane("waiting", [steeredThread]),
            lane("next-week", [nextEvent]),
        ]))
        let sections = BriefLetterLayout.sections(for: doc, includeLede: true)
        #expect(sections.map(\.regionID) == ["lede", "done", "open", "waiting", "next-week"])
        #expect(BriefLetterLayout.isLetter(doc))
        #expect(BriefLetterLane.done.title == "Done this week")
        #expect(BriefLetterLane.open.title == "Still open")
        #expect(BriefLetterLane.nextWeek.title == "Next week")
        #expect(BriefLetterLane.nextWeek.rawValue == "next-week")
        #expect(DailyBriefMasthead.editionTitle(for: .now, kind: "weekly") == "The Weekly Review")
        #expect(DailyBriefMasthead.editionTitle(
            for: Date(timeIntervalSince1970: 1_788_400_000),
            kind: "morning",
            timeZone: TimeZone(identifier: "UTC")!,
            locale: Locale(identifier: "en_US")
        ) == "The Thursday Brief")

        // The open lane gives the avatar to threads, not tasks.
        #expect(BriefLetterLane.open.showsAvatar(for: try item(openThread)))
        #expect(!BriefLetterLane.open.showsAvatar(for: try item(openTask)))
        #expect(!BriefLetterLane.done.showsAvatar(for: try item(doneWork)))
    }

    @Test
    func deferAndDropMapToTheirTools() throws {
        let thread = try item(openThread)
        let deferThread = BriefActionPayload(action: thread.actions![1], sourceRef: thread.ref)
        let now = Date(timeIntervalSince1970: 1_788_400_000)
        #expect(try BriefRoundTwoActions.call("defer_thread", payload: deferThread, now: now)
            == BriefToolCall(name: "snooze_thread", arguments: [
                "account": .string("acct-1"),
                "threadId": .string("t2"),
                "untilTs": .number(4_102_444_800_000),
            ]))
        #expect(BriefRoundTwoActions.undoCall("defer_thread", payload: deferThread, operationID: nil)
            == BriefToolCall(name: "unsnooze_thread", arguments: ["account": .string("acct-1"), "threadId": .string("t2")]))
        #expect(BriefRoundTwoActions.undoCall("defer_thread", payload: deferThread, operationID: "op-3")?.name == "undo_operation")
        // A defer into the past is refused before it reaches the server.
        #expect(throws: BackendError.self) {
            try BriefRoundTwoActions.call("defer_thread", payload: deferThread, now: Date(timeIntervalSince1970: 4_200_000_000))
        }

        let task = try item(openTask)
        let deferTask = BriefActionPayload(action: task.actions![1], sourceRef: task.ref)
        #expect(deferTask.previousDueAt == 4_102_358_400_000)
        let call = try BriefRoundTwoActions.call("defer_task", payload: deferTask)
        #expect(call.name == "tasks_update_card")
        #expect(call.arguments["cardId"] == .string("card-1"))
        #expect(call.arguments["dueIso"] == .string("2100-01-01T00:00:00.000Z"))
        #expect(BriefRoundTwoActions.undoCall("defer_task", payload: deferTask, operationID: "op-4")
            == BriefToolCall(name: "undo_operation", arguments: ["operationId": .string("op-4")]))

        let arranged = BriefRowActions.arrange(task.actions, fallback: nil)
        #expect(arranged.tap?.action == "toggle_task")
        #expect(arranged.trailing.map(\.label) == ["Defer", "Drop"])
    }

    @Test
    func theWeeklyAndEditionFlagsDecodeFromTheReport() throws {
        let weekly = try #require(DailyReportModel(json: .object([
            "_id": .string("r1"), "kind": .string("weekly"), "generatedAt": .number(1_788_400_000_000),
            "light": .bool(true), "first": .bool(true),
        ])))
        #expect(weekly.isWeeklyReview)
        #expect(weekly.isLightEdition)
        #expect(weekly.isFirstEdition)
        // A weekly review is not called a light weekend edition.
        #expect(BriefEditionNotes.notes(for: weekly) == [BriefEditionNotes.first])

        let saturday = try #require(DailyReportModel(json: .object([
            "_id": .string("r2"), "kind": .string("morning"), "light": .bool(true),
        ])))
        #expect(BriefEditionNotes.notes(for: saturday) == [BriefEditionNotes.light])

        let older = try #require(DailyReportModel(json: .object(["_id": .string("r3")])))
        #expect(!older.isLightEdition && !older.isFirstEdition && !older.isWeeklyReview)
        #expect(BriefEditionNotes.notes(for: older).isEmpty)
        #expect(BriefEditionNotes.notes(for: nil).isEmpty)

        // Cached snapshots written before these fields keep decoding.
        let encoded = try JSONEncoder().encode(older)
        let restored = try JSONDecoder().decode(DailyReportModel.self, from: encoded)
        #expect(restored.id == "r3")
    }

    // MARK: - Preferences

    @Test
    func preferencesDecodeAndTheEmailSwitchNeedsTheService() throws {
        let json = JSONValue.object(["preferences": .object([
            "deliveryHour": .number(8),
            "weekendMode": .string("off"),
            "weeklyReview": .bool(false),
            "emailEnabled": .bool(true),
            "timezone": .string("America/New_York"),
            "email": .object(["available": .bool(false), "reason": .string("Email delivery is not set up on this server yet.")]),
        ])])
        let preferences = try #require(BriefPreferences(json: json))
        #expect(preferences.deliveryHour == 8)
        #expect(preferences.weekendMode == .off)
        #expect(!preferences.weeklyReview)
        #expect(!preferences.emailEnabled)
        #expect(!preferences.emailAvailable)
        #expect(preferences.emailUnavailableReason == "Email delivery is not set up on this server yet.")
        #expect(preferences.scheduleSummary == "Weekdays at 8:00 AM America/New York time. No edition on Saturday, and none on Sunday.")

        let defaults = try #require(BriefPreferences(json: .object(["deliveryHour": .number(3)])))
        #expect(defaults.deliveryHour == 7)
        #expect(defaults.weekendMode == .light)
        #expect(defaults.weeklyReview)
        #expect(defaults.scheduleSummary == "Weekdays at 7:00 AM. A light edition on Saturday, and the weekly review on Sunday.")
        #expect(BriefPreferences(json: .string("nope")) == nil)
        #expect(BriefPreferences.deliveryHours == [5, 6, 7, 8, 9, 10, 11])
    }

    @Test
    func aPatchSendsOnlyTheFieldsThatChange() {
        #expect(BriefPreferencesPatch(deliveryHour: 9).arguments == ["deliveryHour": .number(9)])
        #expect(BriefPreferencesPatch(weekendMode: .full).arguments == ["weekendMode": .string("full")])
        #expect(BriefPreferencesPatch(weeklyReview: false, emailEnabled: true).arguments
            == ["weeklyReview": .bool(false), "emailEnabled": .bool(true)])
        #expect(BriefPreferencesPatch().arguments.isEmpty)
    }

    @Test
    func theClientCallsThePreferenceAndSourceTools() async throws {
        let tools = RecordingTools { name, _ in
            switch name {
            case "get_brief_preferences", "save_brief_preferences":
                return .object(["preferences": .object([
                    "deliveryHour": .number(6), "weekendMode": .string("full"), "weeklyReview": .bool(true),
                    "emailEnabled": .bool(true), "email": .object(["available": .bool(true)]),
                ])])
            case "get_brief_sources":
                return .object(["health": .object(["sources": .array([]), "attention": .number(0), "line": .string("All sources are current.")])])
            default:
                return .object([:])
            }
        }
        let client = BriefSettingsClient(tools: tools)
        let loaded = try await client.preferences()
        #expect(loaded.emailEnabled)
        _ = try await client.save(BriefPreferencesPatch(deliveryHour: 6))
        let health = try await client.sources(reportID: "r1")
        #expect(health.line == "All sources are current.")
        _ = try await client.sources(reportID: nil)
        #expect(await tools.arguments(of: "save_brief_preferences") == [["deliveryHour": .number(6)]])
        #expect(await tools.arguments(of: "get_brief_sources") == [["reportId": .string("r1")], [:]])
    }

    // MARK: - Source health

    @Test
    func theSourceLinePutsProblemsFirstAndNamesTheRest() throws {
        let now = Date(timeIntervalSince1970: 1_788_400_000)
        let json = JSONValue.object(["health": .object([
            "sources": .array([
                .object([
                    "id": .string("mail:a1"), "kind": .string("mail"), "label": .string("ann@example.com"),
                    "provider": .string("google"), "status": .string("ok"),
                    "lastSyncedAt": .number((now.timeIntervalSince1970 - 240) * 1_000), "inEdition": .bool(true),
                    "reconnectPath": .null, "detail": .null,
                ]),
                .object([
                    "id": .string("calendar:a1"), "kind": .string("calendar"), "label": .string("ann@example.com"),
                    "provider": .string("google"), "status": .string("syncing"), "lastSyncedAt": .null,
                    "inEdition": .bool(false),
                ]),
                .object([
                    "id": .string("mail:a2"), "kind": .string("mail"), "label": .string("work@example.com"),
                    "provider": .string("microsoft"), "status": .string("reconnect"),
                    "lastSyncedAt": .number((now.timeIntervalSince1970 - 3 * 86_400) * 1_000),
                    "reconnectPath": .string("/api/nylas/auth?provider=microsoft"),
                    "detail": .string("work@example.com needs to reconnect."),
                ]),
                .object(["id": .string("bad")]),
            ]),
            "attention": .number(1),
            "line": .string("1 source needs you."),
        ])])
        let health = try #require(BriefSourceHealth(json: json))
        #expect(health.sources.count == 3)
        #expect(health.attention == 1)
        #expect(health.problems.map(\.id) == ["mail:a2"])
        #expect(health.problems.first?.problemLine == "work@example.com needs to reconnect.")
        #expect(health.sourcesLine(now: now)
            == "Sources: ann@example.com synced 4 min ago · Calendar (ann@example.com) still syncing")
        #expect(BriefSourceHealth.syncedAgo(nil, now: now) == "not synced yet")
        #expect(BriefSourceHealth.syncedAgo(now.addingTimeInterval(-20), now: now) == "just now")
        #expect(BriefSourceHealth.syncedAgo(now.addingTimeInterval(-3_600), now: now) == "1 hour ago")
        #expect(BriefSourceHealth.syncedAgo(now.addingTimeInterval(-5 * 3_600), now: now) == "5 hours ago")
        #expect(BriefSourceHealth.syncedAgo(now.addingTimeInterval(-2 * 86_400), now: now) == "2 days ago")
    }

    @Test
    func refreshingTheBriefReadsTheSourcesForThatEdition() async {
        let tools = RecordingTools { name, _ in
            switch name {
            case "get_latest_daily_report":
                return .object(["report": .object(["_id": .string("r7"), "kind": .string("morning")])])
            case "get_brief_sources":
                return .object(["health": .object(["sources": .array([]), "attention": .number(0), "line": .string("Quiet.")])])
            default:
                return .object([:])
            }
        }
        let store = ProductStore(tools: tools, backend: BackendClient(baseURL: nil))
        await store.refreshBrief()
        #expect(store.dailyReport?.id == "r7")
        #expect(store.briefSources?.line == "Quiet.")
        #expect(await tools.arguments(of: "get_brief_sources") == [["reportId": .string("r7")]])
    }
}
