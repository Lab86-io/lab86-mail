import Foundation
import Testing
@testable import Lab86Mail

// The calendar's grid and timeline arithmetic: month matrices for the year and
// mini-month grids, overlap lanes shared by the day and week timelines, and the
// capping rule behind a month cell's entries.
struct CalendarLayoutTests {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York") ?? .gmt
        calendar.firstWeekday = 1
        return calendar
    }

    private func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 0, _ minute: Int = 0) -> Date {
        calendar.date(
            from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute)
        )!
    }

    private func event(
        _ id: String,
        from start: Date,
        to end: Date,
        allDay: Bool = false,
        calendarID: String? = "cal"
    ) -> CalendarEventSummary {
        CalendarEventSummary(
            id: id,
            accountID: "acct",
            calendarID: calendarID,
            title: id,
            start: start,
            end: end,
            allDay: allDay,
            location: nil
        )
    }

    // MARK: - Month matrices

    // The regression the year view shipped with: blanks and day numbers were
    // separate runs whose identities overlapped, so every month lost as many
    // days as it had leading blanks, minus one.
    @Test
    func everyDayOfTheMonthAppearsExactlyOnce() {
        for month in 1...12 {
            let weeks = CalendarGrid.weeks(ofMonthContaining: date(2026, month, 1), calendar: calendar)
            let days = weeks.flatMap { $0 }.compactMap { $0 }
            let expected = calendar.range(of: .day, in: .month, for: date(2026, month, 1))!.count
            #expect(days == Array(1...expected), "month \(month)")
        }
    }

    @Test
    func monthRowsAreWholeWeeks() {
        let weeks = CalendarGrid.weeks(ofMonthContaining: date(2026, 7, 15), calendar: calendar)
        #expect(weeks.allSatisfy { $0.count == 7 })
        // July 2026 starts on a Wednesday, so the first row holds three blanks.
        #expect(weeks.first?.prefix(3).allSatisfy { $0 == nil } == true)
        #expect(weeks.first?[3] == 1)
    }

    @Test
    func leadingBlanksFollowTheFirstWeekday() {
        var monday = calendar
        monday.firstWeekday = 2
        // 1 July 2026 is a Wednesday: three blanks Sunday-first, two Monday-first.
        #expect(CalendarGrid.leadingBlanks(monthStart: date(2026, 7, 1), calendar: calendar) == 3)
        #expect(CalendarGrid.leadingBlanks(monthStart: date(2026, 7, 1), calendar: monday) == 2)
    }

    @Test
    func weekdayInitialsRotateWithTheFirstWeekday() {
        var monday = calendar
        monday.firstWeekday = 2
        let sundayFirst = CalendarGrid.weekdayInitials(calendar: calendar)
        let mondayFirst = CalendarGrid.weekdayInitials(calendar: monday)
        #expect(sundayFirst.count == 7)
        #expect(mondayFirst.count == 7)
        #expect(mondayFirst.first == sundayFirst[1])
        #expect(mondayFirst.last == sundayFirst[0])
    }

    // MARK: - Timeline placement

    @Test
    func nonOverlappingEventsEachTakeTheFullWidth() {
        let day = date(2026, 7, 28)
        let placements = TimelineLayout.place(
            [
                event("morning", from: date(2026, 7, 28, 9), to: date(2026, 7, 28, 10)),
                event("afternoon", from: date(2026, 7, 28, 14), to: date(2026, 7, 28, 15)),
            ],
            on: day,
            calendar: calendar
        )
        #expect(placements.count == 2)
        #expect(placements.allSatisfy { $0.laneCount == 1 && $0.lane == 0 })
        #expect(placements[0].startMinutes == 9 * 60)
        #expect(placements[0].endMinutes == 10 * 60)
    }

    @Test
    func overlappingEventsSplitTheirClusterAndLeaveOthersAlone() {
        let day = date(2026, 7, 28)
        let placements = TimelineLayout.place(
            [
                event("a", from: date(2026, 7, 28, 9), to: date(2026, 7, 28, 11)),
                event("b", from: date(2026, 7, 28, 9, 30), to: date(2026, 7, 28, 10, 30)),
                event("c", from: date(2026, 7, 28, 10), to: date(2026, 7, 28, 12)),
                event("solo", from: date(2026, 7, 28, 15), to: date(2026, 7, 28, 16)),
            ],
            on: day,
            calendar: calendar
        )
        let byID = Dictionary(uniqueKeysWithValues: placements.map { ($0.event.id, $0) })
        #expect(byID["a"]?.laneCount == 3)
        #expect(byID["b"]?.laneCount == 3)
        #expect(byID["c"]?.laneCount == 3)
        #expect(Set([byID["a"]!.lane, byID["b"]!.lane, byID["c"]!.lane]) == [0, 1, 2])
        // The cluster ends before the standalone event, which keeps full width.
        #expect(byID["solo"]?.laneCount == 1)
    }

    @Test
    func aFreedLaneIsReusedRatherThanWidening() {
        let day = date(2026, 7, 28)
        let placements = TimelineLayout.place(
            [
                event("long", from: date(2026, 7, 28, 9), to: date(2026, 7, 28, 13)),
                event("first", from: date(2026, 7, 28, 9), to: date(2026, 7, 28, 10)),
                event("second", from: date(2026, 7, 28, 10), to: date(2026, 7, 28, 11)),
            ],
            on: day,
            calendar: calendar
        )
        #expect(placements.allSatisfy { $0.laneCount == 2 })
        let byID = Dictionary(uniqueKeysWithValues: placements.map { ($0.event.id, $0) })
        #expect(byID["first"]?.lane == byID["second"]?.lane)
    }

    @Test
    func aBlockNeverCollapsesAndNeverLeavesTheDay() {
        let day = date(2026, 7, 28)
        let placements = TimelineLayout.place(
            [
                // An instant, and an event running in from the previous day and
                // out into the next.
                event("instant", from: date(2026, 7, 28, 9), to: date(2026, 7, 28, 9)),
                event("spanning", from: date(2026, 7, 27, 22), to: date(2026, 7, 29, 2)),
            ],
            on: day,
            calendar: calendar
        )
        let byID = Dictionary(uniqueKeysWithValues: placements.map { ($0.event.id, $0) })
        #expect(byID["instant"]?.endMinutes == 9 * 60 + TimelineLayout.minimumMinutes)
        #expect(byID["spanning"]?.startMinutes == 0)
        #expect(byID["spanning"]?.endMinutes == TimelineLayout.minutesPerDay)
        #expect(placements.allSatisfy { $0.startMinutes >= 0 && $0.endMinutes <= TimelineLayout.minutesPerDay })
        #expect(placements.allSatisfy { $0.endMinutes > $0.startMinutes })
    }

    // MARK: - Day cell contents

    @Test
    func allDayEntriesLeadAndTimedOnesFollowInClockOrder() {
        let chips = DayChips.make(
            events: [
                event("noon", from: date(2026, 7, 28, 12), to: date(2026, 7, 28, 13)),
                event("holiday", from: date(2026, 7, 28), to: date(2026, 7, 29), allDay: true),
                event("dawn", from: date(2026, 7, 28, 6), to: date(2026, 7, 28, 7)),
            ],
            tasks: [],
            limit: 5
        )
        #expect(chips.chips.map(\.title) == ["holiday", "dawn", "noon"])
        #expect(chips.chips.first?.kind == .allDay)
        #expect(chips.overflow == 0)
    }

    @Test
    func theOverflowCountClaimsItsOwnSlot() {
        let events = (1...6).map {
            event("e\($0)", from: date(2026, 7, 28, $0), to: date(2026, 7, 28, $0, 30))
        }
        let capped = DayChips.make(events: events, tasks: [], limit: 3)
        // Two chips plus "+4" fills three slots and accounts for all six.
        #expect(capped.chips.count == 2)
        #expect(capped.overflow == 4)
        #expect(capped.chips.count + capped.overflow == events.count)
    }

    @Test
    func aDayThatExactlyFillsTheCellShowsNoOverflow() {
        let events = (1...3).map {
            event("e\($0)", from: date(2026, 7, 28, $0), to: date(2026, 7, 28, $0, 30))
        }
        let capped = DayChips.make(events: events, tasks: [], limit: 3)
        #expect(capped.chips.count == 3)
        #expect(capped.overflow == 0)
    }

    @Test
    func colourSeedsFollowTheCalendarAndFallBackToTheAccount() {
        let work = event("a", from: date(2026, 7, 28, 9), to: date(2026, 7, 28, 10), calendarID: "work")
        let home = event("b", from: date(2026, 7, 28, 9), to: date(2026, 7, 28, 10), calendarID: "home")
        let unlabelled = event("c", from: date(2026, 7, 28, 9), to: date(2026, 7, 28, 10), calendarID: "  ")
        #expect(DayChips.seed(for: work) == "work")
        #expect(DayChips.seed(for: work) != DayChips.seed(for: home))
        #expect(DayChips.seed(for: unlabelled) == "acct")
    }


    // MARK: - Week navigation

    @Test
    func steppingTheWeekMovesTheSelectionToTheSameWeekday() {
        // Wednesday, 4 March 2026; the week (Sunday-first) starts 1 March.
        let wednesday = date(2026, 3, 4)
        let week = CalendarView.weekStart(for: wednesday, calendar: calendar)
        #expect(week == date(2026, 3, 1))

        let nextWeek = CalendarView.weekPage(afterStepping: 1, from: week, calendar: calendar)
        #expect(nextWeek == date(2026, 3, 8))
        #expect(
            CalendarView.selectedDay(forWeek: nextWeek, keeping: wednesday, calendar: calendar)
                == date(2026, 3, 11)
        )

        let previousWeek = CalendarView.weekPage(afterStepping: -1, from: week, calendar: calendar)
        #expect(previousWeek == date(2026, 2, 22))
        #expect(
            CalendarView.selectedDay(forWeek: previousWeek, keeping: wednesday, calendar: calendar)
                == date(2026, 2, 25)
        )
    }

    @Test
    func showingTheWeekThatAlreadyHoldsTheSelectionKeepsIt() {
        let wednesday = date(2026, 3, 4, 9, 30)
        let week = CalendarView.weekStart(for: wednesday, calendar: calendar)
        #expect(CalendarView.selectedDay(forWeek: week, keeping: wednesday, calendar: calendar) == wednesday)
    }
}
