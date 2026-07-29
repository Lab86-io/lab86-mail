import HorizonCalendar
import SwiftUI

// Month view backed by Airbnb's HorizonCalendar, shaped after Apple Calendar's
// month: one continuous vertical scroll rather than paged months, the weekday
// header pinned to the top, a display-face month title, hairline week rules
// with the week number in the left rail, and day cells carrying the day's
// actual entries instead of anonymous dots.
struct HorizonMonthView: View {
    @Environment(AppEnvironment.self) private var environment
    let events: [CalendarEventSummary]
    let tasks: [TaskSummary]
    let selectedDay: Date
    let onSelectDay: (Date) -> Void
    // The title belongs to the month under the reader's eye, which changes as
    // the scroll moves rather than when a day is picked.
    let onVisibleMonthChange: (Date) -> Void
    // Bumped only by the Today button. Scrolling on any selection change would
    // also fire while this view is being torn down for the day view.
    let todayToken: Int

    @StateObject private var proxy = CalendarViewProxy()
    @State private var reportedMonth: Date?

    // Room for the day number and three entries; taller than wide, unlike the
    // square cells a dot grid needs.
    private static let dayAspectRatio: CGFloat = 1.42
    private static let weekRail: CGFloat = 22
    private static let chipLimit = 3
    // The gap the week rule is drawn down the middle of.
    private static let rowGap: CGFloat = 7

    private var calendar: Calendar { .autoupdatingCurrent }

    var body: some View {
        CalendarViewRepresentable(
            calendar: calendar,
            visibleDateRange: visibleRange,
            monthsLayout: .vertical(
                options: VerticalMonthsLayoutOptions(
                    pinDaysOfWeekToTop: true,
                    alwaysShowCompleteBoundaryMonths: true
                )
            ),
            dataDependency: dataDependency,
            proxy: proxy
        )
        .backgroundColor(.clear)
        .days { dayCell(for: $0) }
        .monthHeaders { monthHeader(for: $0) }
        .dayOfWeekHeaders { _, index in weekdayHeader(index) }
        .monthBackgrounds { weekRules(in: $0) }
        .onDaySelection { day in
            if let date = calendar.date(from: day.components) {
                onSelectDay(calendar.startOfDay(for: date))
            }
        }
        .onScroll { visibleDayRange, _ in
            reportVisibleMonth(in: visibleDayRange)
        }
        .dayAspectRatio(Self.dayAspectRatio)
        // HorizonCalendar asserts this is within 0.5...3; anything shorter
        // traps in a debug build rather than simply laying out tightly.
        .dayOfWeekAspectRatio(0.5)
        .interMonthSpacing(16)
        .monthDayInsets(
            NSDirectionalEdgeInsets(top: 6, leading: Self.weekRail, bottom: 10, trailing: 8)
        )
        .verticalDayMargin(Self.rowGap)
        .horizontalDayMargin(0)
        // HorizonCalendar opens on the first month of its range, which left the
        // view two years behind the day the user was looking at.
        .onAppear {
            proxy.scrollToDay(
                containing: selectedDay,
                // Centred rather than pinned to the top: the weeks either side
                // are the context that makes a month worth opening.
                scrollPosition: .centered,
                animated: false
            )
        }
        .onChange(of: todayToken) {
            proxy.scrollToDay(
                containing: .now,
                scrollPosition: .centered,
                animated: true
            )
        }
    }

    private var visibleRange: ClosedRange<Date> {
        let today = calendar.startOfDay(for: .now)
        let lower = calendar.date(byAdding: .month, value: -24, to: today) ?? today
        let upper = calendar.date(byAdding: .month, value: 24, to: today) ?? today
        return lower...upper
    }

    // The calendar lazily calls the item providers outside SwiftUI's update
    // loop, so everything they read has to be declared as a dependency.
    private var dataDependency: AnyHashable {
        AnyHashable([
            AnyHashable(events),
            AnyHashable(tasks),
            AnyHashable(selectedDay),
            AnyHashable(environment.theme.accentHue),
            AnyHashable(environment.theme.accentChroma),
        ])
    }

    // MARK: - Month header

    @ViewBuilder private func monthHeader(for month: MonthComponents) -> some View {
        let date = calendar.date(from: DateComponents(year: month.year, month: month.month, day: 1))
        HStack(spacing: 8) {
            Text(title(for: month))
                .font(environment.theme.displayType.displayFont(size: 30, weight: .bold))
                .foregroundStyle(
                    date.map { calendar.isDate($0, equalTo: .now, toGranularity: .month) } ?? false
                        ? environment.theme.accentColor
                        : Color.primary
                )
            Spacer(minLength: 0)
        }
        .padding(.leading, Self.weekRail)
        .padding(.trailing, 8)
        .padding(.top, 20)
        .padding(.bottom, 4)
        .accessibilityAddTraits(.isHeader)
    }

    // The year is stated only when it is not the year in view elsewhere, the
    // way a diary drops the year until it changes.
    private func title(for month: MonthComponents) -> String {
        guard let date = calendar.date(from: DateComponents(year: month.year, month: month.month, day: 1)) else {
            return ""
        }
        if calendar.component(.year, from: date) == calendar.component(.year, from: .now) {
            return date.formatted(.dateTime.month(.wide))
        }
        return date.formatted(.dateTime.month(.wide).year())
    }

    // The pinned row floats over the scrolling months, so each cell carries an
    // opaque field that bleeds past its own column — otherwise day numbers show
    // through the week rail and the trailing inset as they pass underneath.
    private func weekdayHeader(_ index: Int) -> some View {
        let initials = CalendarGrid.weekdayInitials(calendar: calendar)
        return Text(index < initials.count ? initials[index] : "")
            .font(.caption2.weight(.medium))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background {
                Color(uiColor: .systemBackground)
                    .padding(.horizontal, -Self.weekRail - 8)
                    .padding(.bottom, -2)
            }
            .accessibilityHidden(true)
    }

    // MARK: - Day cell

    @ViewBuilder private func dayCell(for day: DayComponents) -> some View {
        let date = calendar.date(from: day.components).map { calendar.startOfDay(for: $0) }
        let isToday = date.map { calendar.isDateInToday($0) } ?? false
        let isSelected = date.map { calendar.isDate($0, inSameDayAs: selectedDay) } ?? false
        let dayEvents = date.map(events(on:)) ?? []
        let dayTasks = date.map(tasks(on:)) ?? []
        let content = DayChips.make(events: dayEvents, tasks: dayTasks, limit: Self.chipLimit)

        VStack(spacing: 2) {
            Text("\(day.day)")
                .font(.system(size: 15, weight: isToday ? .semibold : .regular))
                .foregroundStyle(numberColor(isToday: isToday))
                .frame(width: 26, height: 26)
                .background {
                    if isToday {
                        Circle().fill(environment.theme.accentColor)
                    } else if isSelected {
                        Circle().fill(environment.theme.accentSoftColor)
                    }
                }
            VStack(spacing: 1) {
                ForEach(content.chips) { chip in
                    chipView(chip)
                }
                if content.overflow > 0 {
                    Text("+\(content.overflow)")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                }
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.horizontal, 1)
        .contentShape(.rect)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel(day: day, date: date, entries: dayEvents.count + dayTasks.count))
        .accessibilityAddTraits(.isButton)
    }

    private func numberColor(isToday: Bool) -> Color {
        isToday ? Color(uiColor: .systemBackground) : .primary
    }

    private func chipView(_ chip: DayChips.Chip) -> some View {
        let tint = chip.kind == .task
            ? environment.theme.accentColor
            : environment.theme.avatarColor(seed: chip.seed)
        return Text(chip.title)
            .font(.system(size: 9, weight: .medium))
            .lineLimit(1)
            .truncationMode(.tail)
            .foregroundStyle(.primary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 3)
            .padding(.vertical, 1)
            .background(tint.opacity(0.2), in: RoundedRectangle(cornerRadius: 3, style: .continuous))
    }

    private func accessibilityLabel(day: DayComponents, date: Date?, entries: Int) -> String {
        guard let date else { return "\(day.day)" }
        let stamp = date.formatted(date: .long, time: .omitted)
        if entries == 0 { return "\(stamp), nothing scheduled" }
        return "\(stamp), \(entries) entr\(entries == 1 ? "y" : "ies")"
    }

    // MARK: - Week rules

    private struct WeekRule: Identifiable {
        let y: CGFloat
        let week: Int
        var id: CGFloat { y }
    }

    // Apple rules each week off and numbers it in the margin. The frames come
    // from the month's own layout, so the rules stay put when the cell height
    // or the insets change.
    @ViewBuilder private func weekRules(in context: MonthLayoutContext) -> some View {
        let rules = weekRules(for: context)
        ZStack(alignment: .topLeading) {
            Color.clear
            ForEach(rules) { rule in
                Rectangle()
                    .fill(environment.theme.hairlineColor)
                    .frame(width: max(0, context.bounds.width - Self.weekRail), height: 0.5)
                    .offset(x: Self.weekRail, y: rule.y - Self.rowGap / 2)
                Text("\(rule.week)")
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
                    .frame(width: Self.weekRail - 5, alignment: .trailing)
                    .offset(x: 0, y: rule.y - Self.rowGap / 2 + 1)
            }
        }
        .frame(width: context.bounds.width, height: context.bounds.height, alignment: .topLeading)
        .accessibilityHidden(true)
    }

    private func weekRules(for context: MonthLayoutContext) -> [WeekRule] {
        var seen = Set<Int>()
        var rules: [WeekRule] = []
        for (day, frame) in context.daysAndFrames {
            let key = Int(frame.minY.rounded())
            guard !seen.contains(key) else { continue }
            seen.insert(key)
            guard let date = calendar.date(from: day.components) else { continue }
            rules.append(WeekRule(y: frame.minY, week: calendar.component(.weekOfYear, from: date)))
        }
        return rules
    }

    // MARK: - Data

    private func events(on day: Date) -> [CalendarEventSummary] {
        guard let end = calendar.date(byAdding: .day, value: 1, to: day) else { return [] }
        return events.filter { $0.start < end && $0.end > day }
    }

    private func tasks(on day: Date) -> [TaskSummary] {
        tasks.filter { task in
            guard let due = task.due else { return false }
            return calendar.isDate(due, inSameDayAs: day)
        }
    }

    private func reportVisibleMonth(in range: ClosedRange<DayComponents>) {
        // The month the reader is actually in is the one under the middle of
        // the viewport, not the sliver of the previous month at its top edge.
        let lower = range.lowerBound.components
        let upper = range.upperBound.components
        guard let first = calendar.date(from: lower), let last = calendar.date(from: upper) else { return }
        let middle = first.addingTimeInterval(last.timeIntervalSince(first) / 2)
        guard let month = calendar.dateInterval(of: .month, for: middle)?.start else { return }
        guard reportedMonth != month else { return }
        reportedMonth = month
        onVisibleMonthChange(month)
    }
}
