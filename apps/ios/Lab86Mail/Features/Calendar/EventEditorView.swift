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
        _title = State(initialValue: title)
        _allDay = State(initialValue: allDay)
        _start = State(initialValue: start)
        _end = State(initialValue: end ?? start.addingTimeInterval(3_600))
        _location = State(initialValue: location)
        _calendarID = State(initialValue: calendarID)
        _eventRepeat = State(initialValue: Self.repeatPreset(recurrence))
        _attendeeText = State(initialValue: attendees.joined(separator: ", "))
        _notes = State(initialValue: notes)
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
                    if isCreate, environment.store.accounts.count > 1 {
                        Picker("Account", selection: $accountID) {
                            ForEach(environment.store.accounts) { account in
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
                        .disabled(isSaving || title.trimmingCharacters(in: .whitespaces).isEmpty)
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
            $0.accountID == accountID && !$0.isReadOnly
        }
    }

    private var attendeeEmails: [String] {
        attendeeText
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
                guard !accountID.isEmpty else {
                    throw BackendError.server(status: 400, message: "Connect a mail account first.")
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
                try await environment.store.updateEvent(
                    accountID: accountID,
                    calendarID: calendarID,
                    eventID: eventID,
                    title: title.trimmingCharacters(in: .whitespaces),
                    start: start,
                    end: max(end, start),
                    allDay: allDay,
                    location: location.trimmingCharacters(in: .whitespaces),
                    description: notes.trimmingCharacters(in: .whitespacesAndNewlines),
                    attendeeEmails: attendeeEmails,
                    recurrence: eventRepeat.rule ?? []
                )
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
