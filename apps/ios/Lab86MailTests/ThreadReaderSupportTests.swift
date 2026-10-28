import Foundation
import Testing
@testable import Lab86Mail

// The thread reader's lead line and header names (iOS refresh 2026-10-24).
struct ThreadReaderSupportTests {
    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        calendar.locale = Locale(identifier: "en_US")
        return calendar
    }

    private static let locale = Locale(identifier: "en_US")

    // Friday 2026-10-16, 12:00 UTC.
    private static let now = Date(timeIntervalSince1970: 1_792_152_000)

    // Foundation sets narrow spaces before "AM"; the test reads plain ones.
    private static func plain(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
    }

    private static func line(count: Int, date: Date?) -> String {
        plain(ThreadLeadCopy.line(messageCount: count, lastDate: date, now: now, calendar: calendar, locale: locale))
    }

    @Test
    func theLeadLineCountsAndDatesTheNewestMessage() {
        let oneHourAgo = Self.now.addingTimeInterval(-3_600)
        #expect(Self.line(count: 3, date: oneHourAgo) == "3 messages, newest today at 11:00 AM")
        #expect(Self.line(count: 1, date: oneHourAgo) == "1 message, today at 11:00 AM")
        #expect(Self.line(count: 2, date: nil) == "2 messages")
        #expect(!Self.line(count: 3, date: oneHourAgo).contains("·"))
    }

    @Test
    func theDayPhraseFollowsTheInboxDatelines() {
        let yesterday = Self.now.addingTimeInterval(-86_400)
        #expect(Self.line(count: 1, date: yesterday) == "1 message, yesterday at 12:00 PM")
        // Tuesday of the same week.
        let tuesday = Self.now.addingTimeInterval(-3 * 86_400)
        #expect(Self.line(count: 4, date: tuesday) == "4 messages, newest on Tuesday at 12:00 PM")
        // Earlier this year.
        let october1 = Self.now.addingTimeInterval(-15 * 86_400)
        #expect(Self.line(count: 2, date: october1) == "2 messages, newest on Oct 1 at 12:00 PM")
        // Another year.
        let lastYear = Self.now.addingTimeInterval(-400 * 86_400)
        #expect(Self.line(count: 2, date: lastYear).hasSuffix("2025 at 12:00 PM"))
    }

    @Test
    func recipientNamesDropAddressesAndCountTheRest() {
        #expect(RecipientNames.line(from: "Casey Morgan <casey@northwind.example>, priya@ledgerworks.example")
            == "Casey Morgan, priya@ledgerworks.example")
        #expect(RecipientNames.line(from: "\"Chen\" <sarah.chen@northwind.example>") == "Chen")
        #expect(RecipientNames.line(from: "") == "")
        let many = "A <a@x.example>, B <b@x.example>, C <c@x.example>, D <d@x.example>, E <e@x.example>"
        #expect(RecipientNames.line(from: many) == "A, B, C, and 2 more")
        #expect(RecipientNames.line(from: many, limit: 5) == "A, B, C, D, E")
    }

    @Test
    func theReadingColumnIsTheSharedMaximum() {
        #expect(ThreadReaderMetrics.maxWidth == 680)
    }
}
