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

    @Test
    func chipsCarryTheirCalendarKeyAndTasksCarryNone() {
        let chips = DayChips.make(
            events: [event("a", from: date(2026, 7, 28, 9), to: date(2026, 7, 28, 10), calendarID: "work")],
            tasks: [task("t1", due: date(2026, 7, 28, 15))],
            limit: 5
        )
        #expect(chips.chips.first?.calendarKey == "acct:work")
        #expect(chips.chips.last?.kind == .task)
        #expect(chips.chips.last?.calendarKey == nil)
    }

    // MARK: - Hour axis

    @Test
    func theWidestHourLabelIsTheLongestOne() {
        let day = date(2026, 7, 28)
        let widest = HourAxis.widestLabel(on: day, calendar: calendar)
        let labels = HourAxis.labels(on: day, calendar: calendar)
        #expect(labels.count == 24)
        #expect(labels.contains(widest))
        #expect(labels.allSatisfy { $0.count <= widest.count })
    }

    @Test
    func theTimelineOpensBeforeNowOnceTodayIsUnderWay() {
        let now = date(2026, 7, 28, 14, 10)
        let first = date(2026, 7, 28, 9, 30)
        #expect(HourAxis.openingHour(now: now, isToday: true, firstStart: first, calendar: calendar) == 13)
        // No entries at all: an hour before now.
        #expect(HourAxis.openingHour(now: now, isToday: true, firstStart: nil, calendar: calendar) == 13)
    }

    @Test
    func theTimelineOpensOnTheFirstEntryBeforeTheDayStarts() {
        // Two in the morning with a half-past-nine standup: the morning, not
        // seven hours of empty grid (D12).
        let now = date(2026, 7, 28, 2, 5)
        let first = date(2026, 7, 28, 9, 30)
        #expect(HourAxis.openingHour(now: now, isToday: true, firstStart: first, calendar: calendar) == 8)
        // Another day opens on its first entry, or on eight when it has none.
        #expect(HourAxis.openingHour(now: now, isToday: false, firstStart: first, calendar: calendar) == 8)
        #expect(HourAxis.openingHour(now: now, isToday: false, firstStart: date(2026, 7, 29, 0, 15), calendar: calendar) == 0)
        #expect(HourAxis.openingHour(now: now, isToday: false, firstStart: nil, calendar: calendar) == 8)
    }

    @Test
    func axisAndNumeralFontsGrowToACeiling() {
        #expect(HourAxis.labelFontSize(scaled: 11) == 11)
        #expect(HourAxis.labelFontSize(scaled: 15) == 15)
        // AX3 scales caption2 to about 40 points; the axis stops at 20.
        #expect(HourAxis.labelFontSize(scaled: 40) == HourAxis.maximumLabelFontSize)
        #expect(DayNumeralSize.accessibleFontSize(scaled: 17) == 17)
        #expect(DayNumeralSize.accessibleFontSize(scaled: 53) == DayNumeralSize.maximumAccessibleFontSize)
        #expect(DayNumeralSize.accessibleFontSize(scaled: 0) == 1)
    }

    @Test
    func theHourRowGrowsWithTheTextButSlower() {
        #expect(HourAxis.hourHeight(base: 58, textScale: 1) == 58)
        // The text doubled; the row grew by six tenths of that.
        #expect(HourAxis.hourHeight(base: 58, textScale: 2) == 93)
        // A smaller text size never shrinks the row below its base.
        #expect(HourAxis.hourHeight(base: 58, textScale: 0.8) == 58)
    }

    // MARK: - Block text

    @Test
    func aNarrowBlockShowsOneLineAndATinyOneShowsNone() {
        // A phone's week column at the default size: one line, cut at the
        // end, never a word broken in the middle (D11).
        #expect(BlockText.plan(width: 50, height: 40, fontSize: 11) == BlockText.Plan(lines: 1))
        // A quarter-hour block has no room for a line of text.
        #expect(BlockText.plan(width: 50, height: 12, fontSize: 11).showsText == false)
        // Too narrow for four characters: colour only.
        #expect(BlockText.plan(width: 20, height: 60, fontSize: 11).showsText == false)
    }

    @Test
    func aWideBlockShowsAsManyLinesAsItHoldsToALimit() {
        #expect(BlockText.plan(width: 300, height: 60, fontSize: 15, maxLines: 2) == BlockText.Plan(lines: 2))
        #expect(BlockText.plan(width: 300, height: 28, fontSize: 15, maxLines: 2) == BlockText.Plan(lines: 1))
        #expect(BlockText.plan(width: 200, height: 200, fontSize: 11) == BlockText.Plan(lines: 3))
    }

    @Test
    func accessibilityTextHidesTitlesInTheWeekColumns() {
        // At AX3 the caption is about 29 points; a 50 point column holds too
        // few characters, so the block carries only its colour (D7).
        #expect(BlockText.plan(width: 50, height: 80, fontSize: 29).showsText == false)
        // An iPad column at the same size still reads.
        #expect(BlockText.plan(width: 160, height: 80, fontSize: 29).lines >= 1)
    }

    // MARK: - Slots

    @Test
    func aHoldOnTheGridSnapsToTheHalfHour() {
        #expect(TimelineSlot.minutes(forY: 0, hourHeight: 60) == 0)
        #expect(TimelineSlot.minutes(forY: 95, hourHeight: 60) == 90)
        #expect(TimelineSlot.minutes(forY: 119, hourHeight: 60) == 90)
        #expect(TimelineSlot.minutes(forY: 120, hourHeight: 60) == 120)
        // Past the end of the day the slot stays inside it.
        #expect(TimelineSlot.minutes(forY: 10_000, hourHeight: 60) == 24 * 60 - 30)
        #expect(TimelineSlot.minutes(forY: -40, hourHeight: 60) == 0)
    }

    @Test
    func aSlotStartIsADateOnThatDay() {
        let day = date(2026, 7, 28)
        let start = TimelineSlot.start(forY: 9.5 * 58, hourHeight: 58, on: day, calendar: calendar)
        #expect(start == date(2026, 7, 28, 9, 30))
    }

    @Test
    func theWeekColumnUnderAPointIsFound() {
        #expect(TimelineSlot.column(forX: 10, gutter: 40, columnWidth: 50) == nil)
        #expect(TimelineSlot.column(forX: 40, gutter: 40, columnWidth: 50) == 0)
        #expect(TimelineSlot.column(forX: 389, gutter: 40, columnWidth: 50) == 6)
        #expect(TimelineSlot.column(forX: 390, gutter: 40, columnWidth: 50) == nil)
    }

    // MARK: - Calendar colours

    @Test
    func providerHexColoursParseAndJunkDoesNot() {
        #expect(CalendarPalette.rgb(hex: "#3B6E8F") == CalendarPalette.RGB(red: 59 / 255, green: 110 / 255, blue: 143 / 255))
        #expect(CalendarPalette.rgb(hex: "b5502f") == CalendarPalette.RGB(red: 181 / 255, green: 80 / 255, blue: 47 / 255))
        #expect(CalendarPalette.rgb(hex: "#FFF") == CalendarPalette.RGB(red: 1, green: 1, blue: 1))
        #expect(CalendarPalette.rgb(hex: "#3B6E8F80") == CalendarPalette.RGB(red: 59 / 255, green: 110 / 255, blue: 143 / 255))
        #expect(CalendarPalette.rgb(hex: nil) == nil)
        #expect(CalendarPalette.rgb(hex: "") == nil)
        #expect(CalendarPalette.rgb(hex: "blue") == nil)
        #expect(CalendarPalette.rgb(hex: "#12345") == nil)
    }

    // MARK: - Visibility

    @Test
    func hiddenCalendarsStayOutAndEventsWithoutACalendarStayIn() {
        let work = event("a", from: date(2026, 7, 28, 9), to: date(2026, 7, 28, 10), calendarID: "work")
        let home = event("b", from: date(2026, 7, 28, 9), to: date(2026, 7, 28, 10), calendarID: "home")
        let loose = event("c", from: date(2026, 7, 28, 9), to: date(2026, 7, 28, 10), calendarID: nil)
        let hidden: Set<String> = [CalendarVisibility.key(accountID: "acct", calendarID: "home")]
        #expect(CalendarVisibility.visible([work, home, loose], hiddenKeys: hidden).map(\.id) == ["a", "c"])
        #expect(CalendarVisibility.visible([work, home], hiddenKeys: []).map(\.id) == ["a", "b"])
        #expect(CalendarVisibility.key(for: loose) == nil)
        #expect(CalendarVisibility.key(for: work) == "acct:work")
    }

    // MARK: - Reconnect

    @Test
    func theReconnectBannerListsOnlyTheUnauthorizedAccountsInOrder() {
        let accounts = [
            AccountSummary(json: .object(["accountId": .string("b"), "email": .string("zed@example.com")]))!,
            AccountSummary(json: .object(["accountId": .string("a"), "email": .string("amy@example.com")]))!,
            AccountSummary(json: .object(["accountId": .string("c"), "email": .string("ok@example.com")]))!,
        ]
        let rows = CalendarReconnect.accounts(unauthorizedIDs: ["a", "b"], accounts: accounts)
        #expect(rows.map(\.id) == ["a", "b"])
        #expect(CalendarReconnect.accounts(unauthorizedIDs: [], accounts: accounts).isEmpty)
        #expect(CalendarReconnect.message(for: accounts[1]).hasPrefix("amy@example.com stopped syncing"))
    }

    // MARK: - Bar title

    @Test
    func theBarTitleNamesTheMonthAndYearInEveryMode() {
        let selected = date(2026, 10, 16)
        let scrolledTo = date(2026, 11, 1)
        #expect(CalendarTitle.text(mode: "day", visibleMonth: nil, visibleYear: nil, selectedDay: selected, calendar: calendar) == "October 2026")
        #expect(CalendarTitle.text(mode: "week", visibleMonth: scrolledTo, visibleYear: nil, selectedDay: selected, calendar: calendar) == "October 2026")
        // Month and year follow the scroll, not the selection (D17).
        #expect(CalendarTitle.text(mode: "month", visibleMonth: scrolledTo, visibleYear: nil, selectedDay: selected, calendar: calendar) == "November 2026")
        #expect(CalendarTitle.text(mode: "month", visibleMonth: nil, visibleYear: nil, selectedDay: selected, calendar: calendar) == "October 2026")
        #expect(CalendarTitle.text(mode: "year", visibleMonth: nil, visibleYear: 2027, selectedDay: selected, calendar: calendar) == "2027")
        #expect(CalendarTitle.text(mode: "year", visibleMonth: nil, visibleYear: nil, selectedDay: selected, calendar: calendar) == "2026")
    }

    @Test
    func monthCellsShowTitlesOnlyBelowTheAccessibilitySizes() {
        #expect(MonthCellStyle.showsTitles(isAccessibilitySize: false))
        #expect(!MonthCellStyle.showsTitles(isAccessibilitySize: true))
        #expect(MonthCellStyle.dotLimit == 3)
    }

    // MARK: - Event when lines

    @Test
    func theWhenRowsSplitTheDayAndTheTime() {
        let start = date(2026, 10, 16, 11)
        let end = date(2026, 10, 16, 12)
        let timed = EventWhen.lines(start: start, end: end, allDay: false, calendar: calendar)
        #expect(timed.day == start.formatted(date: .complete, time: .omitted))
        #expect(timed.time?.contains("–") == true)
        #expect(timed.day.contains("·") == false)

        let allDay = EventWhen.lines(start: date(2026, 10, 16), end: date(2026, 10, 17), allDay: true, calendar: calendar)
        #expect(allDay.time == "All day")
        #expect(allDay.day == date(2026, 10, 16).formatted(date: .complete, time: .omitted))

        let span = EventWhen.lines(start: date(2026, 10, 16), end: date(2026, 10, 19), allDay: true, calendar: calendar)
        #expect(span.time == "All day")
        #expect(span.day.contains("–"))

        let missing = EventWhen.lines(start: nil, end: nil, allDay: false, calendar: calendar)
        #expect(missing.day == "Time unavailable")
        #expect(missing.time == nil)
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

    // MARK: - Identity

    @Test
    func entityKeysCannotCollideAcrossTheIdAndAccountBoundary() {
        #expect(CalendarGrid.entityKey(id: "ab", accountID: "c") != CalendarGrid.entityKey(id: "a", accountID: "bc"))
        #expect(CalendarGrid.entityKey(id: "ab", accountID: "c") == CalendarGrid.entityKey(id: "ab", accountID: "c"))
        let placed = TimelineLayout.place([event("ab", from: date(2026, 7, 6, 9), to: date(2026, 7, 6, 10))], on: date(2026, 7, 6), calendar: calendar)
        #expect(placed.first?.id == CalendarGrid.entityKey(id: "ab", accountID: "acct"))
        let chips = DayChips.make(events: [event("ab", from: date(2026, 7, 6), to: date(2026, 7, 7), allDay: true)], tasks: [], limit: 3)
        #expect(chips.chips.first?.id == CalendarGrid.entityKey(id: "ab", accountID: "acct"))
    }

    // MARK: - Daylight-saving days

    @Test
    func theShortMarchDayPlacesEventsOnTheirWallClockHour() {
        // 8 March 2026 in New York has 23 hours: 02:00 jumps to 03:00.
        let day = date(2026, 3, 8)
        let late = TimelineLayout.place([event("late", from: date(2026, 3, 8, 23), to: date(2026, 3, 8, 23, 30))], on: day, calendar: calendar)
        #expect(late.first?.startMinutes == 23 * 60)
        #expect(late.first?.endMinutes == 23 * 60 + 30)
        // Elapsed minutes would have said 22:00; the wall clock says 23:00.
        #expect(TimelineLayout.wallClockMinutes(of: date(2026, 3, 8, 23), on: day, calendar: calendar) == 1380)
        // An event across the gap keeps its wall-clock span.
        let across = TimelineLayout.place([event("gap", from: date(2026, 3, 8, 1, 30), to: date(2026, 3, 8, 3, 30))], on: day, calendar: calendar)
        #expect(across.first?.startMinutes == 90)
        #expect(across.first?.endMinutes == 210)
    }

    @Test
    func theLongNovemberDayKeepsLateEventsInsideTheAxis() {
        // 1 November 2026 in New York has 25 hours: 02:00 falls back to 01:00.
        let day = date(2026, 11, 1)
        let late = TimelineLayout.place([event("late", from: date(2026, 11, 1, 23), to: date(2026, 11, 2, 0))], on: day, calendar: calendar)
        #expect(late.first?.startMinutes == 23 * 60)
        #expect(late.first?.endMinutes == TimelineLayout.minutesPerDay)
        // Midnight of the next day is the axis end, not an hour past it.
        #expect(TimelineLayout.wallClockMinutes(of: date(2026, 11, 2), on: day, calendar: calendar) == TimelineLayout.minutesPerDay)
        // Moments before the day clamp to its start.
        #expect(TimelineLayout.wallClockMinutes(of: date(2026, 10, 31, 23), on: day, calendar: calendar) == 0)
    }

    // MARK: - Day index

    private func task(_ id: String, due: Date?) -> TaskSummary {
        TaskSummary(id: id, title: "Task \(id)", column: "Tasks", due: due, completed: false, order: 0)
    }

    @Test
    func theDayIndexBucketsEveryDayAnEntryTouches() {
        let events = [
            event("one", from: date(2026, 7, 6, 9), to: date(2026, 7, 6, 10)),
            event("span", from: date(2026, 7, 6, 22), to: date(2026, 7, 8, 2)),
            event("whole", from: date(2026, 7, 7), to: date(2026, 7, 8), allDay: true),
            event("ends-at-midnight", from: date(2026, 7, 9, 23), to: date(2026, 7, 10)),
        ]
        let tasks = [task("t1", due: date(2026, 7, 7, 15)), task("none", due: nil)]
        let index = CalendarDayIndex(events: events, tasks: tasks, calendar: calendar, revision: 3)

        #expect(index.timed(on: date(2026, 7, 6)).map(\.id) == ["one", "span"])
        #expect(index.timed(on: date(2026, 7, 7)).map(\.id) == ["span"])
        #expect(index.timed(on: date(2026, 7, 8)).map(\.id) == ["span"])
        #expect(index.allDay(on: date(2026, 7, 7)).map(\.id) == ["whole"])
        #expect(index.allDay(on: date(2026, 7, 8)).isEmpty)
        // All-day entries lead when a day is asked for everything.
        #expect(index.events(on: date(2026, 7, 7)).map(\.id) == ["whole", "span"])
        // An event ending exactly at midnight belongs to the day it started.
        #expect(index.timed(on: date(2026, 7, 10)).isEmpty)
        #expect(index.tasks(on: date(2026, 7, 7)).map(\.id) == ["t1"])
        #expect(index.tasks(on: date(2026, 7, 6)).isEmpty)
        #expect(index.hasEntries(on: date(2026, 7, 8)))
        #expect(!index.hasEntries(on: date(2026, 7, 11)))
        // Any moment of the day resolves to the same bucket.
        #expect(index.timed(on: date(2026, 7, 6, 17, 45)).map(\.id) == ["one", "span"])
    }

    @Test
    func theDayIndexCapsARunawaySpanAndCarriesItsRevision() {
        let runaway = event("forever", from: date(2026, 1, 1), to: date(2030, 1, 1))
        let days = CalendarDayIndex.days(touchedBy: runaway, calendar: calendar)
        #expect(days.count == CalendarDayIndex.maximumSpanDays)
        let a = CalendarDayIndex(events: [], tasks: [], calendar: calendar, revision: 1)
        let b = CalendarDayIndex(events: [runaway], tasks: [], calendar: calendar, revision: 1)
        let c = CalendarDayIndex(events: [], tasks: [], calendar: calendar, revision: 2)
        #expect(a == b)
        #expect(a != c)
    }

    #if os(macOS)
    @Test
    func theMacMonthGridReportsTheMonthUnderAnOffset() {
        let months = [date(2026, 6, 1), date(2026, 7, 1), date(2026, 8, 1)]
        let june = MacMonthGridView.sectionHeight(
            weeks: CalendarGrid.weeks(ofMonthContaining: months[0], calendar: calendar).count
        )
        #expect(MacMonthGridView.month(atOffset: 0, months: months, calendar: calendar) == months[0])
        #expect(MacMonthGridView.month(atOffset: june - 1, months: months, calendar: calendar) == months[0])
        #expect(
            MacMonthGridView.month(atOffset: june + MacMonthGridView.monthSpacing + 1, months: months, calendar: calendar)
                == months[1]
        )
        #expect(MacMonthGridView.month(atOffset: 100_000, months: months, calendar: calendar) == months[2])
    }
    #endif

    @Test
    func theColourKeyChangesWhenACalendarChangesColour() {
        #expect(CalendarColors.key(["cal-a": "#ff0000"]) != CalendarColors.key(["cal-a": "#00ff00"]))
        #expect(CalendarColors.key(["cal-b": "#111111", "cal-a": "#222222"]) == "cal-a=#222222,cal-b=#111111")
        #expect(CalendarColors.key([:]).isEmpty)
    }
}
