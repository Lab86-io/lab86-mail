import Foundation
import Testing
@testable import Lab86Mail

// Calendar decode fixes from the feature audit: the join link under
// `conferencing.details`, hidden calendars, and the shared date styles (K9).
struct CalendarModelDecodeTests {
    @Test
    func theJoinLinkIsReadFromDetailsAndFromTheTop() {
        let nested = CalendarEventDetail(json: .object([
            "title": .string("Standup"),
            "conferencing": .object([
                "provider": .string("Google Meet"),
                "details": .object(["url": .string("https://meet.google.com/abc-defg-hij")]),
            ]),
        ]))
        #expect(nested.conferenceURL?.absoluteString == "https://meet.google.com/abc-defg-hij")
        #expect(nested.conferenceLabel == "Google Meet")

        let flat = CalendarEventDetail(json: .object([
            "title": .string("Standup"),
            "conferencing": .object(["url": .string("https://zoom.us/j/1")]),
        ]))
        #expect(flat.conferenceURL?.absoluteString == "https://zoom.us/j/1")
        #expect(flat.conferenceLabel == "Video call")

        let entryPoints = CalendarEventDetail(json: .object([
            "title": .string("Standup"),
            "conferencing": .object([
                "details": .object(["entryPoints": .array([.object(["uri": .string("https://teams.example/j")])])]),
            ]),
        ]))
        #expect(entryPoints.conferenceURL?.absoluteString == "https://teams.example/j")

        let none = CalendarEventDetail(json: .object(["title": .string("Lunch")]))
        #expect(none.conferenceURL == nil)
        #expect(none.conferenceLabel == nil)
    }

    @Test
    func aListRowCarriesItsJoinLink() throws {
        let row = try #require(CalendarEventSummary(json: .object([
            "eventId": .string("evt-1"),
            "accountId": .string("acct-1"),
            "title": .string("Standup"),
            "startIso": .string("2027-01-15T08:00:00.000Z"),
            "endIso": .string("2027-01-15T08:30:00.000Z"),
            "conferencing": .object(["details": .object(["url": .string("https://meet.google.com/abc")])]),
        ])))
        #expect(row.conferenceURL?.absoluteString == "https://meet.google.com/abc")
        // An older cached row without the field still decodes.
        let legacy = Data("""
        {"id":"evt-2","title":"Lunch","start":1800000000000,"end":1800003600000}
        """.utf8)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        let decoded = try decoder.decode(CalendarEventSummary.self, from: legacy)
        #expect(decoded.conferenceURL == nil)
        #expect(decoded.title == "Lunch")
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        let again = try decoder.decode(CalendarEventSummary.self, from: encoder.encode(row))
        #expect(again.conferenceURL == row.conferenceURL)
    }

    @Test
    func hiddenAndReadOnlyCalendarsAreMarked() throws {
        let hidden = try #require(CalendarChoice(json: .object([
            "accountId": .string("acct-1"),
            "calendarId": .string("cal-1"),
            "name": .string("Holidays"),
            "hidden": .bool(true),
            "readOnly": .bool(true),
        ])))
        #expect(hidden.isHidden)
        #expect(hidden.isReadOnly)
        let shown = try #require(CalendarChoice(json: .object([
            "accountId": .string("acct-1"),
            "calendarId": .string("cal-2"),
            "isReadOnly": .bool(false),
        ])))
        #expect(!shown.isHidden)
        #expect(!shown.isReadOnly)
    }

    @Test
    func theDateParserReadsEveryServerForm() {
        let expected = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(CalendarDateParser.date(fromString: "2027-01-15T08:00:00.000Z") == expected)
        #expect(CalendarDateParser.date(fromString: "2027-01-15T08:00:00Z") == expected)
        #expect(CalendarDateParser.date(fromString: "2027-01-15T10:00:00+02:00") == expected)
        #expect(CalendarDateParser.date(fromString: "1800000000") == expected)
        #expect(CalendarDateParser.date(fromString: "1800000000000") == expected)
        #expect(CalendarDateParser.date(.number(1_800_000_000_000)) == expected)
        #expect(CalendarDateParser.date(fromString: "not a date") == nil)
        #expect(CalendarDateParser.date(fromString: "  ") == nil)
        #expect(CalendarDateParser.date(.null) == nil)
    }
}
