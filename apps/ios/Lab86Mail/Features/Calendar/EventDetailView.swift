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
                        Label(source, systemImage: "calendar")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 2)
            }

            Section("When") {
                LabeledContent("Date", value: whenText)
                if isLoading {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Loading details…").foregroundStyle(.secondary)
                    }
                }
            }

            if let location = resolvedLocation {
                Section("Location") {
                    Button {
                        if let url = mapsURL(for: location) { openURL(url) }
                    } label: {
                        Label(location, systemImage: "mappin.and.ellipse")
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
                if let url = detail.conferenceURL {
                    Section("Video call") {
                        Button {
                            openURL(url)
                        } label: {
                            Label("Join \(detail.conferenceLabel ?? "video call")", systemImage: "video")
                        }
                    }
                }

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
                        Button {
                            openURL(link)
                        } label: {
                            Label("Open in calendar", systemImage: "arrow.up.forward.app")
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
                    Label("Couldn’t load full details. \(loadError)", systemImage: "exclamationmark.triangle")
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
                            Label(task.title, systemImage: task.completed ? "checkmark.circle.fill" : "circle")
                        }
                    }
                }
            }
        }
        .navigationTitle(resolvedTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if resolvedCalendarID != nil {
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
                Button("Delete This Occurrence", role: .destructive) {
                    Task { await deleteEvent(scope: .occurrence) }
                }
                Button("Delete Entire Series", role: .destructive) {
                    Task { await deleteEvent(scope: .series) }
                }
            } else {
                Button("Delete Event", role: .destructive) {
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
            actionError = error.localizedDescription
        }
    }

    private var calendarSourceLine: String? {
        let calendar = detail?.calendarName
        let account = detail?.accountID ?? summary?.accountID.nonEmpty
        return [calendar, account].compactMap { $0 }.first
    }

    private var whenText: String {
        guard let start = resolvedStart else { return "Time unavailable" }
        let end = resolvedEnd
        if resolvedAllDay {
            let calendar = Calendar.autoupdatingCurrent
            if let end, !calendar.isDate(start, inSameDayAs: end.addingTimeInterval(-1)) {
                return "All day · \(start.formatted(date: .abbreviated, time: .omitted)) – \(end.formatted(date: .abbreviated, time: .omitted))"
            }
            return "All day · \(start.formatted(date: .complete, time: .omitted))"
        }
        let day = start.formatted(date: .complete, time: .omitted)
        let startTime = start.formatted(date: .omitted, time: .shortened)
        guard let end else { return "\(day) · \(startTime)" }
        let calendar = Calendar.autoupdatingCurrent
        if calendar.isDate(start, inSameDayAs: end) {
            return "\(day) · \(startTime) – \(end.formatted(date: .omitted, time: .shortened))"
        }
        return "\(start.formatted(date: .abbreviated, time: .shortened)) – \(end.formatted(date: .abbreviated, time: .shortened))"
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
            loadError = error.localizedDescription
        }
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
