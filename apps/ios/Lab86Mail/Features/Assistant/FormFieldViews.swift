import SwiftUI
#if os(iOS)
import UIKit
#endif

// One view for each field kind of a form question (docs/albatross-thread.md,
// "Questions are forms"). Every typed field names its content type, so iOS
// AutoFill offers the user's own contact card, and its keyboard. The label
// sits over the control; the help, the prefill source, and the error sit
// under it. The Mac compiles the same views; AutoFill content types for names
// and addresses have no Mac constant, so the modifier is inert there.

#if os(iOS)
extension View {
    func formContentType(_ type: UITextContentType?) -> some View {
        textContentType(type)
    }
}
#else
enum FormContentTypeShim {
    case name, givenName, middleName, familyName, emailAddress, telephoneNumber
    case streetAddressLine1, streetAddressLine2, addressCity, addressState, postalCode
}

extension View {
    func formContentType(_ type: FormContentTypeShim?) -> some View {
        self
    }
}
#endif

/// One field: label, help, control, source line, error line.
struct FormFieldView: View {
    let field: FormField
    @Binding var value: FormDraftValue
    let error: String?
    let source: String?
    var focus: FocusState<String?>.Binding
    var disabled = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(field.label)
                    .font(.subheadline.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
                if !field.required {
                    Text("Optional")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if let help = field.help {
                Text(help)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            control
                .disabled(disabled)
            if let source {
                Text(source)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("\(field.label): \(error)")
            }
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var control: some View {
        switch field.kind {
        case .choice:
            FormChoiceField(field: field, value: $value, focus: focus)
        case .text:
            FormTextLine(
                placeholder: field.placeholder ?? "Your answer",
                text: textBinding,
                focusID: field.id,
                focus: focus,
                lines: 1...4,
                contentType: nil,
                keyboard: .default,
                capitalization: .sentences
            )
        case .number:
            FormTextLine(
                placeholder: field.placeholder ?? "0",
                text: textBinding,
                focusID: field.id,
                focus: focus,
                lines: 1...1,
                contentType: nil,
                keyboard: .decimalPad,
                capitalization: .never
            )
        case .phone:
            FormTextLine(
                placeholder: field.placeholder ?? "(555) 010-0100",
                text: textBinding,
                focusID: field.id,
                focus: focus,
                lines: 1...1,
                contentType: .telephoneNumber,
                keyboard: .numbersAndPunctuation,
                capitalization: .never
            )
        case .email:
            FormTextLine(
                placeholder: field.placeholder ?? "name@example.com",
                text: textBinding,
                focusID: field.id,
                focus: focus,
                lines: 1...1,
                contentType: .emailAddress,
                keyboard: .emailAddress,
                capitalization: .never
            )
        case .date:
            FormDateField(text: textBinding)
        case .name:
            FormNameField(fieldID: field.id, value: $value, focus: focus)
        case .address:
            FormAddressField(fieldID: field.id, value: $value, focus: focus)
        case .contact:
            FormContactField(fieldID: field.id, value: $value, focus: focus)
        }
    }

    /// The text of a one-value field.
    private var textBinding: Binding<String> {
        Binding(
            get: {
                if case .text(let text) = value { return text }
                return ""
            },
            set: { value = .text($0) }
        )
    }
}

/// One text field with its AutoFill type, keyboard, and focus id.
struct FormTextLine: View {
    let placeholder: String
    @Binding var text: String
    let focusID: String
    var focus: FocusState<String?>.Binding
    var lines: ClosedRange<Int> = 1...1
    #if os(iOS)
    var contentType: UITextContentType?
    var keyboard: UIKeyboardType = .default
    var capitalization: TextInputAutocapitalization = .sentences
    #else
    var contentType: FormContentTypeShim?
    var keyboard: KeyboardTypeShim = .default
    var capitalization: TextInputAutocapitalizationShim = .sentences
    #endif

    var body: some View {
        field
            .textFieldStyle(.roundedBorder)
            .lineLimit(lines)
            .focused(focus, equals: focusID)
            .formContentType(contentType)
            .keyboardType(keyboard)
            .textInputAutocapitalization(capitalization)
            .autocorrectionDisabled(contentType != nil)
            .submitLabel(lines.upperBound > 1 ? .return : .next)
    }

    /// A grouped Mac form shows a field's title as the row label, so the
    /// example text goes in the prompt and the label hides. The phone shows
    /// the title as the placeholder.
    @ViewBuilder private var field: some View {
        #if os(macOS)
        TextField(placeholder, text: $text, prompt: Text(placeholder), axis: lines.upperBound > 1 ? .vertical : .horizontal)
            .labelsHidden()
        #else
        TextField(placeholder, text: $text, axis: lines.upperBound > 1 ? .vertical : .horizontal)
        #endif
    }
}

/// The choice rows, and the "Other" field when the form allows one.
struct FormChoiceField: View {
    let field: FormField
    @Binding var value: FormDraftValue
    var focus: FocusState<String?>.Binding

    private var selected: [String] {
        if case .choice(let selected, _) = value { return selected }
        return []
    }

    private var other: Binding<String> {
        Binding(
            get: {
                if case .choice(_, let other) = value { return other }
                return ""
            },
            set: { value = .choice(selected: selected, other: $0) }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(field.options) { option in
                FormOptionRow(
                    option: option,
                    selected: selected.contains(option.id),
                    multiple: field.multiple
                ) {
                    toggle(option.id)
                }
            }
            if field.allowOther {
                TextField("Other", text: other, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...3)
                    .focused(focus, equals: "\(field.id).other")
                    .padding(.top, 4)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func toggle(_ id: String) {
        var next = selected
        if field.multiple {
            if let index = next.firstIndex(of: id) {
                next.remove(at: index)
            } else {
                next.append(id)
            }
        } else {
            next = next == [id] ? [] : [id]
        }
        var otherText = ""
        if case .choice(_, let text) = value { otherText = text }
        value = .choice(selected: next, other: otherText)
    }
}

/// One option: the label, its detail line, the recommended tag, and the
/// calendar note. The whole row is the tap target.
struct FormOptionRow: View {
    @Environment(AppEnvironment.self) private var environment
    let option: FormOption
    let selected: Bool
    let multiple: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: multiple
                    ? (selected ? "checkmark.square.fill" : "square")
                    : (selected ? "largecircle.fill.circle" : "circle"))
                    .font(.body)
                    .foregroundStyle(selected ? environment.theme.accentColor : Color.secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail = option.detail {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let recommended = option.recommended {
                        Text(recommended)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(environment.theme.accentColor)
                    }
                    if let calendar = option.calendar {
                        Text(calendar.note)
                            .font(.caption)
                            .foregroundStyle(calendar.fit == .conflict ? Color.red : Color.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 6)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .hoverHighlight()
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

/// A date as `YYYY-MM-DD`. The picker starts at today when the field is empty.
struct FormDateField: View {
    @Binding var text: String

    private var date: Binding<Date> {
        Binding(
            get: { FormValidation.isoDate(text) ?? Date.now },
            set: { text = FormValidation.isoString($0) }
        )
    }

    var body: some View {
        // The picker shows today when the field is empty, but the draft stays
        // empty until the user picks a date: an untouched optional date is not sent.
        DatePicker("Date", selection: date, displayedComponents: .date)
            .datePickerStyle(.compact)
            .labelsHidden()
    }
}

/// First, middle (optional), and last name.
struct FormNameField: View {
    let fieldID: String
    @Binding var value: FormDraftValue
    var focus: FocusState<String?>.Binding

    private var parts: (first: String, middle: String, last: String) {
        if case .name(let first, let middle, let last) = value { return (first, middle, last) }
        return ("", "", "")
    }

    var body: some View {
        VStack(spacing: 8) {
            FormTextLine(
                placeholder: "First name",
                text: Binding(get: { parts.first }, set: { value = .name(first: $0, middle: parts.middle, last: parts.last) }),
                focusID: "\(fieldID).first",
                focus: focus,
                contentType: .givenName,
                capitalization: .words
            )
            FormTextLine(
                placeholder: "Middle name (optional)",
                text: Binding(get: { parts.middle }, set: { value = .name(first: parts.first, middle: $0, last: parts.last) }),
                focusID: "\(fieldID).middle",
                focus: focus,
                contentType: .middleName,
                capitalization: .words
            )
            FormTextLine(
                placeholder: "Last name",
                text: Binding(get: { parts.last }, set: { value = .name(first: parts.first, middle: parts.middle, last: $0) }),
                focusID: "\(fieldID).last",
                focus: focus,
                contentType: .familyName,
                capitalization: .words
            )
        }
    }
}

/// Street, apartment, city, state or region, postal code, and country.
struct FormAddressField: View {
    let fieldID: String
    @Binding var value: FormDraftValue
    var focus: FocusState<String?>.Binding

    private struct Parts {
        var line1 = ""
        var line2 = ""
        var city = ""
        var region = ""
        var postalCode = ""
        var country = Locale.current.region?.identifier ?? "US"
    }

    private var parts: Parts {
        if case .address(let line1, let line2, let city, let region, let postalCode, let country) = value {
            return Parts(line1: line1, line2: line2, city: city, region: region, postalCode: postalCode, country: country)
        }
        return Parts()
    }

    private func write(_ change: (inout Parts) -> Void) {
        var next = parts
        change(&next)
        value = .address(
            line1: next.line1, line2: next.line2, city: next.city, region: next.region,
            postalCode: next.postalCode, country: next.country
        )
    }

    /// The regions the system knows, by their local names.
    private static var regions: [(code: String, name: String)] {
        Locale.Region.isoRegions
            .map { region in (code: region.identifier, name: Locale.current.localizedString(forRegionCode: region.identifier) ?? region.identifier) }
            .filter { $0.code.count == 2 }
            .sorted { $0.name < $1.name }
    }

    var body: some View {
        VStack(spacing: 8) {
            FormTextLine(
                placeholder: "Street address",
                text: Binding(get: { parts.line1 }, set: { text in write { $0.line1 = text } }),
                focusID: "\(fieldID).line1",
                focus: focus,
                contentType: .streetAddressLine1,
                capitalization: .words
            )
            FormTextLine(
                placeholder: "Apartment or unit (optional)",
                text: Binding(get: { parts.line2 }, set: { text in write { $0.line2 = text } }),
                focusID: "\(fieldID).line2",
                focus: focus,
                contentType: .streetAddressLine2,
                capitalization: .words
            )
            FormTextLine(
                placeholder: "City",
                text: Binding(get: { parts.city }, set: { text in write { $0.city = text } }),
                focusID: "\(fieldID).city",
                focus: focus,
                contentType: .addressCity,
                capitalization: .words
            )
            HStack(spacing: 8) {
                FormTextLine(
                    placeholder: "State or region",
                    text: Binding(get: { parts.region }, set: { text in write { $0.region = text } }),
                    focusID: "\(fieldID).region",
                    focus: focus,
                    contentType: .addressState,
                    capitalization: .words
                )
                FormTextLine(
                    placeholder: "Postal code",
                    text: Binding(get: { parts.postalCode }, set: { text in write { $0.postalCode = text } }),
                    focusID: "\(fieldID).postal",
                    focus: focus,
                    contentType: .postalCode,
                    keyboard: .numbersAndPunctuation,
                    capitalization: .characters
                )
            }
            Picker("Country", selection: Binding(get: { parts.country }, set: { code in write { $0.country = code } })) {
                ForEach(Self.regions, id: \.code) { region in
                    Text(region.name).tag(region.code)
                }
            }
            .pickerStyle(.menu)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// A person to reach: name, phone, and the relationship.
struct FormContactField: View {
    let fieldID: String
    @Binding var value: FormDraftValue
    var focus: FocusState<String?>.Binding

    private var parts: (name: String, phone: String, relationship: String) {
        if case .contact(let name, let phone, let relationship) = value { return (name, phone, relationship) }
        return ("", "", "")
    }

    var body: some View {
        VStack(spacing: 8) {
            FormTextLine(
                placeholder: "Name",
                text: Binding(get: { parts.name }, set: { value = .contact(name: $0, phone: parts.phone, relationship: parts.relationship) }),
                focusID: "\(fieldID).name",
                focus: focus,
                contentType: .name,
                capitalization: .words
            )
            FormTextLine(
                placeholder: "(555) 010-0122",
                text: Binding(get: { parts.phone }, set: { value = .contact(name: parts.name, phone: $0, relationship: parts.relationship) }),
                focusID: "\(fieldID).phone",
                focus: focus,
                contentType: .telephoneNumber,
                keyboard: .numbersAndPunctuation,
                capitalization: .never
            )
            FormTextLine(
                placeholder: "Relationship (optional)",
                text: Binding(get: { parts.relationship }, set: { value = .contact(name: parts.name, phone: parts.phone, relationship: $0) }),
                focusID: "\(fieldID).relationship",
                focus: focus,
                contentType: nil,
                capitalization: .words
            )
        }
    }
}

/// The field id behind a focus id ("phone.first" is the field "phone").
enum FormFocus {
    static func fieldID(of focusID: String) -> String {
        if let dot = focusID.firstIndex(of: ".") { return String(focusID[..<dot]) }
        return focusID
    }
}
