#if canImport(HorizonCalendar)
import HorizonCalendar
import SwiftUI

// Month view backed by Airbnb's HorizonCalendar, shaped after Apple Calendar's
// month: one continuous vertical scroll rather than paged months, the weekday
// header pinned to the top, a display-face month title, hairline week rules
// with the week number in the left rail, and day cells carrying the day's
// actual entries in their calendar's colour instead of anonymous dots. At
// accessibility text sizes the entries become dots, because a cell cannot
// hold titles at that size.
struct HorizonMonthView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .footnote) private var numeralSide: CGFloat = 24
    @ScaledMetric(relativeTo: .footnote) private var numeralFontSize: CGFloat = 13
    @ScaledMetric(relativeTo: .title) private var headingSize: CGFloat = 28
    let index: CalendarDayIndex
    let colors: CalendarColors
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
    private static let trailingInset: CGFloat = 8
    private static let chipLimit = 3
    // The gap the week rule is drawn down the middle of.
    private static let rowGap: CGFloat = 7

    private var calendar: Calendar { .autoupdatingCurrent }
    private var showsTitles: Bool {
        MonthCellStyle.showsTitles(isAccessibilitySize: dynamicTypeSize.isAccessibilitySize)
    }
    // The week-number rail needs room the large text sizes do not have.
    private var weekRail: CGFloat { showsTitles ? Self.weekRail : 8 }

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
        // traps in a debug build rather than simply laying out tightly. The
        // row is taller at accessibility sizes so one large letter fits.
        .dayOfWeekAspectRatio(showsTitles ? 0.5 : 1)
        .interMonthSpacing(16)
        .monthDayInsets(
            NSDirectionalEdgeInsets(top: 6, leading: weekRail, bottom: 10, trailing: Self.trailingInset)
        )
        .verticalDayMargin(Self.rowGap)
        .horizontalDayMargin(0)
        // HorizonCalendar opens on the first month of its range, which left the
        // view two years behind the day the user was looking at. The month
        // opens with its heading at the top, so the first month on screen is
        // always named (D17).
        .onAppear {
            proxy.scrollToMonth(
                containing: selectedDay,
                scrollPosition: .firstFullyVisiblePosition(padding: 0),
                animated: false
            )
        }
        .onChange(of: todayToken) {
            proxy.scrollToMonth(
                containing: .now,
                scrollPosition: .firstFullyVisiblePosition(padding: 0),
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
            // The index's revision stands in for the arrays: it changes
            // exactly when they do, without rehashing every entry.
            AnyHashable(index.revision),
            AnyHashable(selectedDay),
            AnyHashable(environment.theme.accentHue),
            AnyHashable(environment.theme.accentChroma),
            AnyHashable(colors.key),
            AnyHashable(showsTitles),
        ])
    }

    // MARK: - Month header

    @ViewBuilder private func monthHeader(for month: MonthComponents) -> some View {
        let date = calendar.date(from: DateComponents(year: month.year, month: month.month, day: 1))
        HStack(spacing: 8) {
            Text(title(for: month))
                .font(environment.theme.displayType.displayFont(size: min(headingSize, 36), weight: .bold))
                .foregroundStyle(
                    date.map { calendar.isDate($0, equalTo: .now, toGranularity: .month) } ?? false
                        ? environment.theme.accentColor
                        : Color.primary
                )
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Spacer(minLength: 0)
        }
        .padding(.leading, weekRail)
        .padding(.trailing, Self.trailingInset)
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

    // The pinned row floats over the scrolling months, so it needs an opaque
    // field. Each cell covers only its own column; the first and the last
    // also cover the rail and the inset beside them. A field that bled past
    // every cell covered the letters of the neighbours (D10).
    private func weekdayHeader(_ index: Int) -> some View {
        let initials = CalendarGrid.weekdayInitials(calendar: calendar)
        return Text(index < initials.count ? initials[index] : "")
            .font(.caption2.weight(.medium))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background {
                environment.theme.paperColor
                    .padding(.leading, index == 0 ? -weekRail : 0)
                    .padding(.trailing, index == 6 ? -Self.trailingInset : 0)
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
        let content = DayChips.make(
            events: dayEvents,
            tasks: dayTasks,
            limit: showsTitles ? Self.chipLimit : MonthCellStyle.dotLimit
        )

        VStack(spacing: 2) {
            numeral("\(day.day)", isToday: isToday, isSelected: isSelected)
            if showsTitles {
                chipStack(content)
            } else {
                dotRow(content.chips)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.horizontal, 1)
        .contentShape(.rect)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel(day: day, date: date, entries: dayEvents.count + dayTasks.count))
        // The day view's heading marks selection; without it here VoiceOver
        // cannot tell the selected day in the month grid from any other.
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }

    // The day number scales with the text. Below the accessibility sizes it
    // sits in a circle; above them the circle goes and today is a bar.
    @ViewBuilder private func numeral(_ text: String, isToday: Bool, isSelected: Bool) -> some View {
        if showsTitles {
            let side = min(numeralSide, 30)
            Text(text)
                .font(.footnote.weight(isToday ? .semibold : .regular))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .foregroundStyle(isToday ? environment.theme.paperColor : .primary)
                .frame(width: side, height: side)
                .background {
                    if isToday {
                        Circle().fill(environment.theme.accentColor)
                    } else if isSelected {
                        Circle().fill(environment.theme.accentSoftColor)
                    }
                }
        } else {
            Text(text)
                .font(.system(size: min(numeralFontSize, 22), weight: isToday ? .semibold : .regular))
                .monospacedDigit()
                .lineLimit(1)
                .foregroundStyle(isToday ? environment.theme.accentColor : .primary)
                .padding(.horizontal, 3)
                .background {
                    if isSelected {
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(environment.theme.accentSoftColor)
                    }
                }
                .overlay(alignment: .bottom) {
                    if isToday {
                        Capsule().fill(environment.theme.accentColor).frame(height: 2)
                    }
                }
        }
    }

    private func chipStack(_ content: (chips: [DayChips.Chip], overflow: Int)) -> some View {
        VStack(spacing: 1) {
            ForEach(content.chips) { chip in
                chipView(chip)
            }
            if content.overflow > 0 {
                Text("+\(content.overflow)")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity)
            }
            Spacer(minLength: 0)
        }
    }

    private func dotRow(_ chips: [DayChips.Chip]) -> some View {
        HStack(spacing: 3) {
            ForEach(chips) { chip in
                Circle()
                    .fill(colors.color(for: chip))
                    .frame(width: 5, height: 5)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func chipView(_ chip: DayChips.Chip) -> some View {
        Text(chip.title)
            .font(.caption2.weight(.medium))
            .lineLimit(1)
            .truncationMode(.tail)
            .foregroundStyle(.primary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 5)
            .padding(.trailing, 2)
            .padding(.vertical, 1)
            .calendarBlock(tint: colors.color(for: chip), cornerRadius: 3, edge: 2)
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
    // or the insets change. The number goes when the rail is too narrow.
    @ViewBuilder private func weekRules(in context: MonthLayoutContext) -> some View {
        let rules = weekRules(for: context)
        ZStack(alignment: .topLeading) {
            Color.clear
            ForEach(rules) { rule in
                Rectangle()
                    .fill(environment.theme.hairlineColor)
                    .frame(width: max(0, context.bounds.width - weekRail), height: 0.5)
                    .offset(x: weekRail, y: rule.y - Self.rowGap / 2)
                if showsTitles {
                    Text("\(rule.week)")
                        .font(.caption2)
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                        .frame(width: weekRail - 5, alignment: .trailing)
                        .offset(x: 0, y: rule.y - Self.rowGap / 2 + 1)
                }
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
        index.events(on: day)
    }

    private func tasks(on day: Date) -> [TaskSummary] {
        index.tasks(on: day)
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
#endif
