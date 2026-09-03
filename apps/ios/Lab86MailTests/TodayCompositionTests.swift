import Foundation
import Testing
@testable import Lab86Mail

// What Today says about itself. The same rules `tests/albatross-today.test.ts`
// pins for the web, so the two clients cannot describe the same day in two
// different sentences.
struct TodayCompositionTests {
    private func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 12) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York") ?? .gmt
        return calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour))!
    }

    // MARK: The day-shape line

    @Test func anEmptyDaySaysSoAndDoesNotInventWork() {
        #expect(
            TodayComposition.dayShapeLine(needsYouCount: 0, eventCount: 0, capacity: .normal)
                == "Nothing needs you and nothing is booked. The day is yours."
        )
    }

    @Test func theDeckNeverCountsWhatAlbatrossCarries() {
        // Today no longer lists the albatross stack, so the deck says nothing
        // about it. The line is the day, the mail, and one move.
        let line = TodayComposition.dayShapeLine(needsYouCount: 0, eventCount: 2, capacity: .normal)
        #expect(line == "2 things are booked.")
        #expect(!line.contains("carrying"))
    }

    // MARK: The next move

    private func move(start: Date?, end: Date?) -> WorkExecutionMove {
        WorkExecutionMove(
            workID: "w1", workTitle: "Passport renewal", stepKey: "s1", stepTitle: "Send the form",
            detail: nil, url: nil, phase: start == nil ? "unscheduled" : "upcoming",
            scheduledStartAt: start, scheduledEndAt: end, remainingSteps: 2, totalSteps: 3, areaName: nil
        )
    }

    @Test func nextMoveRendersOnlyForABlockBookedToday() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York") ?? .gmt
        calendar.locale = Locale(identifier: "en_US")
        let now = date(2026, 9, 3, 9)
        let later = date(2026, 9, 3, 14)
        let tomorrow = date(2026, 9, 4, 14)

        #expect(TodayComposition.nextMove(from: nil, now: now, calendar: calendar) == nil)
        #expect(TodayComposition.nextMove(from: move(start: nil, end: nil), now: now, calendar: calendar) == nil)
        #expect(
            TodayComposition.nextMove(from: move(start: tomorrow, end: nil), now: now, calendar: calendar) == nil
        )

        let booked = TodayComposition.nextMove(from: move(start: later, end: nil), now: now, calendar: calendar)
        #expect(booked?.stepTitle == "Send the form")
        #expect(booked?.workTitle == "Passport renewal")
        // Foundation writes a narrow no-break space before the period.
        #expect(booked?.time.replacingOccurrences(of: "\u{202F}", with: " ") == "2:00 PM")

        let active = TodayComposition.nextMove(
            from: move(start: date(2026, 9, 3, 8), end: date(2026, 9, 3, 10)), now: now, calendar: calendar
        )
        #expect(active?.time == "Now")
    }

    @Test func aPassedBlockIsNotANextMove() {
        // The missed-move prompt lives in the Work detail, never on Today.
        let now = date(2026, 9, 3, 12)
        let passed = move(start: date(2026, 9, 3, 8), end: date(2026, 9, 3, 9))
        #expect(TodayComposition.nextMove(from: passed, now: now) == nil)
    }

    @Test func mailThatMattersReadsTheBriefsOwnLaneAndCapsAtFour() {
        func row(_ id: String, line: String? = nil) -> JSONValue {
            var object: [String: JSONValue] = [
                "account": .string("jakob@example.com"),
                "threadId": .string(id),
                "subject": .string("Venue count"),
                "people": .array([.string("Sarah Chen")]),
                "whyItMatters": .string("Asked for the head count."),
            ]
            if let line { object["line"] = .string(line) }
            return .object(object)
        }
        let sections: JSONValue = .object([
            "answer": .array([row("t1", line: "Asked for the venue count"), row("t2"), row("t3"), row("t4"), row("t5")]),
            "replyOwed": .array([row("legacy")]),
        ])
        let items = ImportantMailItem.fromSections(sections)
        #expect(items.count == 4)
        #expect(items.first?.sender == "Sarah Chen")
        #expect(items.first?.reason == "Asked for the venue count")
        #expect(items[1].reason == "Asked for the head count.")
        #expect(items.map(\.threadID) == ["t1", "t2", "t3", "t4"])

        // Editions older than 2026-09-03 carry no "answer" lane.
        let legacy = ImportantMailItem.fromSections(.object(["replyOwed": .array([row("legacy"), row("legacy")])]))
        #expect(legacy.map(\.threadID) == ["legacy"])
        #expect(ImportantMailItem.fromSections(nil).isEmpty)
    }

    @Test func countsReadAsSentencesNotAsTallies() {
        #expect(
            TodayComposition.dayShapeLine(needsYouCount: 1, eventCount: 2, capacity: .normal)
                == "One thing needs you, and 2 things are booked."
        )
    }

    @Test func capacityColoursTheSentenceWithoutScolding() {
        #expect(
            TodayComposition.dayShapeLine(needsYouCount: 1, eventCount: 0, capacity: .low)
                .contains("Keeping the rest light.")
        )
        #expect(
            TodayComposition.dayShapeLine(needsYouCount: 1, eventCount: 0, capacity: .high)
                .contains("There is room for more.")
        )
    }

    @Test func neverUsesTheWordsThatMakeADayFeelLikeADebt() {
        for capacity in TodayComposition.Capacity.allCases {
            for needsYou in [0, 1, 4] {
                let line = TodayComposition.dayShapeLine(
                    needsYouCount: needsYou, eventCount: 2, capacity: capacity
                ).lowercased()
                #expect(!line.contains("overdue"))
                #expect(!line.contains("behind"))
                #expect(!line.contains("should"))
                #expect(!line.contains("failed"))
            }
        }
    }

    // MARK: The brief's stamp

    @Test func saysNothingWhenNoBriefHasEverBeenWritten() {
        let now = date(2026, 8, 5)
        #expect(TodayComposition.briefFreshness(generatedAt: nil, now: now) == nil)
        #expect(!TodayComposition.briefIsStale(generatedAt: nil, now: now))
        #expect(
            TodayComposition.briefStandingLine(generatedAt: nil, now: now) == "Not written yet today."
        )
    }

    @Test func saysPlainlyHowOldItIs() {
        let now = date(2026, 8, 5)
        #expect(
            TodayComposition.briefFreshness(generatedAt: now.addingTimeInterval(-1_800), now: now)
                == "Written just now"
        )
        #expect(
            TodayComposition.briefFreshness(generatedAt: now.addingTimeInterval(-3 * 3_600), now: now)
                == "Written 3 hours ago"
        )
        #expect(
            TodayComposition.briefFreshness(generatedAt: now.addingTimeInterval(-26 * 3_600), now: now)
                == "Written yesterday"
        )
        #expect(
            TodayComposition.briefFreshness(
                generatedAt: now.addingTimeInterval(-24 * 24 * 3_600), now: now
            ) == "Written 24 days ago"
        )
    }

    @Test func aBriefDescribingAnOlderDaySaysSoLoudly() {
        // The audit found one presenting a 24-day-old day under a "Live" label.
        let now = date(2026, 8, 5)
        #expect(TodayComposition.briefIsStale(generatedAt: now.addingTimeInterval(-24 * 24 * 3_600), now: now))
        #expect(!TodayComposition.briefIsStale(generatedAt: now.addingTimeInterval(-6 * 3_600), now: now))
        #expect(
            TodayComposition.briefStandingLine(
                generatedAt: now.addingTimeInterval(-24 * 24 * 3_600), now: now
            ).hasSuffix("it describes an older day.")
        )
    }

    @Test func aFreshBriefSaysWhereItCameFrom() {
        let now = date(2026, 8, 5)
        #expect(
            TodayComposition.briefStandingLine(generatedAt: now.addingTimeInterval(-600), now: now)
                == "Written just now, from your mail and calendar."
        )
    }
}
