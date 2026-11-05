import Foundation
import Testing
@testable import Lab86Mail

// The live Today page, held to the web's answers (tests/today-page.test.ts and
// lib/obligations/today-fixtures.ts). Wednesday, October 28, 2026, 11:05 AM in
// Los Angeles. Invented people only.
struct TodayPageTests {
    private static let tz = "America/Los_Angeles"
    private static let now: ObligationMillis = 1_793_210_700_000
    private static let hour: ObligationMillis = 3_600_000
    private static let day: ObligationMillis = 86_400_000

    private func item(
        _ id: String,
        kind: ObligationKind = .reply,
        state: ObligationState = .open,
        source: ObligationSource = .mail,
        sourceLabel: String? = nil,
        title: String = "Can you confirm the date?",
        asker: String = "Ada Example",
        due: ObligationDue = .none,
        dueAt: ObligationMillis? = nil,
        workID: String? = nil,
        pushLevel: ObligationPushLevel = .none,
        code: ObligationCode? = nil,
        draftReady: Bool = false,
        createdAt: ObligationMillis = TodayPageTests.now - TodayPageTests.hour,
        closedAt: ObligationMillis? = nil,
        closeReason: ObligationCloseReason? = nil
    ) -> ObligationView {
        ObligationView(
            id: id,
            kind: kind,
            state: state,
            source: source,
            sourceKey: "\(source.rawValue):acct:\(id)",
            sourceLabel: sourceLabel,
            title: title,
            asker: asker,
            due: due,
            dueAt: dueAt,
            workID: workID,
            pushLevel: pushLevel,
            code: code,
            draftReady: draftReady,
            createdAt: createdAt,
            closedAt: closedAt,
            closeReason: closeReason
        )
    }

    private func rows(_ items: [ObligationView], extras: [NeedsYouExtra] = [], cap: Int = TodayPage.needsYouCap) -> TodayRows {
        TodayPage.rows(
            groups: NeedsYouGrouping.groups(items: items, extras: extras, now: Self.now, timezone: Self.tz),
            cap: cap
        )
    }

    private func event(
        _ id: String,
        from: Double,
        to: Double,
        allDay: Bool = false,
        location: String? = nil,
        status: String? = nil
    ) -> TodayScheduleEvent {
        TodayScheduleEvent(
            id: id,
            title: id,
            startAt: Self.now + from * Self.hour,
            endAt: Self.now + to * Self.hour,
            allDay: allDay,
            location: location,
            status: status
        )
    }

    private func lineKeys(_ lines: [TodayScheduleLine]) -> [String] {
        lines.map { line in
            switch line {
            case .open: return "open"
            case .event(let event, let state):
                switch state {
                case .past: return "\(event.id):past"
                case .now: return "\(event.id):now"
                case .next: return "\(event.id):next"
                case .later: return "\(event.id):later"
                }
            }
        }
    }

    private func note(_ items: [ObligationView], _ events: [TodayScheduleEvent], now: ObligationMillis = TodayPageTests.now) -> String {
        let list = rows(items)
        let words = TodayPage.note(
            rows: list.rows,
            open: list.open,
            dueToday: list.dueToday,
            lines: TodayPage.scheduleLines(events, now: now),
            now: now,
            timezone: Self.tz
        )
        return "\(words.lead) \(words.day)"
    }

    // The day of `TODAY_PREVIEW_ITEMS` and `TODAY_PREVIEW_EVENTS`.
    private var fixtureItems: [ObligationView] {
        let pays = (0..<3).map { index in
            item(
                "tp_pay_\(index)",
                kind: .change,
                title: "Your payment of $36.00 could not be processed.",
                asker: "Lumen Hosting",
                due: .today,
                createdAt: Self.now - Double(8 + index * 24) * Self.hour
            )
        }
        return [
            item(
                "tp_flight",
                kind: .change,
                title: "Flight HA 220 now departs at 6:40 PM from gate C12.",
                asker: "Harbor Air",
                pushLevel: .timeSensitive,
                createdAt: Self.now - 40 * 60_000
            ),
            item(
                "tp_rsvp",
                kind: .rsvp,
                source: .calendar,
                sourceLabel: "Vendor review",
                title: "Answer the invitation: Vendor review",
                asker: "Dana Whitfield",
                due: .soon,
                dueAt: Self.now + 26 * Self.hour,
                createdAt: Self.now - 3 * Self.hour
            ),
            item(
                "tp_marin",
                title: "What works for you to send the licensing terms to the press office?",
                asker: "Marin Okafor",
                draftReady: true,
                createdAt: Self.now - 20 * Self.hour
            ),
            item(
                "tp_review",
                kind: .action,
                source: .github,
                sourceLabel: "northwind/web #491",
                title: "Review: Move the invoice export to the new queue",
                asker: "Priya Raman",
                due: .today,
                createdAt: Self.now - 5 * Self.hour
            ),
        ] + pays + [
            item(
                "tp_nda",
                kind: .action,
                title: "Please sign the updated NDA before the kickoff.",
                asker: "Tomás Rivera",
                due: .soon,
                dueAt: Self.now + 2 * Self.day,
                createdAt: Self.now - 3 * Self.hour
            ),
            item(
                "tp_card",
                kind: .change,
                title: "The card ending 4410 expires next month.",
                asker: "Bramble Press",
                createdAt: Self.now - 30 * Self.hour
            ),
            item(
                "tp_slack",
                kind: .action,
                source: .slack,
                sourceLabel: "#finance",
                title: "Can you send the Q3 numbers before the board call?",
                asker: "Sam Lindqvist",
                createdAt: Self.now - 26 * Self.hour
            ),
        ]
    }

    private var fixtureEvents: [TodayScheduleEvent] {
        // An hour of the day is an offset from 11:05 AM.
        let start = -(11 + 5.0 / 60)
        func at(_ title: String, _ from: Double, _ to: Double, _ location: String? = nil) -> TodayScheduleEvent {
            TodayScheduleEvent(
                id: title,
                title: title,
                startAt: Self.now + (start + from) * Self.hour,
                endAt: Self.now + (start + to) * Self.hour,
                location: location
            )
        }
        return [
            at("Team standup", 9.5, 9.75),
            at("Design review", 10.5, 11.5, "Studio"),
            at("Lunch with Mara", 12, 13, "Ostro"),
            at("Board prep", 15, 16, "Room 2"),
            at("Squash", 19, 20),
        ]
    }

    // MARK: - The rows of the list

    @Test func theNoticesOfOneSenderShareARowAndTwoQuestionsDoNot() {
        let list = rows([
            item("a", kind: .change, title: "Payment failed.", asker: "Lumen Hosting"),
            item("b", kind: .change, title: "Payment failed again.", asker: "lumen hosting", createdAt: Self.now - 2 * Self.hour),
            item("c", asker: "Marin"),
            item("d", asker: "Marin", createdAt: Self.now - 3 * Self.hour),
        ])
        #expect(list.open == 3)
        #expect(list.rows.map(\.id) == ["c", "d", "a"])
        #expect(list.rows.map(\.otherIDs) == [[], [], ["b"]])
    }

    @Test func theCapCountsRowsAndTheRestIsACount() {
        let list = rows((0..<8).map { item("r\($0)") }, cap: 6)
        #expect(list.rows.count == 6)
        #expect(list.more == 2)
        #expect(list.open == 8)
    }

    @Test func dueTodayLeadsThenAQuestionComesBeforeANoticeWithADueWord() {
        let list = rows([
            item("notice", kind: .change, due: .soon),
            item("question"),
            item("today", kind: .action, asker: "Sam", due: .today),
        ])
        #expect(list.rows.map(\.id) == ["today", "question", "notice"])
    }

    @Test func waitingOnOthersAndClosedItemsAreNotOnTheList() {
        let list = rows([
            item("wait", kind: .waiting),
            item("closed", state: .done, closedAt: Self.now - 1_000, closeReason: .userDone),
        ])
        #expect(list.rows.isEmpty)
        #expect(list.open == 0)
    }

    @Test func aRowThatLeavesKeepsItsPlaceAndComesBackOnce() {
        let list = rows([item("a"), item("b", createdAt: Self.now - 2 * Self.hour)])
        let gone = TodayRow(entry: .obligation(item("gone")))
        let leaving = TodayLeavingRow(row: gone, index: 1, word: "Done")
        #expect(TodayPage.rowsInView(list.rows, leaving: leaving).map(\.id) == ["a", "gone", "b"])
        #expect(TodayPage.rowsInView(list.rows, leaving: nil).map(\.id) == ["a", "b"])
        // Undo: the row is on the list again, so it does not show twice.
        let back = TodayLeavingRow(row: list.rows[0], index: 1, word: "Done")
        #expect(TodayPage.rowsInView(list.rows, leaving: back).map(\.id) == ["a", "b"])
    }

    // MARK: - The schedule

    @Test func eachEventHasItsStateAndALongOpenStretchHasALine() {
        let lines = TodayPage.scheduleLines(
            [event("past", from: -3, to: -2), event("now", from: -0.5, to: 0.5), event("next", from: 3, to: 4), event("later", from: 4, to: 5)],
            now: Self.now
        )
        #expect(lineKeys(lines) == ["past:past", "now:now", "open", "next:next", "later:later"])
    }

    @Test func aCancelledEventLeavesTheDayAndAnAllDayEventHasItsOwnPlace() {
        let lines = TodayPage.scheduleLines(
            [event("gone", from: 1, to: 2, status: "cancelled"), event("all", from: -11, to: 13, allDay: true)],
            now: Self.now
        )
        #expect(lines.isEmpty)
        #expect(TodayPage.allDayEvents([event("all", from: -11, to: 13, allDay: true)]).map(\.id) == ["all"])
    }

    @Test func aTimeReadsAsAPersonSaysIt() {
        // 12 PM, 3 PM, and 9:30 AM on October 28, 2026, in Los Angeles.
        #expect(TodayPage.clockLabel(1_793_214_000_000, timezone: Self.tz) == "12 PM")
        #expect(TodayPage.clockLabel(1_793_224_800_000, timezone: Self.tz) == "3 PM")
        #expect(TodayPage.clockLabel(1_793_205_000_000, timezone: Self.tz) == "9:30 AM")
    }

    // MARK: - The note

    @Test func theFixtureDaySaysTheNewsTheCountAndWhatIsNext() {
        #expect(note(fixtureItems, fixtureEvents) ==
            "8 things need you, 3 of them today. Start with Harbor Air. Design review ends at 11:30 AM. Lunch with Mara is next, at 12 PM.")
    }

    @Test func itNeverPromisesATimeThatHasPassed() {
        #expect(note([], fixtureEvents, now: Self.now + 10 * Self.hour) ==
            "Nothing needs you right now. Your calendar is clear for the rest of today.")
    }

    @Test func anEmptyDaySaysSo() {
        #expect(note([], []) == "Nothing needs you right now. Nothing is on your calendar today.")
    }

    @Test func oneItemAndOneSenderWithManyNoticesReadAsOneThingToStart() {
        #expect(note([item("r", asker: "Marin")], []).hasPrefix("One thing needs you. Start with Marin."))
        let notices = note(
            [
                item("a", kind: .change, title: "Failed.", asker: "Stripe"),
                item("b", kind: .change, title: "Failed.", asker: "Stripe", createdAt: Self.now - 2 * Self.hour),
            ],
            []
        )
        #expect(notices.hasPrefix("One thing needs you. Start with Stripe. Nothing is"))
    }

    @Test func aNextEventSoonCountsTheMinutes() {
        let standup = event("Standup", from: 0.25, to: 0.5)
        #expect(note([], [standup]).hasSuffix("Standup starts in 15 minutes."))
    }

    @Test func theFirstWordsFollowTheKindOfTheFirstRow() {
        let extra = NeedsYouExtra(id: "approval:1", kind: .approval, title: "Send the terms")
        #expect(TodayPage.note(
            rows: rows([], extras: [extra]).rows,
            open: 1,
            dueToday: 1,
            lines: [],
            now: Self.now,
            timezone: Self.tz
        ).lead == "One thing needs you. Start with the approval for an Albatross.")
        #expect(note([item("c", kind: .code, asker: "Northwind")], []).hasPrefix("One thing needs you. Start with Northwind."))
    }

    // MARK: - The words of a row

    private func titles(_ obligation: ObligationView) -> [String] {
        TodayPage.buttons(for: .obligation(obligation)).map(\.title)
    }

    @Test func theFirstActionHasAWordFromFixedRules() {
        #expect(titles(item("a")) == ["Reply", "Done"])
        #expect(titles(item("b", draftReady: true)) == ["Open draft", "Done"])
        #expect(titles(item("c", kind: .rsvp, source: .calendar)) == ["Accept", "Decline"])
        #expect(titles(item("d", kind: .code)) == ["Copy", "Done"])
        #expect(titles(item("e", kind: .action, source: .github, title: "Review: Move the export")) == ["Review", "Done"])
        #expect(titles(item("f", kind: .change, title: "Flight moved.")) == ["Open", "Done"])
        #expect(titles(item("g", kind: .action, source: .slack, title: "Send the numbers.")) == ["Open", "Done"])
        #expect(titles(item("h", kind: .action, source: .slack, workID: "w1")) == ["Start in Albatross", "Done"])
        // "Reviewer" is not a word of its own.
        #expect(titles(item("i", kind: .change, title: "Reviewer changed.")) == ["Open", "Done"])
        #expect(TodayPage.buttons(for: .obligation(item("j", kind: .code)), copied: true).first?.title == "Copied")
    }

    @Test func onlyTheFirstActionIsPrimaryAndALaterMenuSkipsACode() {
        let buttons = TodayPage.buttons(for: .obligation(item("a")))
        #expect(buttons.map(\.isPrimary) == [true, false])
        #expect(TodayPage.showsLater(.obligation(item("a"))))
        #expect(!TodayPage.showsLater(.obligation(item("b", kind: .code))))
        let extra = NeedsYouEntry.albatross(NeedsYouExtra(id: "question:1", kind: .question))
        #expect(!TodayPage.showsLater(extra))
        #expect(TodayPage.buttons(for: extra).map(\.title) == ["Answer"])
    }

    @Test func aDueWordReadsAsASentence() {
        #expect(TodayPage.dueSentenceWord(kind: .action, text: "Today") == "Due today")
        #expect(TodayPage.dueSentenceWord(kind: .action, text: "Fri") == "Due Friday")
        #expect(TodayPage.dueSentenceWord(kind: .rsvp, text: "Tomorrow 1:05 PM") == "Starts tomorrow, 1:05 PM")
        #expect(TodayPage.dueSentenceWord(kind: .prepare, text: "Nov 16") == "Starts Nov 16")
        #expect(TodayPage.dueSentenceWord(kind: .code, text: "8 min") == "8 min")
        #expect(TodayPage.dueSentenceWord(kind: .action, text: "") == "")
    }

    @Test func theRowWordsNameThePlaceAndTheStatus() {
        let urgent = TodayPage.words(
            for: TodayRow(entry: .obligation(item("a", kind: .change, title: "Flight moved.", asker: "Harbor Air", pushLevel: .timeSensitive))),
            now: Self.now,
            timezone: Self.tz
        )
        #expect(urgent.status == "Urgent")
        #expect(urgent.statusTone == .tag)

        let review = TodayPage.words(
            for: TodayRow(entry: .obligation(item("b", kind: .action, source: .github, sourceLabel: "northwind/web #491", title: "Review: Move the export", due: .today))),
            now: Self.now,
            timezone: Self.tz
        )
        #expect(review.place == "northwind/web #491")
        #expect(review.status == "Due today")
        #expect(review.statusTone == .hot)

        // The line already names the place, so the words do not say it twice.
        let invite = TodayPage.words(
            for: TodayRow(entry: .obligation(item("c", kind: .rsvp, source: .calendar, sourceLabel: "Vendor review", title: "Answer the invitation: Vendor review"))),
            now: Self.now,
            timezone: Self.tz
        )
        #expect(invite.place == "")

        let list = rows([
            item("d", kind: .change, title: "Failed.", asker: "Lumen Hosting"),
            item("e", kind: .change, title: "Failed.", asker: "Lumen Hosting", createdAt: Self.now - 2 * Self.hour),
            item("f", kind: .change, title: "Failed.", asker: "Lumen Hosting", createdAt: Self.now - 3 * Self.hour),
        ])
        #expect(TodayPage.words(for: list.rows[0], now: Self.now, timezone: Self.tz).place == "3 notices")
    }

    @Test func anOpenCodeShowsItsDigits() {
        let words = TodayPage.words(
            for: TodayRow(entry: .obligation(item("a", kind: .code, code: ObligationCode(value: "482913", expiresAt: Self.now + 480_000)))),
            now: Self.now,
            timezone: Self.tz
        )
        #expect(words.code == "482 913")
        #expect(words.status == "8 min")
        #expect(TodayPage.accessibilityLabel(words).contains("Verification code 482 913"))
    }

    @Test func theLeadIsInitialsForAPersonAndAGlyphForASystem() {
        #expect(TodayPage.lead(for: .obligation(item("a", kind: .change, asker: "Harbor Air"))) == .initials(name: "Harbor Air", seed: "Harbor Air"))
        #expect(TodayPage.lead(for: .obligation(item("b", kind: .code))) == .glyph("key"))
        #expect(TodayPage.lead(for: .obligation(item("c", kind: .action, source: .bitbucket))) == .glyph(NeedsYouPresentation.sourceGlyph(.bitbucket)))
        #expect(TodayPage.sourceBadge(for: .obligation(item("d"))) == nil)
        #expect(TodayPage.sourceBadge(for: .obligation(item("e", source: .github))) == NeedsYouPresentation.sourceGlyph(.github))
    }

    @Test func theRowLineLeavesOutWhatTheFirstActionSays() {
        #expect(TodayPage.rowLine("Review: Move the export") == "Move the export")
        #expect(TodayPage.rowLine("Answer the invitation: Vendor review") == "Invitation: Vendor review")
        #expect(TodayPage.rowLine("Can you review the plan?") == "Can you review the plan?")
        #expect(TodayPage.rowLine("The payment failed.") == "The payment failed")
    }

    @Test func aLongGapBeforeTheNextEventSaysSo() {
        let squash = event("Squash", from: 3, to: 4)
        #expect(note([], [squash]).contains("No more events until Squash at"))
    }

    // MARK: - The page

    @Test func theLivePageIsForAUserInTheFlagOnTheCurrentEdition() {
        #expect(TodayPage.showsLivePage(enabled: true, showsLatestEdition: true))
        #expect(!TodayPage.showsLivePage(enabled: true, showsLatestEdition: false))
        #expect(!TodayPage.showsLivePage(enabled: false, showsLatestEdition: true))
    }

    @Test func theColumnsAndTheActionsFollowTheWebWidths() {
        #expect(!TodayPage.usesColumns(pageWidth: 859))
        #expect(TodayPage.usesColumns(pageWidth: 860))
        #expect(TodayPage.listWidth(pageWidth: 400) == 400)
        #expect(TodayPage.listWidth(pageWidth: 1_000, asideWidth: 288) == 664)
        #expect(!TodayPage.actionsBeside(listWidth: 559, isAccessibilitySize: false))
        #expect(TodayPage.actionsBeside(listWidth: 560, isAccessibilitySize: false))
        #expect(!TodayPage.actionsBeside(listWidth: 900, isAccessibilitySize: true))
    }

    @Test @MainActor func theArtStaysBigInsideItsShareOfTheViewport() {
        // A phone: the width leads, and the share caps it.
        #expect(abs(TodayLiveMasthead.paintingHeight(width: 353, viewportHeight: 852) - 218.86) < 0.01)
        #expect(abs(TodayLiveMasthead.paintingHeight(width: 700, viewportHeight: 1_000) - 340) < 0.01)
        // A wide page stays in the band of 260 to 360 points.
        #expect(TodayLiveMasthead.paintingHeight(width: 1_000, viewportHeight: 500) == 260)
        #expect(TodayLiveMasthead.paintingHeight(width: 1_000, viewportHeight: 2_000) == 360)
        // A short screen never takes the painting under its floor.
        #expect(TodayLiveMasthead.paintingHeight(width: 320, viewportHeight: 400) == 192)
    }

    // MARK: - Worth knowing

    @Test func theFactsDecodeAndAnOlderEditionHasNone() throws {
        let edition = try #require(DailyReportModel(json: .object([
            "_id": .string("r1"),
            "generatedAt": .number(1_793_210_700_000),
            "worthKnowing": .array([
                .object(["title": .string("Northwind renews on November 12."), "line": .string("The seat price rises 8 percent.")]),
                .object(["line": .string("A fact with no title is left out.")]),
            ]),
        ])))
        #expect(edition.worthKnowing.map(\.title) == ["Northwind renews on November 12."])
        #expect(edition.worthKnowing.first?.line == "The seat price rises 8 percent.")

        let older = try #require(DailyReportModel(json: .object(["_id": .string("r0")])))
        #expect(older.worthKnowing.isEmpty)

        // A saved snapshot keeps the facts, and an old snapshot keeps decoding.
        let data = try JSONEncoder().encode(edition)
        let decoded = try JSONDecoder().decode(DailyReportModel.self, from: data)
        #expect(decoded.worthKnowing == edition.worthKnowing)
        let oldData = try JSONEncoder().encode(older)
        #expect(try JSONDecoder().decode(DailyReportModel.self, from: oldData).worthKnowing.isEmpty)
    }
}
