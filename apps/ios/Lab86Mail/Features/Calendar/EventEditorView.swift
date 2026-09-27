import SwiftUI

// One form for both creating an event and editing an existing one — the
// phone counterpart of the desktop calendar's create/edit dialogs.
struct EventEditorView: View {
    enum EventRepeat: String, CaseIterable, Identifiable {
        case never, daily, weekly, monthly, yearly
        var id: Self { self }
        var title: String { rawValue.capitalized }
        var rule: [String]? {
            switch self {
            case .never: nil
            case .daily: ["RRULE:FREQ=DAILY"]
            case .weekly: ["RRULE:FREQ=WEEKLY"]
            case .monthly: ["RRULE:FREQ=MONTHLY"]
            case .yearly: ["RRULE:FREQ=YEARLY"]
            }
        }
    }

    enum Mode {
        case create
        case edit(accountID: String, calendarID: String, eventID: String)
    }

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss

    let mode: Mode
    @State private var accountID: String = ""
    @State private var title: String
    @State private var allDay: Bool
    @State private var start: Date
    @State private var end: Date
    @State private var location: String
    @State private var calendarID: String
    @State private var eventRepeat: EventRepeat
    @State private var attendeeText: String
    @State private var notes: String
    @State private var isSaving = false
    @State private var saveError: String?
    @State private var showsDiscardConfirmation = false
    @State private var showsInviteConfirmation = false
    @State private var baseline = ""
    @State private var didSeed = false
    // The values the form opened with. An edit sends only what differs.
    private let initialSnapshot: EventFormSnapshot

    init(
        mode: Mode,
        title: String = "",
        allDay: Bool = false,
        start: Date = Self.defaultStart,
        end: Date? = nil,
        location: String = "",
        calendarID: String = "",
        recurrence: [String] = [],
        attendees: [String] = [],
        notes: String = ""
    ) {
        self.mode = mode
        // A stored all-day event ends the day after its last day; the form
        // shows the last day itself (CAL-4).
        let dates = EventWriteFields.editorDates(start: start, end: end, allDay: allDay)
        let seededEnd = dates.end ?? dates.start.addingTimeInterval(3_600)
        let preset = Self.repeatPreset(recurrence)
        _title = State(initialValue: title)
        _allDay = State(initialValue: allDay)
        _start = State(initialValue: dates.start)
        _end = State(initialValue: seededEnd)
        _location = State(initialValue: location)
        _calendarID = State(initialValue: calendarID)
        _eventRepeat = State(initialValue: preset)
        _attendeeText = State(initialValue: attendees.joined(separator: ", "))
        _notes = State(initialValue: notes)
        initialSnapshot = EventFormSnapshot(
            title: title.trimmingCharacters(in: .whitespaces),
            allDay: allDay,
            start: dates.start,
            end: max(seededEnd, dates.start),
            location: location.trimmingCharacters(in: .whitespaces),
            repeatRule: preset.rule,
            attendees: Self.emails(in: attendees.joined(separator: ", ")),
            notes: notes.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    private var currentSnapshot: EventFormSnapshot {
        EventFormSnapshot(
            title: title.trimmingCharacters(in: .whitespaces),
            allDay: allDay,
            start: start,
            end: max(end, start),
            location: location.trimmingCharacters(in: .whitespaces),
            repeatRule: eventRepeat.rule,
            attendees: attendeeEmails,
            notes: notes.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    static var defaultStart: Date {
        let calendar = Calendar.autoupdatingCurrent
        let next = calendar.nextDate(
            after: .now,
            matching: DateComponents(minute: 0),
            matchingPolicy: .nextTime
        )
        return next ?? .now
    }

    private var isCreate: Bool {
        if case .create = mode { return true }
        return false
    }

    // Pure policy over value types; nonisolated so tests (which run off the
    // main actor) can call it without tripping the isolation assertion.
    nonisolated static func canCreateEvent(
        accountID: String,
        calendarID: String,
        calendars: [CalendarChoice],
        unauthorizedAccountIDs: Set<String>
    ) -> Bool {
        guard !accountID.isEmpty, !unauthorizedAccountIDs.contains(accountID) else { return false }
        let writable = calendars.filter { $0.accountID == accountID && !$0.isReadOnly }
        if calendarID.isEmpty { return !writable.isEmpty }
        return writable.contains { $0.calendarID == calendarID }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title)
                    TextField("Location", text: $location)
                }

                Section {
                    Toggle("All day", isOn: $allDay)
                    DatePicker(
                        "Starts",
                        selection: $start,
                        displayedComponents: allDay ? [.date] : [.date, .hourAndMinute]
                    )
                    DatePicker(
                        "Ends",
                        selection: $end,
                        in: start...,
                        displayedComponents: allDay ? [.date] : [.date, .hourAndMinute]
                    )
                }

                Section("Calendar") {
                    if isCreate, availableAccounts.count > 1 {
                        Picker("Account", selection: $accountID) {
                            ForEach(availableAccounts) { account in
                                Text(account.displayName ?? account.email).tag(account.id)
                            }
                        }
                    }
                    Picker("Calendar", selection: $calendarID) {
                        Text("Primary calendar").tag("")
                        ForEach(availableCalendars) { calendar in
                            Text(calendar.name).tag(calendar.calendarID)
                        }
                    }
                    Picker("Repeat", selection: $eventRepeat) {
                        ForEach(EventRepeat.allCases) { option in
                            Text(option.title).tag(option)
                        }
                    }
                }

                Section("People") {
                    TextField("Invitee email addresses", text: $attendeeText, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.emailAddress)
                    Text("Invitations are sent only after you confirm Save.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("Notes") {
                    TextEditor(text: $notes)
                        .frame(minHeight: 90)
                }

                if let saveError {
                    Section {
                        Text(saveError).font(.footnote).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(isCreate ? "New event" : "Edit event")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        if isDirty { showsDiscardConfirmation = true } else { dismiss() }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") {
                        if attendeeEmails.isEmpty {
                            Task { await save() }
                        } else {
                            showsInviteConfirmation = true
                        }
                    }
                        .disabled(
                            isSaving
                                || title.trimmingCharacters(in: .whitespaces).isEmpty
                                || (isCreate && !canCreateOnSelectedAccount)
                        )
                }
            }
            .onChange(of: start) { oldValue, newValue in
                // Keep the duration stable when the start moves.
                end = end.addingTimeInterval(newValue.timeIntervalSince(oldValue))
            }
            .onAppear {
                if accountID.isEmpty { accountID = environment.store.accounts.first?.id ?? "" }
                Task {
                    await environment.store.refreshCalendarChoices()
                    await MainActor.run {
                        if isCreate,
                           environment.store.calendarUnauthorizedAccountIDs.contains(accountID)
                            || !availableCalendars.contains(where: { !$0.isReadOnly }) {
                            accountID = environment.store.calendarChoices.first(where: {
                                !$0.isReadOnly
                                    && !environment.store.calendarUnauthorizedAccountIDs.contains($0.accountID)
                                    && $0.isPrimary
                            })?.accountID
                                ?? environment.store.calendarChoices.first(where: {
                                    !$0.isReadOnly
                                        && !environment.store.calendarUnauthorizedAccountIDs.contains($0.accountID)
                                })?.accountID
                                ?? accountID
                        }
                        if calendarID.isEmpty {
                            calendarID = availableCalendars.first(where: \.isPrimary)?.calendarID ?? ""
                        }
                        baseline = fingerprint
                        didSeed = true
                    }
                }
            }
            .onChange(of: accountID) {
                if !availableCalendars.contains(where: { $0.calendarID == calendarID }) {
                    calendarID = availableCalendars.first(where: \.isPrimary)?.calendarID
                        ?? availableCalendars.first?.calendarID
                        ?? ""
                }
            }
            .interactiveDismissDisabled(isDirty)
            .confirmationDialog(
                "Discard event changes?",
                isPresented: $showsDiscardConfirmation,
                titleVisibility: .visible
            ) {
                Button("Discard Changes", role: .destructive) { dismiss() }
                Button("Keep Editing", role: .cancel) {}
            }
            .confirmationDialog(
                "Send invitations?",
                isPresented: $showsInviteConfirmation,
                titleVisibility: .visible
            ) {
                Button("Save and Invite \(attendeeEmails.count) People") {
                    Task { await save() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The connected calendar provider will email these attendees.")
            }
        }
    }

    private var availableCalendars: [CalendarChoice] {
        environment.store.calendarChoices.filter {
            $0.accountID == accountID
                && !$0.isReadOnly
                && !environment.store.calendarUnauthorizedAccountIDs.contains($0.accountID)
        }
    }

    private var availableAccounts: [AccountSummary] {
        environment.store.accounts.filter {
            !environment.store.calendarUnauthorizedAccountIDs.contains($0.id)
        }
    }

    private var canCreateOnSelectedAccount: Bool {
        Self.canCreateEvent(
            accountID: accountID,
            calendarID: calendarID,
            calendars: environment.store.calendarChoices,
            unauthorizedAccountIDs: environment.store.calendarUnauthorizedAccountIDs
        )
    }

    private var attendeeEmails: [String] { Self.emails(in: attendeeText) }

    private static func emails(in text: String) -> [String] {
        text
            .split(whereSeparator: { $0 == "," || $0 == ";" || $0.isWhitespace })
            .map(String.init)
            .filter { $0.contains("@") }
    }

    private var fingerprint: String {
        [
            accountID,
            calendarID,
            title,
            String(allDay),
            String(start.timeIntervalSince1970),
            String(end.timeIntervalSince1970),
            location,
            eventRepeat.rawValue,
            attendeeText,
            notes,
        ].joined(separator: "\u{1F}")
    }

    private var isDirty: Bool { didSeed && fingerprint != baseline }

    private func save() async {
        isSaving = true
        saveError = nil
        defer { isSaving = false }
        do {
            switch mode {
            case .create:
                guard canCreateOnSelectedAccount else {
                    throw BackendError.server(
                        status: 400,
                        message: "Select an authorized writable calendar."
                    )
                }
                try await environment.store.createEvent(
                    accountID: accountID,
                    calendarID: calendarID.isEmpty ? nil : calendarID,
                    title: title.trimmingCharacters(in: .whitespaces),
                    start: start,
                    end: max(end, start),
                    allDay: allDay,
                    location: location.trimmingCharacters(in: .whitespaces),
                    description: notes.trimmingCharacters(in: .whitespacesAndNewlines),
                    attendeeEmails: attendeeEmails,
                    recurrence: eventRepeat.rule
                )
            case .edit(let accountID, let calendarID, let eventID):
                // Only what the user changed (CAL-2). A series edit opened
                // from one instance must not carry that instance's times, or
                // an empty repeat rule, to the whole series.
                let changes = EventWriteFields.changedArguments(from: initialSnapshot, to: currentSnapshot)
                if !changes.isEmpty {
                    try await environment.store.updateEvent(
                        accountID: accountID,
                        calendarID: calendarID,
                        eventID: eventID,
                        changes: changes
                    )
                }
            }
            dismiss()
        } catch {
            saveError = (error as? BackendError)?.errorDescription ?? error.localizedDescription
        }
    }

    private static func repeatPreset(_ recurrence: [String]) -> EventRepeat {
        let joined = recurrence.joined(separator: " ").uppercased()
        if joined.contains("FREQ=DAILY") { return .daily }
        if joined.contains("FREQ=WEEKLY") { return .weekly }
        if joined.contains("FREQ=MONTHLY") { return .monthly }
        if joined.contains("FREQ=YEARLY") { return .yearly }
        return .never
    }
}
