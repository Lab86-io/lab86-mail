import Foundation
import MobileAPI
import Testing
@testable import Lab86Mail

// Wave C (2026-09-03): the brief reads as a letter. These tests cover the
// pure layer: region order, lane rules, the legacy fallback, the
// `framing.sender` decode, week-ahead emphasis, the event time slot, the
// pulse lines, and the footer sentence.
struct BriefLetterTests {
    private let english = Locale(identifier: "en_US")

    // MARK: - Fixtures

    private func threadItem(
        id: String,
        lane: String,
        subject: String,
        sender: String? = nil,
        reason: String? = nil
    ) -> String {
        var framing = "\"lane\": \"\(lane)\""
        if let reason { framing += ", \"reason\": \"\(reason)\"" }
        if let sender { framing += ", \"sender\": \"\(sender)\"" }
        return """
        {
          "ref": { "kind": "thread", "id": "\(id)", "account": "acct-1", "label": "\(subject)" },
          "framing": { \(framing) },
          "actions": [
            { "action": "open_thread", "label": "Open", "payload": { "account": "acct-1", "threadId": "\(id)" }, "style": "quiet" }
          ]
        }
        """
    }

    private func eventItem(id: String, title: String, reason: String) -> String {
        """
        {
          "ref": { "kind": "event", "id": "\(id)", "account": "acct-1", "label": "\(title)" },
          "framing": { "lane": "today", "reason": "\(reason)" },
          "actions": [
            { "action": "open_event", "label": "Open", "payload": { "account": "acct-1", "eventId": "\(id)" }, "style": "quiet" }
          ]
        }
        """
    }

    private func areaItem(id: String, name: String, line: String?) -> String {
        """
        {
          "ref": { "kind": "area", "id": "\(id)", "label": "\(name)" },
          "framing": { \(line.map { "\"reason\": \"\($0)\"" } ?? "") },
          "actions": [
            { "action": "open_area", "label": "Open", "payload": { "areaId": "\(id)" }, "style": "quiet" }
          ]
        }
        """
    }

    private func laneRegion(_ id: String, title: String, items: [String]) -> String {
        """
        {
          "id": "\(id)",
          "summary": "\(title) lane.",
          "tree": {
            "kind": "entity_list",
            "emphasis": "standard",
            "tone": "neutral",
            "title": "\(title)",
            "variant": "\(id == "areas" ? "compact" : "rows")",
            "items": [\(items.joined(separator: ","))]
          }
        }
        """
    }

    private let ledeRegion = """
    {
      "id": "lede",
      "summary": "Two replies are owed. The afternoon is open.",
      "tree": {
        "kind": "hero",
        "emphasis": "primary",
        "tone": "neutral",
        "surface": "plain",
        "children": [
          { "kind": "text", "emphasis": "primary", "tone": "neutral", "role": "lede", "text": "Two replies are owed. The afternoon is open." }
        ]
      }
    }
    """

    private let weekAheadRegion = """
    {
      "id": "week-ahead",
      "summary": "This Thursday you can send the passport form. Friday is open.",
      "tree": { "kind": "text", "emphasis": "standard", "tone": "neutral", "role": "body", "text": "This Thursday you can send the passport form. Friday is open." }
    }
    """

    private func document(regions: [String], title: String = "The Thursday Brief") -> String {
        """
        {
          "version": 2,
          "title": "\(title)",
          "summary": "Two replies are owed. The afternoon is open.",
          "generatedAt": 1788400000000,
          "timezone": "America/New_York",
          "regions": [\(regions.joined(separator: ","))]
        }
        """
    }

    private func decode(_ json: String) throws -> BriefDocumentV2 {
        try #require(BriefDocumentV2.decode(Data(json.utf8)))
    }

    private func budgetDocument() throws -> BriefDocumentV2 {
        try decode(document(regions: [
            ledeRegion,
            laneRegion("answer", title: "Answer", items: [
                threadItem(id: "t1", lane: "answer", subject: "Venue count", sender: "Sarah Chen", reason: "She asked for the head count by Friday."),
                threadItem(id: "t2", lane: "answer", subject: "Invoice 2211", sender: "Priya Patel"),
            ]),
            laneRegion("today", title: "Today", items: [
                eventItem(id: "e1", title: "Standup", reason: "9:00 AM to 9:30 AM, Room 2"),
                threadItem(id: "t3", lane: "today", subject: "Contract due today", sender: "Legal"),
            ]),
            laneRegion("know", title: "Know", items: [
                threadItem(id: "t4", lane: "know", subject: "Q3 numbers", sender: "Finance", reason: "Revenue is up nine percent."),
            ]),
            weekAheadRegion,
            laneRegion("areas", title: "Areas", items: [
                areaItem(id: "a1", name: "Passport", line: "Send the form on Thursday."),
                areaItem(id: "a2", name: "Wedding", line: nil),
                areaItem(id: "a3", name: "Taxes", line: "Waiting on the accountant."),
                areaItem(id: "a4", name: "Overflow", line: "Should never render."),
            ]),
        ]))
    }

    // MARK: - Region order

    @Test
    func letterSectionsFollowTheDocumentOrderAndSkipEmptyLanes() throws {
        let sections = BriefLetterLayout.sections(for: try budgetDocument(), includeLede: true)
        let kinds = sections.map { section -> String in
            switch section {
            case .lede: "lede"
            case .lane(let lane, _): "lane:\(lane.rawValue)"
            case .weekAhead: "week-ahead"
            case .areas: "areas"
            case .pulse: "pulse"
            case .node: "node"
            }
        }
        #expect(kinds == ["lede", "lane:answer", "lane:today", "lane:know", "week-ahead", "areas"])

        // Today draws the lede itself and asks the document to leave it out.
        let withoutLede = BriefLetterLayout.sections(for: try budgetDocument(), includeLede: false)
        #expect(withoutLede.first?.isLede == false)
        #expect(withoutLede.count == sections.count - 1)

        // The area list is capped at three.
        if case .areas(let items) = try #require(sections.last) {
            #expect(items.map(\.ref.id) == ["a1", "a2", "a3"])
        } else {
            Issue.record("The last section must be the areas.")
        }
        #expect(BriefLetterLayout.isLetter(try budgetDocument()))
    }

    @Test
    func emptyLaneAndEmptyAreasDoNotRender() throws {
        let doc = try decode(document(regions: [
            ledeRegion,
            laneRegion("answer", title: "Answer", items: []),
            laneRegion("know", title: "Know", items: [
                threadItem(id: "t9", lane: "know", subject: "Notes"),
            ]),
            laneRegion("areas", title: "Areas", items: []),
        ]))
        let sections = BriefLetterLayout.sections(for: doc, includeLede: true)
        #expect(sections.count == 2)
        if case .lane(let lane, let items) = sections[1] {
            #expect(lane == .know)
            #expect(items.count == 1)
        } else {
            Issue.record("Expected the Know lane.")
        }
    }

    @Test
    func eventsSitBeforeThreadsInsideTheTodayLane() throws {
        let sections = BriefLetterLayout.sections(for: try budgetDocument(), includeLede: false)
        guard case .lane(.today, let items) = sections[1] else {
            Issue.record("Expected the Today lane second.")
            return
        }
        #expect(items.map(\.ref.kind) == ["event", "thread"])
    }

    @Test
    func laneTitlesAndNotesAreTheChosenCopy() {
        #expect(BriefLetterLane.answer.title == "Answer")
        #expect(BriefLetterLane.answer.note == "Replies you owe")
        #expect(BriefLetterLane.today.title == "Today")
        #expect(BriefLetterLane.today.note == "Deadlines and the calendar")
        #expect(BriefLetterLane.know.title == "Know")
        #expect(BriefLetterLane.know.note == "Worth a look")
    }

    // MARK: - Legacy editions

    @Test
    func legacyEditionRegionsFallBackToTheNodeRenderer() throws {
        let legacy = try decode(document(regions: [
            """
            {
              "id": "opening",
              "summary": "Good morning.",
              "tree": {
                "kind": "hero", "emphasis": "primary", "tone": "neutral", "surface": "elevated",
                "children": [ { "kind": "text", "emphasis": "primary", "tone": "neutral", "role": "lede", "text": "Good morning." } ]
              }
            }
            """,
            laneRegion("needs-reply", title: "Reply owed", items: [
                threadItem(id: "t1", lane: "Reply owed", subject: "Venue count"),
            ]),
            laneRegion("bulk-tail", title: "The rest", items: [
                threadItem(id: "t2", lane: "Bulk", subject: "Newsletter"),
            ]),
            """
            { "id": "frontier-gate", "summary": "Question", "tree": { "kind": "prompt", "emphasis": "standard", "tone": "neutral", "variant": "question", "placeholder": "Answer" } }
            """,
        ], title: "Daily Brief"))
        let sections = BriefLetterLayout.sections(for: legacy, includeLede: true)
        #expect(sections.count == 3)
        for section in sections {
            guard case .node = section else {
                Issue.record("A legacy region must reach the node renderer.")
                return
            }
        }
        #expect(!BriefLetterLayout.isLetter(legacy))
    }

    @Test
    func aKnownIdWithTheWrongTreeStillFallsBack() throws {
        // An id the letter knows, but a tree it does not: the node renderer keeps it.
        let doc = try decode(document(regions: [
            ledeRegion,
            """
            { "id": "answer", "summary": "Answer", "tree": { "kind": "text", "emphasis": "standard", "tone": "neutral", "role": "body", "text": "Two replies." } }
            """,
        ]))
        let sections = BriefLetterLayout.sections(for: doc, includeLede: true)
        #expect(sections.count == 2)
        if case .node(let region) = sections[1] {
            #expect(region.id == "answer")
        } else {
            Issue.record("Expected a node fallback.")
        }
    }

    @Test
    func aNewerDocumentVersionStillRendersAFallback() throws {
        let newer = try decode("""
        { "version": 3, "title": "The Friday Brief", "summary": "A newer letter.", "generatedAt": 1, "regions": [] }
        """)
        #expect(newer.regions.count == 1)
        let sections = BriefLetterLayout.sections(for: newer, includeLede: true)
        #expect(sections.count == 1)
        #expect(!BriefLetterLayout.isLetter(newer))
    }

    // MARK: - framing.sender

    @Test
    func framingSenderDecodesAndUnknownKeysAreIgnored() throws {
        let json = """
        {
          "ref": { "kind": "thread", "id": "t1", "account": "acct-1", "label": "Venue count" },
          "framing": { "lane": "answer", "reason": "She asked for the head count by Friday.", "sender": "Sarah Chen", "futureKey": 7 },
          "actions": [ { "action": "open_thread", "label": "Open", "payload": {}, "style": "quiet" } ]
        }
        """
        let item = try JSONDecoder().decode(BriefEntityItem.self, from: Data(json.utf8))
        #expect(item.framing?.sender == "Sarah Chen")
        #expect(item.framing?.lane == "answer")

        let copy = BriefMailRowCopy(item: item, entity: nil)
        #expect(copy.sender == "Sarah Chen")
        #expect(copy.subject == "Venue count")
        #expect(copy.action == "Open")
        #expect(copy.avatarName == "Sarah Chen")
        #expect(
            copy.accessibilityLabel
                == "From Sarah Chen, Venue count, She asked for the head count by Friday., action Open"
        )
    }

    @Test
    func framingWithoutSenderStillDecodes() throws {
        let json = """
        {
          "ref": { "kind": "thread", "id": "t1", "account": "acct-1", "label": "Venue count" },
          "framing": { "lane": "Reply owed", "reason": "Old edition." }
        }
        """
        let item = try JSONDecoder().decode(BriefEntityItem.self, from: Data(json.utf8))
        #expect(item.framing?.sender == nil)
        let copy = BriefMailRowCopy(item: item, entity: nil)
        #expect(copy.sender == nil)
        #expect(copy.avatarName == "Venue count")
        #expect(copy.action == nil)
        #expect(copy.accessibilityLabel == "Venue count, Old edition.")
    }

    @Test
    func framingSenderRoundTripsThroughTheEncoder() throws {
        let framing = BriefFraming(reason: "Line", lane: "know", sender: "Priya Patel")
        let data = try JSONEncoder().encode(framing)
        let decoded = try JSONDecoder().decode(BriefFraming.self, from: data)
        #expect(decoded == framing)
    }

    // MARK: - Week ahead emphasis

    @Test
    func weekdayNamesAndDatesAreEmboldened() {
        let text = "This Thursday you can send the passport form. Friday is open."
        #expect(WeekAheadEmphasis.terms(in: text, locale: english) == ["Thursday", "Friday"])

        let dated = "Send it by September 12. The review is on Sep 30th, and 3 October is free."
        #expect(WeekAheadEmphasis.terms(in: dated, locale: english) == ["September 12", "Sep 30th", "3 October"])

        let attributed = WeekAheadEmphasis.attributed(text, locale: english)
        let strong = attributed.runs.filter { $0.inlinePresentationIntent == .stronglyEmphasized }
        #expect(strong.count == 2)
        #expect(String(attributed.characters) == text)
    }

    @Test
    func wordsThatContainADayNameStayPlain() {
        let text = "Sunrise is early. Monetary policy moved. Weds is not a word."
        #expect(WeekAheadEmphasis.terms(in: text, locale: english).isEmpty)
        let none = WeekAheadEmphasis.attributed(text, locale: english)
        #expect(none.runs.allSatisfy { $0.inlinePresentationIntent != .stronglyEmphasized })
    }

    // MARK: - Event time slot

    @Test
    func eventTimeSlotReadsTheReasonFirst() {
        #expect(
            BriefEventTimeSlot.make(reason: "9:00 AM to 9:30 AM, Room 2", startAt: nil)
                == BriefEventTimeSlot.Slot(time: "9:00", suffix: "AM")
        )
        #expect(
            BriefEventTimeSlot.make(reason: "14:00 to 15:00", startAt: nil)
                == BriefEventTimeSlot.Slot(time: "14:00", suffix: nil)
        )
        #expect(
            BriefEventTimeSlot.make(reason: "All day, Boston", startAt: nil)
                == BriefEventTimeSlot.Slot(time: "All", suffix: "day")
        )
        #expect(BriefEventTimeSlot.make(reason: nil, startAt: nil) == nil)
        #expect(BriefEventTimeSlot.make(reason: "Room 2", startAt: nil) == nil)
    }

    @Test
    func eventTimeSlotFallsBackToTheHydratedStart() throws {
        let zone = try #require(TimeZone(identifier: "America/New_York"))
        // 2026-09-03 13:00 UTC = 9:00 AM in New York.
        let startAt: Double = 1_788_440_400_000
        let slot = try #require(BriefEventTimeSlot.make(reason: nil, startAt: startAt, timeZone: zone))
        #expect(slot.time.hasPrefix("9") || slot.time.hasPrefix("09"))
    }

    // MARK: - Area pulse

    @Test
    func pulseLinesSplitTheLabelFromTheText() throws {
        #expect(BriefPulseLine.parse("Last change: The venue confirmed.") == BriefPulseLine(label: "Last change", text: "The venue confirmed."))
        #expect(BriefPulseLine.parse("Open question: Who pays the deposit?") == BriefPulseLine(label: "Open question", text: "Who pays the deposit?"))
        #expect(BriefPulseLine.parse("Nothing moved this week.") == BriefPulseLine(label: nil, text: "Nothing moved this week."))

        let doc = try decode(document(regions: [
            """
            { "id": "lede", "summary": "The wedding is on track.", "tree": { "kind": "hero", "emphasis": "primary", "tone": "neutral", "surface": "plain", "children": [ { "kind": "text", "emphasis": "primary", "tone": "neutral", "role": "lede", "text": "The wedding is on track." } ] } }
            """,
            """
            { "id": "pulse", "summary": "Pulse", "tree": { "kind": "stack", "emphasis": "standard", "tone": "neutral", "density": "standard", "children": [
              { "kind": "text", "emphasis": "standard", "tone": "neutral", "role": "body", "text": "Last change: The venue confirmed." },
              { "kind": "text", "emphasis": "standard", "tone": "neutral", "role": "body", "text": "Next move: Send the deposit." }
            ] } }
            """,
            """
            { "id": "ask", "summary": "Add a thought.", "tree": { "kind": "prompt", "emphasis": "muted", "tone": "neutral", "variant": "capture", "placeholder": "Get this out of my head" } }
            """,
            """
            { "id": "open-work", "summary": "Open work.", "tree": { "kind": "query_list", "emphasis": "standard", "tone": "neutral", "title": "Open work", "query": { "name": "area_open_work", "areaId": "a1" }, "limit": 6, "variant": "rows", "emptyText": "No open work." } }
            """,
        ], title: "Wedding"))
        let sections = BriefLetterLayout.sections(for: doc, includeLede: true)
        #expect(sections.count == 4)
        #expect(sections[0].isLede)
        if case .pulse(let lines) = sections[1] {
            #expect(lines.map(\.label) == ["Last change", "Next move"])
        } else {
            Issue.record("Expected the pulse second.")
        }
        if case .node(let ask) = sections[2] { #expect(ask.id == "ask") } else { Issue.record("Expected the ask prompt.") }
        if case .node(let work) = sections[3] { #expect(work.id == "open-work") } else { Issue.record("Expected open work.") }
        #expect(BriefLetterLayout.isLetter(doc))
    }

    // MARK: - Footer

    @Test
    func footerSentenceCountsTheNoise() {
        #expect(DailyBriefFooterCopy.sentence(noise: 38, selected: 5) == "38 other messages arrived. None needed you.")
        #expect(DailyBriefFooterCopy.sentence(noise: 1, selected: 5) == "1 other message arrived. It did not need you.")
        #expect(DailyBriefFooterCopy.sentence(noise: 0, selected: 5) == "Nothing else arrived.")
        #expect(DailyBriefFooterCopy.sentence(noise: 12, selected: 0) == "Nothing in your mail needs you this morning.")
    }

    @Test
    func dailyReportDecodesTheBudgetStatsAndSurvivesTheirAbsence() throws {
        let budget = try #require(DailyReportModel(json: .object([
            "_id": .string("report-1"),
            "generatedAt": .number(1_788_400_000_000),
            "title": .string("The Thursday Brief"),
            "stats": .object(["scannedThreads": .number(120), "noise": .number(38), "selected": .number(5)]),
        ])))
        #expect(budget.stats.noise == 38)
        #expect(budget.stats.selected == 5)
        #expect(budget.stats.isBudgetEdition)

        let older = try #require(DailyReportModel(json: .object([
            "_id": .string("report-0"),
            "generatedAt": .number(1_753_300_000_000),
            "title": .string("Old Edition"),
            "stats": .object(["scannedThreads": .number(80)]),
        ])))
        #expect(older.stats.noise == nil)
        #expect(!older.stats.isBudgetEdition)
    }
}
