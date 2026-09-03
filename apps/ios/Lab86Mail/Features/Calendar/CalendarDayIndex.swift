import Foundation

// The calendar's data, bucketed by day once instead of filtered per cell.
//
// Every grid used to scan the whole event array for each day it drew — seven
// days per pass in the week view, forty-two cells in the month — and SwiftUI
// re-evaluated those scans on every geometry change. One index built when the
// data changes answers each day in constant time, and its revision is a cheap
// identity for views that need to know the data moved without rehashing it.
struct CalendarDayIndex: Equatable, Sendable {
    let revision: Int
    private let timedByDay: [Date: [CalendarEventSummary]]
    private let allDayByDay: [Date: [CalendarEventSummary]]
    private let tasksByDay: [Date: [TaskSummary]]
    private let calendar: Calendar

    // A multi-day entry lands on every day it touches; this caps a malformed
    // provider range so one bad event cannot spin the index for years.
    static let maximumSpanDays = 400

    static let empty = CalendarDayIndex(events: [], tasks: [], calendar: .autoupdatingCurrent, revision: 0)

    init(events: [CalendarEventSummary], tasks: [TaskSummary], calendar: Calendar, revision: Int) {
        var timed: [Date: [CalendarEventSummary]] = [:]
        var allDay: [Date: [CalendarEventSummary]] = [:]
        for event in events {
            for day in Self.days(touchedBy: event, calendar: calendar) {
                if event.allDay {
                    allDay[day, default: []].append(event)
                } else {
                    timed[day, default: []].append(event)
                }
            }
        }
        var dueTasks: [Date: [TaskSummary]] = [:]
        for task in tasks {
            guard let due = task.due else { continue }
            dueTasks[calendar.startOfDay(for: due), default: []].append(task)
        }
        self.timedByDay = timed
        self.allDayByDay = allDay
        self.tasksByDay = dueTasks
        self.calendar = calendar
        self.revision = revision
    }

    // The same test the per-view filters applied: overlap with [day, day+1).
    static func days(touchedBy event: CalendarEventSummary, calendar: Calendar) -> [Date] {
        var day = calendar.startOfDay(for: event.start)
        var days: [Date] = [day]
        while days.count < maximumSpanDays,
              let next = calendar.date(byAdding: .day, value: 1, to: day),
              next < event.end {
            days.append(next)
            day = next
        }
        return days
    }

    func timed(on day: Date) -> [CalendarEventSummary] {
        timedByDay[calendar.startOfDay(for: day)] ?? []
    }

    func allDay(on day: Date) -> [CalendarEventSummary] {
        allDayByDay[calendar.startOfDay(for: day)] ?? []
    }

    // All-day entries first, as the month chips expect.
    func events(on day: Date) -> [CalendarEventSummary] {
        allDay(on: day) + timed(on: day)
    }

    func tasks(on day: Date) -> [TaskSummary] {
        tasksByDay[calendar.startOfDay(for: day)] ?? []
    }

    func hasEntries(on day: Date) -> Bool {
        let key = calendar.startOfDay(for: day)
        return !(timedByDay[key]?.isEmpty ?? true)
            || !(allDayByDay[key]?.isEmpty ?? true)
            || !(tasksByDay[key]?.isEmpty ?? true)
    }

    static func == (lhs: CalendarDayIndex, rhs: CalendarDayIndex) -> Bool {
        lhs.revision == rhs.revision
    }
}
