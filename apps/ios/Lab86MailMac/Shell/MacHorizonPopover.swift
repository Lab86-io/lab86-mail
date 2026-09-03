import SwiftUI

// The horizon control on the Mac: a popover under the caption button in the
// Work detail, and under "Change" on a Later card. One segmented control,
// one typed date field with a live parse line, one field for the user's own
// words. Return commits. Esc closes the popover.

// The pure part: what the parse line says for the typed text.
enum MacHorizonPopoverCopy {
    static let width: CGFloat = 320
    static let datePlaceholder = "Not before, for example next month"
    static let wordsPlaceholder = "In your words"
    static let parseFailed = "Type a date or a phrase like in two weeks."
    static let wordsOnly = "Kept as your words. No date."
    static let saveFailed = "Could not save. Try again."

    // The typed text as a horizon. A bare date ("Nov 1", "Friday",
    // "2026-11-01") reads as a sleep date, so the field takes dates as well
    // as phrases.
    static func parse(_ text: String, now: Date, calendar: Calendar = .current) -> WorkHorizon? {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return nil }
        if let phrase = WorkHorizonHint.parse(clean, now: now, calendar: calendar) {
            return phrase
        }
        if let date = isoDate(clean, calendar: calendar) {
            return WorkHorizon(kind: .later, notBefore: date, label: nil)
        }
        if let bare = WorkHorizonHint.parse("not before \(clean)", now: now, calendar: calendar),
           bare.notBefore != nil {
            // The preposition was ours, not the user's. Keep only their words.
            return WorkHorizon(kind: .later, notBefore: bare.notBefore, label: nil)
        }
        return nil
    }

    // "Sunday, Nov 1" for a date, "Someday" for a someday phrase, the
    // words-only line for a phrase with no date, the failure line otherwise.
    static func parseLine(for text: String, now: Date, calendar: Calendar = .current) -> String {
        guard let parsed = parse(text, now: now, calendar: calendar) else { return parseFailed }
        if parsed.kind == .someday { return "Someday" }
        if let notBefore = parsed.notBefore { return longDate(notBefore, now: now, calendar: calendar) }
        if parsed.kind == .now, let by = parsed.by {
            return "By \(longDate(by, now: now, calendar: calendar))"
        }
        return wordsOnly
    }

    // "Sunday, Nov 1", with the year once it differs from now.
    static func longDate(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        let locale = Locale(identifier: "en_US")
        var style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        style = style.weekday(.wide).month(.abbreviated).day()
        if calendar.component(.year, from: date) != calendar.component(.year, from: now) {
            style = style.year()
        }
        return date.formatted(style)
    }

    private static func isoDate(_ text: String, calendar: Calendar) -> Date? {
        let parts = text.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, parts[0] > 1_900, (1...12).contains(parts[1]), (1...31).contains(parts[2]) else {
            return nil
        }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
}

struct MacHorizonPopover: View {
    let initial: WorkHorizon?
    let onSet: (WorkHorizon?) async -> Bool
    let onClose: () -> Void

    @State private var kind: WorkHorizonKind
    @State private var dateText = ""
    @State private var words: String
    @State private var isSaving = false
    @State private var failed = false
    @FocusState private var focus: Field?
    private let now = Date.now

    private enum Field: Hashable {
        case date
        case words
    }

    init(initial: WorkHorizon?, onSet: @escaping (WorkHorizon?) async -> Bool, onClose: @escaping () -> Void) {
        self.initial = initial
        self.onSet = onSet
        self.onClose = onClose
        _kind = State(initialValue: initial?.kind ?? .now)
        _words = State(initialValue: initial?.label ?? "")
    }

    private var parsed: WorkHorizon? { MacHorizonPopoverCopy.parse(dateText, now: now) }

    private var parseLine: String { MacHorizonPopoverCopy.parseLine(for: dateText, now: now) }

    // The date the popover writes: the typed one, else the one it opened with.
    private var notBefore: Date? {
        if !dateText.trimmingCharacters(in: .whitespaces).isEmpty { return parsed?.notBefore }
        return initial?.notBefore
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("Horizon", selection: $kind) {
                ForEach(WorkHorizonKind.allCases, id: \.self) { value in
                    Text(value.label).tag(value)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            switch kind {
            case .now:
                Text("Albatross carries this now.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            case .later:
                VStack(alignment: .leading, spacing: 4) {
                    TextField(MacHorizonPopoverCopy.datePlaceholder, text: $dateText)
                        .textFieldStyle(.roundedBorder)
                        .focused($focus, equals: .date)
                        .onSubmit { Task { await commit() } }
                    Text(currentDateLine)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .contentTransition(.opacity)
                        .animation(WorkMotion.cross, value: currentDateLine)
                        .accessibilityLabel("Parsed date, \(currentDateLine)")
                }
                wordsField
            case .someday:
                Text("It sleeps until you move it. Nobody asks about it.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                wordsField
            }

            HStack {
                if failed {
                    Text(MacHorizonPopoverCopy.saveFailed)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Button("Cancel", action: onClose)
                    .keyboardShortcut(.cancelAction)
                Button(isSaving ? "Saving…" : "Set") { Task { await commit() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(isSaving)
            }
        }
        .padding(16)
        .frame(width: MacHorizonPopoverCopy.width)
        .onChange(of: dateText) { _, value in
            // A someday phrase in the date field moves the segment. The
            // words field then keeps the phrase.
            if let parsed = MacHorizonPopoverCopy.parse(value, now: now), parsed.kind == .someday {
                kind = .someday
                if words.isEmpty { words = parsed.label ?? value }
            }
        }
        .onChange(of: kind) { _, value in
            focus = value == .later ? .date : (value == .someday ? .words : nil)
        }
        .task {
            if kind == .later { focus = .date }
        }
    }

    private var wordsField: some View {
        TextField(MacHorizonPopoverCopy.wordsPlaceholder, text: $words)
            .textFieldStyle(.roundedBorder)
            .focused($focus, equals: .words)
            .onSubmit { Task { await commit() } }
    }

    // With no typed text the line states the date the popover opened with.
    private var currentDateLine: String {
        if dateText.trimmingCharacters(in: .whitespaces).isEmpty, let date = initial?.notBefore, date > now {
            return MacHorizonPopoverCopy.longDate(date, now: now)
        }
        return parseLine
    }

    private func commit() async {
        guard !isSaving else { return }
        isSaving = true
        failed = false
        let label: String?
        if kind == .later, words.trimmingCharacters(in: .whitespaces).isEmpty {
            label = parsed?.label ?? dateText.nilIfBlank
        } else {
            label = words.nilIfBlank
        }
        let horizon = HorizonSheetResult.horizon(
            kind: kind,
            notBefore: kind == .later ? notBefore : nil,
            by: initial?.by,
            label: label
        )
        let ok = await onSet(horizon)
        isSaving = false
        if ok {
            onClose()
        } else {
            failed = true
        }
    }
}
