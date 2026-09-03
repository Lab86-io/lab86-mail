#if os(macOS)
import SwiftUI

// The Mac's month: a continuous vertical scroll of months in the shape of the
// iOS HorizonCalendar month (pinned weekday header, month title, hairline
// week rules, day cells carrying their entries), built on the same matrix and
// chip helpers so both platforms read the same way.
struct MacMonthGridView: View {
    @Environment(AppEnvironment.self) private var environment
    let index: CalendarDayIndex
    let selectedDay: Date
    let onSelectDay: (Date) -> Void
    let onOpenDay: (Date) -> Void
    // The title belongs to the month under the middle of the viewport.
    let onVisibleMonthChange: (Date) -> Void
    // Bumped only by the Today button.
    let todayToken: Int

    static let rowHeight: CGFloat = 96
    static let monthHeaderHeight: CGFloat = 52
    static let monthSpacing: CGFloat = 20
    private static let chipLimit = 3
    private static let monthsEitherSide = 12

    private var calendar: Calendar { .autoupdatingCurrent }

    private var currentMonth: Date {
        calendar.dateInterval(of: .month, for: .now)?.start ?? calendar.startOfDay(for: .now)
    }

    private var months: [Date] {
        (-Self.monthsEitherSide...Self.monthsEitherSide).compactMap {
            calendar.date(byAdding: .month, value: $0, to: currentMonth)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            weekdayHeader
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: Self.monthSpacing) {
                        ForEach(months, id: \.self) { month in
                            monthSection(month)
                                .id(month)
                        }
                    }
                    .padding(.bottom, 40)
                }
                .onScrollGeometryChange(for: CGFloat.self) { geometry in
                    geometry.contentOffset.y + geometry.containerSize.height / 2
                } action: { _, middle in
                    if let month = Self.month(atOffset: middle, months: months, calendar: calendar) {
                        onVisibleMonthChange(month)
                    }
                }
                .onAppear {
                    proxy.scrollTo(monthStart(of: selectedDay), anchor: .top)
                }
                .onChange(of: todayToken) {
                    withAnimation { proxy.scrollTo(currentMonth, anchor: .top) }
                }
            }
        }
    }

    // MARK: - Geometry shared with the tests

    static func sectionHeight(weeks: Int) -> CGFloat {
        monthHeaderHeight + CGFloat(weeks) * rowHeight
    }

    // Which month a content offset falls in, walking the same heights the
    // sections are laid out with.
    static func month(atOffset offset: CGFloat, months: [Date], calendar: Calendar) -> Date? {
        var y: CGFloat = 0
        for month in months {
            let weeks = CalendarGrid.weeks(ofMonthContaining: month, calendar: calendar).count
            let bottom = y + sectionHeight(weeks: weeks) + monthSpacing
            if offset < bottom { return month }
            y = bottom
        }
        return months.last
    }

    private func monthStart(of day: Date) -> Date {
        calendar.dateInterval(of: .month, for: day)?.start ?? day
    }

    // MARK: - Header

    private var weekdayHeader: some View {
        HStack(spacing: 0) {
            ForEach(Array(CalendarGrid.weekdayInitials(calendar: calendar).enumerated()), id: \.offset) { _, initial in
                Text(initial)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(.vertical, 6)
        .background(Color(uiColor: .systemBackground))
        .accessibilityHidden(true)
    }

    // MARK: - Month

    private func monthSection(_ month: Date) -> some View {
        let weeks = CalendarGrid.weeks(ofMonthContaining: month, calendar: calendar)
        let isCurrent = calendar.isDate(month, equalTo: .now, toGranularity: .month)
        return VStack(spacing: 0) {
            HStack {
                Text(title(for: month))
                    .font(environment.theme.displayType.displayFont(size: 26, weight: .bold))
                    .foregroundStyle(isCurrent ? environment.theme.accentColor : Color.primary)
                Spacer(minLength: 0)
            }
            // The header's height is exactly monthHeaderHeight and each week
            // row exactly rowHeight (its rule is drawn inside the row), so
            // `sectionHeight` and the offset model describe what is rendered.
            .frame(height: Self.monthHeaderHeight, alignment: .bottomLeading)
            .padding(.horizontal, 12)
            .accessibilityAddTraits(.isHeader)
            ForEach(Array(weeks.enumerated()), id: \.offset) { _, week in
                HStack(spacing: 0) {
                    ForEach(Array(week.enumerated()), id: \.offset) { _, day in
                        cell(day: day, in: month)
                    }
                }
                .frame(height: Self.rowHeight)
                .overlay(alignment: .top) {
                    Rectangle()
                        .fill(environment.theme.hairlineColor)
                        .frame(height: 0.5)
                        .accessibilityHidden(true)
                }
            }
        }
    }

    private func title(for month: Date) -> String {
        if calendar.component(.year, from: month) == calendar.component(.year, from: .now) {
            return month.formatted(.dateTime.month(.wide))
        }
        return month.formatted(.dateTime.month(.wide).year())
    }

    // MARK: - Day cell

    @ViewBuilder private func cell(day: Int?, in month: Date) -> some View {
        if let day, let date = calendar.date(byAdding: .day, value: day - 1, to: month) {
            let isToday = calendar.isDateInToday(date)
            let isSelected = calendar.isDate(date, inSameDayAs: selectedDay)
            let content = DayChips.make(
                events: index.events(on: date),
                tasks: index.tasks(on: date),
                limit: Self.chipLimit
            )
            VStack(spacing: 3) {
                Text("\(day)")
                    .font(.system(size: 13, weight: isToday ? .semibold : .regular))
                    .foregroundStyle(isToday ? Color(uiColor: .systemBackground) : .primary)
                    .frame(width: 24, height: 24)
                    .background {
                        if isToday {
                            Circle().fill(environment.theme.accentColor)
                        } else if isSelected {
                            Circle().fill(environment.theme.accentSoftColor)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                VStack(spacing: 1) {
                    ForEach(content.chips) { chip in
                        chipView(chip)
                    }
                    if content.overflow > 0 {
                        Text("+\(content.overflow)")
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Spacer(minLength: 0)
                }
            }
            .padding(4)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(isSelected && !isToday ? environment.theme.accentSoftColor.opacity(0.25) : Color.clear)
            .contentShape(.rect)
            // A double click opens the day; a single click only moves the
            // selection, so the month stays a scanning surface.
            .onTapGesture(count: 2) { onOpenDay(date) }
            .onTapGesture { onSelectDay(date) }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityLabel(for: date, entries: index.events(on: date).count + index.tasks(on: date).count))
            .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        } else {
            Color.clear
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func chipView(_ chip: DayChips.Chip) -> some View {
        let tint = chip.kind == .task
            ? environment.theme.accentColor
            : environment.theme.avatarColor(seed: chip.seed)
        return Text(chip.title)
            .font(.system(size: 10, weight: .medium))
            .lineLimit(1)
            .truncationMode(.tail)
            .foregroundStyle(.primary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(tint.opacity(0.2), in: RoundedRectangle(cornerRadius: 3, style: .continuous))
    }

    private func accessibilityLabel(for date: Date, entries: Int) -> String {
        let stamp = date.formatted(date: .long, time: .omitted)
        if entries == 0 { return "\(stamp), nothing scheduled" }
        return "\(stamp), \(entries) entr\(entries == 1 ? "y" : "ies")"
    }
}
#endif
