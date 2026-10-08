import Foundation

// Passwords and IDs on the wire (lib/secure/contract.ts): the items as every
// client sees them, their uses, the allow request on a run, the sign-in save
// offer, and the input of the ask card. No type here can hold a value: the
// server sends labels, sites, field names, and masked hints. Decoded at the
// repository boundary with the same tolerance as ThreadModels.swift: a
// missing key reads as nil or empty, and an unknown word reads as a safe
// default, so a newer server never breaks decoding.

// MARK: - Kinds

/// The kinds of item (`SECURE_ITEM_KINDS`).
enum SecureItemKind: String, Hashable, Codable, Sendable, CaseIterable {
    case signIn = "sign_in"
    case idNumber = "id_number"
    case dateOfBirth = "date_of_birth"
    case apiKey = "api_key"

    static func from(_ raw: String?) -> SecureItemKind? {
        raw.flatMap { SecureItemKind(rawValue: $0) }
    }

    /// The secret fields of the kind, in the contract's order (`SECURE_FIELDS`).
    var secretFields: [String] {
        switch self {
        case .signIn: ["username", "password"]
        case .idNumber: ["number", "expires", "name_on_id"]
        case .dateOfBirth: ["date"]
        case .apiKey: ["key"]
        }
    }

    /// The field whose hint the list row shows.
    var mainField: String {
        switch self {
        case .signIn: "password"
        case .idNumber: "number"
        case .dateOfBirth: "date"
        case .apiKey: "key"
        }
    }

    /// The word in a sentence: "sign-in", "ID", "date of birth", "key".
    var noun: String {
        switch self {
        case .signIn: "sign-in"
        case .idNumber: "ID"
        case .dateOfBirth: "date of birth"
        case .apiKey: "key"
        }
    }

    /// The label of an item that has none.
    var defaultLabel: String {
        switch self {
        case .signIn: "Sign-in"
        case .idNumber: "ID number"
        case .dateOfBirth: "Date of birth"
        case .apiKey: "Key"
        }
    }

    /// An ID and a date of birth start with no sites and ask on each new one.
    /// A sign-in and a key work on their own sites.
    var asksOnNewSite: Bool { self == .idNumber || self == .dateOfBirth }

    /// A sign-in and a key need at least one site.
    var needsSite: Bool { !asksOnNewSite }

    /// The group of the settings list.
    var group: SecureItemGroup {
        switch self {
        case .signIn: .signIns
        case .idNumber, .dateOfBirth: .ids
        case .apiKey: .keys
        }
    }
}

/// The three groups of the settings list.
enum SecureItemGroup: Hashable, Sendable, CaseIterable {
    case signIns, ids, keys

    var title: String {
        switch self {
        case .signIns: "Sign-ins"
        case .ids: "IDs"
        case .keys: "Keys"
        }
    }
}

/// The types of ID number (`ID_NUMBER_TYPES`).
enum IdNumberType: String, Hashable, Codable, Sendable, CaseIterable {
    case ssn
    case driversLicense = "drivers_license"
    case passport
    case stateID = "state_id"
    case other

    /// `ID_NUMBER_LABELS`.
    var label: String {
        switch self {
        case .ssn: "Social Security number"
        case .driversLicense: "Driver's license"
        case .passport: "Passport"
        case .stateID: "State ID"
        case .other: "ID number"
        }
    }

    /// Reads the wire word, or the label a server may put in `facts.type`.
    static func from(_ raw: String?) -> IdNumberType? {
        guard let raw = raw?.nilIfBlank else { return nil }
        if let type = IdNumberType(rawValue: raw) { return type }
        return allCases.first { $0.label.caseInsensitiveCompare(raw) == .orderedSame }
    }

    /// The label inside a sentence: "driver's license", but "Social Security
    /// number" and "ID number" keep their capitals.
    var inSentence: String {
        switch self {
        case .ssn: "Social Security number"
        case .driversLicense: "driver's license"
        case .passport: "passport"
        case .stateID: "state ID"
        case .other: "ID number"
        }
    }

    /// A state or province.
    var usesRegion: Bool { self == .driversLicense || self == .stateID || self == .other }
    var usesCountry: Bool { self == .passport || self == .other }
    var usesExpiry: Bool { self != .ssn }
    var usesNameOnID: Bool { self != .ssn }
}

/// An item label inside a sentence: an ID type keeps its own form; any
/// other label drops its first capital unless it is an acronym.
enum SecureItemLabel {
    static func inSentence(_ label: String) -> String {
        IdNumberType.from(label)?.inSentence ?? label.lowercasedFirst
    }
}

/// The user-facing name of a field (`SECURE_FIELD_LABELS`).
enum SecureFieldLabel {
    static func text(_ field: String) -> String {
        switch field {
        case "username": return "Username"
        case "password": return "Password"
        case "number": return "Number"
        case "expires": return "Expiry date"
        case "name_on_id": return "Name on the ID"
        case "date": return "Date of birth"
        case "key": return "Key"
        default:
            let words = field.replacingOccurrences(of: "_", with: " ")
            return words.prefix(1).uppercased() + words.dropFirst()
        }
    }
}

// MARK: - Items

/// One item as every client sees it. No value.
struct SecureItemView: Identifiable, Hashable, Sendable {
    let id: String
    let kind: SecureItemKind
    /// "Chase", "Driver's license", "OpenAI".
    let label: String
    /// Registrable domains, or the exact hosts of a key.
    let sites: [String]
    /// Field name to masked hint: "••••", "ends 4821", "sk-…f3a2".
    let hints: [String: String]
    /// Plain facts that are safe to show: an ID type, a region, a country, an expiry month.
    let facts: [String: String]
    let createdAt: Date?
    let updatedAt: Date?
    let lastUsedAt: Date?

    init(
        id: String,
        kind: SecureItemKind,
        label: String,
        sites: [String] = [],
        hints: [String: String] = [:],
        facts: [String: String] = [:],
        createdAt: Date? = nil,
        updatedAt: Date? = nil,
        lastUsedAt: Date? = nil
    ) {
        self.id = id
        self.kind = kind
        self.label = label
        self.sites = sites
        self.hints = hints
        self.facts = facts
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastUsedAt = lastUsedAt
    }

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue?.nilIfBlank ?? json["_id"]?.stringValue?.nilIfBlank,
              let kind = SecureItemKind.from(json["kind"]?.stringValue) else { return nil }
        self.id = id
        self.kind = kind
        label = json["label"]?.stringValue?.nilIfBlank ?? kind.defaultLabel
        sites = (json["sites"]?.arrayValue ?? []).compactMap { $0.stringValue?.nilIfBlank }
        hints = Self.strings(json["hints"])
        facts = Self.strings(json["facts"])
        createdAt = CalendarDateParser.date(json["createdAt"])
        updatedAt = CalendarDateParser.date(json["updatedAt"])
        lastUsedAt = CalendarDateParser.date(json["lastUsedAt"])
    }

    private static func strings(_ json: JSONValue?) -> [String: String] {
        var out: [String: String] = [:]
        for (key, value) in json?.objectValue ?? [:] {
            if let text = value.stringValue?.nilIfBlank { out[key] = text }
        }
        return out
    }

    func hint(_ field: String) -> String? { hints[field] }

    /// The hint the list row shows.
    var mainHint: String? { hints[kind.mainField] }

    var idType: IdNumberType? { IdNumberType.from(facts["type"]) }

    /// "NY" or "US": the region first, else the country.
    var place: String? { facts["region"]?.nilIfBlank ?? facts["country"]?.nilIfBlank }

    /// The hosts an item covers: a site covers itself and every host under it.
    func covers(host: String) -> Bool {
        let host = SecureSite.clean(host)
        guard !host.isEmpty else { return false }
        return sites.contains { SecureSite.covers(site: $0, host: host) }
    }
}

/// `GET /api/secure-details`.
struct SecureDetailsResponse: Hashable, Sendable {
    static let path = "/api/secure-details"

    /// False when Passwords and IDs is off for this user: every secure surface hides.
    let enabled: Bool
    let items: [SecureItemView]

    init(enabled: Bool, items: [SecureItemView]) {
        self.enabled = enabled
        self.items = items
    }

    init(json: JSONValue) {
        enabled = json["enabled"]?.boolValue ?? false
        items = (json["items"]?.arrayValue ?? []).compactMap(SecureItemView.init(json:))
    }
}

// MARK: - Uses

/// What happened in one use (`SecureUseOutcome`).
enum SecureUseOutcome: String, Hashable, Sendable {
    /// A run typed it on a page.
    case typed
    /// A run sent it to an API host.
    case sent
    /// A run asked for it on a site that is not its own.
    case refusedSite = "refused_site"
    /// A run asked the user to allow a new site.
    case asked
    case allowedOnce = "allowed_once"
    case allowedAlways = "allowed_always"
    case denied
    case unknown

    static func from(_ raw: String?) -> SecureUseOutcome {
        raw.flatMap { SecureUseOutcome(rawValue: $0) } ?? .unknown
    }
}

/// One use of one item, as `GET /api/secure-details/[itemId]/uses` sends it.
struct SecureUseView: Identifiable, Hashable, Sendable {
    let id: String
    let itemID: String
    let field: String?
    let site: String?
    let workID: String?
    let workTitle: String?
    let outcome: SecureUseOutcome
    let at: Date?

    init(
        id: String,
        itemID: String,
        field: String? = nil,
        site: String? = nil,
        workID: String? = nil,
        workTitle: String? = nil,
        outcome: SecureUseOutcome,
        at: Date? = nil
    ) {
        self.id = id
        self.itemID = itemID
        self.field = field
        self.site = site
        self.workID = workID
        self.workTitle = workTitle
        self.outcome = outcome
        self.at = at
    }

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue?.nilIfBlank ?? json["_id"]?.stringValue?.nilIfBlank else { return nil }
        self.id = id
        itemID = json["itemId"]?.stringValue ?? ""
        field = json["field"]?.stringValue?.nilIfBlank
        site = json["site"]?.stringValue?.nilIfBlank
        workID = json["workId"]?.stringValue?.nilIfBlank
        workTitle = json["workTitle"]?.stringValue?.nilIfBlank
        outcome = SecureUseOutcome.from(json["outcome"]?.stringValue)
        at = CalendarDateParser.date(json["at"])
    }

    /// The route answers `{ ok, uses }`; a bare array reads the same way.
    static func list(from json: JSONValue) -> [SecureUseView] {
        let rows = json["uses"]?.arrayValue ?? json.arrayValue ?? []
        return rows.compactMap(SecureUseView.init(json:))
    }
}

/// One row of the "Recent uses" group: uses of one outcome, site, Work, and
/// minute merge into one row with every field.
struct SecureUseRow: Identifiable, Hashable, Sendable {
    let id: String
    let outcome: SecureUseOutcome
    let site: String?
    let workTitle: String?
    let fields: [String]
    let at: Date?

    /// The rows, newest first.
    static func rows(from uses: [SecureUseView], calendar: Calendar = .current) -> [SecureUseRow] {
        let sorted = uses.sorted { ($0.at ?? .distantPast) > ($1.at ?? .distantPast) }
        var rows: [SecureUseRow] = []
        for use in sorted {
            if let last = rows.last, Self.merges(last, use, calendar: calendar) {
                var fields = last.fields
                if let field = use.field, !fields.contains(field) { fields.append(field) }
                rows[rows.count - 1] = SecureUseRow(
                    id: last.id, outcome: last.outcome, site: last.site, workTitle: last.workTitle, fields: fields, at: last.at
                )
            } else {
                rows.append(SecureUseRow(
                    id: use.id, outcome: use.outcome, site: use.site, workTitle: use.workTitle,
                    fields: use.field.map { [$0] } ?? [], at: use.at
                ))
            }
        }
        return rows
    }

    private static func merges(_ row: SecureUseRow, _ use: SecureUseView, calendar: Calendar) -> Bool {
        guard row.outcome == use.outcome, row.site == use.site, row.workTitle == use.workTitle else { return false }
        guard let a = row.at, let b = use.at else { return row.at == nil && use.at == nil }
        return calendar.isDate(a, equalTo: b, toGranularity: .minute)
    }

    /// "Typed on dmv.ny.gov · Number, Expiry date".
    var title: String {
        let verb: String
        switch outcome {
        case .typed: verb = "Typed"
        case .sent: verb = "Sent"
        case .refusedSite: verb = "Refused"
        case .asked: verb = "Asked"
        case .allowedOnce: verb = "Allowed once"
        case .allowedAlways: verb = "Always allowed"
        case .denied: verb = "Not allowed"
        case .unknown: verb = "Used"
        }
        var text = verb
        if let site = site?.nilIfBlank {
            text += outcome == .sent ? " to \(site)" : " on \(site)"
        }
        let labels = fields.map(SecureFieldLabel.text)
        if !labels.isEmpty { text += " · " + labels.joined(separator: ", ") }
        return text
    }

    /// "Not one of this ID's sites · Renew the license · Oct 5, 9:41 AM".
    func detail(noun: String, locale: Locale = .current) -> String {
        var parts: [String] = []
        if outcome == .refusedSite { parts.append("Not one of this \(noun)'s sites") }
        if let workTitle = workTitle?.nilIfBlank { parts.append(workTitle) }
        if let at {
            parts.append(at.formatted(.dateTime.month(.abbreviated).day().hour().minute().locale(locale)))
        }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Allow

/// The answer to an `allow_secure` handoff.
enum SecureAllowScope: String, Hashable, Codable, Sendable {
    case once, always, deny

    static func from(_ raw: String?) -> SecureAllowScope? {
        raw.flatMap { SecureAllowScope(rawValue: $0) }
    }
}

/// `next.allow` on an `allow_secure` handoff: what the run asks to use, and where.
struct SecureAllowRequest: Hashable, Codable, Sendable {
    let itemID: String
    let kind: SecureItemKind
    /// "Driver's license".
    let itemLabel: String
    /// The field labels the run asks for: ["Number", "Expiry date"].
    let fieldLabels: [String]
    /// The registrable domain of the page: "ny.gov".
    let site: String
    /// The page host, for the reason line: "dmv.ny.gov".
    let host: String

    enum CodingKeys: String, CodingKey {
        case itemID = "itemId"
        case kind, itemLabel, fieldLabels, site, host
    }

    init(itemID: String, kind: SecureItemKind, itemLabel: String, fieldLabels: [String], site: String, host: String) {
        self.itemID = itemID
        self.kind = kind
        self.itemLabel = itemLabel
        self.fieldLabels = fieldLabels
        self.site = site
        self.host = host
    }

    init?(json: JSONValue) {
        guard let itemID = json["itemId"]?.stringValue?.nilIfBlank,
              let kind = SecureItemKind.from(json["kind"]?.stringValue),
              let site = json["site"]?.stringValue?.nilIfBlank else { return nil }
        self.itemID = itemID
        self.kind = kind
        itemLabel = json["itemLabel"]?.stringValue?.nilIfBlank ?? kind.defaultLabel
        fieldLabels = (json["fieldLabels"]?.arrayValue ?? []).compactMap { $0.stringValue?.nilIfBlank }
        self.site = site
        host = json["host"]?.stringValue?.nilIfBlank ?? site
    }
}

/// `next.allowAnswer`: the first answer, so every device shows the same receipt.
struct SecureAllowAnswerView: Hashable, Codable, Sendable {
    let scope: SecureAllowScope
    let at: Date?

    init(scope: SecureAllowScope, at: Date? = nil) {
        self.scope = scope
        self.at = at
    }

    init?(json: JSONValue) {
        guard let scope = SecureAllowScope.from(json["scope"]?.stringValue) else { return nil }
        self.scope = scope
        at = CalendarDateParser.date(json["at"])
    }
}

/// `next.saveSignIn` on a `sign_in` handoff when no sign-in is saved for the site (V13).
struct SecureSaveSignInOffer: Hashable, Codable, Sendable {
    let site: String

    init(site: String) {
        self.site = site
    }

    init?(json: JSONValue) {
        guard let site = json["site"]?.stringValue?.nilIfBlank else { return nil }
        self.site = site
    }
}

// MARK: - The ask card

/// The input of `ask_secure_detail` (V12): what to add, and why. No value.
struct SecureRequestInput: Hashable, Sendable {
    let kind: SecureItemKind
    let label: String?
    let site: String?
    let reason: String

    init(kind: SecureItemKind, label: String? = nil, site: String? = nil, reason: String) {
        self.kind = kind
        self.label = label?.nilIfBlank
        self.site = site?.nilIfBlank
        self.reason = reason
    }

    init?(json: JSONValue) {
        guard let kind = SecureItemKind.from(json["kind"]?.stringValue) else { return nil }
        self.init(
            kind: kind,
            label: json["label"]?.stringValue,
            site: json["site"]?.stringValue.map(SecureSite.clean),
            reason: json["reason"]?.stringValue?.nilIfBlank ?? ""
        )
    }

    /// The answer of the card: `{ saved: true, itemId }` or `{ skipped: true }`.
    static func savedAnswer(itemID: String) -> JSONValue {
        .object(["saved": .bool(true), "itemId": .string(itemID)])
    }

    static let skippedAnswer: JSONValue = .object(["skipped": .bool(true)])
}

// MARK: - Errors

/// Why a save, a delete, or an allow did not go through, with the line the user reads.
enum SecureSaveError: Error, Equatable, Sendable {
    /// The value does not fit its shape.
    case invalid(String)
    /// A card number, a two-factor code, a bank number: Albatross does not keep it.
    case refused(reason: String?, field: String?, message: String?)
    /// The site is not a site.
    case site(String?)
    /// The user has as many items as the server allows, or a second date of birth.
    case limit(String?)
    /// The question was answered already, on another device.
    case closed(String?)
    /// Passwords and IDs is off for this user.
    case off
    case notFound
    /// The server wants a recent identity check, then a retry.
    case verifyIdentity
    case other(String)

    static let cardLine = "This looks like a card number. Albatross does not keep card numbers yet."
    static let codeLine = "This looks like a two-factor or recovery code. Those stay with you."
    static let bankLine = "This looks like a bank or routing number. Albatross does not keep it yet."
    static let refusedLine = "Albatross does not keep this value."
    static let siteLine = "Enter a site like chase.com."
    static let limitLine = "You have as many items as Albatross can keep. Delete one first."
    static let closedLine = "This was answered already."
    static let offLine = "Passwords and IDs is not on for your account."
    static let notFoundLine = "This item is gone. It may be deleted on another device."
    static let checkLine = "Albatross needs one more check first."
    static let saveFailedLine = "It did not save. Try again."

    var line: String {
        switch self {
        case .invalid(let message): return message
        case .refused(let reason, _, let message): return Self.refusedLine(reason: reason, message: message)
        case .site(let message): return message?.nilIfBlank ?? Self.siteLine
        case .limit(let message): return message?.nilIfBlank ?? Self.limitLine
        case .closed(let message): return message?.nilIfBlank ?? Self.closedLine
        case .off: return Self.offLine
        case .notFound: return Self.notFoundLine
        case .verifyIdentity: return Self.checkLine
        case .other(let message): return message
        }
    }

    /// The line of a refusal, by the server's reason.
    static func refusedLine(reason: String?, message: String?) -> String {
        switch reason {
        case "card": return cardLine
        case "code": return codeLine
        case "bank": return bankLine
        default: return message?.nilIfBlank ?? refusedLine
        }
    }

    /// The field a refusal names, so the sheet puts the line under it.
    var field: String? {
        if case .refused(_, let field, _) = self { return field }
        return nil
    }

    /// Reads the route's error body: `{ code, reason?, field?, error }`.
    static func from(status: Int, body: JSONValue?) -> SecureSaveError {
        let message = body?["error"]?.stringValue?.nilIfBlank
        let code = body?["code"]?.stringValue
        if status == 403, code == "verify_identity" || message == nil { return .verifyIdentity }
        switch code {
        case "verify_identity": return .verifyIdentity
        case "refused":
            return .refused(reason: body?["reason"]?.stringValue, field: body?["field"]?.stringValue?.nilIfBlank, message: message)
        case "invalid": return .invalid(message ?? "Check the value and try again.")
        case "site": return .site(message)
        case "limit": return .limit(message)
        case "closed": return .closed(message)
        case "off": return .off
        case "not_found": return .notFound
        default: break
        }
        switch status {
        case 404: return .notFound
        case 409: return .limit(message)
        case 503: return .off
        default: return .other(message ?? Self.saveFailedLine)
        }
    }
}
