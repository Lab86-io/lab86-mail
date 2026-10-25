import SwiftUI

// Read-only event detail. Opens instantly from the row's summary, then enriches
// with the full `calendar_event_detail` read when a calendar id is known
// (Calendar-tab events). Rows opened from an Area (no calendar id) show the
// summary they carry rather than an empty screen.
struct EventDetailView: View {
    private enum RecurrenceScope: String, Identifiable {
        case occurrence
        case series
        var id: Self { self }
    }

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss
    let route: EventRoute

    @State private var detail: CalendarEventDetail?
    @State private var isLoading = false
    @State private var loadError: String?
    @State private var showsEditor = false
    @State private var showsDeleteConfirmation = false
    @State private var editScope: RecurrenceScope = .occurrence
    @State private var isActing = false
    @State private var actionError: String?
    @State private var linkedTasks: [TaskSummary] = []
    @State private var openTask: TaskSummary?

    private var summary: CalendarEventSummary? {
        route.preview ?? environment.store.events.first {
            $0.id == route.eventID && $0.accountID == route.accountID
        }
    }

    private var resolvedTitle: String {
        detail?.title ?? summary?.title ?? "Event"
    }

    private var resolvedStart: Date? { detail?.start ?? summary?.start }
    private var resolvedEnd: Date? { detail?.end ?? summary?.end }
    private var resolvedAllDay: Bool { detail?.allDay ?? summary?.allDay ?? false }
    private var resolvedLocation: String? { detail?.location ?? summary?.location }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(resolvedTitle)
                        .font(.title3.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    if let source = calendarSourceLine {
                        Text(source)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 2)
                // The one action a meeting needs sits with the title, as a
                // word, not behind an icon further down the page.
                if let url = detail?.conferenceURL {
                    Button("Join \(detail?.conferenceLabel ?? "video call")") {
                        openURL(url)
                    }
                    .font(.body.weight(.semibold))
                }
            }

            Section("When") {
                VStack(alignment: .leading, spacing: 2) {
                    Text(whenLines.day)
                    if let time = whenLines.time {
                        Text(time)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
                if isLoading {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Loading details…").foregroundStyle(.secondary)
                    }
                }
            }

            if let location = resolvedLocation {
                Section("Location") {
                    Button(location) {
                        if let url = mapsURL(for: location) { openURL(url) }
                    }
                    .accessibilityHint("Opens in Maps")
                }
            }

            if let detail, !detail.attendees.isEmpty, resolvedCalendarID != nil {
                Section("Respond") {
                    HStack(spacing: 10) {
                        rsvpButton("Going", status: "yes")
                        rsvpButton("Maybe", status: "maybe")
                        rsvpButton("No", status: "no")
                    }
                    .buttonStyle(.bordered)
                    if let actionError {
                        Text(actionError).font(.footnote).foregroundStyle(.red)
                    }
                }
            }

            if let detail {
                if !detail.attendees.isEmpty {
                    Section("Guests") {
                        ForEach(detail.attendees) { attendee in
                            AttendeeRow(attendee: attendee)
                        }
                    }
                }

                if let organizer = detail.organizerLabel {
                    Section("Organizer") {
                        Text(organizer)
                    }
                }

                if let description = detail.description {
                    Section("Notes") {
                        Text(description)
                            .font(.body)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if let link = detail.htmlLink {
                    Section {
                        Button("Open in calendar") {
                            openURL(link)
                        }
                    }
                }
            }

            if let loadError, detail == nil, summary == nil {
                Section {
                    ContentUnavailableView(
                        "Event unavailable",
                        systemImage: "calendar.badge.exclamationmark",
                        description: Text(loadError)
                    )
                }
            } else if let loadError, detail == nil {
                Section {
                    Text("Could not load the full details. \(loadError)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if !linkedTasks.isEmpty {
                Section("Related tasks") {
                    ForEach(linkedTasks) { task in
                        Button {
                            openTask = task
                        } label: {
                            HStack {
                                Text(task.title)
                                    .foregroundStyle(.primary)
                                Spacer()
                                if task.completed {
                                    Text("Done")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle(resolvedTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // A read-only calendar (a subscription, a shared view) has no
            // edit and no delete; the page states that it is read-only.
            if resolvedCalendarID != nil, !isReadOnlyCalendar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        if isRecurring {
                            Button("Edit this occurrence") {
                                editScope = .occurrence
                                showsEditor = true
                            }
                            Button("Edit entire series") {
                                editScope = .series
                                showsEditor = true
                            }
                            Divider()
                            Button("Delete occurrence or series", role: .destructive) {
                                showsDeleteConfirmation = true
                            }
                        } else {
                            Button("Edit event") { showsEditor = true }
                            Button("Delete event", role: .destructive) { showsDeleteConfirmation = true }
                        }
                    } label: {
                        Label("Event actions", systemImage: "ellipsis.circle")
                    }
                    .disabled(isActing)
                }
            }
        }
        .sheet(isPresented: $showsEditor) {
            if let calendarID = resolvedCalendarID {
                EventEditorView(
                    mode: .edit(
                        accountID: route.accountID,
                        calendarID: calendarID,
                        eventID: editScope == .series ? (detail?.masterEventID ?? route.eventID) : route.eventID
                    ),
                    title: resolvedTitle,
                    allDay: resolvedAllDay,
                    start: resolvedStart ?? .now,
                    end: resolvedEnd,
                    location: resolvedLocation ?? "",
                    calendarID: calendarID,
                    recurrence: detail?.recurrence ?? [],
                    attendees: detail?.attendees.compactMap(\.email) ?? [],
                    notes: detail?.description ?? ""
                )
                .onDisappear { Task { await load() } }
            }
        }
        .confirmationDialog(
            "Delete this event?",
            isPresented: $showsDeleteConfirmation,
            titleVisibility: .visible
        ) {
            if isRecurring {
                Button("Delete this occurrence", role: .destructive) {
                    Task { await deleteEvent(scope: .occurrence) }
                }
                Button("Delete entire series", role: .destructive) {
                    Task { await deleteEvent(scope: .series) }
                }
            } else {
                Button("Delete event", role: .destructive) {
                    Task { await deleteEvent(scope: .occurrence) }
                }
            }
        } message: {
            Text(
                isRecurring
                    ? "Choose whether this affects only this occurrence or the full recurring series. Guests are not emailed."
                    : "Guests are not emailed a cancellation."
            )
        }
        .task(id: route.id) { await load() }
        .sheet(item: $openTask) { TaskDetailView(task: $0) }
    }

    private var resolvedCalendarID: String? {
        let id = route.calendarID ?? summary?.calendarID
        return (id?.isEmpty == false) ? id : nil
    }

    private var calendarChoice: CalendarChoice? {
        guard let calendarID = resolvedCalendarID else { return nil }
        return environment.store.calendarChoices.first {
            $0.accountID == route.accountID && $0.calendarID == calendarID
        }
    }

    private var isReadOnlyCalendar: Bool {
        calendarChoice?.isReadOnly == true
    }

    private var isRecurring: Bool {
        detail?.masterEventID != nil || detail?.recurrence.isEmpty == false
    }

    private func rsvpButton(_ title: String, status: String) -> some View {
        Button(title) {
            Task { await respond(status) }
        }
        .disabled(isActing)
    }

    private func respond(_ status: String) async {
        guard let calendarID = resolvedCalendarID else { return }
        isActing = true
        actionError = nil
        defer { isActing = false }
        do {
            try await environment.store.rsvpEvent(
                accountID: route.accountID,
                calendarID: calendarID,
                eventID: route.eventID,
                status: status
            )
            await load()
        } catch {
            guard !error.isCancellation else { return }
            actionError = error.localizedDescription
        }
    }

    private func deleteEvent(scope: RecurrenceScope) async {
        guard let calendarID = resolvedCalendarID else { return }
        isActing = true
        defer { isActing = false }
        do {
            try await environment.store.deleteEvent(
                accountID: route.accountID,
                calendarID: calendarID,
                eventID: scope == .series ? (detail?.masterEventID ?? route.eventID) : route.eventID,
                deleteSeries: scope == .series
            )
            dismiss()
        } catch {
            guard !error.isCancellation else { return }
            actionError = error.localizedDescription
        }
    }

    private var calendarSourceLine: String? {
        let calendar = detail?.calendarName ?? calendarChoice?.name
        let account = detail?.accountID ?? summary?.accountID.nonEmpty
        guard let source = [calendar, account].compactMap({ $0 }).first else { return nil }
        return isReadOnlyCalendar ? "\(source), read-only" : source
    }

    // The date on one line and the time on the next. Two facts, two lines;
    // no joining dot.
    private var whenLines: (day: String, time: String?) {
        EventWhen.lines(start: resolvedStart, end: resolvedEnd, allDay: resolvedAllDay)
    }

    private func mapsURL(for location: String) -> URL? {
        var components = URLComponents()
        components.scheme = "https"
        components.host = "maps.apple.com"
        components.queryItems = [URLQueryItem(name: "q", value: location)]
        return components.url
    }

    private func load() async {
        linkedTasks = await environment.store.tasksForCalendarEvent(
            eventID: route.eventID,
            masterEventID: detail?.masterEventID
        )
        let calendarID = route.calendarID ?? summary?.calendarID
        guard let calendarID, !calendarID.isEmpty else {
            // Summary-only detail — nothing richer to fetch without a calendar id.
            return
        }
        isLoading = true
        defer { isLoading = false }
        do {
            detail = try await environment.store.loadEventDetail(
                accountID: route.accountID,
                eventID: route.eventID,
                calendarID: calendarID
            )
            linkedTasks = await environment.store.tasksForCalendarEvent(
                eventID: route.eventID,
                masterEventID: detail?.masterEventID
            )
        } catch {
            guard !error.isCancellation else { return }
            loadError = error.localizedDescription
        }
    }
}

// The "When" rows of an event: the day on one line, the time on the next.
// An all-day event says so where the time would be; a span across days
// names both days.
enum EventWhen {
    static func lines(
        start: Date?,
        end: Date?,
        allDay: Bool,
        calendar: Calendar = .autoupdatingCurrent
    ) -> (day: String, time: String?) {
        guard let start else { return ("Time unavailable", nil) }
        if allDay {
            if let end, !calendar.isDate(start, inSameDayAs: end.addingTimeInterval(-1)) {
                let last = end.addingTimeInterval(-1)
                return (
                    "\(start.formatted(date: .abbreviated, time: .omitted)) – \(last.formatted(date: .abbreviated, time: .omitted))",
                    "All day"
                )
            }
            return (start.formatted(date: .complete, time: .omitted), "All day")
        }
        let day = start.formatted(date: .complete, time: .omitted)
        let startTime = start.formatted(date: .omitted, time: .shortened)
        guard let end else { return (day, startTime) }
        if calendar.isDate(start, inSameDayAs: end) {
            return (day, "\(startTime) – \(end.formatted(date: .omitted, time: .shortened))")
        }
        return (
            "\(start.formatted(date: .abbreviated, time: .omitted)) – \(end.formatted(date: .abbreviated, time: .omitted))",
            "\(startTime) – \(end.formatted(date: .omitted, time: .shortened))"
        )
    }
}

private struct AttendeeRow: View {
    let attendee: CalendarEventDetail.Attendee

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(attendee.name).lineLimit(1)
                if let email = attendee.email, email != attendee.name {
                    Text(email).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            if attendee.isOrganizer {
                Text("Organizer").font(.caption2).foregroundStyle(.secondary)
            }
            if let status = attendee.responseStatus {
                Image(systemName: responseSymbol(status))
                    .font(.caption)
                    .foregroundStyle(responseColor(status))
                    .accessibilityLabel(responseLabel(status))
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func responseSymbol(_ status: String) -> String {
        switch status.lowercased() {
        case "accepted", "yes": return "checkmark.circle.fill"
        case "declined", "no": return "xmark.circle.fill"
        case "tentative", "maybe": return "questionmark.circle.fill"
        default: return "circle"
        }
    }

    private func responseColor(_ status: String) -> Color {
        switch status.lowercased() {
        case "accepted", "yes": return .green
        case "declined", "no": return .red
        case "tentative", "maybe": return .orange
        default: return .secondary
        }
    }

    private func responseLabel(_ status: String) -> String {
        switch status.lowercased() {
        case "accepted", "yes": return "Accepted"
        case "declined", "no": return "Declined"
        case "tentative", "maybe": return "Tentative"
        default: return "No response"
        }
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
