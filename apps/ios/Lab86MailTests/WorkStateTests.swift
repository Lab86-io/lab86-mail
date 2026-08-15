import Foundation
import Testing
@testable import Lab86Mail

// The one definition of what state an Albatross is in. These are the same rules
// `tests/albatross-work-state.test.ts` pins for the web. Two clients disagreeing
// about whether a thing needs you is the drift this file exists to stop.
struct WorkStateTests {
    private func item(
        _ id: String = "w",
        title: String? = "Set up a gold allocation",
        rawText: String = "raw",
        status: String = "ready",
        workState: String? = nil,
        agentState: String? = nil,
        areaID: String? = "area_1",
        areaName: String? = "Money",
        openQuestions: Int = 0,
        scheduledEndAt: Date? = nil
    ) -> WorkListItem {
        var row: [String: JSONValue] = [
            "_id": .string(id),
            "rawText": .string(rawText),
            "status": .string(status),
            "openQuestions": .number(Double(openQuestions)),
        ]
        if let title { row["title"] = .string(title) }
        if let workState { row["workState"] = .string(workState) }
        if let agentState { row["agentState"] = .string(agentState) }
        if let areaID { row["primaryAreaId"] = .string(areaID) }
        if let areaName { row["areaName"] = .string(areaName) }
        if let scheduledEndAt { row["scheduledEndAt"] = .number(scheduledEndAt.timeIntervalSince1970 * 1_000) }
        return WorkListItem(json: .object(row))!
    }

    private func detail(workState: String = "active", scheduledEndAt: Date) -> WorkDetail {
        WorkDetail(json: .object([
            "work": .object([
                "_id": .string("work-1"),
                "title": .string("Renew passport"),
                "rawText": .string("Renew my passport"),
                "status": .string("ready"),
                "workState": .string(workState),
            ]),
            "plan": .object([
                "_id": .string("plan-1"),
                "status": .string("applied"),
                "outcome": .string("Passport renewed"),
            ]),
            "execution": .object([
                "currentStep": .object([
                    "key": .string("official-form"),
                    "kind": .string("task"),
                    "title": .string("Complete the official form"),
                ]),
                "remainingSteps": .number(1),
                "totalSteps": .number(4),
                "scheduledStartAt": .number(1_999_000),
                "scheduledEndAt": .number(scheduledEndAt.timeIntervalSince1970 * 1_000),
            ]),
        ]))!
    }

    // MARK: What needs you

    @Test func anOpenQuestionAlwaysNeedsYou() {
        #expect(item(openQuestions: 1).needsYou)
        #expect(item(openQuestions: 3).state == .needsYou)
    }

    @Test func aStuckOrAskingAgentNeedsYou() {
        #expect(item(agentState: "needs_input").needsYou)
        #expect(item(agentState: "error").needsYou)
        #expect(item(status: "needs_answers").needsYou)
    }

    @Test func aFinishedThingNeverNeedsYou() {
        #expect(!item(workState: "done", openQuestions: 2).needsYou)
        #expect(!item(workState: "archived", openQuestions: 2).needsYou)
    }

    // MARK: The states themselves

    @Test func closedWithQuestionsLeftIsStillAsking() {
        // The whole point of the state: a thing you stopped, that Albatross
        // never got an answer to, must not read as settled.
        #expect(item(workState: "done", openQuestions: 1).state == .unresolved)
        #expect(item(workState: "released", openQuestions: 2).state == .unresolved)
    }

    @Test func putDownIsNeverFiledAsHidden() {
        // Released is checked before archived, so the product can always tell
        // the user what they consciously chose to stop carrying.
        #expect(item(workState: "released").state == .released)
        #expect(item(workState: "archived").state == .archived)
    }

    @Test func theRestFallWhereTheyShould() {
        #expect(item(workState: "paused").state == .paused)
        #expect(item(workState: "waiting").state == .waiting)
        #expect(item(workState: "blocked").state == .waiting)
        #expect(item().state == .inProgress)
    }

    @Test func aCalendarHoldStopsBlockingWorkWhenItEnds() {
        let end = Date(timeIntervalSince1970: 2_000)
        let work = item(scheduledEndAt: end)
        #expect(work.hasUpcomingBooking(at: end.addingTimeInterval(-1)))
        #expect(!work.hasUpcomingBooking(at: end))
    }

    @Test func workDetailRecoveryAppearsAsTheClockPassesTheDeadline() throws {
        let now = Date(timeIntervalSince1970: 2_000)
        #expect(passedWorkExecutionMove(detail(scheduledEndAt: now.addingTimeInterval(1)), at: now) == nil)

        let passed = try #require(
            passedWorkExecutionMove(detail(scheduledEndAt: now.addingTimeInterval(-1)), at: now)
        )
        #expect(passed.workID == "work-1")
        #expect(passed.stepKey == "official-form")
        #expect(passed.scheduledStartAt == Date(timeIntervalSince1970: 1_999))

        for state in ["done", "released", "archived"] {
            #expect(
                passedWorkExecutionMove(
                    detail(workState: state, scheduledEndAt: now.addingTimeInterval(-1)),
                    at: now
                ) == nil
            )
        }
    }

    @Test func successfulRecoveryRefreshesTheOwningSurface() {
        var refreshCount = 0
        #expect(
            completeMissedMoveRecovery(error: nil) {
                refreshCount += 1
            } == nil
        )
        #expect(refreshCount == 1)

        #expect(
            completeMissedMoveRecovery(error: "Try again.") {
                refreshCount += 1
            } == "Try again."
        )
        #expect(refreshCount == 1)
    }

    // MARK: What the row says out loud

    @Test func theStandingLineCountsInWordsWhereItCan() {
        #expect(item(openQuestions: 1).standingLine == "One question waiting for you")
        #expect(item(openQuestions: 4).standingLine == "4 questions waiting for you")
        #expect(item(workState: "waiting").standingLine == "Waiting on somebody else")
    }

    @Test func aRowNeverShowsAnIdentifierOrABlankLine() {
        #expect(item(title: nil, rawText: "Renew the passport").displayTitle == "Renew the passport")
        #expect(item(title: nil, rawText: "   ").displayTitle == "Something you asked for")
        #expect(item(title: "  ", rawText: "").displayTitle == "Something you asked for")
    }

    @Test func onlyWhatAsksForYouEarnsTheAccent() {
        #expect(WorkState.needsYou.asksForYou)
        #expect(WorkState.unresolved.asksForYou)
        for state in [WorkState.inProgress, .waiting, .paused, .done, .released, .archived] {
            #expect(!state.asksForYou)
        }
    }

    // MARK: Filtering and grouping

    @Test func theNeedsYouFilterIsTheShortList() {
        let rows = [item("a", openQuestions: 2), item("b"), item("c", agentState: "error")]
        let filtered = WorkGrouping.filter(rows, by: .needsYou, areaID: nil)
        #expect(filtered.map(\.id) == ["a", "c"])
    }

    @Test func theNoAreaFilterIsWhatTheOldReviewQueueWas() {
        let rows = [item("a", areaID: nil, areaName: nil), item("b")]
        #expect(WorkGrouping.filter(rows, by: .unhomed, areaID: nil).map(\.id) == ["a"])
    }

    @Test func anAreaNarrowsEveryFilter() {
        let rows = [item("a", areaID: "money"), item("b", areaID: "house", openQuestions: 1)]
        #expect(WorkGrouping.filter(rows, by: .all, areaID: "money").map(\.id) == ["a"])
        #expect(WorkGrouping.filter(rows, by: .needsYou, areaID: "money").isEmpty)
    }

    @Test func groupsComeBackInTheOrderTheListShowsThem() {
        let rows = [
            item("done", workState: "done"),
            item("asking", openQuestions: 1),
            item("moving"),
        ]
        let groups = WorkGrouping.group(rows)
        #expect(groups.map(\.state) == [.needsYou, .inProgress, .done])
    }

    @Test func emptyGroupsAreNeverDrawn() {
        let groups = WorkGrouping.group([item("moving")])
        #expect(groups.count == 1)
        #expect(groups[0].state == .inProgress)
    }

    @Test func executionSnapshotKeepsCurrentMissedAndNeedsYouSeparate() throws {
        let now = Date(timeIntervalSince1970: 2_000)
        let value = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(
                #"""
                {
                  "currentMove": {
                    "workId":"current", "workTitle":"Renew passport",
                    "stepKey":"book", "stepTitle":"Book the appointment",
                    "phase":"active", "scheduledStartAt":2000000,
                    "remainingSteps":2, "totalSteps":3, "areaName":"Personal"
                  },
                  "missedMoves": [{
                    "workId":"missed", "workTitle":"Submit expenses",
                    "stepTitle":"Upload the receipts", "phase":"missed",
                    "remainingSteps":1, "totalSteps":2
                  }],
                  "needsYou": [{
                    "_id":"asking", "title":"Choose a hotel", "rawText":"Choose a hotel",
                    "status":"needs_answers", "openQuestions":1
                  }]
                }
                """#.utf8
            )
        )

        let snapshot = WorkExecutionSnapshot(json: value)

        #expect(snapshot.currentMove?.workID == "current")
        #expect(snapshot.currentMove?.scheduledStartAt == now)
        #expect(snapshot.currentMove?.stepTitle == "Book the appointment")
        #expect(snapshot.missedMoves.map(\.workID) == ["missed"])
        #expect(snapshot.needsYou.map(\.id) == ["asking"])
    }

    @Test func executionMoveKeepsSeparateScheduledBlocksAndRepairsBlankTitles() throws {
        let first = try #require(WorkExecutionMove(json: .object([
            "workId": .string("passport"),
            "workTitle": .string("Renew passport"),
            "stepKey": .string("submit"),
            "stepTitle": .string(" "),
            "scheduledStartAt": .number(2_000_000),
        ])))
        let second = try #require(WorkExecutionMove(json: .object([
            "workId": .string("passport"),
            "workTitle": .string("Renew passport"),
            "stepKey": .string("submit"),
            "stepTitle": .string("Submit the form"),
            "scheduledStartAt": .number(3_000_000),
        ])))

        #expect(first.stepTitle == "Open the current step")
        #expect(first.id != second.id)
    }

    @Test func oldWorkDetailSnapshotDecodesWithoutExecution() throws {
        let detail = try JSONDecoder().decode(
            WorkDetail.self,
            from: Data(
                #"""
                {
                  "work": {
                    "id":"w1", "title":"Renew passport", "rawText":"Renew passport",
                    "status":"ready", "workState":"active", "agentState":"idle"
                  },
                  "plan":null, "project":null, "questions":[], "application":null,
                  "contract":null, "evidence":[]
                }
                """#.utf8
            )
        )

        #expect(detail.execution.currentStep == nil)
        #expect(detail.execution.guideSteps.isEmpty)
        #expect(detail.execution.remainingSteps == 0)
        #expect(detail.execution.totalSteps == 0)
    }

    @Test func mailProofCandidateNamesTheExactRequirementBeforeConfirmation() {
        let candidate = WorkProofCandidate(json: .object([
            "workId": .string("passport"),
            "workTitle": .string("Renew passport"),
            "proofId": .string("confirmation"),
            "proofWhat": .string("The application confirmation arrived"),
        ]), matchedMessageID: "message-7", matchedContent: "Your application was received.")

        #expect(candidate?.workID == "passport")
        #expect(candidate?.proofID == "confirmation")
        #expect(candidate?.proofWhat == "The application confirmation arrived")
        #expect(candidate?.matchedMessageID == "message-7")
        #expect(candidate?.matchedContent == "Your application was received.")
    }
}

struct CalendarAuthorizationTests {
    private func calendar(
        accountID: String = "account-1",
        calendarID: String = "calendar-1",
        readOnly: Bool = false
    ) -> CalendarChoice {
        CalendarChoice(json: .object([
            "accountId": .string(accountID),
            "calendarId": .string(calendarID),
            "name": .string("Primary"),
            "isPrimary": .bool(true),
            "readOnly": .bool(readOnly),
        ]))!
    }

    @Test func eventCreationRequiresTheSelectedAuthorizedWritableCalendar() {
        let writable = calendar()
        #expect(
            EventEditorView.canCreateEvent(
                accountID: "account-1",
                calendarID: "calendar-1",
                calendars: [writable],
                unauthorizedAccountIDs: []
            )
        )
        #expect(
            !EventEditorView.canCreateEvent(
                accountID: "account-1",
                calendarID: "calendar-1",
                calendars: [writable],
                unauthorizedAccountIDs: ["account-1"]
            )
        )
        #expect(
            !EventEditorView.canCreateEvent(
                accountID: "account-1",
                calendarID: "calendar-1",
                calendars: [calendar(readOnly: true)],
                unauthorizedAccountIDs: []
            )
        )
        #expect(
            !EventEditorView.canCreateEvent(
                accountID: "account-1",
                calendarID: "different-calendar",
                calendars: [writable],
                unauthorizedAccountIDs: []
            )
        )
    }
}
