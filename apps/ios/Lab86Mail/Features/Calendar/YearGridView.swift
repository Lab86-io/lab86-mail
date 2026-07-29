import SwiftUI

// Year view after Apple Calendar's: years run continuously under one scroll
// rather than being stepped through with chevrons, each headed by its own
// numeral and laid out three months to a row. Tapping a month opens it.
struct YearGridView: View {
    @Environment(AppEnvironment.self) private var environment
    let anchor: Date
    let onSelectMonth: (Date) -> Void
    // The title follows the year under the reader's eye.
    let onVisibleYearChange: (Int) -> Void
    // Bumped only by the Today button; the anchor alone would also move when a
    // month is opened from here.
    let todayToken: Int

    @State private var scrolledYear: Int?

    private static let span = 6

    private var calendar: Calendar { .autoupdatingCurrent }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(years, id: \.self) { year in
                    yearSection(year)
                        .id(year)
                }
            }
            .scrollTargetLayout()
        }
        .scrollPosition(id: $scrolledYear, anchor: .top)
        .onAppear {
            if scrolledYear == nil { scrolledYear = calendar.component(.year, from: anchor) }
        }
        .onChange(of: scrolledYear) { _, year in
            if let year { onVisibleYearChange(year) }
        }
        .onChange(of: todayToken) {
            withAnimation { scrolledYear = calendar.component(.year, from: .now) }
        }
    }

    private var years: [Int] {
        let current = calendar.component(.year, from: anchor)
        return Array((current - Self.span)...(current + Self.span))
    }

    @ViewBuilder private func yearSection(_ year: Int) -> some View {
        let isCurrent = year == calendar.component(.year, from: .now)
        VStack(spacing: 16) {
            Text(String(year))
                .font(environment.theme.displayType.displayFont(size: 30, weight: .bold))
                .foregroundStyle(isCurrent ? environment.theme.accentColor : .primary)
                .frame(maxWidth: .infinity)
                .accessibilityAddTraits(.isHeader)
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 16), count: 3),
                spacing: 22
            ) {
                ForEach(1...12, id: \.self) { month in
                    if let start = calendar.date(from: DateComponents(year: year, month: month, day: 1)) {
                        MiniMonthView(monthStart: start) { onSelectMonth(start) }
                    }
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 24)
        .padding(.bottom, 30)
    }
}

// MARK: - Mini month

// One month at a glance: name, then a plain seven-column numeral grid with no
// weekday header — the density Apple's year view uses.
struct MiniMonthView: View {
    @Environment(AppEnvironment.self) private var environment
    let monthStart: Date
    let onOpen: () -> Void

    private var calendar: Calendar { .autoupdatingCurrent }

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 6) {
                Text(monthStart.formatted(.dateTime.month(.abbreviated)))
                    .font(environment.theme.displayType.displayFont(size: 16, weight: .bold))
                    .foregroundStyle(isCurrentMonth ? environment.theme.accentColor : .primary)
                grid
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(monthStart.formatted(.dateTime.month(.wide).year()))
    }

    // Rows come from one matrix of optional day numbers, so a blank slot can
    // never share an identity with a day and get dropped.
    private var grid: some View {
        VStack(spacing: 2) {
            ForEach(Array(weeks.enumerated()), id: \.offset) { _, week in
                HStack(spacing: 1) {
                    ForEach(Array(week.enumerated()), id: \.offset) { _, day in
                        cell(day)
                    }
                }
            }
        }
    }

    // Both kinds of slot carry a definite height. A blank left free to grow
    // vertically would set the row's height from the space around it rather
    // than from the numerals in it.
    private static let cellHeight: CGFloat = 14

    @ViewBuilder private func cell(_ day: Int?) -> some View {
        if let day {
            Text("\(day)")
                .font(.system(size: 9.5))
                .monospacedDigit()
                .foregroundStyle(isToday(day) ? Color(uiColor: .systemBackground) : .primary)
                .frame(maxWidth: .infinity, minHeight: Self.cellHeight, maxHeight: Self.cellHeight)
                .background {
                    if isToday(day) {
                        Circle()
                            .fill(environment.theme.accentColor)
                            .frame(width: Self.cellHeight, height: Self.cellHeight)
                    }
                }
        } else {
            Color.clear.frame(maxWidth: .infinity, minHeight: Self.cellHeight, maxHeight: Self.cellHeight)
        }
    }

    private var weeks: [[Int?]] {
        CalendarGrid.weeks(ofMonthContaining: monthStart, calendar: calendar)
    }

    private var isCurrentMonth: Bool {
        calendar.isDate(monthStart, equalTo: .now, toGranularity: .month)
    }

    private func isToday(_ day: Int) -> Bool {
        guard let date = calendar.date(byAdding: .day, value: day - 1, to: monthStart) else { return false }
        return calendar.isDateInToday(date)
    }
}
