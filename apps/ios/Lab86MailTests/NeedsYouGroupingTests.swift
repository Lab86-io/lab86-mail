import Foundation
import Testing
@testable import Lab86Mail

// The groups of the Needs you page, held to the web's answers
// (tests/needs-you-groups.test.ts). Wednesday, October 28, 2026, 11:05 AM
// in Los Angeles; the day starts at 07:00 UTC (PDT).
struct NeedsYouGroupingTests {
    private static let tz = "America/Los_Angeles"
    private static let now: ObligationMillis = 1_793_210_700_000
    private static let startOfToday: ObligationMillis = 1_793_170_800_000
    private static let hour: ObligationMillis = 3_600_000
    private static let day: ObligationMillis = 86_400_000

    private func item(
        _ id: String,
        kind: ObligationKind = .reply,
        state: ObligationState = .open,
        due: ObligationDue = .none,
        dueAt: ObligationMillis? = nil,
        pushLevel: ObligationPushLevel = .normal,
        code: ObligationCode? = nil,
        snoozedUntil: ObligationMillis? = nil,
        createdAt: ObligationMillis = NeedsYouGroupingTests.now - NeedsYouGroupingTests.hour,
        updatedAt: ObligationMillis? = nil,
        closedAt: ObligationMillis? = nil
    ) -> ObligationView {
        ObligationView(
            id: id,
            kind: kind,
            state: state,
            sourceKey: "mail:acct:\(id)",
            title: "Asks for a reply.",
            asker: "Ada Example",
            due: due,
            dueAt: dueAt,
            pushLevel: pushLevel,
            code: code,
            snoozedUntil: snoozedUntil,
            createdAt: createdAt,
            updatedAt: updatedAt,
            closedAt: closedAt
        )
    }

    private func group(_ obligation: ObligationView) -> NeedsYouGroupID? {
        NeedsYouGrouping.group(of: obligation, now: Self.now, timezone: Self.tz)
    }

    @Test func closedTodayStaysAndClosedBeforeTodayHides() {
        #expect(group(item("a", state: .done, closedAt: Self.startOfToday + Self.hour)) == .closedToday)
        #expect(group(item("b", state: .resolved, closedAt: Self.startOfToday - 1)) == nil)
        // Without a close time, the last change stands in for it.
        #expect(group(item("c", state: .expired, updatedAt: Self.startOfToday + 1)) == .closedToday)
        #expect(item("d", state: .dismissed).isClosed)
        #expect(!item("e", state: .snoozed).isClosed)
    }

    @Test func aSnoozedItemHidesUntilItsTime() {
        #expect(group(item("a", state: .snoozed, snoozedUntil: Self.now + Self.hour)) == nil)
        #expect(group(item("b", state: .snoozed, snoozedUntil: Self.now - 1)) == .noDate)
        #expect(group(item("c", state: .snoozed)) == .noDate)
    }

    @Test func waitingCodesTimeSensitiveAndOverdueItems() {
        #expect(group(item("a", kind: .waiting)) == .waiting)
        #expect(group(item("b", kind: .code, code: ObligationCode(value: "123456"))) == .now)
        #expect(group(item("c", kind: .change, due: .later, pushLevel: .timeSensitive)) == .now)
        #expect(group(item("d", dueAt: Self.now - 1)) == .now)
    }

    @Test func aConcreteDueTimeDecidesTheDay() {
        #expect(group(item("a", dueAt: Self.now + Self.hour)) == .today)
        #expect(group(item("b", dueAt: Self.startOfToday + Self.day + Self.hour)) == .thisWeek)
        #expect(group(item("c", dueAt: Self.startOfToday + 6 * Self.day + Self.hour)) == .thisWeek)
        #expect(group(item("d", dueAt: Self.startOfToday + 7 * Self.day + Self.hour)) == .afterThisWeek)
        // The concrete time wins over the word.
        #expect(group(item("e", due: .today, dueAt: Self.startOfToday + 10 * Self.day)) == .afterThisWeek)
    }

    @Test func withoutATimeTheDueWordDecides() {
        #expect(group(item("a", due: .today)) == .today)
        #expect(group(item("b", due: .soon)) == .thisWeek)
        #expect(group(item("c", due: .later)) == .afterThisWeek)
        #expect(group(item("d", due: .none)) == .noDate)
    }

    @Test func anInvalidTimeZoneFallsBackToTheDevice() {
        #expect(NeedsYouGrouping.group(of: item("a", due: .today), now: Self.now, timezone: "Not/AZone") == .today)
        #expect(NeedsYouClock.safeTimeZone("Not/AZone") == nil)
        #expect(NeedsYouClock.safeTimeZone("Europe/Oslo")?.identifier == "Europe/Oslo")
        #expect(NeedsYouClock.safeTimeZone(nil) == nil)
    }

    @Test func groupsComeInDisplayOrderWithoutTheEmptyOnesAndAlbatrossItemsJoin() {
        let groups = NeedsYouGrouping.groups(
            items: [
                item("later", due: .later),
                item("today", due: .today),
                item("done", state: .done, closedAt: Self.now - Self.hour),
                item("wait", kind: .waiting),
            ],
            extras: [
                NeedsYouExtra(id: "question:1", kind: .question, createdAt: Self.now - 2 * Self.hour),
                NeedsYouExtra(id: "approval:1", kind: .approval, createdAt: Self.now - 3 * Self.hour),
                NeedsYouExtra(id: "checkin:1", kind: .checkin, createdAt: Self.now - 2 * Self.hour),
                NeedsYouExtra(id: "update:1", kind: .update, createdAt: Self.now - 2 * Self.hour),
                NeedsYouExtra(id: "question:old", kind: .question, attention: false),
            ],
            now: Self.now,
            timezone: Self.tz
        )
        #expect(groups.map(\.id) == [.now, .today, .afterThisWeek, .waiting, .closedToday])
        #expect(groups.map(\.label) == ["Now", "Today", "After this week", "Waiting on others", "Closed today"])
        #expect(groups[0].entries.map(\.id) == ["question:1", "approval:1"])
        #expect(groups[1].entries.map(\.id) == ["today", "checkin:1"])
    }

    @Test func datedItemsComeFirstByDateThenTheNewestFirstTiesById() {
        let entries: [NeedsYouEntry] = [
            .obligation(item("b", createdAt: Self.now - 3 * Self.hour)),
            .obligation(item("a", createdAt: Self.now - 3 * Self.hour)),
            .obligation(item("new", createdAt: Self.now - Self.hour)),
            .obligation(item("late", dueAt: Self.now + 5 * Self.hour)),
            .obligation(item("soon", dueAt: Self.now + Self.hour)),
            .albatross(NeedsYouExtra(id: "q", kind: .question)),
        ]
        #expect(entries.sorted(by: NeedsYouGrouping.comesFirst).map(\.id) == ["soon", "late", "new", "a", "b", "q"])
        // Two dated items with the same time fall through to recency.
        let sameDue: [NeedsYouEntry] = [
            .obligation(item("x", dueAt: Self.now + Self.hour, createdAt: Self.now - Self.hour)),
            .obligation(item("y", dueAt: Self.now + Self.hour, createdAt: Self.now)),
        ]
        #expect(sameDue.sorted(by: NeedsYouGrouping.comesFirst).map(\.id) == ["y", "x"])
    }

    @Test func closedRowsSortByTheirCloseTimeNewestFirst() {
        let groups = NeedsYouGrouping.groups(
            items: [
                item("first", state: .done, createdAt: Self.now - Self.hour, closedAt: Self.now - 3 * Self.hour),
                item("second", state: .done, createdAt: Self.now - 5 * Self.hour, closedAt: Self.now - Self.hour),
            ],
            now: Self.now,
            timezone: Self.tz
        )
        #expect(groups.map(\.id) == [.closedToday])
        #expect(groups[0].entries.map(\.id) == ["second", "first"])
    }

    @Test func theSummaryCountsNowOpenAndClosedToday() {
        let groups = NeedsYouGrouping.groups(
            items: [
                item("code", kind: .code, code: ObligationCode(value: "482913", expiresAt: Self.now + 480_000)),
                item("hot", kind: .change, pushLevel: .timeSensitive),
                item("today", due: .today),
                item("week", due: .soon),
                item("wait", kind: .waiting),
                item("done", state: .done, closedAt: Self.now - Self.hour),
            ],
            extras: [NeedsYouExtra(id: "question:1", kind: .question)],
            now: Self.now,
            timezone: Self.tz
        )
        let summary = NeedsYouGrouping.summary(of: groups)
        #expect(summary == NeedsYouSummary(now: 3, open: 6, closedToday: 1))
        #expect(summary.line == "3 now · 6 open · 1 closed today")
        #expect(NeedsYouGrouping.summary(of: []) == NeedsYouSummary(now: 0, open: 0, closedToday: 0))
        #expect(NeedsYouSummary(now: 0, open: 0, closedToday: 0).line == "0 open")
    }

    @Test func theLaterMenuInTheMorning() {
        let options = NeedsYouGrouping.laterOptions(now: Self.now, timezone: Self.tz)
        #expect(options.map(\.id) == [.laterToday, .tomorrowMorning, .nextWeek])
        #expect(options.map(\.label) == ["Later today", "Tomorrow morning", "Next week"])
        #expect(options[0].until == Self.now + 3 * Self.hour)
        #expect(options[1].until == 1_793_289_600_000)
        // November 2 is the next Monday; PST starts November 1, so 9 AM is 17:00 UTC.
        #expect(options[2].until == 1_793_638_800_000)
    }

    @Test func lateInTheEveningLaterTodayGoes() {
        // 10:30 PM on October 28 in Los Angeles.
        let evening: ObligationMillis = 1_793_251_800_000
        #expect(NeedsYouGrouping.laterOptions(now: evening, timezone: Self.tz).map(\.id) == [.tomorrowMorning, .nextWeek])
    }

    @Test func onAMondayNextWeekMeansTheMondayAfter() {
        let monday: ObligationMillis = 1_793_642_400_000
        let next = NeedsYouGrouping.laterOptions(now: monday, timezone: Self.tz).first { $0.id == .nextWeek }
        #expect(next?.until == 1_794_243_600_000)
    }

    @Test func anOpenCodePastItsExpiryReadsAsExpiredAndLeavesNow() {
        let code = { (id: String, expiresAt: ObligationMillis?, state: ObligationState) in
            self.item(id, kind: .code, state: state, code: ObligationCode(value: "482913", expiresAt: expiresAt))
        }
        let settled = NeedsYouGrouping.settleExpiredCodes(
            [code("old", Self.now - 1, .open), code("live", Self.now + 300_000, .open), code("none", nil, .open), item("r")],
            now: Self.now
        )
        #expect(settled[0].state == .expired)
        #expect(settled[0].closeReason == .expired)
        #expect(settled[0].closedAt == Self.now - 1)
        #expect(group(settled[0]) == .closedToday)
        #expect(settled[1].state == .open)
        #expect(settled[2].state == .open)
        #expect(settled[3].state == .open)
        // A closed code keeps its own close reason.
        let used = NeedsYouGrouping.settleExpiredCodes([code("used", Self.now - 1, .done)], now: Self.now)[0]
        #expect(used.state == .done)
        #expect(used.closeReason == nil)
        // The next wake is the soonest open code expiry after now.
        #expect(NeedsYouGrouping.nextCodeExpiry([
            code("past", Self.now - 1, .open),
            code("late", Self.now + 540_000, .open),
            code("soon", Self.now + 120_000, .open),
            code("closed", Self.now + 60_000, .expired),
        ], now: Self.now) == Self.now + 120_000)
        #expect(NeedsYouGrouping.nextCodeExpiry([code("none", nil, .open), item("r")], now: Self.now) == nil)
    }

    @Test func theClockCountsDaysAcrossADaylightChange() {
        let clock = NeedsYouClock(timezone: Self.tz)
        #expect(clock.startOfDay(Self.now) == Self.startOfToday)
        // November 1 ends daylight time: the day after has 25 hours.
        let november1 = clock.startOfDay(Self.now, plusDays: 4)
        let november2 = clock.startOfDay(Self.now, plusDays: 5)
        #expect(november2 - november1 == 25 * Self.hour)
        #expect(clock.dayDistance(november2, from: Self.now) == 5)
        #expect(clock.weekday(Self.now) == 3)
    }
}
