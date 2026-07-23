import HorizonCalendar
import SwiftUI

// Month view backed by Airbnb's HorizonCalendar — horizontally paged months
// with our accent day cells and event dots; tapping a day drops into the
// day timeline.
struct HorizonMonthView: View {
    @Environment(AppEnvironment.self) private var environment
    let events: [CalendarEventSummary]
    let tasks: [TaskSummary]
    let selectedDay: Date
    let onSelectDay: (Date) -> Void

    private var calendar: Calendar { .autoupdatingCurrent }

    var body: some View {
        let today = calendar.startOfDay(for: .now)
        let lower = calendar.date(byAdding: .month, value: -12, to: today) ?? today
        let upper = calendar.date(byAdding: .month, value: 12, to: today) ?? today

        CalendarViewRepresentable(
            calendar: calendar,
            visibleDateRange: lower...upper,
            monthsLayout: .horizontal(options: HorizontalMonthsLayoutOptions()),
            dataDependency: events
        )
        .days { day in
            dayCell(for: day)
        }
        .onDaySelection { day in
            if let date = calendar.date(from: day.components) {
                onSelectDay(calendar.startOfDay(for: date))
            }
        }
        .interMonthSpacing(20)
        .verticalDayMargin(6)
        .horizontalDayMargin(2)
    }

    @ViewBuilder private func dayCell(for day: DayComponents) -> some View {
        let date = calendar.date(from: day.components).map { calendar.startOfDay(for: $0) }
        let isToday = date.map { calendar.isDateInToday($0) } ?? false
        let eventCount = date.map(eventCount(on:)) ?? 0
        let taskCount = date.map(taskCount(on:)) ?? 0
        VStack(spacing: 3) {
            Text("\(day.day)")
                .font(.callout.weight(isToday ? .bold : .regular))
                .foregroundStyle(isToday ? Color(uiColor: .systemBackground) : .primary)
                .frame(width: 32, height: 32)
                .background {
                    if isToday {
                        Circle().fill(environment.theme.accentColor)
                    }
                }
            HStack(spacing: 2) {
                ForEach(0..<min(eventCount, 2), id: \.self) { _ in
                    Circle()
                        .fill(environment.theme.accent2Color)
                        .frame(width: 4, height: 4)
                }
                if taskCount > 0 {
                    RoundedRectangle(cornerRadius: 1)
                        .fill(environment.theme.accentColor)
                        .frame(width: 6, height: 4)
                }
            }
            .frame(height: 5)
        }
        .frame(maxWidth: .infinity)
        .contentShape(.rect)
        .accessibilityLabel(
            date.map {
                "\($0.formatted(date: .long, time: .omitted)), \(eventCount) event\(eventCount == 1 ? "" : "s"), \(taskCount) task\(taskCount == 1 ? "" : "s")"
            }
                ?? "\(day.day)"
        )
    }

    private func eventCount(on day: Date) -> Int {
        guard let end = calendar.date(byAdding: .day, value: 1, to: day) else { return 0 }
        return events.count { $0.start < end && $0.end > day }
    }

    private func taskCount(on day: Date) -> Int {
        tasks.count { task in
            guard let due = task.due else { return false }
            return calendar.isDate(due, inSameDayAs: day)
        }
    }
}
