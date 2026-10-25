import Foundation
import Testing
@testable import Lab86Mail

// The board's arithmetic: how columns share a wide window and page on a
// phone (D22), and what the quiet line under a card title says.
struct TasksBoardLayoutTests {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York") ?? .gmt
        return calendar
    }

    private func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 0, _ minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
    }

    // MARK: - Columns

    @Test
    func threeColumnsShareAnIPadDetailColumnWithoutPaging() {
        // The iPad landscape detail column beside the sidebar.
        let plan = BoardLayout.plan(available: 745, count: 3)
        #expect(plan.fits)
        #expect(plan.columnWidth == 229)
        // Three columns, two gaps, and the insets fit in the width.
        #expect(plan.columnWidth * 3 + plan.spacing * 2 + plan.inset * 2 <= 745)
    }

    @Test
    func aPhonePagesOneColumnWithTheNextPeeking() {
        let plan = BoardLayout.plan(available: 402, count: 3)
        #expect(!plan.fits)
        #expect(plan.columnWidth == 329)
        #expect(plan.columnWidth < 402)
    }

    @Test
    func aPagedColumnNeverGrowsPastItsLimit() {
        let plan = BoardLayout.plan(available: 600, count: 5)
        #expect(!plan.fits)
        #expect(plan.columnWidth == BoardLayout.maximumPagedWidth)
    }

    @Test
    func oneColumnFillsTheWidthItHas() {
        let plan = BoardLayout.plan(available: 402, count: 1)
        #expect(plan.fits)
        #expect(plan.columnWidth == 402 - BoardLayout.inset * 2)
    }

    @Test
    func noColumnsGiveAnEmptyPlan() {
        let plan = BoardLayout.plan(available: 402, count: 0)
        #expect(!plan.fits)
        #expect(plan.columnWidth == 0)
    }

    // MARK: - Card meta

    @Test
    func theMetaLineJoinsPriorityAndDueDateWithAComma() {
        let now = date(2026, 10, 16, 9)
        let line = TaskMeta.line(priority: "high", due: date(2026, 10, 18, 17), completed: false, now: now, calendar: calendar)
        #expect(line == TaskMeta.Line(text: "High priority, Oct 18", isOverdue: false))
        #expect(line?.text.contains("·") == false)
    }

    @Test
    func aCardWithNothingToSayHasNoMetaLine() {
        #expect(TaskMeta.line(priority: nil, due: nil, completed: false) == nil)
        #expect(TaskMeta.line(priority: "none", due: nil, completed: false) == nil)
        #expect(TaskMeta.line(priority: "", due: nil, completed: false) == nil)
    }

    @Test
    func onlyAnOpenCardPastItsDueDateIsOverdue() {
        let now = date(2026, 10, 16, 9)
        let past = date(2026, 10, 15, 17)
        #expect(TaskMeta.line(priority: nil, due: past, completed: false, now: now, calendar: calendar)?.isOverdue == true)
        #expect(TaskMeta.line(priority: nil, due: past, completed: true, now: now, calendar: calendar)?.isOverdue == false)
    }

    @Test
    func dueTextReadsTodayWithTheTimeAndTomorrowWithout() {
        let now = date(2026, 10, 16, 9)
        let today = TaskMeta.dueText(date(2026, 10, 16, 17), now: now, calendar: calendar)
        #expect(today.hasPrefix("Today, "))
        #expect(today.contains("5:00"))
        #expect(TaskMeta.dueText(date(2026, 10, 17, 12), now: now, calendar: calendar) == "Tomorrow")
        #expect(TaskMeta.dueText(date(2026, 10, 20, 12), now: now, calendar: calendar) == "Oct 20")
    }

    @Test
    func priorityWordsAreSentencesNotChips() {
        #expect(TaskMeta.priorityWord("high") == "High priority")
        #expect(TaskMeta.priorityWord("Medium") == "Medium priority")
        #expect(TaskMeta.priorityWord("low") == "Low priority")
        #expect(TaskMeta.priorityWord("urgent") == nil)
    }
}
