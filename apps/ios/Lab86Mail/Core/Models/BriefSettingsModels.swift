import Foundation

// The Daily Brief delivery preferences, the source health line, and per-item
// steering (round 2, FEATURES items 3, 6, 8, 9, 18). Web Settings and native
// read the same tools: `get_brief_preferences`, `save_brief_preferences`,
// `get_brief_sources`, and `steer_brief_item`.

enum BriefWeekendMode: String, CaseIterable, Identifiable, Sendable {
    case full
    case light
    case off

    var id: String { rawValue }

    var label: String {
        switch self {
        case .full: "Full edition"
        case .light: "Light edition"
        case .off: "No edition"
        }
    }

    var detail: String {
        switch self {
        case .full: "Saturday and Sunday get the same edition as a weekday."
        case .light: "Replies owed, today, and your calendar. Waiting and FYI sections stay out."
        case .off: "Nothing arrives on Saturday or Sunday."
        }
    }
}

struct BriefPreferences: Equatable, Sendable {
    static let deliveryHours = Array(5...11)

    var deliveryHour: Int
    var weekendMode: BriefWeekendMode
    var weeklyReview: Bool
    var emailEnabled: Bool
    var timezone: String?
    var emailAvailable: Bool
    var emailUnavailableReason: String?

    init(
        deliveryHour: Int = 7,
        weekendMode: BriefWeekendMode = .light,
        weeklyReview: Bool = true,
        emailEnabled: Bool = false,
        timezone: String? = nil,
        emailAvailable: Bool = false,
        emailUnavailableReason: String? = nil
    ) {
        self.deliveryHour = deliveryHour
        self.weekendMode = weekendMode
        self.weeklyReview = weeklyReview
        self.emailEnabled = emailEnabled
        self.timezone = timezone
        self.emailAvailable = emailAvailable
        self.emailUnavailableReason = emailUnavailableReason
    }

    /// Reads `{preferences: {...}}` or the bare preferences object.
    init?(json: JSONValue?) {
        guard let json else { return nil }
        let row = json["preferences"] ?? json
        guard row.objectValue != nil else { return nil }
        let hour = Int(row["deliveryHour"]?.doubleValue ?? 7)
        deliveryHour = Self.deliveryHours.contains(hour) ? hour : 7
        weekendMode = row["weekendMode"]?.stringValue.flatMap(BriefWeekendMode.init(rawValue:)) ?? .light
        weeklyReview = row["weeklyReview"]?.boolValue ?? true
        timezone = row["timezone"]?.stringValue?.nilIfBlank
        emailAvailable = row["email"]?["available"]?.boolValue ?? false
        emailUnavailableReason = row["email"]?["reason"]?.stringValue?.nilIfBlank
        // An edition by email cannot go out without the email service.
        emailEnabled = emailAvailable && (row["emailEnabled"]?.boolValue ?? false)
    }

    /// "7:00 AM" in the device locale.
    static func hourLabel(_ hour: Int, locale: Locale = .current) -> String {
        var components = DateComponents()
        components.hour = hour
        components.minute = 0
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        guard let date = calendar.date(from: components) else { return "\(hour):00" }
        var style = Date.FormatStyle(date: .omitted, time: .shortened)
        style.timeZone = calendar.timeZone
        style.locale = locale
        return date.formatted(style)
    }

    /// "7:00 AM", the same words the web summary uses.
    static func plainHourLabel(_ hour: Int) -> String {
        let clock = hour % 12 == 0 ? 12 : hour % 12
        return "\(clock):00 \(hour < 12 ? "AM" : "PM")"
    }

    /// One sentence that says when the next editions arrive.
    var scheduleSummary: String {
        let zone = timezone.map { " \($0.replacingOccurrences(of: "_", with: " ")) time" } ?? ""
        let weekend = switch weekendMode {
        case .off: "No edition on Saturday"
        case .light: "A light edition on Saturday"
        case .full: "The full edition on Saturday"
        }
        let sunday = weeklyReview
            ? "the weekly review on Sunday"
            : (weekendMode == .off ? "none on Sunday" : "the same on Sunday")
        return "Weekdays at \(Self.plainHourLabel(deliveryHour))\(zone). \(weekend), and \(sunday)."
    }
}

/// One change to the brief preferences. Only the set fields go to the server.
struct BriefPreferencesPatch: Equatable, Sendable {
    var deliveryHour: Int?
    var weekendMode: BriefWeekendMode?
    var weeklyReview: Bool?
    var emailEnabled: Bool?

    var arguments: [String: JSONValue] {
        var arguments: [String: JSONValue] = [:]
        if let deliveryHour { arguments["deliveryHour"] = .number(Double(deliveryHour)) }
        if let weekendMode { arguments["weekendMode"] = .string(weekendMode.rawValue) }
        if let weeklyReview { arguments["weeklyReview"] = .bool(weeklyReview) }
        if let emailEnabled { arguments["emailEnabled"] = .bool(emailEnabled) }
        return arguments
    }
}

// MARK: - Source health

struct BriefSource: Identifiable, Equatable, Sendable {
    enum Kind: String, Sendable {
        case mail
        case calendar
        case connector
    }

    enum Status: String, Sendable {
        case ok
        case syncing
        case stale
        case reconnect
        case error
    }

    let id: String
    let kind: Kind
    let label: String
    let provider: String
    let status: Status
    let lastSyncedAt: Date?
    let inEdition: Bool
    let reconnectPath: String?
    let detail: String?

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue?.nilIfBlank,
              let kind = json["kind"]?.stringValue.flatMap(Kind.init(rawValue:)) else { return nil }
        self.id = id
        self.kind = kind
        label = json["label"]?.stringValue?.nilIfBlank ?? id
        provider = json["provider"]?.stringValue ?? ""
        status = json["status"]?.stringValue.flatMap(Status.init(rawValue:)) ?? .ok
        lastSyncedAt = CalendarDateParser.date(json["lastSyncedAt"])
        inEdition = json["inEdition"]?.boolValue ?? false
        reconnectPath = json["reconnectPath"]?.stringValue?.nilIfBlank
        detail = json["detail"]?.stringValue?.nilIfBlank
    }

    /// A source the user must act on.
    var needsUser: Bool { status == .reconnect || status == .error }

    /// "Calendar (ann@example.com)" for a calendar, else the label.
    var displayName: String { kind == .calendar ? "Calendar (\(label))" : label }

    /// "synced 4 min ago", or "still syncing" before the first sync.
    func syncLine(now: Date) -> String {
        if status == .syncing, lastSyncedAt == nil { return "still syncing" }
        return "synced \(BriefSourceHealth.syncedAgo(lastSyncedAt, now: now))"
    }

    /// The problem sentence, when the server wrote none.
    var problemLine: String {
        detail ?? (status == .reconnect ? "\(displayName) needs to reconnect." : "\(displayName) could not sync.")
    }
}

struct BriefSourceHealth: Equatable, Sendable {
    let sources: [BriefSource]
    let attention: Int
    let line: String

    init(sources: [BriefSource], attention: Int, line: String) {
        self.sources = sources
        self.attention = attention
        self.line = line
    }

    /// Reads `{health: {...}}` or the bare summary.
    init?(json: JSONValue?) {
        guard let json else { return nil }
        let row = json["health"] ?? json
        guard row.objectValue != nil else { return nil }
        sources = (row["sources"]?.arrayValue ?? []).compactMap(BriefSource.init(json:))
        attention = Int(row["attention"]?.doubleValue ?? Double(sources.filter(\.needsUser).count))
        line = row["line"]?.stringValue?.nilIfBlank ?? ""
    }

    /// Sources that need the user, first on the line.
    var problems: [BriefSource] { sources.filter(\.needsUser) }
    var others: [BriefSource] { sources.filter { !$0.needsUser } }

    /// "just now", "4 min ago", "3 hours ago", "2 days ago".
    static func syncedAgo(_ at: Date?, now: Date) -> String {
        guard let at else { return "not synced yet" }
        let diff = max(0, now.timeIntervalSince(at))
        if diff < 60 { return "just now" }
        let minutes = Int((diff / 60).rounded())
        if minutes < 60 { return "\(minutes) min ago" }
        let hours = Int((Double(minutes) / 60).rounded())
        if hours < 24 { return "\(hours) \(hours == 1 ? "hour" : "hours") ago" }
        let days = Int((Double(hours) / 24).rounded())
        return "\(days) \(days == 1 ? "day" : "days") ago"
    }

    /// "Sources: a@x.com synced 4 min ago · Calendar (a@x.com) synced just now".
    func sourcesLine(now: Date) -> String? {
        guard !others.isEmpty else { return nil }
        return "Sources: " + others.map { "\($0.displayName) \($0.syncLine(now: now))" }.joined(separator: " · ")
    }
}

/// One-line notes about the edition itself, shown with the source line.
enum BriefEditionNotes {
    static let first =
        "Your first brief, from the last two days of mail and the week ahead. It fills in as your mailbox finishes syncing."
    static let light = "A light weekend edition: replies owed, today, and your calendar."

    static func notes(for report: DailyReportModel?) -> [String] {
        guard let report else { return [] }
        var notes: [String] = []
        if report.isFirstEdition { notes.append(first) }
        if report.isLightEdition, !report.isWeeklyReview { notes.append(light) }
        return notes
    }
}

// MARK: - Steering

enum BriefSteeringMode: String, CaseIterable, Sendable {
    case notForMe = "not_for_me"
    case lessFromSender = "less_from_sender"
    case keepShowing = "keep_showing"

    /// Every choice but Keep showing takes the item out of the live edition.
    var hidesItem: Bool { self != .keepShowing }
}

/// The `steer_brief_item` arguments from one brief action payload. Nil when
/// the payload misses the mode or the thread.
enum BriefSteeringRequest {
    static func arguments(_ payload: BriefActionPayload) -> [String: JSONValue]? {
        guard let mode = payload.mode.flatMap(BriefSteeringMode.init(rawValue:)),
              let account = payload.account?.nilIfBlank,
              let threadID = payload.threadID?.nilIfBlank else { return nil }
        var arguments: [String: JSONValue] = [
            "mode": .string(mode.rawValue),
            "account": .string(account),
            "threadId": .string(threadID),
        ]
        if let subject = payload.subject?.nilIfBlank { arguments["subject"] = .string(subject) }
        if let senderEmail = payload.senderEmail?.nilIfBlank { arguments["senderEmail"] = .string(senderEmail) }
        if let receivedAt = payload.receivedAt { arguments["receivedAt"] = .number(receivedAt) }
        return arguments
    }
}

/// The client for the brief preference, source, and steering tools.
struct BriefSettingsClient: Sendable {
    let tools: any ToolInvoking

    func preferences() async throws -> BriefPreferences {
        let result = try await tools.invoke("get_brief_preferences")
        guard let preferences = BriefPreferences(json: result) else { throw BackendError.invalidResponse }
        return preferences
    }

    func save(_ patch: BriefPreferencesPatch) async throws -> BriefPreferences {
        let result = try await tools.invoke("save_brief_preferences", arguments: patch.arguments)
        guard let preferences = BriefPreferences(json: result) else { throw BackendError.invalidResponse }
        return preferences
    }

    func sources(reportID: String?) async throws -> BriefSourceHealth {
        var arguments: [String: JSONValue] = [:]
        if let reportID = reportID?.nilIfBlank { arguments["reportId"] = .string(reportID) }
        let result = try await tools.invoke("get_brief_sources", arguments: arguments)
        guard let health = BriefSourceHealth(json: result) else { throw BackendError.invalidResponse }
        return health
    }
}
