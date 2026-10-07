import Foundation

// Personal details on the wire (lib/albatross/thread-contract.ts): the facts
// that forms ask for, which Albatross types into forms. The server encrypts
// them at rest; the client sees the clear values only through
// `/api/personal-details`. No log line or error ever carries a value.

/// A key in the user's personal details: one of the fixed keys, or
/// `custom:<slug>` for a plain fact the user added.
enum PersonalDetailKey: Hashable, Sendable {
    case name
    case email
    case phone
    case homeAddress
    case emergencyContact
    case custom(String)

    static let customPrefix = "custom:"

    /// The fixed keys in catalog order.
    static let fixed: [PersonalDetailKey] = [.name, .email, .phone, .homeAddress, .emergencyContact]

    init?(wire: String) {
        switch wire {
        case "name": self = .name
        case "email": self = .email
        case "phone": self = .phone
        case "home_address": self = .homeAddress
        case "emergency_contact": self = .emergencyContact
        default:
            guard wire.hasPrefix(Self.customPrefix) else { return nil }
            let slug = String(wire.dropFirst(Self.customPrefix.count))
            guard Self.isSlug(slug) else { return nil }
            self = .custom(slug)
        }
    }

    /// The wire word.
    var wire: String {
        switch self {
        case .name: "name"
        case .email: "email"
        case .phone: "phone"
        case .homeAddress: "home_address"
        case .emergencyContact: "emergency_contact"
        case .custom(let slug): Self.customPrefix + slug
        }
    }

    /// The label of a fixed key. A custom detail carries its own label.
    var fixedLabel: String? {
        switch self {
        case .name: "Name"
        case .email: "Email"
        case .phone: "Phone"
        case .homeAddress: "Home address"
        case .emergencyContact: "Emergency contact"
        case .custom: nil
        }
    }

    var isCustom: Bool {
        if case .custom = self { return true }
        return false
    }

    /// `custom:<slug>`: lower case letters, digits, `_` and `-`, up to 40.
    static func isSlug(_ slug: String) -> Bool {
        guard !slug.isEmpty, slug.count <= 40 else { return false }
        for (index, scalar) in slug.unicodeScalars.enumerated() {
            let isLower = scalar.value >= 97 && scalar.value <= 122
            let isDigit = scalar.value >= 48 && scalar.value <= 57
            let isMark = scalar == "_" || scalar == "-"
            if index == 0 {
                guard isLower || isDigit else { return false }
            } else {
                guard isLower || isDigit || isMark else { return false }
            }
        }
        return true
    }
}

struct PersonalNameValue: Hashable, Sendable {
    let first: String
    let middle: String?
    let last: String

    init(first: String, middle: String? = nil, last: String) {
        self.first = first
        self.middle = middle?.nilIfBlank
        self.last = last
    }

    init?(json: JSONValue) {
        guard let first = json["first"]?.stringValue?.nilIfBlank,
              let last = json["last"]?.stringValue?.nilIfBlank else { return nil }
        self.init(first: first, middle: json["middle"]?.stringValue, last: last)
    }

    var json: JSONValue { FormFieldValue.name(first: first, middle: middle, last: last) }

    /// "Sam Rivera", or "Sam Lee Rivera" with a middle name.
    var full: String {
        [first, middle, last].compactMap { $0?.nilIfBlank }.joined(separator: " ")
    }
}

struct PersonalAddressValue: Hashable, Sendable {
    let line1: String
    let line2: String?
    let city: String
    let region: String
    let postalCode: String
    /// ISO 3166-1 alpha-2, upper case.
    let country: String

    init(line1: String, line2: String? = nil, city: String, region: String, postalCode: String, country: String) {
        self.line1 = line1
        self.line2 = line2?.nilIfBlank
        self.city = city
        self.region = region
        self.postalCode = postalCode
        self.country = country.uppercased()
    }

    init?(json: JSONValue) {
        guard let line1 = json["line1"]?.stringValue?.nilIfBlank,
              let city = json["city"]?.stringValue?.nilIfBlank,
              let region = json["region"]?.stringValue?.nilIfBlank,
              let postalCode = json["postalCode"]?.stringValue?.nilIfBlank else { return nil }
        self.init(
            line1: line1,
            line2: json["line2"]?.stringValue,
            city: city,
            region: region,
            postalCode: postalCode,
            country: json["country"]?.stringValue?.nilIfBlank ?? "US"
        )
    }

    var json: JSONValue {
        FormFieldValue.address(line1: line1, line2: line2, city: city, region: region, postalCode: postalCode, country: country)
    }

    /// "12 Elm Street, Apt 3, Springfield, IL 62704".
    var display: String {
        var parts = [line1]
        if let line2 { parts.append(line2) }
        parts.append(city)
        parts.append("\(region) \(postalCode)")
        return parts.joined(separator: ", ")
    }
}

struct PersonalContactValue: Hashable, Sendable {
    let name: String
    let phone: String
    let relationship: String?

    init(name: String, phone: String, relationship: String? = nil) {
        self.name = name
        self.phone = phone
        self.relationship = relationship?.nilIfBlank
    }

    init?(json: JSONValue) {
        guard let name = json["name"]?.stringValue?.nilIfBlank,
              let phone = json["phone"]?.stringValue?.nilIfBlank else { return nil }
        self.init(name: name, phone: phone, relationship: json["relationship"]?.stringValue)
    }

    var json: JSONValue { FormFieldValue.contact(name: name, phone: phone, relationship: relationship) }

    /// "Alex Rivera · (555) 010-0122 · Partner".
    var display: String {
        [name, phone, relationship].compactMap { $0?.nilIfBlank }.joined(separator: " · ")
    }
}

struct PersonalCustomValue: Hashable, Sendable {
    let label: String
    let value: String

    init?(json: JSONValue) {
        guard let label = json["label"]?.stringValue?.nilIfBlank,
              let value = json["value"]?.stringValue?.nilIfBlank else { return nil }
        self.label = label
        self.value = value
    }

    init(label: String, value: String) {
        self.label = label
        self.value = value
    }

    var json: JSONValue { .object(["label": .string(label), "value": .string(value)]) }
}

/// The value of one detail, by its key's shape.
enum PersonalDetailValue: Hashable, Sendable {
    case name(PersonalNameValue)
    case text(String)
    case address(PersonalAddressValue)
    case contact(PersonalContactValue)
    case custom(PersonalCustomValue)

    init?(key: PersonalDetailKey, json: JSONValue) {
        switch key {
        case .name:
            guard let value = PersonalNameValue(json: json) else { return nil }
            self = .name(value)
        case .email, .phone:
            guard let value = json.stringValue?.nilIfBlank else { return nil }
            self = .text(value)
        case .homeAddress:
            guard let value = PersonalAddressValue(json: json) else { return nil }
            self = .address(value)
        case .emergencyContact:
            guard let value = PersonalContactValue(json: json) else { return nil }
            self = .contact(value)
        case .custom:
            guard let value = PersonalCustomValue(json: json) else { return nil }
            self = .custom(value)
        }
    }

    var json: JSONValue {
        switch self {
        case .name(let value): value.json
        case .text(let value): .string(value)
        case .address(let value): value.json
        case .contact(let value): value.json
        case .custom(let value): value.json
        }
    }

    /// One line for lists.
    var display: String {
        switch self {
        case .name(let value): value.full
        case .text(let value): value
        case .address(let value): value.display
        case .contact(let value): value.display
        case .custom(let value): value.value
        }
    }
}

/// Where a detail came from.
enum PersonalDetailSource: String, Hashable, Sendable {
    case account, settings, chat, form
    case unknown

    static func from(_ raw: String?) -> PersonalDetailSource {
        raw.flatMap { PersonalDetailSource(rawValue: $0) } ?? .unknown
    }

    /// "From your account", "You saved this on Oct 7", "You told Albatross on
    /// Oct 7", "From a form on Oct 7".
    func line(updatedAt: Date?, locale: Locale = .current) -> String {
        let day = updatedAt.map { date in
            " on " + date.formatted(.dateTime.month(.abbreviated).day().locale(locale))
        } ?? ""
        switch self {
        case .account: return "From your account"
        case .settings: return "You saved this" + day
        case .chat: return "You told Albatross" + day
        case .form: return "From a form" + day
        case .unknown: return "Saved" + day
        }
    }
}

/// One saved detail, as the settings API returns it.
struct PersonalDetailView: Identifiable, Hashable, Sendable {
    let key: PersonalDetailKey
    let label: String
    let value: PersonalDetailValue
    /// One line for lists, as the server shows it.
    let display: String
    let source: PersonalDetailSource
    /// False for an account default that the user has not saved.
    let saved: Bool
    let updatedAt: Date?

    var id: String { key.wire }

    init(
        key: PersonalDetailKey,
        label: String? = nil,
        value: PersonalDetailValue,
        display: String? = nil,
        source: PersonalDetailSource,
        saved: Bool,
        updatedAt: Date? = nil
    ) {
        self.key = key
        self.label = label ?? key.fixedLabel ?? "Detail"
        self.value = value
        self.display = display ?? value.display
        self.source = source
        self.saved = saved
        self.updatedAt = updatedAt
    }

    init?(json: JSONValue) {
        guard let wire = json["key"]?.stringValue, let key = PersonalDetailKey(wire: wire),
              let raw = json["value"], let value = PersonalDetailValue(key: key, json: raw) else { return nil }
        let label: String?
        if case .custom(let custom) = value {
            label = json["label"]?.stringValue?.nilIfBlank ?? custom.label
        } else {
            label = json["label"]?.stringValue?.nilIfBlank
        }
        self.init(
            key: key,
            label: label,
            value: value,
            display: json["display"]?.stringValue?.nilIfBlank,
            source: PersonalDetailSource.from(json["source"]?.stringValue),
            saved: json["saved"]?.boolValue ?? true,
            updatedAt: CalendarDateParser.date(json["updatedAt"])
        )
    }

    /// The source line under the value.
    var sourceLine: String { source.line(updatedAt: updatedAt) }
}

/// `GET /api/personal-details`.
struct PersonalDetailsResponse: Hashable, Sendable {
    static let path = "/api/personal-details"

    let details: [PersonalDetailView]
    /// The fixed keys that have no value, in catalog order.
    let missing: [PersonalDetailKey]

    init(details: [PersonalDetailView], missing: [PersonalDetailKey]) {
        self.details = details
        self.missing = missing
    }

    init(json: JSONValue) {
        details = (json["details"]?.arrayValue ?? []).compactMap(PersonalDetailView.init(json:))
        let named = (json["missing"]?.arrayValue ?? []).compactMap { $0.stringValue.flatMap(PersonalDetailKey.init(wire:)) }
        if named.isEmpty {
            let present = Set(details.map(\.key))
            missing = PersonalDetailKey.fixed.filter { !present.contains($0) }
        } else {
            missing = named
        }
    }
}

/// Why a save did not go through, with the line the user reads.
enum PersonalDetailSaveError: Error, Equatable, Sendable {
    /// The value does not fit its shape.
    case invalid(String)
    /// A password, a card number, an ID number: Albatross does not keep it.
    case refused
    /// The user has as many custom details as the server allows.
    case limit
    case other(String)

    static let refusedLine = "Albatross does not keep this number here."
    static let limitLine = "You have as many details as Albatross can keep. Delete one first."

    var line: String {
        switch self {
        case .invalid(let message): message
        case .refused: Self.refusedLine
        case .limit: Self.limitLine
        case .other(let message): message
        }
    }

    /// Reads the route's error body: `{ code: 'invalid' | 'refused', error }`
    /// on 400, 409 at the limit.
    static func from(status: Int, body: JSONValue?) -> PersonalDetailSaveError {
        if status == 409 { return .limit }
        let message = body?["error"]?.stringValue?.nilIfBlank
        switch body?["code"]?.stringValue {
        case "refused": return .refused
        case "invalid": return .invalid(message ?? "Check the value and try again.")
        default: return .other(message ?? "The detail did not save. Try again.")
        }
    }
}
