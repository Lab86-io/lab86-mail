import Foundation
import Testing
@testable import Lab86Mail

// The day drawn to scale. These are the same rules `tests/albatross-day-ribbon.test.ts`
// pins for the web, so the two clients cannot draw the same day differently.
struct DayRibbonTests {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York") ?? .gmt
        return calendar
    }

    private func at(_ hour: Int, _ minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 8, day: 3, hour: hour, minute: minute))!
    }

    private func event(
        _ id: String,
        from start: Date,
        to end: Date,
        allDay: Bool = false,
        title: String = "Meeting",
        location: String? = nil
    ) -> CalendarEventSummary {
        CalendarEventSummary(
            id: id,
            accountID: "acct",
            calendarID: "cal",
            title: title,
            start: start,
            end: end,
            allDay: allDay,
            location: location
        )
    }

    // MARK: The ribbon covers the whole day it is given

    @Test func quietDayUsesTheWakingWindow() {
        let window = DayRibbon.window(events: [], now: at(12), calendar: calendar)
        #expect(window.startHour == DayRibbon.defaultStartHour)
        #expect(window.endHour == DayRibbon.defaultEndHour)
    }

    @Test func earlyFlightIsNeverClippedOffTheTop() {
        let window = DayRibbon.window(
            events: [event("a", from: at(5), to: at(7))],
            now: at(12),
            calendar: calendar
        )
        #expect(window.startHour <= 5)
    }

    @Test func lateConcertIsNeverClippedOffTheBottom() {
        let window = DayRibbon.window(
            events: [event("a", from: at(21), to: at(23, 30))],
            now: at(12),
            calendar: calendar
        )
        #expect(window.endHour >= 23)
    }

    @Test func nowAlwaysSitsSomewhereOnTheRibbon() {
        let earlyMorning = at(4)
        let window = DayRibbon.window(events: [], now: earlyMorning, calendar: calendar)
        #expect(DayRibbon.nowMarker(earlyMorning, window, calendar: calendar) != nil)
    }

    // MARK: Blocks are drawn to scale

    @Test func longerMeetingIsTallerThanAShorterOne() {
        let window = DayRibbon.window(events: [], now: at(12), calendar: calendar)
        let blocks = DayRibbon.blocks(
            events: [
                event("short", from: at(9), to: at(9, 30)),
                event("long", from: at(14), to: at(17)),
            ],
            window: window,
            now: at(12),
            calendar: calendar
        )
        #expect(blocks[1].height > blocks[0].height)
        #expect(blocks[0].top < blocks[1].top)
    }

    @Test func fifteenMinuteStandUpIsStillReadable() {
        let window = DayRibbon.window(events: [], now: at(12), calendar: calendar)
        let blocks = DayRibbon.blocks(
            events: [event("a", from: at(9), to: at(9, 15))],
            window: window,
            now: at(12),
            calendar: calendar
        )
        // Drawn strictly to scale it would be a hairline nobody could read or tap.
        #expect(blocks[0].height >= DayRibbon.minimumBlockHeight)
    }

    @Test func allDayEventsStayOffTheTimedRibbon() {
        let window = DayRibbon.window(events: [], now: at(12), calendar: calendar)
        let blocks = DayRibbon.blocks(
            events: [
                event("holiday", from: at(0), to: at(23), allDay: true),
                event("real", from: at(10), to: at(11)),
            ],
            window: window,
            now: at(12),
            calendar: calendar
        )
        #expect(blocks.map(\.id) == ["real"])
    }

    // MARK: A day that runs past midnight

    private func yesterday(_ hour: Int) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 8, day: 2, hour: hour))!
    }

    private func tomorrow(_ hour: Int) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 8, day: 4, hour: hour))!
    }

    @Test func overnightFlightLandsAtTheTopOfTheRibbonNotTheFoot() {
        // Live defect: read as plain hours-of-day, a 22:00→09:00 flight had a
        // start hour of 22 and an end hour of 9, so it drew as a hairline at ten
        // at night.
        let flight = event("flight", from: yesterday(22), to: at(9))
        let window = DayRibbon.window(events: [flight], now: at(12), calendar: calendar)
        let blocks = DayRibbon.blocks(events: [flight], window: window, now: at(12), calendar: calendar)
        #expect(blocks[0].top == 0)
        #expect(blocks[0].height > 0.1)
    }

    @Test func eventRunningIntoTomorrowEndsAtTheFootRatherThanWrapping() {
        let late = event("late", from: at(21), to: tomorrow(2))
        let window = DayRibbon.window(events: [late], now: at(12), calendar: calendar)
        let blocks = DayRibbon.blocks(events: [late], window: window, now: at(12), calendar: calendar)
        #expect(abs(blocks[0].top + blocks[0].height - 1) < 0.000_01)
    }

    @Test func windowStillOpensEarlyEnoughForAnOvernightArrival() {
        let flight = event("flight", from: yesterday(22), to: at(9))
        #expect(DayRibbon.window(events: [flight], now: at(12), calendar: calendar).startHour == 0)
    }

    // MARK: The drawing stays legible without lying

    /// 26 and 42 points of a 420-point ribbon: the room one line and two lines need.
    private var minHeight: Double { 26.0 / 420.0 }
    private var twoLineHeight: Double { 42.0 / 420.0 }

    @Test func blockTooShortForTwoLinesIsMarkedCompact() {
        let window = DayRibbon.window(events: [], now: at(12), calendar: calendar)
        let stacked = DayRibbon.stack(
            DayRibbon.blocks(
                events: [
                    event("standup", from: at(9), to: at(9, 15)),
                    event("review", from: at(14), to: at(17)),
                ],
                window: window,
                now: at(12),
                calendar: calendar
            ),
            minHeight: minHeight,
            twoLineHeight: twoLineHeight
        )
        #expect(stacked[0].compact)
        #expect(!stacked[1].compact)
    }

    @Test func anHourOnALongDayIsStillOneLineBecauseThatIsAllItFits() {
        // Live defect: an hour of a fifteen-hour day is 28 points. It cleared
        // the one-line minimum, so it kept two lines and cut the second in half.
        let window = DayRibbon.window(events: [], now: at(12), calendar: calendar)
        let stacked = DayRibbon.stack(
            DayRibbon.blocks(
                events: [event("review", from: at(9, 30), to: at(10, 30))],
                window: window,
                now: at(12),
                calendar: calendar
            ),
            minHeight: minHeight,
            twoLineHeight: twoLineHeight
        )
        #expect(stacked[0].compact)
    }

    @Test func twoMeetingsCloseTogetherNeverSitOnTopOfEachOther() {
        let window = DayRibbon.window(events: [], now: at(12), calendar: calendar)
        let stacked = DayRibbon.stack(
            DayRibbon.blocks(
                events: [
                    event("standup", from: at(9), to: at(9, 15)),
                    event("review", from: at(9, 30), to: at(10, 30)),
                ],
                window: window,
                now: at(12),
                calendar: calendar
            ),
            minHeight: minHeight,
            twoLineHeight: twoLineHeight
        )
        #expect(stacked[1].top >= stacked[0].top + stacked[0].height)
    }

    @Test func nudgedBlockStillStatesItsRealTime() {
        let window = DayRibbon.window(events: [], now: at(12), calendar: calendar)
        let stacked = DayRibbon.stack(
            DayRibbon.blocks(
                events: [
                    event("a", from: at(9), to: at(9, 10)),
                    event("b", from: at(9, 15), to: at(9, 25)),
                ],
                window: window,
                now: at(12),
                calendar: calendar
            ),
            minHeight: minHeight,
            twoLineHeight: twoLineHeight
        )
        // The drawing may move. The claim may not.
        #expect(stacked[1].label.contains("9:15"))
    }

    @Test func lastBlockOfALongDayIsNeverPushedOffTheBottom() {
        let window = DayRibbon.window(events: [], now: at(12), calendar: calendar)
        let stacked = DayRibbon.stack(
            DayRibbon.blocks(
                events: [event("late", from: at(21, 50), to: at(22))],
                window: window,
                now: at(12),
                calendar: calendar
            ),
            minHeight: minHeight,
            twoLineHeight: twoLineHeight
        )
        #expect(stacked[0].top + stacked[0].height <= 1.0001)
    }

    @Test func roomyDayIsLeftExactlyWhereItBelongs() {
        let window = DayRibbon.window(events: [], now: at(12), calendar: calendar)
        let blocks = DayRibbon.blocks(
            events: [event("a", from: at(14), to: at(17))],
            window: window,
            now: at(12),
            calendar: calendar
        )
        let stacked = DayRibbon.stack(blocks, minHeight: minHeight, twoLineHeight: twoLineHeight)
        #expect(abs(stacked[0].top - blocks[0].top) < 0.000_001)
        #expect(abs(stacked[0].height - blocks[0].height) < 0.000_001)
    }

    // MARK: Open air is the fact an agenda never states

    @Test func realGapAfterAMeetingIsFoundAndMeasured() {
        let now = at(8)
        let window = DayRibbon.window(events: [], now: now, calendar: calendar)
        let blocks = DayRibbon.blocks(
            events: [event("a", from: at(9), to: at(10))],
            window: window,
            now: at(12),
            calendar: calendar
        )
        let gaps = DayRibbon.gaps(blocks: blocks, window: window, now: now, calendar: calendar)
        #expect(!gaps.isEmpty)
        #expect(gaps.contains { $0.minutes >= DayRibbon.minimumOpeningMinutes })
    }

    @Test func corridorBetweenTwoMeetingsIsNotCalledFreeTime() {
        let now = at(8)
        let window = DayRibbon.window(events: [], now: now, calendar: calendar)
        let blocks = DayRibbon.blocks(
            events: [
                event("a", from: at(9), to: at(10)),
                event("b", from: at(10, 20), to: at(11)),
            ],
            window: window,
            now: at(12),
            calendar: calendar
        )
        let gaps = DayRibbon.gaps(blocks: blocks, window: window, now: now, calendar: calendar)
        // Twenty minutes between two meetings is a corridor, not an opening.
        #expect(gaps.allSatisfy { $0.minutes >= DayRibbon.minimumOpeningMinutes })
    }

    @Test func timeAlreadyGoneIsNeverOfferedAsOpen() {
        let now = at(20)
        let window = DayRibbon.window(events: [], now: now, calendar: calendar)
        let gaps = DayRibbon.gaps(blocks: [], window: window, now: now, calendar: calendar)
        // At 8pm the morning is not available, however empty it was.
        #expect(gaps.allSatisfy { $0.top >= 0.8 })
    }

    @Test func fullyBookedDaySaysSoPlainly() {
        #expect(DayRibbon.openAirLine([]) == "No real openings left today.")
    }

    @Test func summaryCountsOpeningsRatherThanScoringTheDay() {
        let line = DayRibbon.openAirLine([
            DayRibbon.Gap(top: 0, height: 0.1, minutes: 60, label: "1 hour free"),
            DayRibbon.Gap(top: 0.5, height: 0.1, minutes: 90, label: "1h 30m free"),
        ])
        #expect(line.contains("2 openings"))
        #expect(!line.lowercased().contains("productiv"))
        #expect(!line.contains("%"))
    }

    // MARK: The hour rail stays legible

    @Test func longDayThinsItsTicksRatherThanCrowdingThem() {
        let short = DayRibbon.ticks(DayRibbon.Window(startHour: 9, endHour: 15))
        let long = DayRibbon.ticks(DayRibbon.Window(startHour: 5, endHour: 23))
        #expect(long.count <= short.count + 2)
    }

    @Test func hoursReadAsAPersonSaysThem() {
        let labels = DayRibbon.ticks(DayRibbon.Window(startHour: 11, endHour: 14)).map(\.label)
        #expect(labels.contains("11am"))
        #expect(labels.contains("12pm"))
        #expect(!labels.contains("0pm"))
    }
}
