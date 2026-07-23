import SwiftUI
import UIKit

// A phone-native calendar in the shape of the best mobile references
// (Outlook/Cron/Google Calendar): a paged week strip up top, a swipeable
// all-day + hourly day timeline underneath with overlap-aware event blocks
// and a live now line, plus an agenda list mode for scanning ahead.
struct CalendarView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var showsNewEvent = false
    @State private var selectedDay: Date = Calendar.autoupdatingCurrent.startOfDay(for: .now)
    @State private var weekPage: Date = CalendarView.weekStart(for: .now)
    @State private var openTask: TaskSummary?
    @AppStorage("calendarViewMode") private var viewMode = "day"

    private static let dayWindow = -28...56

    private var store: ProductStore { environment.store }
    private var calendar: Calendar { .autoupdatingCurrent }

    var body: some View {
        @Bindable var navigation = environment.navigation
        Group {
            switch viewMode {
            case "agenda": agendaBody
            case "week": weekBody
            case "month": monthBody
            case "year": yearBody
            default: dayBody
            }
        }
        .navigationTitle(viewMode == "year" ? yearTitle : monthTitle)
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $navigation.eventRoute) { route in
            EventDetailView(route: route)
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if !calendar.isDateInToday(selectedDay) {
                    Button("Today") {
                        select(day: calendar.startOfDay(for: .now))
                    }
                }
                Menu {
                    Picker("View", selection: $viewMode) {
                        Text("Day").tag("day")
                        Text("Week").tag("week")
                        Text("Month").tag("month")
                        Text("Year").tag("year")
                        Text("Agenda").tag("agenda")
                    }
                } label: {
                    Label("Calendar view", systemImage: viewModeSymbol)
                }
                Button {
                    showsNewEvent = true
                } label: {
                    Label("New event", systemImage: "plus")
                }
            }
        }
        .sheet(isPresented: $showsNewEvent) {
            EventEditorView(
                mode: .create,
                start: defaultNewEventStart
            )
        }
        .sheet(item: $openTask) {
            TaskDetailView(task: $0)
        }
        .shellToolbar()
    }

    // MARK: - Day mode

    private var dayBody: some View {
        VStack(spacing: 0) {
            weekStrip
            Divider()
            if let notice = store.calendarError {
                CalendarNotice(message: notice) {
                    Task { await store.refreshCalendar(sync: true) }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            TabView(selection: dayBinding) {
                ForEach(dayRange, id: \.self) { day in
                    DayTimelineView(
                        day: day,
                        events: timedEvents(on: day),
                        allDayEvents: allDayEvents(on: day),
                        tasks: dueTasks(on: day),
                        onOpen: { environment.navigation.openEvent($0) },
                        onOpenTask: { openTask = $0 },
                        onReschedule: { event, start, end in
                            Task { await store.rescheduleEvent(event, start: start, end: end) }
                        }
                    )
                    .tag(day)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .ignoresSafeArea(edges: .bottom)
        }
        .background(Color(uiColor: .systemBackground))
        .refreshableIfAvailable { await store.refreshCalendar(sync: true) }
    }

    private var weekStrip: some View {
        TabView(selection: weekBinding) {
            ForEach(weekRange, id: \.self) { weekStart in
                HStack(spacing: 0) {
                    ForEach(0..<7, id: \.self) { offset in
                        let day = calendar.date(byAdding: .day, value: offset, to: weekStart) ?? weekStart
                        dayCell(day)
                    }
                }
                .padding(.horizontal, 10)
                .tag(weekStart)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .frame(height: 74)
    }

    private func dayCell(_ day: Date) -> some View {
        let isSelected = calendar.isDate(day, inSameDayAs: selectedDay)
        let isToday = calendar.isDateInToday(day)
        let hasEvents = !timedEvents(on: day).isEmpty
            || !allDayEvents(on: day).isEmpty
            || !dueTasks(on: day).isEmpty
        return Button {
            select(day: day)
        } label: {
            VStack(spacing: 5) {
                Text(day.formatted(.dateTime.weekday(.narrow)))
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                Text(day.formatted(.dateTime.day()))
                    .font(.callout.weight(isSelected || isToday ? .semibold : .regular))
                    .foregroundStyle(
                        isSelected
                            ? Color(uiColor: .systemBackground)
                            : (isToday ? environment.theme.accentColor : .primary)
                    )
                    .frame(width: 34, height: 34)
                    .background {
                        if isSelected {
                            Circle().fill(environment.theme.accentColor)
                        }
                    }
                Circle()
                    .fill(hasEvents ? environment.theme.accent2Color : .clear)
                    .frame(width: 4, height: 4)
            }
            .frame(maxWidth: .infinity)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(day.formatted(date: .complete, time: .omitted))
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }

    private var viewModeSymbol: String {
        switch viewMode {
        case "week": "calendar.day.timeline.leading"
        case "month": "calendar"
        case "year": "square.grid.3x3"
        case "agenda": "list.bullet"
        default: "calendar.day.timeline.left"
        }
    }

    private var yearTitle: String {
        selectedDay.formatted(.dateTime.year())
    }

    // MARK: - Week mode

    private var weekBody: some View {
        TabView(selection: weekBinding) {
            ForEach(weekRange, id: \.self) { weekStart in
                WeekTimelineView(
                    weekStart: weekStart,
                    events: store.events,
                    tasks: store.dueCalendarTasks,
                    selectedDay: selectedDay,
                    onOpen: { environment.navigation.openEvent($0) },
                    onOpenTask: { openTask = $0 },
                    onSelectDay: { day in
                        select(day: day)
                        viewMode = "day"
                    }
                )
                .tag(weekStart)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .background(Color(uiColor: .systemBackground))
    }

    // MARK: - Month mode

    private var monthBody: some View {
        HorizonMonthView(
            events: store.events,
            tasks: store.dueCalendarTasks,
            selectedDay: selectedDay,
            onSelectDay: { day in
                select(day: day)
                viewMode = "day"
            }
        )
        .background(Color(uiColor: .systemBackground))
    }

    // MARK: - Year mode

    private var yearBody: some View {
        let yearStart = calendar.dateInterval(of: .year, for: selectedDay)?.start ?? selectedDay
        return ScrollView {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 14), count: 3), spacing: 20) {
                ForEach(0..<12, id: \.self) { offset in
                    if let monthStart = calendar.date(byAdding: .month, value: offset, to: yearStart) {
                        MiniMonthView(
                            monthStart: monthStart,
                            onOpen: {
                                selectedDay = monthStart
                                viewMode = "month"
                            }
                        )
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            HStack {
                Button {
                    if let previous = calendar.date(byAdding: .year, value: -1, to: selectedDay) {
                        selectedDay = calendar.startOfDay(for: previous)
                    }
                } label: {
                    Label("Previous year", systemImage: "chevron.backward")
                }
                Spacer()
                Button {
                    if let next = calendar.date(byAdding: .year, value: 1, to: selectedDay) {
                        selectedDay = calendar.startOfDay(for: next)
                    }
                } label: {
                    Label("Next year", systemImage: "chevron.forward")
                }
            }
            .labelStyle(.iconOnly)
            .padding(.horizontal, 24)
            .padding(.vertical, 10)
            .background(.bar)
        }
    }

    // MARK: - Agenda mode

    @ViewBuilder private var agendaBody: some View {
        if store.events.isEmpty, store.dueCalendarTasks.isEmpty {
            emptyOrErrorState
        } else {
            List {
                if let error = store.calendarError {
                    Section {
                        CalendarNotice(message: error) {
                            Task { await store.refreshCalendar(sync: true) }
                        }
                    }
                }
                ForEach(groupedDates, id: \.0) { day, events, tasks in
                    Section(sectionTitle(day)) {
                        ForEach(events) { event in
                            Button { environment.navigation.openEvent(event) } label: {
                                EventRow(event: event)
                            }
                            .buttonStyle(.plain)
                        }
                        ForEach(tasks) { task in
                            Button { openTask = task } label: {
                                HStack {
                                    Image(systemName: task.completed ? "checkmark.circle.fill" : "checklist")
                                        .foregroundStyle(environment.theme.accentColor)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(task.title)
                                            .foregroundStyle(.primary)
                                        Text("Task due \(task.due?.formatted(date: .omitted, time: .shortened) ?? "")")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .refreshable { await store.refreshCalendar(sync: true) }
        }
    }

    @ViewBuilder private var emptyOrErrorState: some View {
        if !store.calendarDidLoad {
            if store.isSyncingCalendar {
                ProgressView("Loading your calendar…")
            } else if let error = store.calendarError {
                ContentUnavailableView {
                    Label("Couldn’t load your calendar", systemImage: "calendar.badge.exclamationmark")
                } description: {
                    Text(error)
                } actions: {
                    Button("Sync Now") { Task { await store.refreshCalendar(sync: true) } }
                        .buttonStyle(.borderedProminent)
                }
            } else {
                ContentUnavailableView {
                    Label("Calendar not loaded yet", systemImage: "calendar")
                } description: {
                    Text("Pull down to sync your connected calendars.")
                } actions: {
                    Button("Sync Now") { Task { await store.refreshCalendar(sync: true) } }
                }
            }
        } else if let error = store.calendarError {
            ContentUnavailableView {
                Label("Calendar needs a sync", systemImage: "calendar.badge.exclamationmark")
            } description: {
                Text(error)
            } actions: {
                Button("Sync Now") { Task { await store.refreshCalendar(sync: true) } }
                    .buttonStyle(.borderedProminent)
            }
        } else {
            ContentUnavailableView(
                "No upcoming events",
                systemImage: "calendar",
                description: Text("Nothing scheduled in the next 30 days.")
            )
        }
    }

    // MARK: - Selection plumbing

    private var dayBinding: Binding<Date> {
        Binding(
            get: { selectedDay },
            set: { select(day: $0) }
        )
    }

    private var weekBinding: Binding<Date> {
        Binding(
            get: { weekPage },
            set: { newWeek in
                weekPage = newWeek
                // Paging the strip moves the selection into the visible week,
                // keeping the same weekday when possible (Outlook behavior).
                if Self.weekStart(for: selectedDay, calendar: calendar) != newWeek {
                    let weekday = calendar.component(.weekday, from: selectedDay)
                    let offset = (weekday - calendar.firstWeekday + 7) % 7
                    selectedDay = calendar.date(byAdding: .day, value: offset, to: newWeek) ?? newWeek
                }
            }
        )
    }

    private func select(day: Date) {
        selectedDay = calendar.startOfDay(for: day)
        let week = Self.weekStart(for: day, calendar: calendar)
        if weekPage != week { weekPage = week }
    }

    static func weekStart(for date: Date, calendar: Calendar = .autoupdatingCurrent) -> Date {
        let start = calendar.dateInterval(of: .weekOfYear, for: date)?.start ?? date
        return calendar.startOfDay(for: start)
    }

    private var dayRange: [Date] {
        let today = calendar.startOfDay(for: .now)
        return Self.dayWindow.compactMap { calendar.date(byAdding: .day, value: $0, to: today) }
    }

    private var weekRange: [Date] {
        let anchor = Self.weekStart(for: .now, calendar: calendar)
        return stride(from: -4, through: 8, by: 1).compactMap {
            calendar.date(byAdding: .weekOfYear, value: $0, to: anchor)
        }
    }

    private var monthTitle: String {
        selectedDay.formatted(.dateTime.month(.wide).year())
    }

    private var defaultNewEventStart: Date {
        if calendar.isDateInToday(selectedDay) { return EventEditorView.defaultStart }
        return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: selectedDay) ?? selectedDay
    }

    // MARK: - Event slicing

    private func timedEvents(on day: Date) -> [CalendarEventSummary] {
        let start = calendar.startOfDay(for: day)
        guard let end = calendar.date(byAdding: .day, value: 1, to: start) else { return [] }
        return store.events.filter { !$0.allDay && $0.start < end && $0.end > start }
    }

    private func allDayEvents(on day: Date) -> [CalendarEventSummary] {
        let start = calendar.startOfDay(for: day)
        guard let end = calendar.date(byAdding: .day, value: 1, to: start) else { return [] }
        return store.events.filter { $0.allDay && $0.start < end && $0.end > start }
    }

    private func dueTasks(on day: Date) -> [TaskSummary] {
        store.dueCalendarTasks.filter { task in
            guard let due = task.due else { return false }
            return calendar.isDate(due, inSameDayAs: day)
        }
    }

    private var groupedDates: [(Date, [CalendarEventSummary], [TaskSummary])] {
        let eventGroups = Dictionary(grouping: store.events) { calendar.startOfDay(for: $0.start) }
        let taskGroups = Dictionary(grouping: store.dueCalendarTasks) {
            calendar.startOfDay(for: $0.due ?? .distantFuture)
        }
        let days = Set(eventGroups.keys).union(taskGroups.keys)
        return days.sorted().map {
            (
                $0,
                (eventGroups[$0] ?? []).sorted { $0.start < $1.start },
                (taskGroups[$0] ?? []).sorted { ($0.due ?? .distantFuture) < ($1.due ?? .distantFuture) }
            )
        }
    }

    private func sectionTitle(_ day: Date) -> String {
        if calendar.isDateInToday(day) { return "Today" }
        if calendar.isDateInTomorrow(day) { return "Tomorrow" }
        return day.formatted(.dateTime.weekday(.wide).month().day())
    }
}

// A pull-to-refresh that composes onto non-List containers.
private extension View {
    func refreshableIfAvailable(_ action: @escaping @Sendable () async -> Void) -> some View {
        refreshable { await action() }
    }
}

// MARK: - Day timeline

private struct DayTimelineView: View {
    let day: Date
    let events: [CalendarEventSummary]
    let allDayEvents: [CalendarEventSummary]
    let tasks: [TaskSummary]
    let onOpen: (CalendarEventSummary) -> Void
    let onOpenTask: (TaskSummary) -> Void
    let onReschedule: (CalendarEventSummary, Date, Date) -> Void

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private static let hourHeight: CGFloat = 58
    private static let gutter: CGFloat = 54

    private var calendar: Calendar { .autoupdatingCurrent }

    var body: some View {
        VStack(spacing: 0) {
            if !allDayEvents.isEmpty || !tasks.isEmpty {
                allDayLane
                Divider()
            }
            ScrollViewReader { proxy in
                ScrollView {
                    timeline
                        .padding(.bottom, 24)
                }
                .onAppear { scrollToStart(proxy) }
                .onChange(of: day) { scrollToStart(proxy) }
            }
        }
    }

    private var allDayLane: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(allDayEvents) { event in
                    Button {
                        onOpen(event)
                    } label: {
                        Text(event.title)
                            .font(.caption.weight(.medium))
                            .lineLimit(1)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(
                                environment.theme.accent2Color.opacity(0.16),
                                in: Capsule()
                            )
                            .foregroundStyle(.primary)
                    }
                    .buttonStyle(.plain)
                }
                ForEach(tasks) { task in
                    Button {
                        onOpenTask(task)
                    } label: {
                        Label(task.title, systemImage: task.completed ? "checkmark.circle.fill" : "checklist")
                            .font(.caption.weight(.medium))
                            .lineLimit(1)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(
                                environment.theme.accentColor.opacity(0.14),
                                in: Capsule()
                            )
                            .foregroundStyle(.primary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens task, not calendar event")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
    }

    private var timeline: some View {
        GeometryReader { geometry in
            let laneWidth = geometry.size.width - Self.gutter - 12
            ZStack(alignment: .topLeading) {
                hourGrid
                ForEach(positionedEvents) { positioned in
                    eventBlock(positioned, laneWidth: laneWidth)
                }
                if calendar.isDateInToday(day) {
                    nowLine(width: geometry.size.width)
                }
            }
        }
        .frame(height: Self.hourHeight * 24)
    }

    private var hourGrid: some View {
        VStack(spacing: 0) {
            ForEach(0..<24, id: \.self) { hour in
                HStack(alignment: .top, spacing: 8) {
                    Text(hourLabel(hour))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .frame(width: Self.gutter - 12, alignment: .trailing)
                        .offset(y: -5)
                    VStack { Divider() }
                }
                .frame(height: Self.hourHeight, alignment: .top)
                .id(hour)
            }
        }
    }

    private func eventBlock(_ positioned: PositionedEvent, laneWidth: CGFloat) -> some View {
        let event = positioned.event
        let frame = blockFrame(event)
        let width = max(44, laneWidth / CGFloat(positioned.laneCount) - 3)
        let accent = environment.theme.accentColor
        return Button {
            onOpen(event)
        } label: {
            HStack(alignment: .top, spacing: 0) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(accent)
                    .frame(width: 3)
                VStack(alignment: .leading, spacing: 1) {
                    Text(event.title)
                        .font(.caption.weight(.semibold))
                        .lineLimit(frame.height > 40 ? 2 : 1)
                    if frame.height > 30 {
                        Text(timeRange(event))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if let location = event.location, frame.height > 58 {
                        Text(location)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                Spacer(minLength: 0)
            }
            .frame(width: width, height: frame.height, alignment: .topLeading)
            .background(accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(alignment: .bottomTrailing) {
                Capsule()
                    .fill(accent.opacity(0.8))
                    .frame(width: 22, height: 4)
                    .padding(4)
                    .opacity(horizontalSizeClass == .regular ? 1 : 0)
                    .gesture(
                        DragGesture(minimumDistance: 4)
                            .onEnded { value in
                                let minutes = Int(value.translation.height / Self.hourHeight * 60)
                                    .roundedToMultiple(15)
                                guard minutes != 0 else { return }
                                let end = max(
                                    event.start.addingTimeInterval(15 * 60),
                                    event.end.addingTimeInterval(TimeInterval(minutes * 60))
                                )
                                onReschedule(event, event.start, end)
                                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                UIAccessibility.post(
                                    notification: .announcement,
                                    argument: "Ends at \(end.formatted(date: .omitted, time: .shortened))"
                                )
                            },
                        isEnabled: horizontalSizeClass == .regular
                    )
                    .accessibilityLabel("Resize event")
            }
            .clipped()
        }
        .buttonStyle(.plain)
        .gesture(
            DragGesture(minimumDistance: 8)
                .onEnded { value in
                    let minutes = Int(value.translation.height / Self.hourHeight * 60).roundedToMultiple(15)
                    guard minutes != 0 else { return }
                    let start = event.start.addingTimeInterval(TimeInterval(minutes * 60))
                    let end = event.end.addingTimeInterval(TimeInterval(minutes * 60))
                    onReschedule(event, start, end)
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    UIAccessibility.post(
                        notification: .announcement,
                        argument: "Moved to \(start.formatted(date: .omitted, time: .shortened))"
                    )
                },
            isEnabled: horizontalSizeClass == .regular
        )
        .offset(
            x: Self.gutter + (laneWidth / CGFloat(positioned.laneCount)) * CGFloat(positioned.lane),
            y: frame.y
        )
        .accessibilityLabel("\(event.title), \(timeRange(event))")
    }

    private func nowLine(width: CGFloat) -> some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let minutes = minutesIntoDay(context.date)
            HStack(spacing: 4) {
                Circle()
                    .fill(.red)
                    .frame(width: 7, height: 7)
                Rectangle()
                    .fill(.red)
                    .frame(height: 1)
            }
            .frame(width: width - Self.gutter + 10)
            .offset(x: Self.gutter - 10, y: CGFloat(minutes) / 60 * Self.hourHeight - 3.5)
            .accessibilityHidden(true)
        }
    }

    // MARK: - Geometry

    private struct PositionedEvent: Identifiable {
        let event: CalendarEventSummary
        let lane: Int
        let laneCount: Int
        var id: String { event.id + event.accountID }
    }

    // Overlapping events share the width of their cluster, Google Calendar
    // style: greedy lane assignment within clusters of transitive overlap.
    private var positionedEvents: [PositionedEvent] {
        let sorted = events.sorted {
            $0.start == $1.start ? $0.end > $1.end : $0.start < $1.start
        }
        var result: [PositionedEvent] = []
        var cluster: [(CalendarEventSummary, Int)] = []
        var laneEnds: [Date] = []
        var clusterEnd = Date.distantPast

        func flush() {
            let count = max(1, laneEnds.count)
            result += cluster.map { PositionedEvent(event: $0.0, lane: $0.1, laneCount: count) }
            cluster = []
            laneEnds = []
        }

        for event in sorted {
            if !cluster.isEmpty, event.start >= clusterEnd {
                flush()
            }
            if let free = laneEnds.firstIndex(where: { $0 <= event.start }) {
                laneEnds[free] = event.end
                cluster.append((event, free))
            } else {
                laneEnds.append(event.end)
                cluster.append((event, laneEnds.count - 1))
            }
            clusterEnd = max(clusterEnd, event.end)
        }
        flush()
        return result
    }

    private func blockFrame(_ event: CalendarEventSummary) -> (y: CGFloat, height: CGFloat) {
        let startMinutes = max(0, minutesIntoDay(event.start))
        let endMinutes = min(24 * 60, minutesIntoDay(event.end, clampToDay: true))
        let y = CGFloat(startMinutes) / 60 * Self.hourHeight
        let height = max(26, CGFloat(endMinutes - startMinutes) / 60 * Self.hourHeight - 2)
        return (y, height)
    }

    private func minutesIntoDay(_ date: Date, clampToDay: Bool = false) -> Int {
        let dayStart = calendar.startOfDay(for: day)
        let minutes = Int(date.timeIntervalSince(dayStart) / 60)
        if clampToDay { return min(max(minutes, 0), 24 * 60) }
        return minutes
    }

    private func scrollToStart(_ proxy: ScrollViewProxy) {
        let target: Int
        if calendar.isDateInToday(day) {
            target = max(0, calendar.component(.hour, from: .now) - 1)
        } else if let first = events.first(where: { calendar.isDate($0.start, inSameDayAs: day) }) {
            target = max(0, calendar.component(.hour, from: first.start) - 1)
        } else {
            target = 8
        }
        proxy.scrollTo(target, anchor: .top)
    }

    private func hourLabel(_ hour: Int) -> String {
        let date = calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day) ?? day
        return date.formatted(.dateTime.hour())
    }

    private func timeRange(_ event: CalendarEventSummary) -> String {
        "\(event.start.formatted(date: .omitted, time: .shortened)) – \(event.end.formatted(date: .omitted, time: .shortened))"
    }
}

private extension Int {
    func roundedToMultiple(_ multiple: Int) -> Int {
        guard multiple > 0 else { return self }
        return Int((Double(self) / Double(multiple)).rounded()) * multiple
    }
}

// MARK: - Week timeline (7 columns over one hour axis)

private struct WeekTimelineView: View {
    let weekStart: Date
    let events: [CalendarEventSummary]
    let tasks: [TaskSummary]
    let selectedDay: Date
    let onOpen: (CalendarEventSummary) -> Void
    let onOpenTask: (TaskSummary) -> Void
    let onSelectDay: (Date) -> Void

    @Environment(AppEnvironment.self) private var environment

    private static let hourHeight: CGFloat = 52
    private static let gutter: CGFloat = 34

    private var calendar: Calendar { .autoupdatingCurrent }
    private var days: [Date] {
        (0..<7).compactMap { calendar.date(byAdding: .day, value: $0, to: weekStart) }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    grid.padding(.bottom, 24)
                }
                .onAppear { proxy.scrollTo(8, anchor: .top) }
            }
        }
    }

    private var header: some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: Self.gutter)
            ForEach(days, id: \.self) { day in
                Button {
                    onSelectDay(day)
                } label: {
                    VStack(spacing: 2) {
                        Text(day.formatted(.dateTime.weekday(.narrow)))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text(day.formatted(.dateTime.day()))
                            .font(.footnote.weight(calendar.isDateInToday(day) ? .bold : .regular))
                            .foregroundStyle(calendar.isDateInToday(day) ? environment.theme.accentColor : .primary)
                        if let task = tasks.first(where: {
                            guard let due = $0.due else { return false }
                            return calendar.isDate(due, inSameDayAs: day)
                        }) {
                            Image(systemName: "checklist")
                                .font(.system(size: 8, weight: .semibold))
                                .foregroundStyle(environment.theme.accentColor)
                                .accessibilityLabel("Due task \(task.title)")
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(day.formatted(date: .abbreviated, time: .omitted))
            }
        }
    }

    private var grid: some View {
        GeometryReader { geometry in
            let columnWidth = (geometry.size.width - Self.gutter) / 7
            ZStack(alignment: .topLeading) {
                VStack(spacing: 0) {
                    ForEach(0..<24, id: \.self) { hour in
                        HStack(alignment: .top, spacing: 4) {
                            Text(shortHour(hour))
                                .font(.system(size: 9))
                                .foregroundStyle(.tertiary)
                                .frame(width: Self.gutter - 6, alignment: .trailing)
                                .offset(y: -4)
                            VStack { Divider() }
                        }
                        .frame(height: Self.hourHeight, alignment: .top)
                        .id(hour)
                    }
                }
                ForEach(Array(days.enumerated()), id: \.offset) { index, day in
                    let dayEvents = timed(on: day)
                    ForEach(dayEvents) { event in
                        block(event, day: day, columnIndex: index, columnWidth: columnWidth)
                    }
                }
                if let todayIndex = days.firstIndex(where: { calendar.isDateInToday($0) }) {
                    TimelineView(.periodic(from: .now, by: 60)) { context in
                        let minutes = calendar.component(.hour, from: context.date) * 60
                            + calendar.component(.minute, from: context.date)
                        Rectangle()
                            .fill(.red)
                            .frame(width: columnWidth, height: 1.5)
                            .offset(
                                x: Self.gutter + CGFloat(todayIndex) * columnWidth,
                                y: CGFloat(minutes) / 60 * Self.hourHeight
                            )
                            .accessibilityHidden(true)
                    }
                }
            }
        }
        .frame(height: Self.hourHeight * 24)
    }

    private func block(
        _ event: CalendarEventSummary,
        day: Date,
        columnIndex: Int,
        columnWidth: CGFloat
    ) -> some View {
        let dayStart = calendar.startOfDay(for: day)
        let startMinutes = max(0, Int(event.start.timeIntervalSince(dayStart) / 60))
        let endMinutes = min(24 * 60, Int(event.end.timeIntervalSince(dayStart) / 60))
        let y = CGFloat(startMinutes) / 60 * Self.hourHeight
        let height = max(18, CGFloat(endMinutes - startMinutes) / 60 * Self.hourHeight - 1)
        let accent = environment.theme.accentColor
        return Button {
            onOpen(event)
        } label: {
            Text(event.title)
                .font(.system(size: 9, weight: .semibold))
                .lineLimit(height > 30 ? 3 : 1)
                .multilineTextAlignment(.leading)
                .padding(3)
                .frame(width: columnWidth - 2, height: height, alignment: .topLeading)
                .background(accent.opacity(0.16), in: RoundedRectangle(cornerRadius: 4))
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 1).fill(accent).frame(width: 2)
                }
                .clipped()
        }
        .buttonStyle(.plain)
        .offset(x: Self.gutter + CGFloat(columnIndex) * columnWidth + 1, y: y)
        .accessibilityLabel(event.title)
    }

    private func timed(on day: Date) -> [CalendarEventSummary] {
        let start = calendar.startOfDay(for: day)
        guard let end = calendar.date(byAdding: .day, value: 1, to: start) else { return [] }
        return events.filter { !$0.allDay && $0.start < end && $0.end > start }
    }

    private func shortHour(_ hour: Int) -> String {
        let date = calendar.date(bySettingHour: hour, minute: 0, second: 0, of: weekStart) ?? weekStart
        return date.formatted(.dateTime.hour())
    }
}

// MARK: - Year mini month

private struct MiniMonthView: View {
    let monthStart: Date
    let onOpen: () -> Void

    @Environment(AppEnvironment.self) private var environment

    private var calendar: Calendar { .autoupdatingCurrent }

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 5) {
                Text(monthStart.formatted(.dateTime.month(.abbreviated)))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(
                        calendar.isDate(monthStart, equalTo: .now, toGranularity: .month)
                            ? environment.theme.accentColor
                            : .primary
                    )
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 1), count: 7), spacing: 2) {
                    ForEach(0..<leadingBlanks, id: \.self) { _ in
                        Color.clear.frame(height: 11)
                    }
                    ForEach(dayNumbers, id: \.self) { day in
                        Text("\(day)")
                            .font(.system(size: 8))
                            .foregroundStyle(isToday(day) ? Color(uiColor: .systemBackground) : .secondary)
                            .frame(maxWidth: .infinity, minHeight: 11)
                            .background {
                                if isToday(day) {
                                    Circle().fill(environment.theme.accentColor)
                                }
                            }
                    }
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(monthStart.formatted(.dateTime.month(.wide).year()))
    }

    private var dayNumbers: [Int] {
        Array(calendar.range(of: .day, in: .month, for: monthStart) ?? 1..<29)
    }

    private var leadingBlanks: Int {
        let weekday = calendar.component(.weekday, from: monthStart)
        return (weekday - calendar.firstWeekday + 7) % 7
    }

    private func isToday(_ day: Int) -> Bool {
        guard let date = calendar.date(byAdding: .day, value: day - 1, to: monthStart) else { return false }
        return calendar.isDateInToday(date)
    }
}

struct CalendarNotice: View {
    let message: String
    let onSync: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(.orange)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Sync Now", action: onSync)
                    .font(.caption.weight(.medium))
                    .buttonStyle(.plain)
                    .foregroundStyle(.tint)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
