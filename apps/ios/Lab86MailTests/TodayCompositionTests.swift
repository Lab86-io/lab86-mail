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

    @Test func aDayWithCarriedWorkDoesNotClaimToBeEmpty() {
        // Live defect on the web: the header read "The day is yours" while
        // the authoritative current move showed an Albatross underneath it.
        #expect(
            TodayComposition.dayShapeLine(
                needsYouCount: 0, eventCount: 0, capacity: .normal, carryingCount: 1
            ) == "Nothing needs you today. Albatross is carrying one thing on its own."
        )
        #expect(
            TodayComposition.dayShapeLine(
                needsYouCount: 0, eventCount: 0, capacity: .normal, carryingCount: 3
            ).contains("carrying 3 things")
        )
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
