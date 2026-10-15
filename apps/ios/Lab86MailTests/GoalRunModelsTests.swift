import Foundation
import Testing
@testable import Lab86Mail

// Goal runs on the wire (docs/albatross-goal-runs.md, "Contract summary"):
// the five goal fields of a run, their tolerance for an older server and the
// offline cache, the new artifact kinds, the Work detail's goal fields, and a
// draft's attachments. The contract is lib/albatross/goal-run-contract.ts.
struct GoalRunModelsTests {
    // MARK: - Fixtures: Sam Rivera bills Harbor Design for the quarter

    private static let fullRun: JSONValue = .object([
        "id": .string("run_goal_1"),
        "workId": .string("work_invoice"),
        "stepKey": .string("goal"),
        "stepIdentity": .string("goal:work_invoice"),
        "stepTitle": .string("Bill Harbor Design for the quarter"),
        "state": .string("handed_off"),
        "trigger": .string("user"),
        "outcome": .string("ready_for_you"),
        "summary": .string("The invoice, the W-9, and the mail to Priya Shah are ready."),
        "goal": .bool(true),
        "messages": .array([
            .object([
                "id": .string("m1"),
                "at": .number(1_760_500_000_000),
                "text": .string("I look for the hours in your mail and in Jira first."),
                "sources": .array([
                    .object(["kind": .string("mail"), "title": .string("Re: Q3 hours"), "id": .string("t_hours"), "accountId": .string("acct_1")]),
                    .object(["kind": .string("jira"), "title": .string("HD-214"), "url": .string("https://harbordesign.example/browse/HD-214")]),
                ]),
            ]),
            .object([
                "id": .string("m2"),
                "at": .number(1_760_500_060_000),
                "text": .string("Jira shows 36, 52, and 41 hours."),
                "sources": .array([
                    .object(["kind": .string("jira"), "title": .string("HD-214 worklog"), "url": .string("https://harbordesign.example/browse/HD-214?page=worklog")]),
                ]),
            ]),
        ]),
        "checklist": .array([
            .object(["id": .string("c1"), "text": .string("Find the billing address"), "state": .string("done")]),
            .object(["id": .string("c2"), "text": .string("Find the hours for each month"), "state": .string("doing")]),
            .object(["id": .string("c3"), "text": .string("Make the invoice"), "state": .string("todo")]),
            .object(["id": .string("c4"), "text": .string("Sign the W-9"), "state": .string("yours")]),
        ]),
        "items": .array([
            .object([
                "kind": .string("draft"), "id": .string("draft_7"), "accountId": .string("acct_1"),
                "title": .string("Draft to Priya Shah"), "state": .string("check"), "note": .string("2 files attached"),
            ]),
            .object([
                "kind": .string("document"), "id": .string("doc_inv"), "url": .string("/?view=files&office=doc_inv"),
                "title": .string("Invoice 2026-10 for Harbor Design"), "state": .string("blanks"),
                "blanks": .array([.string("hours for September"), .string("hourly rate")]),
            ]),
            .object([
                "kind": .string("file"), "id": .string("file_w9"), "url": .string("/?view=files&file=file_w9"),
                "title": .string("Form W-9"), "state": .string("check"), "note": .string("The tax ID fills in when you send."),
            ]),
        ]),
        "unsure": .array([
            .string("I found no mail with the hours for July. I used 36 from the Jira worklog."),
            .string("  "),
            .string("I found no mail with the hours for July. I used 36 from the Jira worklog."),
        ]),
        "artifacts": .array([
            .object(["kind": .string("deck"), "id": .string("doc_deck"), "title": .string("Quarter review"), "url": .string("/?view=files&document=doc_deck")]),
            .object(["kind": .string("file"), "id": .string("file_w9"), "title": .string("Form W-9"), "url": .string("/?view=files&file=file_w9")]),
        ]),
        "createdAt": .number(1_760_499_000_000),
        "updatedAt": .number(1_760_500_060_000),
    ])

    // MARK: - Decoding

    @Test func decodesTheFiveGoalFields() throws {
        let run = try #require(StepRunView(json: Self.fullRun))
        #expect(run.goal)
        #expect(run.isGoal)
        #expect(run.messages.count == 2)
        #expect(run.messages[0].sources.map(\.kind) == [.mail, .jira])
        #expect(run.messages[0].sources[0].referenceID == "t_hours")
        #expect(run.messages[0].sources[0].accountID == "acct_1")
        #expect(run.messages[1].at != nil)
        #expect(run.checklist.map(\.state) == [.done, .doing, .todo, .yours])
        #expect(run.doingItem?.text == "Find the hours for each month")
        #expect(run.items.map(\.kind) == [.draft, .document, .file])
        #expect(run.items[1].state == .blanks)
        #expect(run.items[1].blanks == ["hours for September", "hourly rate"])
        #expect(run.items[2].note == "The tax ID fills in when you send.")
        #expect(run.items[2].savedFileID == "file_w9")
        // Blank and repeated lines drop out.
        #expect(run.unsure.count == 1)
        #expect(run.artifacts.map(\.kind) == [.deck, .file])
        #expect(run.artifacts[0].kind.label == "Deck")
    }

    @Test func anOlderServerLeavesTheGoalFieldsEmpty() throws {
        let run = try #require(StepRunView(json: .object([
            "id": .string("run_old"),
            "stepKey": .string("step-1"),
            "stepTitle": .string("Send the letter"),
            "state": .string("running"),
        ])))
        #expect(!run.goal)
        #expect(!run.isGoal)
        #expect(run.messages.isEmpty)
        #expect(run.checklist.isEmpty)
        #expect(run.items.isEmpty)
        #expect(run.unsure.isEmpty)
        #expect(run.doingItem == nil)
    }

    @Test func theGoalKeyAloneMakesAGoalRun() {
        let run = StepRunView(id: "r", workID: "w", stepKey: GoalRun.stepKey, stepTitle: "Bill the client", state: .queued)
        #expect(run.isGoal)
        #expect(!run.goal)
    }

    @Test func unknownWordsReadAsUnknownNotAsAFailure() throws {
        let json: JSONValue = .object([
            "id": .string("run_new"),
            "stepKey": .string("goal"),
            "stepTitle": .string("Bill the client"),
            "state": .string("running"),
            "messages": .array([
                .object(["id": .string("m"), "text": .string("Hello"), "sources": .array([
                    .object(["kind": .string("slack"), "title": .string("#billing"), "url": .string("https://slack.example/c/1")]),
                ])]),
            ]),
            "checklist": .array([.object(["id": .string("c"), "text": .string("Ask"), "state": .string("later")])]),
            "items": .array([.object(["kind": .string("video"), "title": .string("Walkthrough"), "state": .string("maybe")])]),
        ])
        let run = try #require(StepRunView(json: json))
        #expect(run.messages[0].sources[0].kind == .unknown)
        #expect(run.messages[0].sources[0].kind.word == "Source")
        #expect(run.checklist[0].state == .unknown)
        #expect(run.checklist[0].state.word == nil)
        #expect(run.items[0].kind == .unknown)
        #expect(run.items[0].state == .unknown)
        #expect(run.items[0].state.word == "Check it")
        #expect(run.items[0].kind.verb == "Open")
    }

    @Test func aSourceNeedsATitleAndAPlaceToOpen() {
        #expect(RunSource(json: .object(["kind": .string("web"), "url": .string("https://irs.gov")])) == nil)
        #expect(RunSource(json: .object(["kind": .string("web"), "title": .string("IRS")])) == nil)
        let byID = RunSource(json: .object(["kind": .string("mail"), "title": .string("Re: hours"), "id": .string("t1")]))
        #expect(byID?.referenceID == "t1")
        #expect(byID?.id == "mail:t1")
    }

    @Test func aMessageWithoutTextOrAnIDDropsOut() {
        #expect(RunMessage(json: .object(["id": .string("m"), "text": .string("   ")])) == nil)
        #expect(RunMessage(json: .object(["text": .string("Hello")])) == nil)
        let many = (0..<12).map { index -> JSONValue in
            .object(["kind": .string("web"), "title": .string("Page \(index)"), "url": .string("https://example.com/\(index)")])
        }
        let capped = RunMessage(json: .object(["id": .string("m"), "text": .string("Hello"), "sources": .array(many)]))
        #expect(capped?.sources.count == RunMessage.sourceLimit)
    }

    @Test func anItemNeedsATitleAndReadyWithBlanksIsBlanks() {
        #expect(HandoffItem(json: .object(["kind": .string("draft"), "state": .string("ready")])) == nil)
        let item = HandoffItem(json: .object([
            "kind": .string("sheet"), "title": .string("Hours"), "state": .string("ready"),
            "blanks": .array([.string("rate"), .string("Rate"), .string("  ")]),
        ]))
        #expect(item?.state == .blanks)
        #expect(item?.blanks == ["rate"])
        #expect(item?.kind.opensInDocumentMode == true)
        #expect(HandoffItem(kind: .event, title: "Call").kind.opensInDocumentMode == false)
    }

    @Test func theSavedFileIDComesFromTheLinkElseTheID() {
        #expect(SavedFileLink.fileID(in: "/?view=files&file=file_1") == "file_1")
        #expect(SavedFileLink.fileID(in: "https://other.example/?view=files&file=file_1") == nil)
        #expect(SavedFileLink.fileID(in: "") == nil)
        #expect(SavedFileLink.bytesPath(fileID: "file_1") == "/api/files/saved/file_1")
        #expect(HandoffItem(kind: .file, referenceID: "file_2", title: "W-9").savedFileID == "file_2")
        #expect(HandoffItem(kind: .file, referenceID: "file_2", url: "/?view=files&file=file_3", title: "W-9").savedFileID == "file_3")
    }

    @Test func theUnsureLinesKeepTheFirstFour() {
        let lines = StepRunView.cleanUnsure(["a", "a", "b  c", "", "d", "e", "f"])
        #expect(lines == ["a", "b c", "d", "e"])
    }

    // MARK: - The offline cache

    @Test func theCacheRoundTripsTheGoalFields() throws {
        let run = try #require(StepRunView(json: Self.fullRun))
        let data = try JSONEncoder().encode(run)
        let decoded = try JSONDecoder().decode(StepRunView.self, from: data)
        #expect(decoded == run)
        #expect(decoded.items.count == 3)
        #expect(decoded.messages[0].sources.count == 2)
    }

    @Test func aCachedRunWithoutTheGoalKeysStillDecodes() throws {
        let cached: [String: Any] = [
            "id": "run_cached",
            "workID": "work_1",
            "stepKey": "step-1",
            "stepIdentity": "step-1",
            "stepTitle": "Send the letter",
            "state": "done",
            "trigger": "user",
            "log": [] as [Any],
            "artifacts": [] as [Any],
        ]
        let data = try JSONSerialization.data(withJSONObject: cached)
        let run = try JSONDecoder().decode(StepRunView.self, from: data)
        #expect(run.id == "run_cached")
        #expect(!run.goal)
        #expect(run.items.isEmpty)
        #expect(run.unsure.isEmpty)
    }

    @Test func withStateKeepsTheGoalFields() throws {
        let run = try #require(StepRunView(json: Self.fullRun))
        let closed = run.with(state: .closed)
        #expect(closed.state == .closed)
        #expect(closed.items == run.items)
        #expect(closed.checklist == run.checklist)
        #expect(closed.messages == run.messages)
        #expect(closed.unsure == run.unsure)
        #expect(closed.goal)
    }

    // MARK: - The Work detail

    @Test func theDetailReadsGoalRunsAndTheChecklist() throws {
        let detail = try #require(WorkDetail(json: .object([
            "work": .object(["_id": .string("work_invoice"), "title": .string("Bill Harbor Design for the quarter")]),
            "execution": .object(["guideSteps": .array([]), "remainingSteps": .number(0), "totalSteps": .number(0)]),
            "goalRuns": .bool(true),
            "checklist": .array([.object(["id": .string("c1"), "text": .string("Find the hours"), "state": .string("doing")])]),
        ])))
        #expect(detail.isGoalWork)
        #expect(detail.checklist?.first?.state == .doing)
        let data = try JSONEncoder().encode(detail)
        let decoded = try JSONDecoder().decode(WorkDetail.self, from: data)
        #expect(decoded.isGoalWork)
        #expect(decoded.checklist?.count == 1)
    }

    @Test func theExecutionReadsTheGoalRun() throws {
        let detail = try #require(WorkDetail(json: .object([
            "work": .object(["_id": .string("work_invoice"), "title": .string("Bill Harbor Design for the quarter")]),
            "goalRuns": .bool(true),
            "execution": .object([
                "guideSteps": .array([]),
                "goalRun": .object([
                    "id": .string("run_goal_1"), "stepKey": .string("goal"), "stepTitle": .string("Bill Harbor Design for the quarter"),
                    "state": .string("running"), "goal": .bool(true),
                ]),
            ]),
        ])))
        #expect(detail.execution.goalRun?.id == "run_goal_1")
        #expect(detail.execution.goalRun?.isGoal == true)
        #expect(detail.execution.activeRun == nil)
        // The optimistic writes keep it.
        #expect(detail.completing(stepID: "x").execution.goalRun?.id == "run_goal_1")
        let cached = try JSONDecoder().decode(WorkDetail.self, from: try JSONEncoder().encode(detail))
        #expect(cached.execution.goalRun?.id == "run_goal_1")
    }

    @Test func theThreadRowReadsGoalAndItemCount() throws {
        let row = try #require(ThreadRow(json: .object([
            "workId": .string("work_invoice"), "title": .string("Bill Harbor Design for the quarter"),
            "status": .string("ready_for_you"), "goal": .bool(true), "itemCount": .number(3),
        ])))
        #expect(row.goal)
        #expect(row.itemCount == 3)
        #expect(row.with(unread: true).goal)
        #expect(row.with(unread: true).itemCount == 3)
        let older = try #require(ThreadRow(json: .object(["workId": .string("w"), "title": .string("Renew")])))
        #expect(!older.goal)
        #expect(older.itemCount == 0)
    }

    @Test func anOlderDetailIsNotAGoalWork() throws {
        let detail = try #require(WorkDetail(json: .object([
            "work": .object(["_id": .string("work_1"), "title": .string("Send the letter")]),
            "execution": .object(["guideSteps": .array([])]),
        ])))
        #expect(!detail.isGoalWork)
        #expect(detail.checklist == nil)
    }

    // MARK: - Draft attachments

    @Test func aDraftAttachmentRoundTripsItsWireShape() throws {
        let rows = DraftAttachment.list(from: .array([
            .object([
                "source": .string("file"), "fileId": .string("file_inv"), "provider": .string("office"),
                "format": .string("pdf"), "name": .string("Invoice 2026-10.pdf"), "size": .number(86_016),
                "contentType": .string("application/pdf"),
            ]),
            .object(["source": .string("file"), "fileId": .string("file_w9"), "provider": .string("upload"), "format": .string("native"), "name": .string("Form W-9.pdf")]),
            .object(["source": .string("file"), "name": .string("No id.pdf")]),
        ]))
        #expect(rows.count == 2)
        #expect(rows[0].format == .pdf)
        #expect(rows[0].format.word == "PDF")
        #expect(rows[0].size == 86_016)
        #expect(rows[1].size == nil)
        let json = rows[0].json
        #expect(json["source"]?.stringValue == "file")
        #expect(json["fileId"]?.stringValue == "file_inv")
        #expect(json["provider"]?.stringValue == "office")
        #expect(json["size"]?.doubleValue == 86_016)
        #expect(DraftAttachment.list(from: .array([json])) == [rows[0]])
    }

    @Test func anUnknownProviderOrFormatReadsAsUnknown() {
        let row = DraftAttachment(json: .object([
            "fileId": .string("f"), "provider": .string("box"), "format": .string("docx"), "name": .string("x.docx"),
        ]))
        #expect(row?.provider == .unknown)
        #expect(row?.format == .unknown)
        #expect(row?.format.word == "File")
    }
}
