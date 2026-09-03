import SwiftUI

/// The presets under "Later", each with its resolved date on the right, so
/// the user sees the real date before the tap.
enum HorizonPresets {
    struct Preset: Identifiable, Equatable {
        let id: String
        let title: String
        let date: Date
        /// "Mon 8 Sep", "1 Oct", "3 Dec".
        let resolved: String
    }

    static func make(now: Date, calendar: Calendar = .current) -> [Preset] {
        let today = calendar.startOfDay(for: now)
        let weekday = calendar.component(.weekday, from: today) - 1
        var untilMonday = (1 - weekday + 7) % 7
        if untilMonday == 0 { untilMonday = 7 }
        let nextWeek = calendar.date(byAdding: .day, value: untilMonday, to: today) ?? today
        let monthStart = calendar.date(from: calendar.dateComponents([.year, .month], from: today)) ?? today
        let nextMonth = calendar.date(byAdding: .month, value: 1, to: monthStart) ?? today
        let threeMonths = calendar.date(byAdding: .month, value: 3, to: today) ?? today
        return [
            Preset(id: "next-week", title: "Next week", date: nextWeek, resolved: resolved(nextWeek, weekday: true, calendar: calendar)),
            Preset(id: "next-month", title: "Next month", date: nextMonth, resolved: resolved(nextMonth, weekday: false, calendar: calendar)),
            Preset(id: "three-months", title: "In three months", date: threeMonths, resolved: resolved(threeMonths, weekday: false, calendar: calendar)),
        ]
    }

    static func resolved(_ date: Date, weekday: Bool, calendar: Calendar = .current) -> String {
        let locale = Locale(identifier: "en_US")
        var style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        style = weekday ? style.weekday(.abbreviated).day().month(.abbreviated) : style.day().month(.abbreviated)
        return date.formatted(style)
    }

    /// What the field prints under the user's words.
    static func hintLine(for text: String, now: Date, calendar: Calendar = .current) -> String? {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return nil }
        guard let parsed = WorkHorizonHint.parse(clean, now: now, calendar: calendar) else {
            return "Kept as your words. No date."
        }
        if parsed.kind == .someday { return "Someday" }
        if let notBefore = parsed.notBefore {
            return "Back on \(WorkHorizon.shortDate(notBefore, now: now, calendar: calendar))"
        }
        if let by = parsed.by, parsed.kind == .now {
            return "By \(WorkHorizon.shortDate(by, now: now, calendar: calendar))"
        }
        return "Kept as your words. No date."
    }
}

/// The horizon the sheet writes. Nil means "now, no target": the horizon is
/// cleared.
enum HorizonSheetResult {
    static func horizon(
        kind: WorkHorizonKind,
        notBefore: Date?,
        by: Date?,
        label: String?
    ) -> WorkHorizon? {
        let cleanLabel = label?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank.map { String($0.prefix(120)) }
        switch kind {
        case .now:
            guard by != nil else { return nil }
            return WorkHorizon(kind: .now, by: by)
        case .later:
            return WorkHorizon(kind: .later, notBefore: notBefore, by: by, label: cleanLabel)
        case .someday:
            return WorkHorizon(kind: .someday, label: cleanLabel)
        }
    }
}

/// Writes a horizon through the durable command outbox, applies it locally
/// at once, and lets the next refresh settle it against the server.
enum WorkHorizonWriter {
    @MainActor
    static func set(_ horizon: WorkHorizon?, for workID: String, environment: AppEnvironment) async -> Bool {
        guard let ownerID = environment.sessionStore.ownerID else { return false }
        do {
            _ = try await environment.commandOutbox.enqueue(
                ownerID: ownerID,
                command: .workSetHorizon(
                    WorkSetHorizonCommandPayload(
                        workID: workID,
                        horizon: horizon.map(WorkHorizonCommandRequest.init)
                    )
                )
            )
        } catch {
            return false
        }
        environment.store.applyWorkHorizon(workID, horizon: horizon)
        // A failed flush keeps the command queued. The local state already
        // says what the user chose, so this is still a success.
        _ = await environment.flushCommandOutbox(ownerID: ownerID)
        await environment.store.refreshWork()
        return true
    }
}

/// One control: Now / Later / Someday. "Later" reveals presets with the
/// resolved date on the right, a date picker, and one field for the user's
/// own words. A disclosure row holds the optional soft target.
struct HorizonSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let initial: WorkHorizon?
    let onSet: (WorkHorizon?) async -> Bool

    @State private var kind: WorkHorizonKind
    @State private var notBefore: Date?
    @State private var by: Date?
    @State private var hint = ""
    @State private var label: String?
    @State private var showsPicker = false
    @State private var showsTarget: Bool
    @State private var isSaving = false
    @State private var failed = false
    @State private var didSet = 0
    private let now = Date.now

    init(title: String, initial: WorkHorizon?, onSet: @escaping (WorkHorizon?) async -> Bool) {
        self.title = title
        self.initial = initial
        self.onSet = onSet
        _kind = State(initialValue: initial?.kind ?? .now)
        _notBefore = State(initialValue: initial?.notBefore)
        _by = State(initialValue: initial?.by)
        _label = State(initialValue: initial?.label)
        _showsTarget = State(initialValue: initial?.by != nil)
    }

    private var presets: [HorizonPresets.Preset] { HorizonPresets.make(now: now) }

    private var parsedLine: String? { HorizonPresets.hintLine(for: hint, now: now) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Horizon", selection: $kind) {
                        ForEach(WorkHorizonKind.allCases, id: \.self) { value in
                            Text(value.label).tag(value)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                } footer: {
                    Text(kindNote)
                }

                if kind == .later {
                    Section {
                        ForEach(presets) { preset in
                            Button {
                                choose(preset.date)
                            } label: {
                                HStack {
                                    Text(preset.title).foregroundStyle(.primary)
                                    Spacer()
                                    Text(preset.resolved)
                                        .foregroundStyle(.secondary)
                                        .monospacedDigit()
                                    if isChosen(preset.date) {
                                        Text("Chosen")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                        Button {
                            withAnimation(WorkMotion.cross) { showsPicker.toggle() }
                        } label: {
                            HStack {
                                Text("Pick a date").foregroundStyle(.primary)
                                Spacer()
                                if let notBefore, !isPreset(notBefore) {
                                    Text(HorizonPresets.resolved(notBefore, weekday: false))
                                        .foregroundStyle(.secondary)
                                        .monospacedDigit()
                                }
                            }
                        }
                        if showsPicker {
                            DatePicker(
                                "Back on",
                                selection: Binding(
                                    get: { notBefore ?? defaultPickerDate },
                                    set: { notBefore = Calendar.current.startOfDay(for: $0) }
                                ),
                                in: now...,
                                displayedComponents: .date
                            )
                            .datePickerStyle(.graphical)
                            .labelsHidden()
                        }
                    } header: {
                        Text("Back on")
                    }

                    Section {
                        TextField("Or say it: after the wedding", text: $hint)
                            .textInputAutocapitalization(.never)
                            .onChange(of: hint) { _, value in applyHint(value) }
                        if let parsedLine {
                            Text(parsedLine)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .contentTransition(.opacity)
                                .animation(WorkMotion.cross, value: parsedLine)
                        }
                    }
                }

                if kind == .someday {
                    Section {
                        TextField("Your words: when the house is done", text: $hint)
                            .textInputAutocapitalization(.never)
                            .onChange(of: hint) { _, value in label = value.nilIfBlank }
                    }
                }

                Section {
                    DisclosureGroup("Soft target", isExpanded: $showsTarget) {
                        DatePicker(
                            "By",
                            selection: Binding(
                                get: { by ?? defaultTargetDate },
                                set: { by = Calendar.current.startOfDay(for: $0) }
                            ),
                            in: now...,
                            displayedComponents: .date
                        )
                        if by != nil {
                            Button("Remove target") { by = nil }
                        }
                    }
                } footer: {
                    Text("A target is shown, never enforced.")
                }

                if failed {
                    Section {
                        Text("Could not save. Try again.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Set") { Task { await set() } }
                        .disabled(isSaving)
                }
            }
            .onChange(of: showsTarget) { _, expanded in
                if expanded, by == nil { by = defaultTargetDate }
            }
        }
        .presentationDetents([.medium, .large])
        .modifier(HorizonHaptics(kind: kind, didSet: didSet))
    }

    private var kindNote: String {
        switch kind {
        case .now: "Albatross carries this now."
        case .later: "It sleeps until its date, then comes back with one line."
        case .someday: "It sleeps until you move it. Nobody asks about it."
        }
    }

    private var defaultPickerDate: Date {
        presets.first?.date ?? now
    }

    private var defaultTargetDate: Date {
        let base = notBefore ?? Calendar.current.startOfDay(for: now)
        return Calendar.current.date(byAdding: .day, value: 7, to: base) ?? base
    }

    private func isChosen(_ date: Date) -> Bool {
        guard let notBefore else { return false }
        return Calendar.current.isDate(notBefore, inSameDayAs: date)
    }

    private func isPreset(_ date: Date) -> Bool {
        presets.contains { Calendar.current.isDate($0.date, inSameDayAs: date) }
    }

    private func choose(_ date: Date) {
        notBefore = date
        label = nil
        hint = ""
        showsPicker = false
    }

    /// Each keystroke runs the deterministic parse. A date sets the wake
    /// date. Words without a date keep only the label.
    private func applyHint(_ value: String) {
        let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else {
            label = nil
            return
        }
        guard let parsed = WorkHorizonHint.parse(clean, now: now) else {
            label = clean
            notBefore = nil
            return
        }
        if parsed.kind == .someday {
            kind = .someday
            label = parsed.label ?? clean
            return
        }
        notBefore = parsed.notBefore
        if let target = parsed.by {
            by = target
            showsTarget = true
        }
        label = parsed.label ?? clean
    }

    private func set() async {
        isSaving = true
        failed = false
        let horizon = HorizonSheetResult.horizon(kind: kind, notBefore: notBefore, by: by, label: label)
        let ok = await onSet(horizon)
        isSaving = false
        if ok {
            didSet += 1
            dismiss()
        } else {
            failed = true
        }
    }
}

/// `.selection` on a segment change, `.success` on "Set". Silent on the Mac.
private struct HorizonHaptics: ViewModifier {
    let kind: WorkHorizonKind
    let didSet: Int

    func body(content: Content) -> some View {
        #if os(iOS)
        content
            .sensoryFeedback(.selection, trigger: kind)
            .sensoryFeedback(.success, trigger: didSet)
        #else
        content
        #endif
    }
}
