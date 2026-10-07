import SwiftUI

// The agent's questions (docs/chat-agentic-pass.md, section 5): `ask_user`,
// `ask_parameters`, `ask_preferences`, and `ask_question_flow`. Each parses
// its tool input into a form, and each answer encodes to the exact output
// object the server's HITL schema expects (see components/ai-elements/
// hitl-parts.tsx and choice-prompt.tsx on the web).

// MARK: - Forms

struct AskUserForm: Equatable, Sendable {
    struct Option: Equatable, Sendable, Identifiable {
        let label: String
        let description: String?
        var id: String { label }
    }

    struct Question: Equatable, Sendable, Identifiable {
        let question: String
        let options: [Option]
        let multiSelect: Bool
        let minSelections: Int?
        let maxSelections: Int?
        var id: String { question }
        var isFreeText: Bool { options.count < 2 }
    }

    let questions: [Question]

    init?(input: JSONValue) {
        var seen: Set<String> = []
        let questions = (input["questions"]?.arrayValue ?? []).compactMap { row -> Question? in
            guard let text = row["question"]?.stringValue?.nilIfBlank else { return nil }
            let key = text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
            guard seen.insert(key).inserted else { return nil }
            let options = (row["options"]?.arrayValue ?? []).compactMap { option -> Option? in
                guard let label = option["label"]?.stringValue?.nilIfBlank else { return nil }
                return Option(label: label, description: option["description"]?.stringValue?.nilIfBlank)
            }
            return Question(
                question: text,
                options: options,
                multiSelect: row["multiSelect"]?.boolValue ?? false,
                minSelections: row["minSelections"]?.doubleValue.map { Int($0) },
                maxSelections: row["maxSelections"]?.doubleValue.map { Int($0) }
            )
        }
        guard !questions.isEmpty else { return nil }
        self.questions = questions
    }
}

struct AskParametersForm: Equatable, Sendable {
    struct Slider: Equatable, Sendable, Identifiable {
        let id: String
        let label: String
        let min: Double
        let max: Double
        let step: Double?
        let value: Double
        let unit: String?
    }

    let title: String?
    let sliders: [Slider]

    init?(input: JSONValue) {
        let sliders = (input["sliders"]?.arrayValue ?? []).compactMap { row -> Slider? in
            guard let id = row["id"]?.stringValue?.nilIfBlank,
                  let min = row["min"]?.doubleValue, let max = row["max"]?.doubleValue, min.isFinite, max.isFinite, max > min
            else { return nil }
            let value = row["value"]?.doubleValue ?? min
            return Slider(
                id: id,
                label: row["label"]?.stringValue?.nilIfBlank ?? id,
                min: min,
                max: max,
                step: row["step"]?.doubleValue.flatMap { $0.isFinite && $0 > 0 ? $0 : nil },
                value: Swift.min(Swift.max(value, min), max),
                unit: row["unit"]?.stringValue?.nilIfBlank
            )
        }
        guard !sliders.isEmpty else { return nil }
        title = input["title"]?.stringValue?.nilIfBlank
        self.sliders = sliders
    }
}

struct AskPreferencesForm: Equatable, Sendable {
    struct Choice: Equatable, Sendable, Identifiable {
        let value: String
        let label: String
        var id: String { value }
    }

    enum Item: Equatable, Sendable, Identifiable {
        case toggleSwitch(id: String, label: String, description: String?, defaultChecked: Bool)
        case toggle(id: String, label: String, description: String?, options: [Choice], defaultValue: String?)
        case select(id: String, label: String, description: String?, options: [Choice], defaultSelected: String?)

        var id: String {
            switch self {
            case .toggleSwitch(let id, _, _, _), .toggle(let id, _, _, _, _), .select(let id, _, _, _, _): id
            }
        }

        /// The value sent back when the person changes nothing.
        var defaultAnswer: JSONValue {
            switch self {
            case .toggleSwitch(_, _, _, let checked): .bool(checked)
            case .toggle(_, _, _, let options, let value): .string(value ?? options.first?.value ?? "")
            case .select(_, _, _, let options, let value): .string(value ?? options.first?.value ?? "")
            }
        }
    }

    let title: String?
    let items: [Item]

    init?(input: JSONValue) {
        let items = (input["items"]?.arrayValue ?? []).compactMap { row -> Item? in
            guard let id = row["id"]?.stringValue?.nilIfBlank else { return nil }
            let label = row["label"]?.stringValue?.nilIfBlank ?? id
            let description = row["description"]?.stringValue?.nilIfBlank
            func choices(_ key: String) -> [Choice] {
                (row[key]?.arrayValue ?? []).compactMap { option in
                    guard let value = option["value"]?.stringValue else { return nil }
                    return Choice(value: value, label: option["label"]?.stringValue?.nilIfBlank ?? value)
                }
            }
            switch row["type"]?.stringValue {
            case "switch":
                return .toggleSwitch(
                    id: id, label: label, description: description,
                    defaultChecked: row["defaultChecked"]?.boolValue ?? false
                )
            case "toggle":
                let options = choices("options")
                guard options.count >= 2 else { return nil }
                return .toggle(
                    id: id, label: label, description: description, options: options,
                    defaultValue: row["defaultValue"]?.stringValue
                )
            case "select":
                let options = choices("selectOptions")
                guard !options.isEmpty else { return nil }
                return .select(
                    id: id, label: label, description: description, options: options,
                    defaultSelected: row["defaultSelected"]?.stringValue
                )
            default:
                return nil
            }
        }
        guard !items.isEmpty else { return nil }
        title = input["title"]?.stringValue?.nilIfBlank
        self.items = items
    }
}

struct AskQuestionFlowForm: Equatable, Sendable {
    struct Step: Equatable, Sendable, Identifiable {
        let title: String
        let description: String?
        let options: [AskUserForm.Option]
        let multiSelect: Bool
        var id: String { title }
    }

    let steps: [Step]

    init?(input: JSONValue) {
        let steps = (input["steps"]?.arrayValue ?? []).enumerated().compactMap { offset, row -> Step? in
            let options = (row["options"]?.arrayValue ?? []).compactMap { option -> AskUserForm.Option? in
                guard let label = option["label"]?.stringValue?.nilIfBlank else { return nil }
                return AskUserForm.Option(label: label, description: option["description"]?.stringValue?.nilIfBlank)
            }
            guard options.count >= 2 else { return nil }
            return Step(
                title: row["title"]?.stringValue?.nilIfBlank ?? "Step \(offset + 1)",
                description: row["description"]?.stringValue?.nilIfBlank,
                options: options,
                multiSelect: row["multiSelect"]?.boolValue ?? false
            )
        }
        guard !steps.isEmpty else { return nil }
        self.steps = steps
    }
}

// MARK: - Output encoding

/// The output objects the server's HITL tools receive. Pure so tests can
/// prove each shape.
enum AssistantQuestionOutput {
    /// `ask_user` and `ask_question_flow`: `{ answers: [{ question, response }] }`.
    static func answers(_ pairs: [(question: String, response: String)]) -> JSONValue {
        .object([
            "answers": .array(pairs.map {
                .object(["question": .string($0.question), "response": .string($0.response)])
            }),
        ])
    }

    /// `ask_parameters`: `{ values: { [id]: number } }`.
    static func parameters(_ values: [String: Double]) -> JSONValue {
        .object(["values": .object(values.mapValues { .number($0) })])
    }

    /// `ask_preferences`: `{ values: { [id]: string | boolean } }`.
    static func preferences(_ values: [String: JSONValue]) -> JSONValue {
        .object(["values": .object(values)])
    }

    /// A choice answer: the picked labels joined with a comma, or the typed
    /// text when the person wrote instead.
    static func response(selected: [String], typed: String) -> String {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { return text }
        return selected.joined(separator: ", ")
    }
}

// MARK: - Card

struct AssistantQuestionCard: View {
    let question: AssistantQuestionPart
    let onAnswer: (JSONValue) -> Void

    var body: some View {
        Group {
            switch question.kind {
            case .user:
                if let form = AskUserForm(input: question.input) {
                    AskUserCard(form: form, answer: question.answer, onAnswer: onAnswer)
                } else {
                    unavailable
                }
            case .parameters:
                if let form = AskParametersForm(input: question.input) {
                    AskParametersCard(form: form, answer: question.answer, onAnswer: onAnswer)
                } else {
                    unavailable
                }
            case .preferences:
                if let form = AskPreferencesForm(input: question.input) {
                    AskPreferencesCard(form: form, answer: question.answer, onAnswer: onAnswer)
                } else {
                    unavailable
                }
            case .questionFlow:
                if let form = AskQuestionFlowForm(input: question.input) {
                    AskQuestionFlowCard(form: form, answer: question.answer, onAnswer: onAnswer)
                } else {
                    unavailable
                }
            }
        }
    }

    private var unavailable: some View {
        QuestionShell(title: "Albatross asked a question this app cannot show") {
            Text("Answer it on the web, or ask again here.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

private struct QuestionShell<Content: View>: View {
    let title: String?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title, !title.isEmpty {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
            }
            content
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .surfaceCard(cornerRadius: 16)
        .accessibilityElement(children: .contain)
    }
}

/// The compact record of an answered question.
private struct AnswerSummary: View {
    let rows: [(label: String, value: String)]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.label)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(row.value.isEmpty ? "—" : row.value)
                        .font(.footnote.weight(.medium))
                }
            }
        }
    }
}

private struct OptionRow: View {
    @Environment(AppEnvironment.self) private var environment
    let option: AskUserForm.Option
    let selected: Bool
    let multiSelect: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: multiSelect
                    ? (selected ? "checkmark.square.fill" : "square")
                    : (selected ? "largecircle.fill.circle" : "circle"))
                    .font(.body)
                    .foregroundStyle(selected ? environment.theme.accentColor : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                    if let description = option.description {
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

private struct SubmitButton: View {
    @Environment(AppEnvironment.self) private var environment
    let label: String
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        HStack {
            Spacer(minLength: 0)
            Button(label, action: action)
                .buttonStyle(.borderedProminent)
                .tint(environment.theme.accentColor)
                .disabled(!enabled)
        }
    }
}

// MARK: - ask_user

private struct AskUserCard: View {
    let form: AskUserForm
    let answer: JSONValue?
    let onAnswer: (JSONValue) -> Void
    @State private var picked: [String: [String]] = [:]
    @State private var typed: [String: String] = [:]

    var body: some View {
        QuestionShell(title: form.questions.count == 1 ? form.questions[0].question : nil) {
            if let answer {
                AnswerSummary(rows: (answer["answers"]?.arrayValue ?? []).map {
                    ($0["question"]?.stringValue ?? "", $0["response"]?.stringValue ?? "")
                })
            } else {
                ForEach(form.questions) { question in
                    VStack(alignment: .leading, spacing: 8) {
                        if form.questions.count > 1 {
                            Text(question.question)
                                .font(.subheadline.weight(.semibold))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        ForEach(question.options) { option in
                            OptionRow(
                                option: option,
                                selected: picked[question.id, default: []].contains(option.label),
                                multiSelect: question.multiSelect
                            ) {
                                toggle(option.label, in: question)
                            }
                        }
                        TextField(
                            question.isFreeText ? "Your answer" : "Or write your own",
                            text: Binding(
                                get: { typed[question.id] ?? "" },
                                set: { typed[question.id] = $0 }
                            ),
                            axis: .vertical
                        )
                        .textFieldStyle(.roundedBorder)
                        .lineLimit(1...4)
                    }
                }
                SubmitButton(label: "Confirm", enabled: canSubmit) {
                    onAnswer(AssistantQuestionOutput.answers(form.questions.map { question in
                        (
                            question: question.question,
                            response: AssistantQuestionOutput.response(
                                selected: picked[question.id] ?? [],
                                typed: typed[question.id] ?? ""
                            )
                        )
                    }))
                }
            }
        }
    }

    private var canSubmit: Bool {
        form.questions.allSatisfy { question in
            let selections = picked[question.id] ?? []
            let text = (typed[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { return true }
            guard !selections.isEmpty else { return false }
            if let minimum = question.minSelections, selections.count < minimum { return false }
            return true
        }
    }

    private func toggle(_ label: String, in question: AskUserForm.Question) {
        var selections = picked[question.id] ?? []
        if question.multiSelect {
            if let index = selections.firstIndex(of: label) {
                selections.remove(at: index)
            } else if let maximum = question.maxSelections, selections.count >= maximum {
                return
            } else {
                selections.append(label)
            }
        } else {
            selections = selections == [label] ? [] : [label]
        }
        picked[question.id] = selections
    }
}

// MARK: - ask_parameters

private struct AskParametersCard: View {
    @Environment(AppEnvironment.self) private var environment
    let form: AskParametersForm
    let answer: JSONValue?
    let onAnswer: (JSONValue) -> Void
    @State private var values: [String: Double] = [:]

    var body: some View {
        QuestionShell(title: form.title ?? "Set the values") {
            if let answer {
                AnswerSummary(rows: form.sliders.map { slider in
                    (slider.label, formatted(answer["values"]?[slider.id]?.doubleValue ?? slider.value, slider))
                })
            } else {
                ForEach(form.sliders) { slider in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(slider.label)
                                .font(.subheadline)
                            Spacer()
                            Text(formatted(values[slider.id] ?? slider.value, slider))
                                .font(.subheadline.weight(.semibold).monospacedDigit())
                                .foregroundStyle(environment.theme.accentColor)
                        }
                        Slider(
                            value: Binding(
                                get: { values[slider.id] ?? slider.value },
                                set: { values[slider.id] = $0 }
                            ),
                            in: slider.min...slider.max,
                            step: slider.step ?? stepFor(slider)
                        )
                        .tint(environment.theme.accentColor)
                        .accessibilityLabel(slider.label)
                    }
                }
                SubmitButton(label: "Use these values", enabled: true) {
                    var record: [String: Double] = [:]
                    for slider in form.sliders {
                        record[slider.id] = values[slider.id] ?? slider.value
                    }
                    onAnswer(AssistantQuestionOutput.parameters(record))
                }
            }
        }
    }

    private func stepFor(_ slider: AskParametersForm.Slider) -> Double {
        let span = slider.max - slider.min
        return span > 100 ? (span / 100).rounded() : 1
    }

    private func formatted(_ value: Double, _ slider: AskParametersForm.Slider) -> String {
        let number = value == value.rounded() ? String(Int(value)) : String(format: "%.1f", value)
        return slider.unit.map { "\(number) \($0)" } ?? number
    }
}

// MARK: - ask_preferences

private struct AskPreferencesCard: View {
    @Environment(AppEnvironment.self) private var environment
    let form: AskPreferencesForm
    let answer: JSONValue?
    let onAnswer: (JSONValue) -> Void
    @State private var values: [String: JSONValue] = [:]

    var body: some View {
        QuestionShell(title: form.title ?? "Preferences") {
            if let answer {
                AnswerSummary(rows: form.items.map { item in
                    (label(item), display(item, answer["values"]?[item.id] ?? item.defaultAnswer))
                })
            } else {
                ForEach(form.items) { item in
                    switch item {
                    case .toggleSwitch(let id, let label, let description, let checked):
                        Toggle(isOn: Binding(
                            get: { values[id]?.boolValue ?? checked },
                            set: { values[id] = .bool($0) }
                        )) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(label).font(.subheadline)
                                if let description {
                                    Text(description).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                        .tint(environment.theme.accentColor)
                    case .toggle(let id, let label, let description, let options, let defaultValue):
                        VStack(alignment: .leading, spacing: 6) {
                            Text(label).font(.subheadline)
                            if let description {
                                Text(description).font(.caption).foregroundStyle(.secondary)
                            }
                            Picker(label, selection: Binding(
                                get: { values[id]?.stringValue ?? defaultValue ?? options[0].value },
                                set: { values[id] = .string($0) }
                            )) {
                                ForEach(options) { option in
                                    Text(option.label).tag(option.value)
                                }
                            }
                            .pickerStyle(.segmented)
                            .labelsHidden()
                        }
                    case .select(let id, let label, let description, let options, let defaultSelected):
                        VStack(alignment: .leading, spacing: 2) {
                            Picker(label, selection: Binding(
                                get: { values[id]?.stringValue ?? defaultSelected ?? options[0].value },
                                set: { values[id] = .string($0) }
                            )) {
                                ForEach(options) { option in
                                    Text(option.label).tag(option.value)
                                }
                            }
                            .pickerStyle(.menu)
                            if let description {
                                Text(description).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                SubmitButton(label: "Save", enabled: true) {
                    var record: [String: JSONValue] = [:]
                    for item in form.items {
                        record[item.id] = values[item.id] ?? item.defaultAnswer
                    }
                    onAnswer(AssistantQuestionOutput.preferences(record))
                }
            }
        }
    }

    private func label(_ item: AskPreferencesForm.Item) -> String {
        switch item {
        case .toggleSwitch(_, let label, _, _), .toggle(_, let label, _, _, _), .select(_, let label, _, _, _): label
        }
    }

    private func display(_ item: AskPreferencesForm.Item, _ value: JSONValue) -> String {
        switch item {
        case .toggleSwitch:
            return value.boolValue == true ? "On" : "Off"
        case .toggle(_, _, _, let options, _), .select(_, _, _, let options, _):
            let raw = value.stringValue ?? ""
            return options.first { $0.value == raw }?.label ?? raw
        }
    }
}

// MARK: - ask_question_flow

private struct AskQuestionFlowCard: View {
    let form: AskQuestionFlowForm
    let answer: JSONValue?
    let onAnswer: (JSONValue) -> Void
    @State private var stepIndex = 0
    @State private var picked: [Int: [String]] = [:]

    var body: some View {
        QuestionShell(title: answer == nil ? nil : "Your choices") {
            if let answer {
                AnswerSummary(rows: (answer["answers"]?.arrayValue ?? []).map {
                    ($0["question"]?.stringValue ?? "", $0["response"]?.stringValue ?? "")
                })
            } else {
                let step = form.steps[min(stepIndex, form.steps.count - 1)]
                Text("Step \(stepIndex + 1) of \(form.steps.count)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(step.title)
                    .font(.subheadline.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                if let description = step.description {
                    Text(description).font(.caption).foregroundStyle(.secondary)
                }
                ForEach(step.options) { option in
                    OptionRow(
                        option: option,
                        selected: picked[stepIndex, default: []].contains(option.label),
                        multiSelect: step.multiSelect
                    ) {
                        var selections = picked[stepIndex] ?? []
                        if step.multiSelect {
                            if let index = selections.firstIndex(of: option.label) {
                                selections.remove(at: index)
                            } else {
                                selections.append(option.label)
                            }
                        } else {
                            selections = [option.label]
                        }
                        picked[stepIndex] = selections
                    }
                }
                HStack {
                    if stepIndex > 0 {
                        Button("Back") { stepIndex -= 1 }
                            .buttonStyle(.bordered)
                    }
                    Spacer(minLength: 0)
                    SubmitButton(
                        label: stepIndex == form.steps.count - 1 ? "Finish" : "Next",
                        enabled: !(picked[stepIndex] ?? []).isEmpty
                    ) {
                        if stepIndex < form.steps.count - 1 {
                            stepIndex += 1
                        } else {
                            onAnswer(AssistantQuestionOutput.answers(form.steps.enumerated().map { offset, step in
                                (question: step.title, response: (picked[offset] ?? []).joined(separator: ", "))
                            }))
                        }
                    }
                }
            }
        }
        .animation(.easeOut(duration: 0.2), value: stepIndex)
    }
}
