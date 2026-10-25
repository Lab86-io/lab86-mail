import SwiftUI

// The calendar page: a paged week strip over a swipeable day timeline, with
// week, month, year, and agenda modes behind one picker. Events wear their
// calendar's own colour, hidden calendars stay out, and an account whose
// sign-in ended asks to be reconnected where its events would be.
struct CalendarView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.scenePhase) private var scenePhase
    #if os(macOS)
    @State private var macSyncCaption = MacCalendarSyncCaptionModel()
    #endif
    @State private var showsNewEvent = false
    // A hold on the empty grid creates an event at that slot.
    @State private var newEventSlot: NewEventSlot?
    // The freshness subtitle re-renders on this clock, not on every layout.
    @State private var freshnessClock = Date.now
    @State private var selectedDay: Date = Calendar.autoupdatingCurrent.startOfDay(for: .now)
    @State private var weekPage: Date = CalendarView.weekStart(for: .now)
    @State private var openTask: TaskSummary?
    // Month and year scroll continuously, so the title belongs to what is on
    // screen rather than to the day that happens to be selected.
    @State private var visibleMonth: Date?
    @State private var visibleYear: Int?
    @State private var todayToken = 0
    // Events and tasks bucketed by day, rebuilt when the store's data moves
    // rather than re-filtered by every cell on every layout pass.
    @State private var dayIndex = CalendarDayIndex.empty
    @AppStorage("calendarViewMode") private var viewMode = "day"

    private static let dayWindow = -28...56

    struct NewEventSlot: Identifiable {
        let start: Date
        var id: Date { start }
    }

    private var store: ProductStore { environment.store }
    private var calendar: Calendar { .autoupdatingCurrent }

    private var colors: CalendarColors {
        CalendarColors(choices: store.calendarChoices, theme: environment.theme)
    }

    // The calendars the user hid, keyed the way `CalendarChoice.id` is.
    private var hiddenKeys: Set<String> {
        Set(store.calendarChoices.filter(\.isHidden).map(\.id))
    }

    private var visibleEvents: [CalendarEventSummary] {
        CalendarVisibility.visible(store.events, hiddenKeys: hiddenKeys)
    }

    var body: some View {
        @Bindable var navigation = environment.navigation
        VStack(spacing: 0) {
            // Day mode carries the sync line under its week strip. The other
            // modes have no strip, so the line sits at the top of the content.
            if viewMode != "day" {
                CalendarSyncLine(phase: store.calendarSync.phase)
            }
            CalendarReconnectBanner()
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
        .background(environment.theme.paperColor)
        .onChange(of: navigation.pendingCalendarDay, initial: true) { _, day in
            guard let day else { return }
            selectedDay = calendar.startOfDay(for: day)
            weekPage = Self.weekStart(for: day)
            navigation.pendingCalendarDay = nil
        }
        .navigationTitle(navigationTitleText)
        .navigationBarTitleDisplayMode(.inline)
        .modifier(CalendarTitleChrome(title: navigationTitleText, dateline: freshnessSubtitle))
        .task {
            // A passive open. The server skips the sync when the last one
            // finished under two minutes ago, and then no line shows.
            await store.resyncCalendar(reason: .viewOpen)
        }
        .task {
            // The calendar list gives each event its colour and tells which
            // calendars are hidden or read-only.
            await store.refreshCalendarChoices()
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                freshnessClock = .now
            }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            freshnessClock = .now
            Task { await store.resyncCalendar(reason: .viewOpen) }
        }
        .onChange(of: store.calendarSync.phase) { freshnessClock = .now }
        #if os(macOS)
        // ⌘R runs a manual sync and writes one short caption after it.
        .onChange(of: MacRequests.shared.syncCalendarToken) { _, _ in
            Task { await macSyncCaption.manualKick(store: store) }
        }
        .onChange(of: store.calendarSync.phase) { _, phase in
            macSyncCaption.phaseChanged(phase)
        }
        .toolbar {
            ToolbarItem(placement: .automatic) {
                MacCalendarSyncCaptionView(model: macSyncCaption) {
                    Task { await macSyncCaption.manualKick(store: store) }
                }
            }
        }
        #endif
        .syncCompletionHaptic(trigger: store.calendarSync.completionToken)
        .onChange(of: viewMode) {
            // A title carried over from the previous mode would describe a
            // scroll position that no longer exists.
            visibleMonth = nil
            visibleYear = nil
        }
        .onChange(of: store.events, initial: true) { rebuildDayIndex() }
        .onChange(of: store.dueCalendarTasks, initial: true) { rebuildDayIndex() }
        .onChange(of: store.calendarChoices) { rebuildDayIndex() }
        .navigationDestination(item: $navigation.eventRoute) { route in
            EventDetailView(route: route)
        }
        .toolbar { modeToolbar }
        .sheet(isPresented: $showsNewEvent) {
            EventEditorView(
                mode: .create,
                start: defaultNewEventStart
            )
        }
        .sheet(item: $newEventSlot) { slot in
            EventEditorView(
                mode: .create,
                start: slot.start,
                end: slot.start.addingTimeInterval(3_600)
            )
        }
        .sheet(item: $openTask) {
            TaskDetailView(task: $0)
        }
        .shellToolbar()
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder private var modeToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            if showsTodayButton {
                Button("Today") {
                    select(day: calendar.startOfDay(for: .now))
                    // Month and year scroll on their own, so a return to today
                    // is asked for explicitly rather than inferred from the
                    // selection, which also changes when a day is opened.
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
            // The shell's floating button makes chats, mail, and files, not
            // events, so the calendar keeps its own door in the bar.
            Button {
                showsNewEvent = true
            } label: {
                Label("New event", systemImage: "plus")
            }
        }
    }

    // MARK: - Day mode

    private var dayBody: some View {
        VStack(spacing: 0) {
            weekStrip
            CalendarSyncLine(phase: store.calendarSync.phase)
            Divider()
            if let notice = store.calendarError {
                CalendarNotice(message: notice) {
                    Task { await store.resyncCalendar(reason: .manualHTTP) }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            dayPager
        }
        .refreshableIfAvailable { await store.resyncCalendar(reason: .pull) }
    }

    @ViewBuilder private var dayPager: some View {
        #if os(macOS)
        // The Mac has no swipe pager (and the TabView fallback painted
        // phantom scrollers); the strip's arrows and cells drive the day.
        dayTimeline(for: selectedDay)
            .id(selectedDay)
        #else
        TabView(selection: dayBinding) {
            ForEach(dayRange, id: \.self) { day in
                dayTimeline(for: day)
                    .tag(day)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .ignoresSafeArea(edges: .bottom)
        #endif
    }

    private func dayTimeline(for day: Date) -> some View {
        DayTimelineView(
            day: day,
            events: timedEvents(on: day),
            allDayEvents: allDayEvents(on: day),
            tasks: dueTasks(on: day),
            colors: colors,
            onOpen: { environment.navigation.openEvent($0) },
            onOpenTask: { openTask = $0 },
            onReschedule: { event, start, end in
                Task { await store.rescheduleEvent(event, start: start, end: end) }
            },
            onCreate: { start in newEventSlot = NewEventSlot(start: start) }
        )
    }

    #if os(macOS)
    private var weekStrip: some View {
        HStack(spacing: 2) {
            weekStepButton(direction: -1, symbol: "chevron.left", label: "Previous week")
            ForEach(0..<7, id: \.self) { offset in
                let day = calendar.date(byAdding: .day, value: offset, to: weekPage) ?? weekPage
                dayCell(day)
            }
            weekStepButton(direction: 1, symbol: "chevron.right", label: "Next week")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private func weekStepButton(direction: Int, symbol: String, label: String) -> some View {
        Button {
            // Route through the same setter the paged strip uses so the
            // selected day (and the day timeline) follow the week.
            weekBinding.wrappedValue = Self.weekPage(afterStepping: direction, from: weekPage, calendar: calendar)
        } label: {
            Image(systemName: symbol)
                .font(.callout.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 28, height: 44)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
    #else
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
        .frame(height: weekStripHeight)
    }

    @ScaledMetric(relativeTo: .body) private var weekStripHeight: CGFloat = 78
    #endif

    private func dayCell(_ day: Date) -> some View {
        let isSelected = calendar.isDate(day, inSameDayAs: selectedDay)
        let isToday = calendar.isDateInToday(day)
        let hasEntries = dayIndex.hasEntries(on: day)
        return Button {
            select(day: day)
        } label: {
            VStack(spacing: 4) {
                Text(day.formatted(.dateTime.weekday(.narrow)))
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                DayNumeral(text: day.formatted(.dateTime.day()), isToday: isToday, isSelected: isSelected)
                Circle()
                    .fill(hasEntries ? environment.theme.accentColor.opacity(0.55) : .clear)
                    .frame(width: 4, height: 4)
            }
            .frame(maxWidth: .infinity)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(day.formatted(date: .complete, time: .omitted))
        .accessibilityValue(hasEntries ? "Has entries" : "")
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

    private var navigationTitleText: String {
        CalendarTitle.text(
            mode: viewMode,
            visibleMonth: visibleMonth,
            visibleYear: visibleYear,
            selectedDay: selectedDay,
            calendar: calendar
        )
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

    private func weekTimeline(for weekStart: Date) -> some View {
        WeekTimelineView(
            weekStart: weekStart,
            index: dayIndex,
            selectedDay: selectedDay,
            colors: colors,
            onOpen: { environment.navigation.openEvent($0) },
            onOpenTask: { openTask = $0 },
            onSelectDay: { day in select(day: day) },
            onOpenDay: { day in
                select(day: day)
                viewMode = "day"
            },
            onCreate: { start in newEventSlot = NewEventSlot(start: start) }
        )
    }

    #if os(macOS)
    private var weekBody: some View {
        VStack(spacing: 0) {
            HStack {
                weekStepButton(direction: -1, symbol: "chevron.left", label: "Previous week")
                Spacer()
                weekStepButton(direction: 1, symbol: "chevron.right", label: "Next week")
            }
            .padding(.horizontal, 10)
            .frame(height: 34)
            weekTimeline(for: weekPage)
                .id(weekPage)
        }
    }
    #else
    private var weekBody: some View {
        TabView(selection: weekBinding) {
            ForEach(weekRange, id: \.self) { weekStart in
                weekTimeline(for: weekStart)
                    // A page that only asks for the height of its content gets
                    // centred by the pager, which left the week hanging in the
                    // middle of the screen with its early hours cut off.
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    .tag(weekStart)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
    }
    #endif

    // MARK: - Month mode

    @ViewBuilder private var monthBody: some View {
        #if canImport(HorizonCalendar)
        horizonMonthBody
        #elseif os(macOS)
        MacMonthGridView(
            index: dayIndex,
            colors: colors,
            selectedDay: selectedDay,
            onSelectDay: { day in select(day: day) },
            onOpenDay: { day in
                select(day: day)
                viewMode = "day"
            },
            onVisibleMonthChange: { visibleMonth = $0 },
            todayToken: todayToken
        )
        #else
        agendaBody
        #endif
    }

    #if canImport(HorizonCalendar)
    private var horizonMonthBody: some View {
        HorizonMonthView(
            index: dayIndex,
            colors: colors,
            selectedDay: selectedDay,
            onSelectDay: { day in
                select(day: day)
                viewMode = "day"
            },
            onVisibleMonthChange: { visibleMonth = $0 },
            todayToken: todayToken
        )
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
    }

    // MARK: - Agenda mode

    // The loaded window includes weeks of history; the agenda opens on today,
    // not on the oldest loaded day.
    private var agendaAnchorDay: Date? {
        let today = calendar.startOfDay(for: .now)
        let days = groupedDates.map(\.0)
        return days.first(where: { $0 >= today }) ?? days.last
    }

    @ViewBuilder private var agendaBody: some View {
        if visibleEvents.isEmpty, store.dueCalendarTasks.isEmpty {
            emptyOrErrorState
        } else {
            ScrollViewReader { proxy in
                agendaList
                    .onAppear {
                        if let anchor = agendaAnchorDay {
                            proxy.scrollTo(anchor, anchor: .top)
                        }
                    }
                    // The toolbar's Today asks for a scroll explicitly; the
                    // agenda only positioned itself on first appearance before.
                    .onChange(of: todayToken) {
                        if let anchor = agendaAnchorDay {
                            withAnimation { proxy.scrollTo(anchor, anchor: .top) }
                        }
                    }
            }
        }
    }

    private var agendaList: some View {
        List {
            if let error = store.calendarError {
                Section {
                    CalendarNotice(message: error) {
                        Task { await store.resyncCalendar(reason: .manualHTTP) }
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
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
                            agendaTaskRow(task)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .id(day)
            }
        }
        .refreshable { await store.resyncCalendar(reason: .pull) }
    }

    private func agendaTaskRow(_ task: TaskSummary) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(task.title)
                .foregroundStyle(task.completed ? .secondary : .primary)
                .strikethrough(task.completed)
            Text(agendaTaskDetail(task))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private func agendaTaskDetail(_ task: TaskSummary) -> String {
        guard let due = task.due else { return "Task" }
        return "Task, due \(due.formatted(date: .omitted, time: .shortened))"
    }

    @ViewBuilder private var emptyOrErrorState: some View {
        if !store.calendarDidLoad {
            if store.isSyncingCalendar {
                ProgressView("Loading your calendar…")
            } else if let error = store.calendarError {
                ContentUnavailableView {
                    Label("Could not load your calendar", systemImage: "calendar.badge.exclamationmark")
                } description: {
                    Text(error)
                } actions: {
                    Button("Sync now") { Task { await store.resyncCalendar(reason: .manualHTTP) } }
                        .buttonStyle(.borderedProminent)
                }
            } else {
                ContentUnavailableView {
                    Label("Calendar not loaded yet", systemImage: "calendar")
                } description: {
                    Text("Pull down to sync your connected calendars.")
                } actions: {
                    Button("Sync now") { Task { await store.resyncCalendar(reason: .manualHTTP) } }
                }
            }
        } else if let error = store.calendarError {
            ContentUnavailableView {
                Label("Calendar needs a sync", systemImage: "calendar.badge.exclamationmark")
            } description: {
                Text(error)
            } actions: {
                Button("Sync now") { Task { await store.resyncCalendar(reason: .manualHTTP) } }
                    .buttonStyle(.borderedProminent)
            }
        } else {
            ContentUnavailableView {
                Label("No upcoming events", systemImage: "calendar")
            } description: {
                Text("Nothing is scheduled in the next 30 days.")
            } actions: {
                Button("New event") { showsNewEvent = true }
            }
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
                selectedDay = Self.selectedDay(forWeek: newWeek, keeping: selectedDay, calendar: calendar)
            }
        )
    }

    private func select(day: Date) {
        selectedDay = calendar.startOfDay(for: day)
        let week = Self.weekStart(for: day, calendar: calendar)
        if weekPage != week { weekPage = week }
    }

    nonisolated static func weekStart(for date: Date, calendar: Calendar = .autoupdatingCurrent) -> Date {
        let start = calendar.dateInterval(of: .weekOfYear, for: date)?.start ?? date
        return calendar.startOfDay(for: start)
    }

    nonisolated static func weekPage(afterStepping direction: Int, from weekPage: Date, calendar: Calendar) -> Date {
        calendar.date(byAdding: .day, value: direction * 7, to: weekPage) ?? weekPage
    }

    // The selection that belongs to a newly shown week: unchanged when the
    // selected day is already in it, otherwise the same weekday of that week.
    nonisolated static func selectedDay(forWeek newWeek: Date, keeping selectedDay: Date, calendar: Calendar) -> Date {
        guard weekStart(for: selectedDay, calendar: calendar) != newWeek else { return selectedDay }
        let weekday = calendar.component(.weekday, from: selectedDay)
        let offset = (weekday - calendar.firstWeekday + 7) % 7
        return calendar.date(byAdding: .day, value: offset, to: newWeek) ?? newWeek
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

    private var freshnessSubtitle: String {
        CalendarFreshness.subtitle(state: store.calendarSync, now: freshnessClock)
    }

    private var defaultNewEventStart: Date {
        if calendar.isDateInToday(selectedDay) { return EventEditorView.defaultStart }
        return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: selectedDay) ?? selectedDay
    }

    // MARK: - Event slicing

    private func rebuildDayIndex() {
        dayIndex = CalendarDayIndex(
            events: visibleEvents,
            tasks: store.dueCalendarTasks,
            calendar: calendar,
            revision: dayIndex.revision + 1
        )
    }

    private func timedEvents(on day: Date) -> [CalendarEventSummary] {
        dayIndex.timed(on: day)
    }

    private func allDayEvents(on day: Date) -> [CalendarEventSummary] {
        dayIndex.allDay(on: day)
    }

    private func dueTasks(on day: Date) -> [TaskSummary] {
        dayIndex.tasks(on: day)
    }

    private var groupedDates: [(Date, [CalendarEventSummary], [TaskSummary])] {
        let eventGroups = Dictionary(grouping: visibleEvents) { calendar.startOfDay(for: $0.start) }
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

// The bar title in the two product voices. iOS draws it as the principal
// item; the Mac keeps the system title and subtitle, which its toolbar and
// the sync caption are built around.
private struct CalendarTitleChrome: ViewModifier {
    let title: String
    let dateline: String

    func body(content: Content) -> some View {
        #if os(macOS)
        content.navigationSubtitle(dateline)
        #else
        content.toolbar {
            ToolbarItem(placement: .principal) {
                CalendarBarTitle(title: title, dateline: dateline)
            }
        }
        #endif
    }
}

// A pull-to-refresh that composes onto non-List containers.
private extension View {
    func refreshableIfAvailable(_ action: @escaping @Sendable () async -> Void) -> some View {
        refreshable { await action() }
    }

    // A soft tap when a sync completes. The Mac stays silent.
    @ViewBuilder
    func syncCompletionHaptic(trigger: Int) -> some View {
        #if os(iOS)
        sensoryFeedback(.impact(flexibility: .soft), trigger: trigger)
        #else
        self
        #endif
    }
}
