import SwiftUI

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
    // Month and year scroll continuously, so the title belongs to what is on
    // screen rather than to the day that happens to be selected.
    @State private var visibleMonth: Date?
    @State private var visibleYear: Int?
    @State private var todayToken = 0
    @AppStorage("calendarViewMode") private var viewMode = "day"

    private static let dayWindow = -28...56

    private var store: ProductStore { environment.store }
    private var calendar: Calendar { .autoupdatingCurrent }

    var body: some View {
        @Bindable var navigation = environment.navigation
        VStack(spacing: 0) {
            if let move = store.workExecution.missedMoves.first(where: { $0.stepKey != nil }) {
                MissedMoveRecoveryView(move: move)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                Divider()
            }
            Group {
                switch viewMode {
                case "agenda": agendaBody
                case "week": weekBody
                case "month": monthBody
                case "year": yearBody
                default: dayBody
                }
            }
        }
        .navigationTitle(navigationTitleText)
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: viewMode) {
            // A title carried over from the previous mode would describe a
            // scroll position that no longer exists.
            visibleMonth = nil
            visibleYear = nil
        }
        .navigationDestination(item: $navigation.eventRoute) { route in
            EventDetailView(route: route)
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if showsTodayButton {
                    Button("Today") {
                        select(day: calendar.startOfDay(for: .now))
                        // Month and year scroll on their own, so returning to
                        // today has to be asked for explicitly rather than
                        // inferred from the selection — which also changes when
                        // a day is opened, and must not scroll a view that is
                        // on its way out.
                        todayToken += 1
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

    // Month and year both print their period inside the scroll — the month name
    // above each month, the numeral above each year — so the bar states only
    // what the page itself does not.
    private var navigationTitleText: String {
        switch viewMode {
        case "year": ""
        case "month": (visibleMonth ?? selectedDay).formatted(.dateTime.year())
        default: monthTitle
        }
    }

    // In the scrolling modes the offer to return is about where the scroll has
    // wandered to, not about which day happens to be selected.
    private var showsTodayButton: Bool {
        switch viewMode {
        case "year":
            (visibleYear ?? calendar.component(.year, from: selectedDay))
                != calendar.component(.year, from: .now)
        case "month":
            !calendar.isDate(visibleMonth ?? selectedDay, equalTo: .now, toGranularity: .month)
        default:
            !calendar.isDateInToday(selectedDay)
        }
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
                    onSelectDay: { day in select(day: day) },
                    onOpenDay: { day in
                        select(day: day)
                        viewMode = "day"
                    }
                )
                // A page that only asks for the height of its content gets
                // centred by the pager, which is what left the week hanging in
                // the middle of the screen with its early hours cut off.
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .tag(weekStart)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .background(Color(uiColor: .systemBackground))
    }

    // MARK: - Month mode

    @ViewBuilder private var monthBody: some View {
        #if canImport(HorizonCalendar)
        horizonMonthBody
        #else
        // The Mac month grid is still to come; agenda keeps the mode usable.
        agendaBody
        #endif
    }

    #if canImport(HorizonCalendar)
    private var horizonMonthBody: some View {
        HorizonMonthView(
            events: store.events,
            tasks: store.dueCalendarTasks,
            selectedDay: selectedDay,
            onSelectDay: { day in
                select(day: day)
                viewMode = "day"
            },
            onVisibleMonthChange: { visibleMonth = $0 },
            todayToken: todayToken
        )
        .background(Color(uiColor: .systemBackground))
    }
    #endif

    // MARK: - Year mode

    private var yearBody: some View {
        YearGridView(
            anchor: selectedDay,
            onSelectMonth: { monthStart in
                // Every other selection path routes through select(day:), which
                // normalises to startOfDay and re-syncs weekPage. Assigning
                // directly here left week and day mode showing the previously
                // paged week while selectedDay sat in another month.
                select(day: monthStart)
                viewMode = "month"
            },
            onVisibleYearChange: { visibleYear = $0 },
            todayToken: todayToken
        )
        .background(Color(uiColor: .systemBackground))
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
                ForEach(placements) { placement in
                    eventBlock(placement, laneWidth: laneWidth)
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

    private func eventBlock(_ placement: TimelineLayout.Placement, laneWidth: CGFloat) -> some View {
        let event = placement.event
        let frame = blockFrame(placement)
        let width = max(44, laneWidth / CGFloat(placement.laneCount) - 3)
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
                                PlatformHaptics.lightImpact()
                                PlatformAccessibility.announce(
                                    "Ends at \(end.formatted(date: .omitted, time: .shortened))"
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
                    PlatformHaptics.lightImpact()
                    PlatformAccessibility.announce(
                        "Moved to \(start.formatted(date: .omitted, time: .shortened))"
                    )
                },
            isEnabled: horizontalSizeClass == .regular
        )
        .offset(
            x: Self.gutter + (laneWidth / CGFloat(placement.laneCount)) * CGFloat(placement.lane),
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

    private var placements: [TimelineLayout.Placement] {
        TimelineLayout.place(events, on: day, calendar: calendar)
    }

    private func blockFrame(_ placement: TimelineLayout.Placement) -> (y: CGFloat, height: CGFloat) {
        let y = CGFloat(placement.startMinutes) / 60 * Self.hourHeight
        let height = max(
            26,
            CGFloat(placement.endMinutes - placement.startMinutes) / 60 * Self.hourHeight - 2
        )
        return (y, height)
    }

    private func minutesIntoDay(_ date: Date) -> Int {
        Int(date.timeIntervalSince(calendar.startOfDay(for: day)) / 60)
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
    let onOpenDay: (Date) -> Void

    @Environment(AppEnvironment.self) private var environment

    private static let hourHeight: CGFloat = 52
    private static let gutter: CGFloat = 42
    private static let allDayChipLimit = 2

    private var calendar: Calendar { .autoupdatingCurrent }
    private var days: [Date] {
        (0..<7).compactMap { calendar.date(byAdding: .day, value: $0, to: weekStart) }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if hasAllDayEntries {
                Divider()
                allDayLane
            }
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    grid.padding(.bottom, 24)
                }
                .onAppear { proxy.scrollTo(scrollTarget, anchor: .top) }
                .onChange(of: weekStart) { proxy.scrollTo(scrollTarget, anchor: .top) }
            }
        }
        // Without this the pager centres a page that asked only for the height
        // of its content, and the timeline floats away from the header.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 0) {
            ForEach(days, id: \.self) { day in
                dayHeading(day)
            }
        }
        // The hour gutter is reserved with padding, not with a spacer view.
        // `Color.clear.frame(width:)` leaves the height unconstrained, so it
        // grew to fill the page and split the space with the timeline below —
        // which is what left the week's header stranded halfway down the
        // screen with its morning hours scrolled out of reach.
        .padding(.leading, Self.gutter)
        .padding(.bottom, 6)
    }

    private func dayHeading(_ day: Date) -> some View {
        let isToday = calendar.isDateInToday(day)
        let isSelected = calendar.isDate(day, inSameDayAs: selectedDay)
        return Button {
            // The first tap moves the week's selection; tapping the day that is
            // already selected is what opens it, so the header stays a scanning
            // surface rather than a trapdoor.
            if isSelected { onOpenDay(day) } else { onSelectDay(day) }
        } label: {
            VStack(spacing: 3) {
                Text(day.formatted(.dateTime.weekday(.narrow)))
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                Text(day.formatted(.dateTime.day()))
                    .font(.system(size: 15, weight: isToday || isSelected ? .semibold : .regular))
                    .foregroundStyle(isToday ? Color(uiColor: .systemBackground) : .primary)
                    .frame(width: 26, height: 26)
                    .background {
                        if isToday {
                            Circle().fill(environment.theme.accentColor)
                        } else if isSelected {
                            Circle().fill(environment.theme.accentSoftColor)
                        }
                    }
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

    private var hasAllDayEntries: Bool {
        days.contains { !allDayEntries(on: $0).chips.isEmpty }
    }

    private var allDayLane: some View {
        HStack(alignment: .top, spacing: 0) {
            Text("all-day")
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
                .frame(width: Self.gutter - 6, alignment: .trailing)
                .padding(.trailing, 6)
                .padding(.top, 3)
            ForEach(days, id: \.self) { day in
                let content = allDayEntries(on: day)
                VStack(spacing: 1) {
                    ForEach(content.chips) { chip in
                        allDayChip(chip, day: day)
                    }
                    if content.overflow > 0 {
                        Text("+\(content.overflow)")
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .top)
                .padding(.horizontal, 1)
            }
        }
        .padding(.vertical, 4)
    }

    private func allDayChip(_ chip: DayChips.Chip, day: Date) -> some View {
        let tint = chip.kind == .task
            ? environment.theme.accentColor
            : environment.theme.avatarColor(seed: chip.seed)
        return Button {
            open(chip, on: day)
        } label: {
            Text(chip.title)
                .font(.system(size: 9, weight: .medium))
                .lineLimit(1)
                .truncationMode(.tail)
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 3)
                .padding(.vertical, 1)
                .background(tint.opacity(0.2), in: RoundedRectangle(cornerRadius: 3, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func open(_ chip: DayChips.Chip, on day: Date) {
        if chip.kind == .task {
            if let task = dueTasks(on: day).first(where: { "task:" + $0.id == chip.id }) {
                onOpenTask(task)
            }
        } else if let event = allDay(on: day).first(where: { $0.id + $0.accountID == chip.id }) {
            onOpen(event)
        }
    }

    private func allDayEntries(on day: Date) -> (chips: [DayChips.Chip], overflow: Int) {
        DayChips.make(events: allDay(on: day), tasks: dueTasks(on: day), limit: Self.allDayChipLimit)
    }

    // MARK: - Grid

    private var grid: some View {
        GeometryReader { geometry in
            let columnWidth = (geometry.size.width - Self.gutter) / 7
            ZStack(alignment: .topLeading) {
                hourRows
                columnRules(columnWidth: columnWidth, height: Self.hourHeight * 24)
                if let index = days.firstIndex(where: { calendar.isDate($0, inSameDayAs: selectedDay) }) {
                    Rectangle()
                        .fill(environment.theme.accentSoftColor.opacity(0.5))
                        .frame(width: columnWidth, height: Self.hourHeight * 24)
                        .offset(x: Self.gutter + CGFloat(index) * columnWidth)
                        .allowsHitTesting(false)
                }
                ForEach(Array(days.enumerated()), id: \.element) { index, day in
                    ForEach(TimelineLayout.place(timed(on: day), on: day, calendar: calendar)) { placement in
                        block(placement, columnIndex: index, columnWidth: columnWidth)
                    }
                }
                nowLine(columnWidth: columnWidth)
            }
        }
        .frame(height: Self.hourHeight * 24)
    }

    private var hourRows: some View {
        VStack(spacing: 0) {
            ForEach(0..<24, id: \.self) { hour in
                HStack(alignment: .top, spacing: 6) {
                    Text(shortHour(hour))
                        .font(.system(size: 10))
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

    // Faint verticals keep a block readable as belonging to its day when the
    // week is dense; the hour rules alone are not enough at this column width.
    private func columnRules(columnWidth: CGFloat, height: CGFloat) -> some View {
        ForEach(1..<7, id: \.self) { index in
            Rectangle()
                .fill(environment.theme.hairlineColor)
                .frame(width: 0.5, height: height)
                .offset(x: Self.gutter + CGFloat(index) * columnWidth)
        }
        .allowsHitTesting(false)
    }

    @ViewBuilder private func nowLine(columnWidth: CGFloat) -> some View {
        if let todayIndex = days.firstIndex(where: { calendar.isDateInToday($0) }) {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                let minutes = calendar.component(.hour, from: context.date) * 60
                    + calendar.component(.minute, from: context.date)
                HStack(spacing: 0) {
                    Circle()
                        .fill(.red)
                        .frame(width: 6, height: 6)
                    Rectangle()
                        .fill(.red)
                        .frame(height: 1.5)
                }
                .frame(width: columnWidth)
                .offset(
                    x: Self.gutter + CGFloat(todayIndex) * columnWidth,
                    y: CGFloat(minutes) / 60 * Self.hourHeight - 3
                )
                .accessibilityHidden(true)
            }
        }
    }

    private func block(
        _ placement: TimelineLayout.Placement,
        columnIndex: Int,
        columnWidth: CGFloat
    ) -> some View {
        let event = placement.event
        let y = CGFloat(placement.startMinutes) / 60 * Self.hourHeight
        let height = max(
            16,
            CGFloat(placement.endMinutes - placement.startMinutes) / 60 * Self.hourHeight - 1
        )
        let laneWidth = (columnWidth - 2) / CGFloat(placement.laneCount)
        let tint = environment.theme.avatarColor(seed: DayChips.seed(for: event))
        return Button {
            onOpen(event)
        } label: {
            Text(event.title)
                .font(.system(size: 9, weight: .semibold))
                .lineLimit(height > 30 ? 3 : 1)
                .multilineTextAlignment(.leading)
                .padding(.horizontal, 3)
                .padding(.vertical, 1)
                .frame(width: max(10, laneWidth - 1), height: height, alignment: .topLeading)
                .background(tint.opacity(0.2), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 1).fill(tint).frame(width: 2)
                }
                .clipped()
        }
        .buttonStyle(.plain)
        .offset(
            x: Self.gutter + CGFloat(columnIndex) * columnWidth + 1 + laneWidth * CGFloat(placement.lane),
            y: y
        )
        .accessibilityLabel("\(event.title), \(event.start.formatted(date: .abbreviated, time: .shortened))")
    }

    // MARK: - Data

    // Open on the first hour that carries something, so a week whose work
    // starts at seven is not scrolled past and one that starts at ten does not
    // open on empty grid.
    private var scrollTarget: Int {
        if days.contains(where: { calendar.isDateInToday($0) }) {
            return max(0, calendar.component(.hour, from: .now) - 1)
        }
        let starts = days.flatMap { timed(on: $0) }.map { calendar.component(.hour, from: $0.start) }
        guard let earliest = starts.min() else { return 8 }
        return max(0, earliest - 1)
    }

    private func timed(on day: Date) -> [CalendarEventSummary] {
        let start = calendar.startOfDay(for: day)
        guard let end = calendar.date(byAdding: .day, value: 1, to: start) else { return [] }
        return events.filter { !$0.allDay && $0.start < end && $0.end > start }
    }

    private func allDay(on day: Date) -> [CalendarEventSummary] {
        let start = calendar.startOfDay(for: day)
        guard let end = calendar.date(byAdding: .day, value: 1, to: start) else { return [] }
        return events.filter { $0.allDay && $0.start < end && $0.end > start }
    }

    private func dueTasks(on day: Date) -> [TaskSummary] {
        tasks.filter { task in
            guard let due = task.due else { return false }
            return calendar.isDate(due, inSameDayAs: day)
        }
    }

    private func shortHour(_ hour: Int) -> String {
        let date = calendar.date(bySettingHour: hour, minute: 0, second: 0, of: weekStart) ?? weekStart
        return date.formatted(.dateTime.hour())
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
