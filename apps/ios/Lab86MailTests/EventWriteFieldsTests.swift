import Foundation
import Testing
@testable import Lab86Mail

// CAL-2 and CAL-4 (audit 2026-09-26): edits send only changed fields, and
// all-day events travel as date-only strings with an exclusive end.
struct EventWriteFieldsTests {
    private func calendar(_ zone: String) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: zone)!
        return calendar
    }

    private func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 0, in calendar: Calendar) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour))!
    }

    private func snapshot(
        title: String = "Standup",
        allDay: Bool = false,
        start: Date,
        end: Date,
        repeatRule: [String]? = ["RRULE:FREQ=WEEKLY"]
    ) -> EventFormSnapshot {
        EventFormSnapshot(
            title: title, allDay: allDay, start: start, end: end,
            location: "", repeatRule: repeatRule, attendees: [], notes: ""
        )
    }

    @Test
    func aTitleOnlyEditSendsOnlyTheTitle() {
        let ny = calendar("America/New_York")
        let start = date(2026, 9, 26, 9, in: ny)
        let initial = snapshot(start: start, end: start.addingTimeInterval(1_800))
        var current = initial
        current.title = "Team standup"
        let changes = EventWriteFields.changedArguments(from: initial, to: current, calendar: ny)
        #expect(changes == ["title": .string("Team standup")])
    }

    @Test
    func anInstanceWithoutARuleNeverSendsAnEmptyRuleUnlessNeverWasChosen() {
        let ny = calendar("America/New_York")
        let start = date(2026, 9, 26, 9, in: ny)
        // Expanded instances carry no rule, so the form opens on "Never".
        let initial = snapshot(start: start, end: start.addingTimeInterval(1_800), repeatRule: nil)
        var current = initial
        current.location = "Room 2"
        #expect(EventWriteFields.changedArguments(from: initial, to: current, calendar: ny)["recurrence"] == nil)

        // A repeating event the user sets to Never stops the series. The
        // server ignores an empty rule, so the stop is explicit.
        let repeating = snapshot(start: start, end: start.addingTimeInterval(1_800))
        var never = repeating
        never.repeatRule = nil
        let stop = EventWriteFields.changedArguments(from: repeating, to: never, calendar: ny)
        #expect(stop["clearRecurrence"] == .bool(true))
        #expect(stop["recurrence"] == nil)
        var daily = repeating
        daily.repeatRule = ["RRULE:FREQ=DAILY"]
        #expect(
            EventWriteFields.changedArguments(from: repeating, to: daily, calendar: ny)["recurrence"]
                == .array([.string("RRULE:FREQ=DAILY")])
        )
    }

    @Test
    func changedTimesTravelAsOnePair() {
        let ny = calendar("America/New_York")
        let start = date(2026, 9, 26, 9, in: ny)
        let initial = snapshot(start: start, end: start.addingTimeInterval(1_800))
        var current = initial
        current.end = start.addingTimeInterval(3_600)
        let changes = EventWriteFields.changedArguments(from: initial, to: current, calendar: ny)
        #expect(changes["startIso"] != nil)
        #expect(changes["endIso"] != nil)
        #expect(changes["allDay"] == .bool(false))
        #expect(changes["title"] == nil)
    }

    @Test
    func allDayWritesDateOnlyWithAnExclusiveEnd() {
        for zone in ["America/New_York", "Asia/Tokyo", "UTC"] {
            let local = calendar(zone)
            // A 26-28 event, entered late in the evening.
            let args = EventWriteFields.timeArguments(
                start: date(2026, 9, 26, 22, in: local),
                end: date(2026, 9, 28, 22, in: local),
                allDay: true,
                calendar: local
            )
            #expect(args["startIso"] == .string("2026-09-26"), "zone \(zone)")
            #expect(args["endIso"] == .string("2026-09-29"), "zone \(zone)")
            #expect(args["allDay"] == .bool(true))
        }
        let ny = calendar("America/New_York")
        let single = EventWriteFields.timeArguments(
            start: date(2026, 9, 26, in: ny), end: date(2026, 9, 26, in: ny), allDay: true, calendar: ny
        )
        #expect(single["endIso"] == .string("2026-09-27"))
    }

    @Test
    func storedAllDayRowsOpenOnTheirOwnDatesWithAnInclusiveEnd() {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        // Sync stores Sep 26-28 as UTC midnights with an exclusive end.
        let storedStart = utc.date(from: DateComponents(year: 2026, month: 9, day: 26))!
        let storedEnd = utc.date(from: DateComponents(year: 2026, month: 9, day: 29))!
        for zone in ["America/New_York", "Asia/Tokyo"] {
            let local = calendar(zone)
            let dates = EventWriteFields.editorDates(start: storedStart, end: storedEnd, allDay: true, calendar: local)
            #expect(dates.start == date(2026, 9, 26, in: local), "zone \(zone)")
            #expect(dates.end == date(2026, 9, 28, in: local), "zone \(zone)")
            // Saved again unchanged, the span is the same.
            let args = EventWriteFields.timeArguments(start: dates.start, end: dates.end!, allDay: true, calendar: local)
            #expect(args["startIso"] == .string("2026-09-26"))
            #expect(args["endIso"] == .string("2026-09-29"))
        }
        // A local-midnight row reads as its local date too.
        let tokyo = calendar("Asia/Tokyo")
        #expect(EventWriteFields.localDay(of: date(2026, 9, 26, in: tokyo), calendar: tokyo) == date(2026, 9, 26, in: tokyo))
        // Timed events are untouched.
        let timed = Date(timeIntervalSince1970: 1_790_000_000)
        #expect(EventWriteFields.editorDates(start: timed, end: nil, allDay: false).start == timed)
    }

    @Test @MainActor
    func updateSendsOnlyTheChangesWithTheEventIdentity() async throws {
        let tools = RecordingTools()
        let store = ProductStore(tools: tools, backend: BackendClient(baseURL: nil))
        try await store.updateEvent(
            accountID: "a1", calendarID: "c1", eventID: "master-1",
            changes: ["title": .string("Renamed")]
        )
        let arguments = await tools.arguments(of: "calendar_update_event")
        #expect(arguments == [[
            "account": .string("a1"),
            "calendarId": .string("c1"),
            "eventId": .string("master-1"),
            "title": .string("Renamed"),
        ]])
    }

    @Test
    func storedAllDayEventsShowOnTheirOwnLocalDate() throws {
        let local = Calendar.autoupdatingCurrent
        let json: JSONValue = .object([
            "eventId": .string("e1"),
            "title": .string("Holiday"),
            "allDay": .bool(true),
            "startIso": .string("2026-09-26T00:00:00Z"),
            "endIso": .string("2026-09-27T00:00:00Z"),
        ])
        let event = try #require(CalendarEventSummary(json: json))
        let day = local.date(from: DateComponents(year: 2026, month: 9, day: 26))!
        #expect(event.start == day)
        #expect(event.end == local.date(byAdding: .day, value: 1, to: day))
        // The day index puts it on that one day only.
        #expect(CalendarDayIndex.days(touchedBy: event, calendar: local) == [day])

        let detail = CalendarEventDetail(json: json)
        #expect(detail.start == day)
        // Timed events keep their instants.
        let timed = try #require(CalendarEventSummary(json: .object([
            "eventId": .string("e2"), "title": .string("Call"),
            "startIso": .string("2026-09-26T15:00:00Z"), "endIso": .string("2026-09-26T16:00:00Z"),
        ])))
        #expect(timed.start == ISO8601DateFormatter().date(from: "2026-09-26T15:00:00Z"))
    }

    @Test
    func aStoredSpanInEveryZoneKeepsItsDates() {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let start = utc.date(from: DateComponents(year: 2026, month: 9, day: 26))!
        let end = utc.date(from: DateComponents(year: 2026, month: 9, day: 29))!
        for zone in ["America/Los_Angeles", "Europe/Berlin", "Pacific/Auckland"] {
            let local = calendar(zone)
            let span = AllDayDate.localSpan(start: start, end: end, calendar: local)
            #expect(span.start == date(2026, 9, 26, in: local), "zone \(zone)")
            #expect(span.end == date(2026, 9, 29, in: local), "zone \(zone)")
            // Reading it twice changes nothing.
            #expect(AllDayDate.localSpan(start: span.start, end: span.end, calendar: local).start == span.start)
        }
    }
}
