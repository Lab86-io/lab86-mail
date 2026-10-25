import SwiftUI

// Seven days over one hour axis. A block is a flat tint in its calendar's
// colour with a thin leading edge; its title shows only when the column
// holds it, one line cut at the end in a narrow column and never a word
// broken in the middle (D11). The text, the gutter, the chips, and the hour
// rows all scale with Dynamic Type together (D7).
struct WeekTimelineView: View {
    let weekStart: Date
    let index: CalendarDayIndex
    let selectedDay: Date
    let colors: CalendarColors
    let onOpen: (CalendarEventSummary) -> Void
    let onOpenTask: (TaskSummary) -> Void
    let onSelectDay: (Date) -> Void
    let onOpenDay: (Date) -> Void
    let onCreate: (Date) -> Void

    @Environment(AppEnvironment.self) private var environment
    @ScaledMetric(relativeTo: .caption2) private var textScale: CGFloat = 1
    @ScaledMetric(relativeTo: .caption2) private var blockTextSize: CGFloat = 11
    @State private var labelWidth: CGFloat = 30

    private static let baseHourHeight: CGFloat = 52
    private static let gutterPadding: CGFloat = 8
    private static let allDayChipLimit = 2

    private var calendar: Calendar { .autoupdatingCurrent }
    private var days: [Date] {
        (0..<7).compactMap { calendar.date(byAdding: .day, value: $0, to: weekStart) }
    }
    private var hourHeight: CGFloat { HourAxis.hourHeight(base: Self.baseHourHeight, textScale: textScale) }
    private var gutter: CGFloat { labelWidth + Self.gutterPadding }
    private var chipHeight: CGFloat { (blockTextSize * 1.22 + 4).rounded() }

    var body: some View {
        VStack(spacing: 0) {
            header
            if allDayRowCount > 0 {
                Divider()
                allDayLane
            }
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    grid
                        .padding(.top, 12 * textScale)
                        .padding(.bottom, 24)
                }
                .onAppear { proxy.scrollTo(scrollTarget, anchor: .top) }
                .onChange(of: weekStart) { proxy.scrollTo(scrollTarget, anchor: .top) }
            }
        }
        // Without this the pager centres a page that asked only for the height
        // of its content, and the timeline floats away from the header.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .overlay(alignment: .topLeading) {
            HourGutterMeasure(day: weekStart, labelWidth: $labelWidth)
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 0) {
            ForEach(days, id: \.self) { day in
                dayHeading(day)
            }
        }
        // The hour gutter is reserved with padding, not with a spacer view,
        // so the header keeps the height of its content.
        .padding(.leading, gutter)
        .padding(.bottom, 6)
    }

    private func dayHeading(_ day: Date) -> some View {
        let isToday = calendar.isDateInToday(day)
        let isSelected = calendar.isDate(day, inSameDayAs: selectedDay)
        return Button {
            // The first tap moves the week's selection; a tap on the day that
            // is already selected opens it.
            if isSelected { onOpenDay(day) } else { onSelectDay(day) }
        } label: {
            VStack(spacing: 3) {
                Text(day.formatted(.dateTime.weekday(.narrow)))
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                DayNumeral(
                    text: day.formatted(.dateTime.day()),
                    isToday: isToday,
                    isSelected: isSelected,
                    fillsSelection: false
                )
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 6)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(day.formatted(date: .complete, time: .omitted))
        .accessibilityHint(isSelected ? "Opens the day" : "Selects the day")
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }

    // MARK: - All-day lane

    private var allDayRowCount: Int {
        days.map { day in
            let content = allDayEntries(on: day)
            return content.chips.count + (content.overflow > 0 ? 1 : 0)
        }.max() ?? 0
    }

    private var allDayLane: some View {
        GeometryReader { geometry in
            let columnWidth = max(0, (geometry.size.width - gutter) / 7)
            HStack(alignment: .top, spacing: 0) {
                ForEach(days, id: \.self) { day in
                    allDayColumn(day, width: columnWidth)
                }
            }
            .padding(.leading, gutter)
        }
        .frame(height: CGFloat(allDayRowCount) * (chipHeight + 2))
        .padding(.vertical, 4)
    }

    private func allDayColumn(_ day: Date, width: CGFloat) -> some View {
        let content = allDayEntries(on: day)
        return VStack(spacing: 2) {
            ForEach(content.chips) { chip in
                allDayChip(chip, day: day, width: width)
            }
            if content.overflow > 0 {
                Text("+\(content.overflow)")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity)
            }
        }
        .frame(width: width, alignment: .top)
    }

    // A chip shows its title when the column holds a few characters; in a
    // narrower column it is a bar in the calendar's colour.
    private func allDayChip(_ chip: DayChips.Chip, day: Date, width: CGFloat) -> some View {
        let tint = colors.color(for: chip)
        let plan = BlockText.plan(width: width - 2, height: chipHeight + 4, fontSize: blockTextSize, inset: 7, maxLines: 1)
        return Button {
            open(chip, on: day)
        } label: {
            Group {
                if plan.showsText {
                    Text(chip.title)
                        .font(.caption2.weight(.medium))
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .foregroundStyle(.primary)
                        .padding(.leading, 5)
                        .padding(.trailing, 2)
                } else {
                    Color.clear
                }
            }
            .frame(width: max(4, width - 2), height: chipHeight, alignment: .leading)
            .calendarBlock(tint: tint, cornerRadius: 4, edge: 2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(chip.kind == .task ? "\(chip.title), task" : "\(chip.title), all day")
    }

    private func open(_ chip: DayChips.Chip, on day: Date) {
        if chip.kind == .task {
            if let task = dueTasks(on: day).first(where: { "task:" + $0.id == chip.id }) {
                onOpenTask(task)
            }
        } else if let event = allDay(on: day).first(where: { CalendarGrid.entityKey(for: $0) == chip.id }) {
            onOpen(event)
        }
    }

    private func allDayEntries(on day: Date) -> (chips: [DayChips.Chip], overflow: Int) {
        DayChips.make(events: allDay(on: day), tasks: dueTasks(on: day), limit: Self.allDayChipLimit)
    }

    // MARK: - Grid

    private var grid: some View {
        GeometryReader { geometry in
            let columnWidth = max(0, (geometry.size.width - gutter) / 7)
            ZStack(alignment: .topLeading) {
                HourRows(day: weekStart, hourHeight: hourHeight, labelWidth: labelWidth, gutterPadding: Self.gutterPadding)
                columnRules(columnWidth: columnWidth)
                holdSurface(columnWidth: columnWidth)
                blocks(columnWidth: columnWidth)
                nowLine(columnWidth: columnWidth)
            }
        }
        .frame(height: hourHeight * 24)
    }

    // Faint verticals keep a block readable as belonging to its day when the
    // week is dense; the hour rules alone are not enough at this width.
    private func columnRules(columnWidth: CGFloat) -> some View {
        ForEach(1..<7, id: \.self) { index in
            Rectangle()
                .fill(environment.theme.hairlineColor)
                .frame(width: 0.5, height: hourHeight * 24)
                .offset(x: gutter + CGFloat(index) * columnWidth)
        }
        .allowsHitTesting(false)
    }

    private func holdSurface(columnWidth: CGFloat) -> some View {
        TimelineHoldSurface { point in
            guard let column = TimelineSlot.column(forX: point.x, gutter: 0, columnWidth: columnWidth),
                  column < days.count
            else { return }
            onCreate(TimelineSlot.start(forY: point.y, hourHeight: hourHeight, on: days[column], calendar: calendar))
        }
        .frame(width: max(0, columnWidth * 7), height: hourHeight * 24)
        .offset(x: gutter)
        .accessibilityHidden(true)
    }

    private func blocks(columnWidth: CGFloat) -> some View {
        ForEach(Array(days.enumerated()), id: \.element) { columnIndex, day in
            ForEach(TimelineLayout.place(timed(on: day), on: day, calendar: calendar)) { placement in
                block(placement, columnIndex: columnIndex, columnWidth: columnWidth)
            }
        }
    }

    private func block(
        _ placement: TimelineLayout.Placement,
        columnIndex: Int,
        columnWidth: CGFloat
    ) -> some View {
        let event = placement.event
        let y = CGFloat(placement.startMinutes) / 60 * hourHeight
        let height = max(
            (blockTextSize * 1.4).rounded(),
            CGFloat(placement.endMinutes - placement.startMinutes) / 60 * hourHeight - 1
        )
        let laneWidth = (columnWidth - 2) / CGFloat(placement.laneCount)
        let width = max(6, laneWidth - 1)
        let tint = colors.color(for: event)
        let plan = BlockText.plan(width: width, height: height, fontSize: blockTextSize, inset: 8)
        let isPending = environment.store.isPendingServerCopy(event)
        return Button {
            onOpen(event)
        } label: {
            Group {
                if plan.showsText {
                    Text(event.title)
                        .font(.caption2.weight(.semibold))
                        .lineLimit(plan.lines)
                        .truncationMode(.tail)
                        .multilineTextAlignment(.leading)
                        .foregroundStyle(.primary)
                        .padding(.leading, 6)
                        .padding(.trailing, 2)
                        .padding(.vertical, 1)
                } else {
                    Color.clear
                }
            }
            .frame(width: width, height: height, alignment: .topLeading)
            .calendarBlock(tint: tint, cornerRadius: 4, edge: 2)
            .pendingServerCopyBorder(isPending, accent: tint, cornerRadius: 4)
        }
        .buttonStyle(.plain)
        .offset(
            x: gutter + CGFloat(columnIndex) * columnWidth + 1 + laneWidth * CGFloat(placement.lane),
            y: y
        )
        .accessibilityLabel("\(event.title), \(event.start.formatted(date: .abbreviated, time: .shortened))")
    }

    @ViewBuilder private func nowLine(columnWidth: CGFloat) -> some View {
        if let todayIndex = days.firstIndex(where: { calendar.isDateInToday($0) }) {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                let minutes = calendar.component(.hour, from: context.date) * 60
                    + calendar.component(.minute, from: context.date)
                let accent = environment.theme.accentColor
                HStack(spacing: 0) {
                    Circle()
                        .fill(accent)
                        .frame(width: 6, height: 6)
                    Rectangle()
                        .fill(accent)
                        .frame(height: 1.5)
                }
                .frame(width: columnWidth)
                .offset(
                    x: gutter + CGFloat(todayIndex) * columnWidth,
                    y: CGFloat(minutes) / 60 * hourHeight - 3
                )
                .accessibilityHidden(true)
            }
        }
    }

    // MARK: - Data

    // Open on the first hour that carries something, or an hour before now
    // once today is under way, so the morning is not hidden and an empty grid
    // does not open first (D12).
    private var scrollTarget: Int {
        let starts = days.flatMap { timed(on: $0) }.map(\.start).filter { $0 >= weekStart }
        return HourAxis.openingHour(
            now: .now,
            isToday: days.contains { calendar.isDateInToday($0) },
            firstStart: starts.min(),
            calendar: calendar
        )
    }

    private func timed(on day: Date) -> [CalendarEventSummary] {
        index.timed(on: day)
    }

    private func allDay(on day: Date) -> [CalendarEventSummary] {
        index.allDay(on: day)
    }

    private func dueTasks(on day: Date) -> [TaskSummary] {
        index.tasks(on: day)
    }
}
