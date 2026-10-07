import Foundation

// The pure rules of a form card: what the user typed, which fields are valid,
// what the answer looks like on the wire, and when "Save to my details"
// shows. Views stay thin and these rules stay testable.

/// What the user has entered in one field.
enum FormDraftValue: Equatable, Sendable {
    case choice(selected: [String], other: String)
    case text(String)
    case name(first: String, middle: String, last: String)
    case address(line1: String, line2: String, city: String, region: String, postalCode: String, country: String)
    case contact(name: String, phone: String, relationship: String)

    /// The empty value of a field kind.
    static func empty(for kind: FormField.Kind, country: String) -> FormDraftValue {
        switch kind {
        case .choice: .choice(selected: [], other: "")
        case .text, .number, .phone, .email, .date: .text("")
        case .name: .name(first: "", middle: "", last: "")
        case .address: .address(line1: "", line2: "", city: "", region: "", postalCode: "", country: country)
        case .contact: .contact(name: "", phone: "", relationship: "")
        }
    }

    /// A value from the wire (a server-found value, or a saved detail).
    static func from(json: JSONValue, kind: FormField.Kind, country: String) -> FormDraftValue? {
        switch kind {
        case .choice:
            let ids = FormFieldValue.choices(of: json)
            let other = json["other"]?.stringValue ?? ""
            if ids.isEmpty, let one = json.stringValue?.nilIfBlank { return .choice(selected: [one], other: "") }
            return .choice(selected: ids, other: other)
        case .text, .number, .phone, .email, .date:
            guard let text = json.stringValue?.nilIfBlank else { return nil }
            return .text(text)
        case .name:
            guard let value = PersonalNameValue(json: json) else { return nil }
            return .name(first: value.first, middle: value.middle ?? "", last: value.last)
        case .address:
            guard let value = PersonalAddressValue(json: json) else { return nil }
            return .address(
                line1: value.line1, line2: value.line2 ?? "", city: value.city, region: value.region,
                postalCode: value.postalCode, country: value.country.isEmpty ? country : value.country
            )
        case .contact:
            guard let value = PersonalContactValue(json: json) else { return nil }
            return .contact(name: value.name, phone: value.phone, relationship: value.relationship ?? "")
        }
    }

    /// The same value from a saved personal detail.
    static func from(detail: PersonalDetailValue, kind: FormField.Kind, country: String) -> FormDraftValue? {
        from(json: detail.json, kind: kind, country: country)
    }

    /// True when every part is blank.
    var isEmpty: Bool {
        switch self {
        case .choice(let selected, let other):
            return selected.isEmpty && other.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .text(let text):
            return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .name(let first, _, let last):
            return Self.blank(first) && Self.blank(last)
        case .address(let line1, _, let city, _, let postalCode, _):
            return Self.blank(line1) && Self.blank(city) && Self.blank(postalCode)
        case .contact(let name, let phone, _):
            return Self.blank(name) && Self.blank(phone)
        }
    }

    /// The value on the wire, trimmed. Nil when it is empty.
    var json: JSONValue? {
        guard !isEmpty else { return nil }
        switch self {
        case .choice(let selected, let other):
            return FormFieldValue.choice(selected, other: other.trimmingCharacters(in: .whitespacesAndNewlines))
        case .text(let text):
            return .string(text.trimmingCharacters(in: .whitespacesAndNewlines))
        case .name(let first, let middle, let last):
            return FormFieldValue.name(first: Self.trim(first), middle: Self.trim(middle), last: Self.trim(last))
        case .address(let line1, let line2, let city, let region, let postalCode, let country):
            return FormFieldValue.address(
                line1: Self.trim(line1), line2: Self.trim(line2), city: Self.trim(city), region: Self.trim(region),
                postalCode: Self.trim(postalCode), country: Self.trim(country)
            )
        case .contact(let name, let phone, let relationship):
            return FormFieldValue.contact(name: Self.trim(name), phone: Self.trim(phone), relationship: Self.trim(relationship))
        }
    }

    /// One line for a receipt.
    func display(field: FormField) -> String {
        switch self {
        case .choice(let selected, let other):
            let labels = selected.map { id in field.options.first { $0.id == id }?.label ?? id }
            let trimmed = other.trimmingCharacters(in: .whitespacesAndNewlines)
            return (labels + (trimmed.isEmpty ? [] : [trimmed])).joined(separator: ", ")
        case .text(let text):
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        case .name(let first, let middle, let last):
            return PersonalNameValue(first: Self.trim(first), middle: Self.trim(middle), last: Self.trim(last)).full
        case .address(let line1, let line2, let city, let region, let postalCode, let country):
            return PersonalAddressValue(
                line1: Self.trim(line1), line2: Self.trim(line2), city: Self.trim(city), region: Self.trim(region),
                postalCode: Self.trim(postalCode), country: Self.trim(country)
            ).display
        case .contact(let name, let phone, let relationship):
            return PersonalContactValue(name: Self.trim(name), phone: Self.trim(phone), relationship: Self.trim(relationship)).display
        }
    }

    private static func blank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func trim(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// The validators, one for each field kind. Each returns the line under the
/// field, or nil when the value is good.
enum FormValidation {
    static let phoneLine = "Enter a phone number with at least 7 digits."
    static let emailLine = "Enter an email address like name@example.com."
    static let dateLine = "Enter a date."
    static let numberLine = "Enter a number."
    static let nameLine = "Enter a first and a last name."
    static let addressLine = "Enter the street, city, state, and postal code."
    static let contactLine = "Enter a name and a phone number."
    static let answerLine = "Enter an answer."
    static let chooseLine = "Choose one."
    static let chooseSomeLine = "Choose at least one."

    static func phoneError(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count <= 40 else { return phoneLine }
        let allowed = CharacterSet(charactersIn: "+0123456789()-. ")
        guard trimmed.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return phoneLine }
        let digits = trimmed.filter(\.isNumber).count
        return digits >= 7 ? nil : phoneLine
    }

    static func emailError(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count <= 254, !trimmed.contains(" ") else { return emailLine }
        let parts = trimmed.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty else { return emailLine }
        let domain = parts[1]
        guard domain.contains("."), !domain.hasPrefix("."), !domain.hasSuffix(".") else { return emailLine }
        return nil
    }

    /// YYYY-MM-DD, a real calendar date.
    static func dateError(_ text: String) -> String? {
        isoDate(text) == nil ? dateLine : nil
    }

    static func numberError(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value = Double(trimmed), value.isFinite else { return numberLine }
        return nil
    }

    static func nameError(first: String, last: String) -> String? {
        let hasFirst = !first.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasLast = !last.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return hasFirst && hasLast ? nil : nameLine
    }

    static func addressError(line1: String, city: String, region: String, postalCode: String, country: String) -> String? {
        let parts = [line1, city, region, postalCode].map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard parts.allSatisfy({ !$0.isEmpty }) else { return addressLine }
        let code = country.trimmingCharacters(in: .whitespacesAndNewlines)
        guard code.count == 2, code.allSatisfy(\.isLetter) else { return addressLine }
        return nil
    }

    static func contactError(name: String, phone: String) -> String? {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return contactLine }
        return phoneError(phone) == nil ? nil : contactLine
    }

    /// The error of one field's draft value. A blank optional field is fine.
    static func error(for field: FormField, value: FormDraftValue) -> String? {
        if value.isEmpty {
            guard field.required else { return nil }
            switch field.kind {
            case .choice: return field.multiple ? chooseSomeLine : chooseLine
            case .text: return answerLine
            case .number: return numberLine
            case .phone: return phoneLine
            case .email: return emailLine
            case .date: return dateLine
            case .name: return nameLine
            case .address: return addressLine
            case .contact: return contactLine
            }
        }
        switch (field.kind, value) {
        case (.phone, .text(let text)): return phoneError(text)
        case (.email, .text(let text)): return emailError(text)
        case (.date, .text(let text)): return dateError(text)
        case (.number, .text(let text)): return numberError(text)
        case (.name, .name(let first, _, let last)): return nameError(first: first, last: last)
        case (.address, .address(let line1, _, let city, let region, let postalCode, let country)):
            return addressError(line1: line1, city: city, region: region, postalCode: postalCode, country: country)
        case (.contact, .contact(let name, let phone, _)): return contactError(name: name, phone: phone)
        case (.choice, .choice(let selected, let other)):
            if selected.isEmpty, !field.allowOther, other.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return field.multiple ? chooseSomeLine : chooseLine
            }
            return nil
        default: return nil
        }
    }

    /// `YYYY-MM-DD` to a date at noon in the current calendar, or nil.
    static func isoDate(_ text: String, calendar: Calendar = .current) -> Date? {
        let parts = text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]) else { return nil }
        guard parts[0].count == 4, (1...12).contains(month), (1...31).contains(day) else { return nil }
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        components.hour = 12
        guard let date = calendar.date(from: components) else { return nil }
        let check = calendar.dateComponents([.year, .month, .day], from: date)
        guard check.year == year, check.month == month, check.day == day else { return nil }
        return date
    }

    /// A date as `YYYY-MM-DD` in the current calendar.
    static func isoString(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        let year = parts.year ?? 1970
        let month = parts.month ?? 1
        let day = parts.day ?? 1
        return String(format: "%04d-%02d-%02d", year, month, day)
    }
}

/// Where a prefilled value came from, for the quiet line under the field.
enum FormPrefillSource: Equatable, Sendable {
    case account
    case details
    case found(String)

    var line: String {
        switch self {
        case .account: "From your account"
        case .details: "From your details"
        case .found(let source): source
        }
    }
}

/// The state of one form while the user fills it: the values, the prefill
/// sources, the save flag, and which fields the user has left.
struct FormDraft: Equatable, Sendable {
    var values: [String: FormDraftValue]
    var sources: [String: FormPrefillSource]
    /// The saved value of each bound field, to tell a new value from a saved one.
    var savedValues: [String: FormDraftValue]
    var save: Bool
    /// Fields the user left or tried to submit: their errors show.
    var touched: Set<String>

    /// The draft a form opens with: the recommended option selected, the
    /// server-found values and the saved details filled in.
    static func initial(
        form: FormQuestion,
        details: [PersonalDetailKey: PersonalDetailView],
        country: String = Locale.current.region?.identifier ?? "US"
    ) -> FormDraft {
        var values: [String: FormDraftValue] = [:]
        var sources: [String: FormPrefillSource] = [:]
        var savedValues: [String: FormDraftValue] = [:]
        for field in form.fields {
            var value = FormDraftValue.empty(for: field.kind, country: country)
            if field.kind == .choice, let recommended = field.recommendedOption {
                value = .choice(selected: [recommended.id], other: "")
            }
            if let detail = field.boundDetail.flatMap({ details[$0] }),
               let saved = FormDraftValue.from(detail: detail.value, kind: field.kind, country: country) {
                savedValues[field.id] = saved
            }
            if let raw = field.value, let found = FormDraftValue.from(json: raw, kind: field.kind, country: country) {
                value = found
                sources[field.id] = .found(field.valueSource ?? FormPrefillSource.details.line)
            } else if let saved = savedValues[field.id],
                      let detail = field.boundDetail.flatMap({ details[$0] }) {
                value = saved
                sources[field.id] = detail.source == .account && !detail.saved ? .account : .details
            }
            values[field.id] = value
        }
        return FormDraft(values: values, sources: sources, savedValues: savedValues, save: true, touched: [])
    }

    func value(for field: FormField) -> FormDraftValue {
        values[field.id] ?? FormDraftValue.empty(for: field.kind, country: "US")
    }

    func error(for field: FormField) -> String? {
        FormValidation.error(for: field, value: value(for: field))
    }

    /// The error the user sees now: only on a field they left or after a
    /// submit attempt.
    func shownError(for field: FormField) -> String? {
        guard touched.contains(field.id) else { return nil }
        return error(for: field)
    }

    /// True when every field is valid.
    func isComplete(_ form: FormQuestion) -> Bool {
        form.fields.allSatisfy { error(for: $0) == nil }
    }

    /// The bound fields whose value is new or differs from the saved detail.
    /// "Save to my details" shows when this is not empty.
    func changedBoundFields(_ form: FormQuestion) -> [FormField] {
        form.fields.filter { field in
            guard field.boundDetail != nil else { return false }
            let current = value(for: field)
            guard !current.isEmpty, let json = current.json else { return false }
            guard let saved = savedValues[field.id], let savedJSON = saved.json else { return true }
            return json != savedJSON
        }
    }

    func showsSaveToggle(_ form: FormQuestion) -> Bool {
        !changedBoundFields(form).isEmpty
    }

    /// The answer on the wire. `save` is true only when there is something
    /// new to save and the toggle is on.
    func answer(_ form: FormQuestion) -> FormAnswer {
        var wire: [String: JSONValue] = [:]
        for field in form.fields {
            if let json = value(for: field).json { wire[field.id] = json }
        }
        return FormAnswer(values: wire, save: save && showsSaveToggle(form))
    }

    /// The labels of the bound fields the answer saved, for the receipt.
    func savedLabels(_ form: FormQuestion) -> [String] {
        changedBoundFields(form).map { field in
            field.boundDetail?.fixedLabel ?? field.label
        }
    }

    mutating func touchAll(_ form: FormQuestion) {
        touched.formUnion(form.fields.map(\.id))
    }
}
