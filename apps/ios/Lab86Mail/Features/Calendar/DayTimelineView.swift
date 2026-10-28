import SwiftUI

// One day as a timeline: the all-day rows, then the 24 hour rows with the
// day's events as flat tinted blocks in their calendar's colour and, for
// today, the now line. The hour gutter is as wide as its widest label and the
// hour rows grow with the text, so nothing cuts at accessibility sizes (D2).
struct DayTimelineView: View {
    let day: Date
    let events: [CalendarEventSummary]
    let allDayEvents: [CalendarEventSummary]
    let tasks: [TaskSummary]
    let colors: CalendarColors
    let onOpen: (CalendarEventSummary) -> Void
    let onOpenTask: (TaskSummary) -> Void
    let onReschedule: (CalendarEventSummary, Date, Date) -> Void
    let onCreate: (Date) -> Void

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @ScaledMetric(relativeTo: .caption2) private var textScale: CGFloat = 1
    @ScaledMetric(relativeTo: .caption2) private var hourLabelSize: CGFloat = 11
    @ScaledMetric(relativeTo: .subheadline) private var titleSize: CGFloat = 15
    @State private var labelWidth: CGFloat = 40
    @State private var showsEveryAllDayEntry = false

    private static let baseHourHeight: CGFloat = 58
    private static let gutterPadding: CGFloat = 12
    private static let allDayLimit = 3

    private var calendar: Calendar { .autoupdatingCurrent }
    private var hourHeight: CGFloat { HourAxis.hourHeight(base: Self.baseHourHeight, textScale: textScale) }
    private var gutter: CGFloat { labelWidth + Self.gutterPadding }

    var body: some View {
        VStack(spacing: 0) {
            if !allDayEntries.isEmpty {
                allDayLane
                Divider()
            }
            ScrollViewReader { proxy in
                ScrollView {
                    timeline
                        .padding(.top, 12 * textScale)
                        .padding(.bottom, 24)
                }
                .onAppear { scrollToStart(proxy) }
                .onChange(of: day) { scrollToStart(proxy) }
            }
        }
        .overlay(alignment: .topLeading) {
            HourGutterMeasure(day: day, labelWidth: $labelWidth)
        }
    }

    // MARK: - All-day lane

    private enum AllDayEntry: Identifiable {
        case event(CalendarEventSummary)
        case task(TaskSummary)

        var id: String {
            switch self {
            case .event(let event): CalendarGrid.entityKey(for: event)
            case .task(let task): "task:" + task.id
            }
        }
    }

    private var allDayEntries: [AllDayEntry] {
        allDayEvents.map(AllDayEntry.event) + tasks.map(AllDayEntry.task)
    }

    // Plain rows, not chips. The position above the hours and the missing
    // time say "all day"; no label repeats it. Three show, the rest count.
    private var allDayLane: some View {
        let entries = allDayEntries
        let shown = showsEveryAllDayEntry ? entries : Array(entries.prefix(Self.allDayLimit))
        return VStack(alignment: .leading, spacing: 4) {
            ForEach(shown) { entry in
                allDayRow(entry)
            }
            if entries.count > shown.count {
                Button("\(entries.count - shown.count) more") {
                    showsEveryAllDayEntry = true
                }
                .font(.footnote.weight(.medium))
                .buttonStyle(.plain)
                .foregroundStyle(environment.theme.accentColor)
                .padding(.top, 2)
            }
        }
        .padding(.leading, gutter)
        .padding(.trailing, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func allDayRow(_ entry: AllDayEntry) -> some View {
        switch entry {
        case .event(let event):
            Button {
                onOpen(event)
            } label: {
                allDayLabel(title: event.title, trailing: nil)
                    .calendarBlock(tint: colors.color(for: event), cornerRadius: 8)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(event.title), all day")
        case .task(let task):
            Button {
                onOpenTask(task)
            } label: {
                allDayLabel(title: task.title, trailing: task.completed ? "Done" : "Task")
                    .calendarBlock(tint: environment.theme.accentColor, cornerRadius: 8)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(task.title), task")
            .accessibilityHint("Opens the task")
        }
    }

    private func allDayLabel(title: String, trailing: String?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
            if let trailing {
                Text(trailing)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .foregroundStyle(.primary)
        .padding(.leading, 10)
        .padding(.trailing, 8)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Timeline

    private var timeline: some View {
        GeometryReader { geometry in
            let laneWidth = max(0, geometry.size.width - gutter - 12)
            ZStack(alignment: .topLeading) {
                HourRows(day: day, hourHeight: hourHeight, labelWidth: labelWidth, gutterPadding: Self.gutterPadding)
                holdSurface(width: geometry.size.width)
                ForEach(placements) { placement in
                    eventBlock(placement, laneWidth: laneWidth)
                }
                if calendar.isDateInToday(day) {
                    nowLine(width: geometry.size.width)
                }
            }
        }
        .frame(height: hourHeight * 24)
    }

    private func holdSurface(width: CGFloat) -> some View {
        TimelineHoldSurface { point in
            onCreate(TimelineSlot.start(forY: point.y, hourHeight: hourHeight, on: day, calendar: calendar))
        }
        .frame(width: max(0, width - gutter), height: hourHeight * 24)
        .offset(x: gutter)
        .accessibilityHidden(true)
    }

    // MARK: - Event blocks

    private func eventBlock(_ placement: TimelineLayout.Placement, laneWidth: CGFloat) -> some View {
        let event = placement.event
        let frame = blockFrame(placement)
        let width = max(44, laneWidth / CGFloat(placement.laneCount) - 3)
        let tint = colors.color(for: event)
        let plan = BlockText.plan(width: width, height: frame.height, fontSize: titleSize, inset: 15, maxLines: 2)
        let isPending = environment.store.isPendingServerCopy(event)
        return Button {
            onOpen(event)
        } label: {
            EventBlockLabel(
                title: event.title,
                detail: frame.height >= titleSize * 2.7 ? timeRange(event) : nil,
                footnote: frame.height >= titleSize * 4.1 ? event.location : nil,
                lines: plan.lines
            )
            .frame(width: width, height: frame.height, alignment: .topLeading)
            .calendarBlock(tint: tint, cornerRadius: 8)
            .pendingServerCopyBorder(isPending, accent: tint, cornerRadius: 8)
            .overlay(alignment: .bottom) { resizeHandle(event) }
        }
        .buttonStyle(.plain)
        .gesture(moveGesture(event), isEnabled: horizontalSizeClass == .regular)
        .offset(
            x: gutter + (laneWidth / CGFloat(placement.laneCount)) * CGFloat(placement.lane),
            y: frame.y
        )
        .accessibilityLabel("\(event.title), \(timeRange(event))")
    }

    // A wide layout moves a block by dragging it, in quarter hours.
    private func moveGesture(_ event: CalendarEventSummary) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onEnded { value in
                let minutes = Int(value.translation.height / hourHeight * 60).roundedToMultiple(15)
                guard minutes != 0 else { return }
                let start = event.start.addingTimeInterval(TimeInterval(minutes * 60))
                let end = event.end.addingTimeInterval(TimeInterval(minutes * 60))
                onReschedule(event, start, end)
                PlatformHaptics.lightImpact()
                PlatformAccessibility.announce(
                    "Moved to \(start.formatted(date: .omitted, time: .shortened))"
                )
            }
    }

    // The lower edge of a block resizes it on a wide layout. The edge draws
    // nothing (D21); the block's shape is the handle.
    @ViewBuilder private func resizeHandle(_ event: CalendarEventSummary) -> some View {
        if horizontalSizeClass == .regular {
            Color.clear
                .frame(height: 10)
                .contentShape(.rect)
                .gesture(
                    DragGesture(minimumDistance: 4)
                        .onEnded { value in
                            let minutes = Int(value.translation.height / hourHeight * 60).roundedToMultiple(15)
                            guard minutes != 0 else { return }
                            let end = max(
                                event.start.addingTimeInterval(15 * 60),
                                event.end.addingTimeInterval(TimeInterval(minutes * 60))
                            )
                            onReschedule(event, event.start, end)
                            PlatformHaptics.lightImpact()
                            PlatformAccessibility.announce(
                                "Ends at \(end.formatted(date: .omitted, time: .shortened))"
                            )
                        }
                )
                .accessibilityHidden(true)
        }
    }

    // MARK: - Now line

    // The now line speaks in the accent, not in a borrowed red, and the gutter
    // shows the clock time where the hour label would be.
    private func nowLine(width: CGFloat) -> some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let y = CGFloat(minutesIntoDay(context.date)) / 60 * hourHeight
            let accent = environment.theme.accentColor
            ZStack(alignment: .topLeading) {
                HStack(spacing: 0) {
                    Circle()
                        .fill(accent)
                        .frame(width: 7, height: 7)
                    Rectangle()
                        .fill(accent)
                        .frame(height: 1.5)
                }
                .frame(width: max(0, width - gutter + 4))
                .offset(x: gutter - 4, y: y - 3.5)
                Text(context.date.formatted(date: .omitted, time: .shortened))
                    .font(.system(size: HourAxis.labelFontSize(scaled: hourLabelSize), weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(accent)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .padding(.horizontal, 2)
                    .background(environment.theme.paperColor)
                    .frame(width: labelWidth + 4, height: 0, alignment: .trailing)
                    .offset(x: -2, y: y)
            }
            .accessibilityHidden(true)
        }
    }

    // MARK: - Geometry

    private var placements: [TimelineLayout.Placement] {
        TimelineLayout.place(events, on: day, calendar: calendar)
    }

    private func blockFrame(_ placement: TimelineLayout.Placement) -> (y: CGFloat, height: CGFloat) {
        let y = CGFloat(placement.startMinutes) / 60 * hourHeight
        let height = max(
            (titleSize * 1.7).rounded(),
            CGFloat(placement.endMinutes - placement.startMinutes) / 60 * hourHeight - 2
        )
        return (y, height)
    }

    private func minutesIntoDay(_ date: Date) -> Int {
        TimelineLayout.wallClockMinutes(of: date, on: day, calendar: calendar)
    }

    private func scrollToStart(_ proxy: ScrollViewProxy) {
        let firstStart = events
            .filter { calendar.isDate($0.start, inSameDayAs: day) }
            .map(\.start)
            .min()
        let target = HourAxis.openingHour(
            now: .now,
            isToday: calendar.isDateInToday(day),
            firstStart: firstStart,
            calendar: calendar
        )
        proxy.scrollTo(target, anchor: .top)
    }

    private func timeRange(_ event: CalendarEventSummary) -> String {
        "\(event.start.formatted(date: .omitted, time: .shortened)) – \(event.end.formatted(date: .omitted, time: .shortened))"
    }
}

// MARK: - Block label

// The text inside a day block: the title on the lines the block holds, then
// the time and the place when there is room. No text when there is none.
struct EventBlockLabel: View {
    let title: String
    let detail: String?
    let footnote: String?
    let lines: Int

    var body: some View {
        if lines > 0 {
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(lines)
                    .truncationMode(.tail)
                if let detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if let footnote {
                    Text(footnote)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .foregroundStyle(.primary)
            .multilineTextAlignment(.leading)
            .padding(.leading, 9)
            .padding(.trailing, 6)
            .padding(.vertical, 3)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        } else {
            Color.clear
        }
    }
}

// MARK: - Hour rows

// The 24 hour rows of a timeline: a label centred on each hairline rule, so
// "12 AM" reads as the start of the first hour and never hangs above the
// grid. The label column is as wide as the widest label.
struct HourRows: View {
    @Environment(AppEnvironment.self) private var environment
    @ScaledMetric(relativeTo: .caption2) private var hourLabelSize: CGFloat = 11
    let day: Date
    let hourHeight: CGFloat
    let labelWidth: CGFloat
    let gutterPadding: CGFloat

    private var calendar: Calendar { .autoupdatingCurrent }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<24, id: \.self) { hour in
                row(hour)
            }
        }
        .accessibilityHidden(true)
    }

    private func row(_ hour: Int) -> some View {
        HStack(alignment: .top, spacing: gutterPadding) {
            Text(HourAxis.label(hour: hour, on: day, calendar: calendar))
                .font(.system(size: HourAxis.labelFontSize(scaled: hourLabelSize)))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .fixedSize()
                .frame(width: labelWidth, alignment: .trailing)
                .alignmentGuide(.top) { dimensions in dimensions[VerticalAlignment.center] }
            Rectangle()
                .fill(environment.theme.hairlineColor)
                .frame(height: 0.5)
        }
        .frame(height: hourHeight, alignment: .top)
        .id(hour)
    }
}

// The widest hour label, laid out but not drawn, gives the gutter its width.
struct HourGutterMeasure: View {
    @ScaledMetric(relativeTo: .caption2) private var hourLabelSize: CGFloat = 11
    let day: Date
    @Binding var labelWidth: CGFloat

    private var calendar: Calendar { .autoupdatingCurrent }

    var body: some View {
        Text(HourAxis.widestLabel(on: day, calendar: calendar))
            .font(.system(size: HourAxis.labelFontSize(scaled: hourLabelSize)))
            .monospacedDigit()
            .fixedSize()
            .hidden()
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.size.width
            } action: { width in
                if abs(width - labelWidth) > 0.5 { labelWidth = width }
            }
            .accessibilityHidden(true)
    }
}
