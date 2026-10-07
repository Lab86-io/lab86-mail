import Foundation

// The Albatross thread on the wire (lib/albatross/thread-contract.ts): form
// questions, a Work question as the thread shows it, a run with its question,
// the canonical chat session of a Work, and the `step_run` tool shape. Decoded
// at the repository boundary with the same tolerance as StepRunModels.swift: a
// missing key reads as nil or empty, and an unknown word reads as a safe
// default, so a newer server never breaks decoding.

// MARK: - Form questions

/// One option of a choice field.
struct FormOption: Identifiable, Hashable, Sendable {
    struct CalendarNote: Hashable, Sendable {
        enum Fit: String, Hashable, Sendable {
            case free, conflict
        }

        let fit: Fit
        /// "Free on your calendar", "Conflicts with Team sync".
        let note: String
    }

    let id: String
    let label: String
    /// One line under the label: "Mon, Oct 19 · 4:00–8:00 PM · Zoom · $70".
    let detail: String?
    /// The tag of the one best option ("Matches what you said"). The card
    /// shows it and selects this option first.
    let recommended: String?
    let calendar: CalendarNote?

    init(id: String, label: String, detail: String? = nil, recommended: String? = nil, calendar: CalendarNote? = nil) {
        self.id = id
        self.label = label
        self.detail = detail
        self.recommended = recommended
        self.calendar = calendar
    }

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue?.nilIfBlank,
              let label = json["label"]?.stringValue?.nilIfBlank else { return nil }
        self.id = id
        self.label = label
        detail = json["detail"]?.stringValue?.nilIfBlank
        recommended = json["recommended"]?.stringValue?.nilIfBlank
        if let calendar = json["calendar"], calendar.objectValue != nil,
           let note = calendar["note"]?.stringValue?.nilIfBlank {
            self.calendar = CalendarNote(
                fit: calendar["fit"]?.stringValue == "conflict" ? .conflict : .free,
                note: note
            )
        } else {
            calendar = nil
        }
    }
}

/// One field of a form question.
struct FormField: Identifiable, Hashable, Sendable {
    enum Kind: String, Hashable, Sendable, CaseIterable {
        case choice, text, number, phone, email, date, name, address, contact

        /// An unknown kind reads as text, so the user can still answer.
        static func from(_ raw: String?) -> Kind {
            raw.flatMap { Kind(rawValue: $0) } ?? .text
        }

        /// The kinds whose value is an object, not a string.
        var isStructured: Bool {
            self == .name || self == .address || self == .contact
        }

        /// The focus id suffix of the first sub-field of a structured kind
        /// (FormFieldViews: name `.first`, address `.line1`, contact `.name`).
        var firstFocusSuffix: String? {
            switch self {
            case .name: "first"
            case .address: "line1"
            case .contact: "name"
            default: nil
            }
        }
    }

    let id: String
    let label: String
    let kind: Kind
    /// One line under the label.
    let help: String?
    /// Default true.
    let required: Bool
    /// choice only: 2 to 8 options.
    let options: [FormOption]
    /// choice only: more than one option.
    let multiple: Bool
    /// choice only: a free text "Other" answer.
    let allowOther: Bool
    /// Binds the field to a personal detail. The client fills it from the
    /// saved details, and "Save to my details" saves it.
    let detailKey: String?
    /// A value the server found (for example in an email signature).
    let value: JSONValue?
    /// Where `value` came from: "From your email signature".
    let valueSource: String?
    let placeholder: String?

    init(
        id: String,
        label: String,
        kind: Kind,
        help: String? = nil,
        required: Bool = true,
        options: [FormOption] = [],
        multiple: Bool = false,
        allowOther: Bool = false,
        detailKey: String? = nil,
        value: JSONValue? = nil,
        valueSource: String? = nil,
        placeholder: String? = nil
    ) {
        self.id = id
        self.label = label
        self.kind = kind
        self.help = help
        self.required = required
        self.options = options
        self.multiple = multiple
        self.allowOther = allowOther
        self.detailKey = detailKey
        self.value = value
        self.valueSource = valueSource
        self.placeholder = placeholder
    }

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue?.nilIfBlank,
              let label = json["label"]?.stringValue?.nilIfBlank else { return nil }
        self.id = id
        self.label = label
        kind = Kind.from(json["kind"]?.stringValue)
        help = json["help"]?.stringValue?.nilIfBlank
        required = json["required"]?.boolValue ?? true
        options = Array((json["options"]?.arrayValue ?? []).compactMap(FormOption.init).prefix(8))
        multiple = json["multiple"]?.boolValue ?? false
        allowOther = json["allowOther"]?.boolValue ?? false
        detailKey = json["detailKey"]?.stringValue?.nilIfBlank
        let value = json["value"]
        self.value = value == .null ? nil : value
        valueSource = json["valueSource"]?.stringValue?.nilIfBlank
        placeholder = json["placeholder"]?.stringValue?.nilIfBlank
    }

    /// The personal detail key this field binds to, when the key is known.
    var boundDetail: PersonalDetailKey? {
        detailKey.flatMap(PersonalDetailKey.init(wire:))
    }

    /// The option the card selects first: the recommended one.
    var recommendedOption: FormOption? {
        options.first { $0.recommended != nil }
    }
}

/// A form question: the one shape for the chat's `ask_form` and the runner's
/// `needs_answer`.
struct FormQuestion: Hashable, Sendable {
    static let defaultSubmitLabel = "Continue"

    let title: String
    let detail: String?
    let fields: [FormField]
    let submitLabel: String?

    init(title: String, detail: String? = nil, fields: [FormField], submitLabel: String? = nil) {
        self.title = title
        self.detail = detail
        self.fields = fields
        self.submitLabel = submitLabel
    }

    init?(json: JSONValue) {
        guard let title = json["title"]?.stringValue?.nilIfBlank else { return nil }
        let fields = Array((json["fields"]?.arrayValue ?? []).compactMap(FormField.init).prefix(8))
        guard !fields.isEmpty else { return nil }
        self.title = title
        detail = json["detail"]?.stringValue?.nilIfBlank
        self.fields = fields
        submitLabel = json["submitLabel"]?.stringValue?.nilIfBlank
    }

    /// The primary button text.
    var submitTitle: String { submitLabel ?? Self.defaultSubmitLabel }

    /// True when a field binds to a personal detail.
    var bindsDetails: Bool { fields.contains { $0.detailKey != nil } }

    /// A planner question (prompt plus options) as a one-field form, so every
    /// client renders one shape (`legacyQuestionToForm` on the web).
    static func legacy(prompt: String, reason: String?, options: [ThreadQuestion.Option]) -> FormQuestion {
        let formOptions = options.prefix(8).map { option in
            FormOption(id: option.id, label: option.label, detail: option.description)
        }
        let field: FormField
        if formOptions.count >= 2 {
            field = FormField(id: "answer", label: "Answer", kind: .choice, options: Array(formOptions), allowOther: true)
        } else {
            field = FormField(id: "answer", label: "Answer", kind: .text)
        }
        return FormQuestion(title: prompt, detail: reason?.nilIfBlank, fields: [field])
    }
}

/// The answer to a form: the values by field id, the save flag for the bound
/// fields, and whether the user skipped the form.
struct FormAnswer: Hashable, Sendable {
    var values: [String: JSONValue]
    var save: Bool
    var skipped: Bool

    init(values: [String: JSONValue], save: Bool, skipped: Bool = false) {
        self.values = values
        self.save = save
        self.skipped = skipped
    }

    init?(json: JSONValue) {
        guard json.objectValue != nil else { return nil }
        values = json["values"]?.objectValue ?? [:]
        save = json["save"]?.boolValue ?? false
        skipped = json["skipped"]?.boolValue ?? false
    }

    /// The chat form the user closed without an answer.
    static let skippedForm = FormAnswer(values: [:], save: false, skipped: true)

    var json: JSONValue {
        var object: [String: JSONValue] = [
            "values": .object(values),
            "save": .bool(save),
        ]
        if skipped { object["skipped"] = .bool(true) }
        return .object(object)
    }
}

/// Builders for the value of one answered field, as the contract spells it.
enum FormFieldValue {
    /// choice: the chosen option ids, and the "Other" text when given.
    static func choice(_ ids: [String], other: String? = nil) -> JSONValue {
        var object: [String: JSONValue] = ["choices": .array(ids.map(JSONValue.string))]
        if let other = other?.nilIfBlank { object["other"] = .string(other) }
        return .object(object)
    }

    static func name(first: String, middle: String?, last: String) -> JSONValue {
        var object: [String: JSONValue] = ["first": .string(first), "last": .string(last)]
        if let middle = middle?.nilIfBlank { object["middle"] = .string(middle) }
        return .object(object)
    }

    static func address(line1: String, line2: String?, city: String, region: String, postalCode: String, country: String) -> JSONValue {
        var object: [String: JSONValue] = [
            "line1": .string(line1),
            "city": .string(city),
            "region": .string(region),
            "postalCode": .string(postalCode),
            "country": .string(country.uppercased()),
        ]
        if let line2 = line2?.nilIfBlank { object["line2"] = .string(line2) }
        return .object(object)
    }

    static func contact(name: String, phone: String, relationship: String?) -> JSONValue {
        var object: [String: JSONValue] = ["name": .string(name), "phone": .string(phone)]
        if let relationship = relationship?.nilIfBlank { object["relationship"] = .string(relationship) }
        return .object(object)
    }

    /// The chosen option ids of a choice value, for a receipt.
    static func choices(of value: JSONValue?) -> [String] {
        (value?["choices"]?.arrayValue ?? []).compactMap(\.stringValue)
    }
}

// MARK: - The Work question in the thread

/// A Work question as the thread shows it. `form` is nil for an older
/// question; `resolvedForm` builds one from the prompt and the options.
struct ThreadQuestion: Identifiable, Hashable, Sendable {
    enum Status: String, Hashable, Sendable {
        case pending, answered, dismissed, superseded
        case unknown

        static func from(_ raw: String?) -> Status {
            raw.flatMap { Status(rawValue: $0) } ?? .unknown
        }
    }

    /// Where the user answered: the form, or a message in the chat.
    enum AnsweredIn: String, Hashable, Sendable {
        case form, chat
    }

    struct Option: Identifiable, Hashable, Sendable {
        let id: String
        let label: String
        let description: String?

        init(id: String, label: String, description: String? = nil) {
            self.id = id
            self.label = label
            self.description = description
        }

        init?(json: JSONValue) {
            guard let id = json["id"]?.stringValue?.nilIfBlank,
                  let label = json["label"]?.stringValue?.nilIfBlank else { return nil }
            self.id = id
            self.label = label
            description = (json["description"] ?? json["detail"])?.stringValue?.nilIfBlank
        }
    }

    /// The answer text prefix when a chat message answered a run's question.
    static let chatAnswerPrefix = "Answered in the chat: "

    let id: String
    let form: FormQuestion?
    let prompt: String
    let reason: String?
    let options: [Option]
    let status: Status
    /// The answer text for an answered question.
    let answer: String?
    let answeredIn: AnsweredIn?

    init(
        id: String,
        form: FormQuestion? = nil,
        prompt: String,
        reason: String? = nil,
        options: [Option] = [],
        status: Status = .pending,
        answer: String? = nil,
        answeredIn: AnsweredIn? = nil
    ) {
        self.id = id
        self.form = form
        self.prompt = prompt
        self.reason = reason
        self.options = options
        self.status = status
        self.answer = answer
        self.answeredIn = answeredIn
    }

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue?.nilIfBlank ?? json["_id"]?.stringValue?.nilIfBlank else { return nil }
        let form = json["form"].flatMap(FormQuestion.init(json:))
        guard let prompt = json["prompt"]?.stringValue?.nilIfBlank ?? form?.title else { return nil }
        self.id = id
        self.form = form
        self.prompt = prompt
        reason = json["reason"]?.stringValue?.nilIfBlank
        options = (json["options"]?.arrayValue ?? []).compactMap(Option.init)
        status = Status.from(json["status"]?.stringValue)
        answer = json["answer"]?.stringValue?.nilIfBlank
        answeredIn = json["answeredIn"]?.stringValue.flatMap(AnsweredIn.init(rawValue:))
    }

    /// The same question as `work_home` sends it to older surfaces.
    init(legacy question: WorkDetail.Question) {
        id = question.id
        form = nil
        prompt = question.prompt
        reason = question.reason
        options = question.options.map { Option(id: $0.id, label: $0.label, description: $0.detail) }
        status = Status.from(question.status)
        answer = nil
        answeredIn = nil
    }

    /// The form to render.
    var resolvedForm: FormQuestion {
        form ?? FormQuestion.legacy(prompt: prompt, reason: reason, options: options)
    }

    var isPending: Bool { status == .pending }

    /// The answer line without the chat prefix.
    var answerLine: String? {
        guard let answer else { return nil }
        if answer.hasPrefix(Self.chatAnswerPrefix) {
            return String(answer.dropFirst(Self.chatAnswerPrefix.count)).nilIfBlank
        }
        return answer
    }
}

// MARK: - A run in the thread

/// A run as `GET /api/albatross/work/[workId]/runs` sends it: the step-runner
/// view plus its question.
struct ThreadRunView: Identifiable, Hashable, Sendable {
    let run: StepRunView
    let question: ThreadQuestion?

    var id: String { run.id }

    init(run: StepRunView, question: ThreadQuestion? = nil) {
        self.run = run
        self.question = question
    }

    init?(json: JSONValue) {
        guard let run = StepRunView(json: json) else { return nil }
        self.run = run
        question = json["question"].flatMap(ThreadQuestion.init(json:))
    }

    /// The route answers `{ ok, runs }`, oldest first; a bare array reads the
    /// same way.
    static func list(from json: JSONValue) -> [ThreadRunView] {
        let rows = json["runs"]?.arrayValue ?? json.arrayValue ?? []
        return rows.compactMap(ThreadRunView.init(json:))
    }

    /// The pending form of this run's question, when it waits for an answer.
    var pendingQuestion: ThreadQuestion? {
        guard let question, question.isPending else { return nil }
        return question
    }
}

// MARK: - The canonical session

/// The canonical chat session of a Work: `work-<workId>`, which fits the
/// /api/chats id rule (8 to 64 of [A-Za-z0-9_-]).
enum WorkThreadSession {
    static func id(for workID: String) -> String {
        let allowed = workID.unicodeScalars.filter { scalar in
            CharacterSet.alphanumerics.contains(scalar) || scalar == "_" || scalar == "-"
        }
        let clean = String(String.UnicodeScalarView(allowed)).prefix(59)
        return "work-\(clean)"
    }

    static func isThreadID(_ id: String) -> Bool {
        guard id.hasPrefix("work-") else { return false }
        let rest = id.dropFirst("work-".count)
        guard (3...59).contains(rest.count) else { return false }
        return rest.unicodeScalars.allSatisfy { scalar in
            CharacterSet.alphanumerics.contains(scalar) || scalar == "_" || scalar == "-"
        }
    }
}

// MARK: - The step_run tool shape

/// The `data-tool-shape` of `albatross_handle_step`: the client renders the
/// live run block for `runID` in place of the tool row.
struct ThreadStepRunShape: Hashable, Sendable {
    enum Action: String, Hashable, Sendable {
        case started, resumed, steered
        case unknown

        static func from(_ raw: String?) -> Action {
            raw.flatMap { Action(rawValue: $0) } ?? .unknown
        }
    }

    let runID: String
    let workID: String
    let action: Action

    init(runID: String, workID: String, action: Action) {
        self.runID = runID
        self.workID = workID
        self.action = action
    }

    init?(json: JSONValue) {
        guard json["kind"]?.stringValue == "step_run",
              let runID = json["runId"]?.stringValue?.nilIfBlank else { return nil }
        self.runID = runID
        workID = json["workId"]?.stringValue ?? ""
        action = Action.from(json["action"]?.stringValue)
    }

    /// A started or resumed run renders inside its message. A steer note
    /// leaves the run where it already is in the timeline.
    var rendersRunInline: Bool { action == .started || action == .resumed }
}
