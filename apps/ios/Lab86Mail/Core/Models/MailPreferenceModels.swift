import Foundation

// Mail alerts (round 2, FEATURES item 12) and the "How you write" card
// (FEATURES item 16). Alerts read and write `GET/PUT /api/mail/push-settings`;
// the card uses `get_voice_profile`, `update_voice_profile`, and
// `learn_voice_profile`.

struct MailAlertSettings: Equatable, Sendable {
    enum Mode: String, CaseIterable, Identifiable, Sendable {
        case all
        case priority

        var id: String { rawValue }

        var label: String {
            switch self {
            case .all: "Every new email"
            case .priority: "Priority only"
            }
        }

        var detail: String {
            switch self {
            case .all: "Every new email pushes to your iPhone and Mac."
            case .priority:
                "VIP senders, urgent mail, and mail that needs your reply or an action push at once. Everything else arrives in one summary push, at most once an hour."
            }
        }
    }

    static let path = "/api/mail/push-settings"

    var mode: Mode
    var quietHoursEnabled: Bool
    var quietStart: Int
    var quietEnd: Int
    var vipSenders: [String]
    var timezone: String

    init(
        mode: Mode = .all,
        quietHoursEnabled: Bool = false,
        quietStart: Int = 22,
        quietEnd: Int = 7,
        vipSenders: [String] = [],
        timezone: String = TimeZone.current.identifier
    ) {
        self.mode = mode
        self.quietHoursEnabled = quietHoursEnabled
        self.quietStart = quietStart
        self.quietEnd = quietEnd
        self.vipSenders = vipSenders
        self.timezone = timezone
    }

    /// Reads `{ok, settings: {...}}` or the bare settings.
    init?(json: JSONValue?) {
        guard let json, json["ok"]?.boolValue != false else { return nil }
        let row = json["settings"] ?? json
        guard row.objectValue != nil else { return nil }
        mode = row["mode"]?.stringValue.flatMap(Mode.init(rawValue:)) ?? .all
        let quiet = row["quietHours"]
        quietHoursEnabled = quiet?["enabled"]?.boolValue ?? false
        quietStart = Self.hour(quiet?["start"], fallback: 22)
        quietEnd = Self.hour(quiet?["end"], fallback: 7)
        vipSenders = (row["vipSenders"]?.arrayValue ?? []).compactMap { $0.stringValue?.nilIfBlank }
        timezone = row["timezone"]?.stringValue?.nilIfBlank ?? TimeZone.current.identifier
    }

    private static func hour(_ value: JSONValue?, fallback: Int) -> Int {
        guard let raw = value?.doubleValue else { return fallback }
        let hour = Int(raw)
        return (0...23).contains(hour) ? hour : fallback
    }

    /// Quiet hours need two different hours.
    var quietHoursValid: Bool { !quietHoursEnabled || quietStart != quietEnd }

    /// "10:00 PM" for an hour of the day.
    static func hourLabel(_ hour: Int, locale: Locale = .current) -> String {
        BriefPreferences.hourLabel(hour, locale: locale)
    }

    /// A VIP entry: an address (`ann@example.com`) or a domain (`@example.com`).
    static func normalizedVIP(_ raw: String) -> String? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard value.count <= 254, value.contains("@"), !value.contains(" ") else { return nil }
        let parts = value.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[1].contains("."), !parts[1].hasPrefix("."), !parts[1].hasSuffix(".") else {
            return nil
        }
        return value
    }
}

/// One partial change for `PUT /api/mail/push-settings`.
struct MailAlertSettingsPatch: Equatable, Sendable {
    var mode: MailAlertSettings.Mode?
    var quietHoursEnabled: Bool?
    var quietStart: Int?
    var quietEnd: Int?
    var addVipSenders: [String]?
    var removeVipSenders: [String]?

    var body: JSONValue {
        var body: [String: JSONValue] = [:]
        if let mode { body["mode"] = .string(mode.rawValue) }
        var quiet: [String: JSONValue] = [:]
        if let quietHoursEnabled { quiet["enabled"] = .bool(quietHoursEnabled) }
        if let quietStart { quiet["start"] = .number(Double(quietStart)) }
        if let quietEnd { quiet["end"] = .number(Double(quietEnd)) }
        if !quiet.isEmpty { body["quietHours"] = .object(quiet) }
        if let addVipSenders, !addVipSenders.isEmpty { body["addVipSenders"] = .strings(addVipSenders) }
        if let removeVipSenders, !removeVipSenders.isEmpty { body["removeVipSenders"] = .strings(removeVipSenders) }
        return .object(body)
    }
}

// MARK: - How you write

struct VoiceProfile: Equatable, Sendable {
    enum Length: String, CaseIterable, Identifiable, Sendable {
        case short
        case medium
        case long

        var id: String { rawValue }
        var label: String { rawValue.capitalized }
    }

    var greeting: String
    var signOff: String
    var length: Length
    var tone: String
    var notes: String
    let typicalWords: Int
    let edited: Bool
    let sampleCount: Int
    let learnedAt: Date?
    let editedAt: Date?

    /// A blank card, for the form before anything is learned.
    init(greeting: String = "", signOff: String = "", length: Length = .medium, tone: String = "", notes: String = "") {
        self.greeting = greeting
        self.signOff = signOff
        self.length = length
        self.tone = tone
        self.notes = notes
        typicalWords = 0
        edited = false
        sampleCount = 0
        learnedAt = nil
        editedAt = nil
    }

    init?(json: JSONValue?) {
        guard let json, json.objectValue != nil else { return nil }
        greeting = json["greeting"]?.stringValue ?? ""
        signOff = json["signOff"]?.stringValue ?? ""
        length = json["length"]?.stringValue.flatMap(Length.init(rawValue:)) ?? .medium
        tone = json["tone"]?.stringValue ?? ""
        notes = json["notes"]?.stringValue ?? ""
        typicalWords = Int(json["typicalWords"]?.doubleValue ?? 0)
        edited = json["source"]?.stringValue == "edited"
        sampleCount = Int(json["sampleCount"]?.doubleValue ?? 0)
        learnedAt = CalendarDateParser.date(json["learnedAt"])
        editedAt = CalendarDateParser.date(json["editedAt"])
    }

    /// Where the card came from, under the heading.
    static func sourceLine(_ profile: VoiceProfile?) -> String {
        guard let profile else { return "Not learned yet" }
        if profile.edited, let editedAt = profile.editedAt {
            return "Edited \(dayLabel(editedAt))"
        }
        if let learnedAt = profile.learnedAt {
            let emails = profile.sampleCount == 1 ? "email" : "emails"
            return "Learned from \(profile.sampleCount) sent \(emails) on \(dayLabel(learnedAt))"
        }
        return "Set by you"
    }

    static func dayLabel(_ date: Date) -> String {
        date.formatted(.dateTime.month(.abbreviated).day())
    }

    /// `update_voice_profile` arguments with the fields the form owns.
    var updateArguments: [String: JSONValue] {
        [
            "greeting": .string(String(greeting.prefix(80))),
            "signOff": .string(String(signOff.prefix(120))),
            "length": .string(length.rawValue),
            "tone": .string(String(tone.prefix(240))),
            "notes": .string(String(notes.prefix(500))),
        ]
    }

    /// The fields the user can change, for the Save state.
    var editableFields: [String] { [greeting, signOff, length.rawValue, tone, notes] }
}

struct VoiceLearnResult: Equatable, Sendable {
    enum Status: String, Sendable {
        case learned
        case tooSoon = "too_soon"
        case edited
        case notEnoughMail = "not_enough_mail"
    }

    let status: Status
    let profile: VoiceProfile?
    let nextLearnAt: Date?
    let sampleCount: Int?

    init?(json: JSONValue) {
        guard let status = json["status"]?.stringValue.flatMap(Status.init(rawValue:)) else { return nil }
        self.status = status
        profile = VoiceProfile(json: json["profile"])
        nextLearnAt = CalendarDateParser.date(json["nextLearnAt"])
        sampleCount = json["sampleCount"]?.doubleValue.map { Int($0) }
    }

    /// What a learn attempt says back.
    var message: String {
        switch status {
        case .learned:
            return "Albatross learned how you write."
        case .tooSoon:
            let day = VoiceProfile.dayLabel(nextLearnAt ?? .now)
            return "Albatross learns at most once a week. You can learn again on \(day)."
        case .edited:
            return "Your edits are kept. Choose Replace my edits to learn again."
        case .notEnoughMail:
            return "Albatross needs at least 5 sent emails to learn how you write. It found \(sampleCount ?? 0)."
        }
    }
}

struct VoiceProfileClient: Sendable {
    let tools: any ToolInvoking

    func load() async throws -> (profile: VoiceProfile?, nextLearnAt: Date?) {
        let result = try await tools.invoke("get_voice_profile")
        return (VoiceProfile(json: result["profile"]), CalendarDateParser.date(result["nextLearnAt"]))
    }

    func update(_ profile: VoiceProfile) async throws -> VoiceProfile? {
        let result = try await tools.invoke("update_voice_profile", arguments: profile.updateArguments)
        return VoiceProfile(json: result["profile"])
    }

    func learn(replaceEdited: Bool) async throws -> VoiceLearnResult {
        let result = try await tools.invoke(
            "learn_voice_profile",
            arguments: replaceEdited ? ["replaceEdited": .bool(true)] : [:]
        )
        guard let outcome = VoiceLearnResult(json: result) else { throw BackendError.invalidResponse }
        return outcome
    }
}
