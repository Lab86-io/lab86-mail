import SwiftUI

// One form for both creating an event and editing an existing one — the
// phone counterpart of the desktop calendar's create/edit dialogs.
struct EventEditorView: View {
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
    @State private var isSaving = false
    @State private var saveError: String?

    init(
        mode: Mode,
        title: String = "",
        allDay: Bool = false,
        start: Date = Self.defaultStart,
        end: Date? = nil,
        location: String = ""
    ) {
        self.mode = mode
        _title = State(initialValue: title)
        _allDay = State(initialValue: allDay)
        _start = State(initialValue: start)
        _end = State(initialValue: end ?? start.addingTimeInterval(3_600))
        _location = State(initialValue: location)
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

                if isCreate, environment.store.accounts.count > 1 {
                    Section("Calendar account") {
                        Picker("Account", selection: $accountID) {
                            ForEach(environment.store.accounts) { account in
                                Text(account.displayName ?? account.email).tag(account.id)
                            }
                        }
                    }
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
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") { Task { await save() } }
                        .disabled(isSaving || title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onChange(of: start) { oldValue, newValue in
                // Keep the duration stable when the start moves.
                end = end.addingTimeInterval(newValue.timeIntervalSince(oldValue))
            }
            .onAppear {
                if accountID.isEmpty { accountID = environment.store.accounts.first?.id ?? "" }
            }
        }
    }

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
                    title: title.trimmingCharacters(in: .whitespaces),
                    start: start,
                    end: max(end, start),
                    allDay: allDay,
                    location: location.trimmingCharacters(in: .whitespaces),
                    description: nil
                )
            case .edit(let accountID, let calendarID, let eventID):
                try await environment.store.updateEvent(
                    accountID: accountID,
                    calendarID: calendarID,
                    eventID: eventID,
                    title: title.trimmingCharacters(in: .whitespaces),
                    start: start,
                    end: max(end, start),
                    location: location.trimmingCharacters(in: .whitespaces)
                )
            }
            dismiss()
        } catch {
            saveError = (error as? BackendError)?.errorDescription ?? error.localizedDescription
        }
    }
}
