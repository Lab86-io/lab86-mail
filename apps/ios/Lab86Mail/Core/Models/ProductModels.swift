import Foundation

struct AccountSummary: Identifiable, Hashable, Codable, Sendable {
    let id: String
    let email: String
    let provider: String
    let displayName: String?
    let isPrimary: Bool

    init?(json: JSONValue) {
        guard let id = json["accountId"]?.stringValue,
              let email = json["email"]?.stringValue else { return nil }
        self.id = id
        self.email = email
        provider = json["provider"]?.stringValue ?? "mail"
        displayName = json["displayName"]?.stringValue
        isPrimary = json["primary"]?.boolValue ?? false
    }
}

struct MailThreadSummary: Identifiable, Hashable, Codable, Sendable {
    let id: String
    let accountID: String
    let subject: String
    let sender: String
    let snippet: String
    let date: Date
    var unread: Bool
    var starred: Bool
    let category: String?
    let categoryReason: String?
    let categoryConfidence: Double?

    init(
        id: String,
        accountID: String,
        subject: String,
        sender: String,
        snippet: String,
        date: Date,
        unread: Bool,
        starred: Bool,
        category: String? = nil,
        categoryReason: String? = nil,
        categoryConfidence: Double? = nil
    ) {
        self.id = id
        self.accountID = accountID
        self.subject = EmailTextNormalizer.header(subject).nilIfBlank ?? "(No subject)"
        self.sender = EmailTextNormalizer.header(sender).nilIfBlank ?? "Unknown sender"
        self.snippet = EmailTextNormalizer.preview(snippet)
        self.date = date
        self.unread = unread
        self.starred = starred
        self.category = category
        self.categoryReason = categoryReason
        self.categoryConfidence = categoryConfidence
    }

    init?(json: JSONValue, accountID fallbackAccountID: String? = nil) {
        guard let id = json["providerThreadId"]?.stringValue
            ?? json["threadId"]?.stringValue
            ?? json["_id"]?.stringValue else { return nil }
        self.id = id
        // `list_account_threads` returns `accountId`, while the cross-account
        // `corpus_search` contract intentionally calls this field `account`.
        // Accept both so a search result always retains the mailbox required
        // for opening and mutating its provider thread.
        accountID = json["accountId"]?.stringValue
            ?? json["account"]?.stringValue
            ?? fallbackAccountID
            ?? ""
        subject = EmailTextNormalizer.header(json["subject"]?.stringValue).nilIfBlank ?? "(No subject)"
        sender = Self.addressString(json["fromAddress"] ?? json["from"] ?? json["participants"]) ?? "Unknown sender"
        snippet = EmailTextNormalizer.preview(json["snippet"]?.stringValue ?? "")
        date = Self.date(from: json["lastDate"]?.doubleValue ?? json["date"]?.doubleValue)
        unread = json["unread"]?.boolValue ?? false
        starred = json["starred"]?.boolValue ?? false
        category = json["smartCategory"]?["primary"]?.stringValue
        categoryReason = json["smartCategory"]?["reason"]?.stringValue?.nilIfBlank
        categoryConfidence = json["smartCategory"]?["confidence"]?.doubleValue
    }

    private static func date(from value: Double?) -> Date {
        guard var value else { return .distantPast }
        if value > 10_000_000_000 { value /= 1_000 }
        return Date(timeIntervalSince1970: value)
    }

    static func addressString(_ value: JSONValue?) -> String? {
        guard let value else { return nil }
        if let string = value.stringValue { return EmailTextNormalizer.header(string).nilIfBlank }
        if let array = value.arrayValue {
            return array.compactMap(addressString).joined(separator: ", ").nilIfBlank
        }
        if let name = value["name"]?.stringValue, !name.isEmpty {
            return EmailTextNormalizer.header(name).nilIfBlank
        }
        return EmailTextNormalizer.header(value["email"]?.stringValue ?? value["address"]?.stringValue).nilIfBlank
    }
}

struct MailMessage: Identifiable, Hashable, Sendable {
    let id: String
    let sender: String
    let recipients: String
    let snippet: String
    let textBody: String
    let htmlBody: String?
    let attachments: [MailAttachment]
    let date: Date

    var body: String {
        EmailTextNormalizer.readerText(textBody.nilIfBlank ?? snippet)
    }

    init(json: JSONValue, index: Int) {
        id = json["providerMessageId"]?.stringValue ?? json["id"]?.stringValue ?? json["_id"]?.stringValue ?? "message-\(index)"
        sender = MailThreadSummary.addressString(json["from"] ?? json["fromAddress"]) ?? "Unknown sender"
        recipients = MailThreadSummary.addressString(json["to"]) ?? ""
        snippet = EmailTextNormalizer.preview(json["snippet"]?.stringValue ?? "")
        textBody = json["textBody"]?.stringValue
            ?? json["body"]?.stringValue
            ?? ""
        htmlBody = json["htmlBody"]?.stringValue?.nilIfBlank
        attachments = (json["attachments"]?.arrayValue ?? []).compactMap(MailAttachment.init)
        var timestamp = json["receivedAt"]?.doubleValue ?? json["date"]?.doubleValue ?? 0
        if timestamp > 10_000_000_000 { timestamp /= 1_000 }
        date = Date(timeIntervalSince1970: timestamp)
    }

    init(payload: LiveMailMessagePayload, index: Int) {
        id = payload.id.nilIfBlank ?? "message-\(index)"
        sender = EmailTextNormalizer.header(payload.from).nilIfBlank ?? "Unknown sender"
        recipients = EmailTextNormalizer.header(payload.to)
        snippet = EmailTextNormalizer.preview(payload.snippet)
        textBody = payload.textBody ?? ""
        htmlBody = payload.htmlBody?.nilIfBlank
        attachments = payload.attachments.map(\.attachment)
        date = Self.date(from: payload.date)
    }

    private static func date(from rawValue: Double) -> Date {
        var value = rawValue
        if value > 10_000_000_000 { value /= 1_000 }
        return Date(timeIntervalSince1970: value)
    }
}

struct MailAttachment: Identifiable, Hashable, Sendable {
    let id: String
    let filename: String
    let mimeType: String
    let size: Int

    init?(json: JSONValue) {
        guard let id = json["attachmentId"]?.stringValue
            ?? json["id"]?.stringValue
            ?? json["attachment_id"]?.stringValue else { return nil }
        self.id = id
        filename = json["filename"]?.stringValue
            ?? json["name"]?.stringValue
            ?? "Attachment"
        mimeType = json["mimeType"]?.stringValue
            ?? json["contentType"]?.stringValue
            ?? json["content_type"]?.stringValue
            ?? "application/octet-stream"
        size = Int(json["size"]?.doubleValue ?? 0)
    }

    init(id: String, filename: String, mimeType: String, size: Int) {
        self.id = id
        self.filename = filename
        self.mimeType = mimeType
        self.size = size
    }
}

struct MailThreadDetail: Sendable {
    let subject: String
    let messages: [MailMessage]

    init(json: JSONValue) {
        subject = EmailTextNormalizer.header(json["subject"]?.stringValue).nilIfBlank ?? "(No subject)"
        messages = (json["messages"]?.arrayValue ?? []).enumerated().map { MailMessage(json: $0.element, index: $0.offset) }
    }

    init(payload: LiveMailThreadDetailPayload) {
        subject = EmailTextNormalizer.header(payload.subject).nilIfBlank ?? "(No subject)"
        messages = payload.messages.enumerated()
            .map { MailMessage(payload: $0.element, index: $0.offset) }
            .sorted { $0.date < $1.date }
    }
}

struct BulkTriageVerdict: Identifiable, Hashable, Sendable {
    let id: String
    let priority: Int
    let action: String
    let reason: String

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue else { return nil }
        self.id = id
        priority = Int(json["priority"]?.doubleValue ?? 2)
        action = json["action"]?.stringValue ?? "read"
        reason = json["reason"]?.stringValue ?? ""
    }
}

struct UndoableOperationNotice: Identifiable, Hashable, Sendable {
    let id: String
    let summary: String
}

struct LiveMailThreadsPayload: Decodable, Sendable {
    let items: [LiveMailThreadPayload]
}

struct LiveMailThreadPayload: Decodable, Sendable {
    let accountID: String
    let providerThreadID: String
    let subject: String
    let fromAddress: String
    let lastDate: Double
    let snippet: String
    let unread: Bool
    let starred: Bool?
    let smartCategory: LiveMailCategoryPayload?

    enum CodingKeys: String, CodingKey {
        case account
        case accountID = "accountId"
        case id = "_id"
        case providerThreadID = "providerThreadId"
        case subject
        case fromAddress
        case lastDate
        case snippet
        case unread
        case starred
        case smartCategory
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        accountID = try values.decodeIfPresent(String.self, forKey: .accountID)
            ?? values.decode(String.self, forKey: .account)
        providerThreadID = try values.decodeIfPresent(String.self, forKey: .providerThreadID)
            ?? values.decode(String.self, forKey: .id)
        subject = try values.decodeIfPresent(String.self, forKey: .subject) ?? "(No subject)"
        fromAddress = try values.decodeIfPresent(String.self, forKey: .fromAddress) ?? ""
        lastDate = try values.decodeIfPresent(Double.self, forKey: .lastDate) ?? 0
        snippet = try values.decodeIfPresent(String.self, forKey: .snippet) ?? ""
        unread = try values.decodeIfPresent(Bool.self, forKey: .unread) ?? false
        starred = try values.decodeIfPresent(Bool.self, forKey: .starred)
        smartCategory = try values.decodeIfPresent(LiveMailCategoryPayload.self, forKey: .smartCategory)
    }

    var summary: MailThreadSummary {
        var timestamp = lastDate
        if timestamp > 10_000_000_000 { timestamp /= 1_000 }
        return MailThreadSummary(
            id: providerThreadID,
            accountID: accountID,
            subject: subject,
            sender: fromAddress,
            snippet: snippet,
            date: Date(timeIntervalSince1970: timestamp),
            unread: unread,
            starred: starred ?? false,
            category: smartCategory?.primary,
            categoryReason: smartCategory?.reason,
            categoryConfidence: smartCategory?.confidence
        )
    }
}

struct LiveMailCategoryPayload: Decodable, Sendable {
    let primary: String
    let reason: String?
    let confidence: Double?
}

struct LiveMailThreadDetailPayload: Decodable, Sendable {
    let threadID: String
    let subject: String
    let messages: [LiveMailMessagePayload]

    enum CodingKeys: String, CodingKey {
        case threadID = "threadId"
        case subject
        case messages
    }
}

struct LiveMailMessagePayload: Decodable, Sendable {
    let id: String
    let from: String
    let to: String
    let date: Double
    let snippet: String
    let textBody: String?
    let htmlBody: String?
    let attachments: [LiveMailAttachmentPayload]

    enum CodingKeys: String, CodingKey {
        case id = "_id"
        case from
        case to
        case date
        case snippet
        case textBody
        case htmlBody
        case attachments
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        from = try values.decodeIfPresent(String.self, forKey: .from) ?? ""
        to = try values.decodeIfPresent(String.self, forKey: .to) ?? ""
        date = try values.decodeIfPresent(Double.self, forKey: .date) ?? 0
        snippet = try values.decodeIfPresent(String.self, forKey: .snippet) ?? ""
        textBody = try values.decodeIfPresent(String.self, forKey: .textBody)
        htmlBody = try values.decodeIfPresent(String.self, forKey: .htmlBody)
        attachments = try values.decodeIfPresent([LiveMailAttachmentPayload].self, forKey: .attachments) ?? []
    }
}

struct LiveMailAttachmentPayload: Decodable, Sendable {
    let id: String
    let filename: String
    let mimeType: String
    let size: Int

    enum CodingKeys: String, CodingKey {
        case id
        case attachmentID = "attachmentId"
        case filename
        case name
        case mimeType
        case contentType
        case size
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decodeIfPresent(String.self, forKey: .attachmentID)
            ?? values.decode(String.self, forKey: .id)
        filename = try values.decodeIfPresent(String.self, forKey: .filename)
            ?? values.decodeIfPresent(String.self, forKey: .name)
            ?? "Attachment"
        mimeType = try values.decodeIfPresent(String.self, forKey: .mimeType)
            ?? values.decodeIfPresent(String.self, forKey: .contentType)
            ?? "application/octet-stream"
        size = try values.decodeIfPresent(Int.self, forKey: .size) ?? 0
    }

    var attachment: MailAttachment {
        MailAttachment(id: id, filename: filename, mimeType: mimeType, size: size)
    }
}

// Robust calendar date parsing. The server emits ISO timestamps from
// `new Date(...).toISOString()`, which ALWAYS carries fractional seconds
// (".000Z"); a default `ISO8601DateFormatter` rejects those, so the previous
// code silently produced 1970 for every event. This accepts ISO8601 with and
// without fractional seconds plus numeric seconds/milliseconds, and returns nil
// on anything it cannot read so a required date can be rejected rather than
// invented.
enum CalendarDateParser {
    static func date(_ json: JSONValue?) -> Date? {
        switch json {
        case .string(let raw): return date(fromString: raw)
        case .number(let value): return date(fromNumber: value)
        default: return nil
        }
    }

    static func date(fromString raw: String) -> Date? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        // Formatters are built inline (ISO8601DateFormatter is a non-Sendable
        // class, so it is not held as shared static state).
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = fractional.date(from: trimmed) { return parsed }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let parsed = plain.date(from: trimmed) { return parsed }
        if let numeric = Double(trimmed) { return date(fromNumber: numeric) }
        return nil
    }

    static func date(fromNumber value: Double) -> Date? {
        guard value > 0, value.isFinite else { return nil }
        // Values past year ~2286-in-seconds are milliseconds since the epoch.
        let seconds = value > 10_000_000_000 ? value / 1_000 : value
        return Date(timeIntervalSince1970: seconds)
    }
}

struct CalendarEventSummary: Identifiable, Hashable, Codable, Sendable {
    let id: String
    let accountID: String
    let calendarID: String?
    let title: String
    let start: Date
    let end: Date
    let allDay: Bool
    let location: String?

    init(
        id: String,
        accountID: String,
        calendarID: String?,
        title: String,
        start: Date,
        end: Date,
        allDay: Bool,
        location: String?
    ) {
        self.id = id
        self.accountID = accountID
        self.calendarID = calendarID
        self.title = title
        self.start = start
        self.end = end
        self.allDay = allDay
        self.location = location
    }

    init?(json: JSONValue) {
        guard let id = json["eventId"]?.stringValue
            ?? json["providerEventId"]?.stringValue
            ?? json["_id"]?.stringValue else { return nil }
        // A required date that cannot be read rejects the event. Never 1970.
        guard let start = CalendarDateParser.date(json["startIso"] ?? json["startAt"] ?? json["start"]),
              let end = CalendarDateParser.date(json["endIso"] ?? json["endAt"] ?? json["end"]),
              end >= start else { return nil }
        self.id = id
        accountID = json["accountId"]?.stringValue ?? json["account"]?.stringValue ?? ""
        calendarID = json["calendarId"]?.stringValue?.nilIfBlank
        title = json["title"]?.stringValue?.nilIfBlank ?? "Untitled event"
        self.start = start
        self.end = end
        allDay = json["allDay"]?.boolValue ?? false
        location = json["location"]?.stringValue?.nilIfBlank
    }

    // Backwards-compatible cache decoding: snapshots written before accountID /
    // calendarID / allDay existed still load (new fields default rather than
    // failing the whole ProductSnapshot).
    enum CodingKeys: String, CodingKey {
        case id, accountID, calendarID, title, start, end, allDay, location
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        accountID = try container.decodeIfPresent(String.self, forKey: .accountID) ?? ""
        calendarID = try container.decodeIfPresent(String.self, forKey: .calendarID)
        title = try container.decode(String.self, forKey: .title)
        start = try container.decode(Date.self, forKey: .start)
        end = try container.decode(Date.self, forKey: .end)
        allDay = try container.decodeIfPresent(Bool.self, forKey: .allDay) ?? false
        location = try container.decodeIfPresent(String.self, forKey: .location)
    }
}

// Full event read backing EventDetailView. Populated from `calendar_event_detail`
// (which requires a calendar id) with the untruncated description, attendees,
// conferencing, and organizer that the list result intentionally trims.
struct CalendarEventDetail: Sendable {
    struct Attendee: Identifiable, Hashable, Sendable {
        let name: String
        let email: String?
        let responseStatus: String?
        let isOrganizer: Bool
        var id: String { email ?? name }
    }

    let title: String
    let start: Date?
    let end: Date?
    let allDay: Bool
    let location: String?
    let description: String?
    let calendarName: String?
    let accountID: String?
    let organizerLabel: String?
    let conferenceURL: URL?
    let conferenceLabel: String?
    let attendees: [Attendee]
    let htmlLink: URL?
    let masterEventID: String?
    let recurrence: [String]

    init(json: JSONValue) {
        title = json["title"]?.stringValue?.nilIfBlank ?? "Untitled event"
        start = CalendarDateParser.date(json["startIso"] ?? json["startAt"] ?? json["start"])
        end = CalendarDateParser.date(json["endIso"] ?? json["endAt"] ?? json["end"])
        allDay = json["allDay"]?.boolValue ?? false
        location = json["location"]?.stringValue?.nilIfBlank
        description = json["description"]?.stringValue?.nilIfBlank
        calendarName = (json["calendarName"] ?? json["calendarId"])?.stringValue?.nilIfBlank
        accountID = json["accountId"]?.stringValue?.nilIfBlank ?? json["account"]?.stringValue?.nilIfBlank
        organizerLabel = MailThreadSummary.addressString(json["organizer"])
        htmlLink = json["htmlLink"]?.stringValue.flatMap(URL.init(string:))
        masterEventID = json["masterEventId"]?.stringValue?.nilIfBlank
        recurrence = (json["recurrence"]?.arrayValue ?? []).compactMap(\.stringValue)

        let conference = json["conferencing"]
        let rawConferenceURL = conference?["url"]?.stringValue
            ?? conference?["uri"]?.stringValue
            ?? conference?["link"]?.stringValue
            ?? conference?["entryPoints"]?.arrayValue?.compactMap { $0["uri"]?.stringValue }.first
        conferenceURL = rawConferenceURL.flatMap(URL.init(string:))
        conferenceLabel = conference?["provider"]?.stringValue?.nilIfBlank
            ?? conference?["name"]?.stringValue?.nilIfBlank
            ?? (rawConferenceURL != nil ? "Video call" : nil)

        attendees = (json["participants"]?.arrayValue ?? json["attendees"]?.arrayValue ?? []).compactMap { row in
            let email = row["email"]?.stringValue?.nilIfBlank ?? row["address"]?.stringValue?.nilIfBlank
            let name = row["name"]?.stringValue?.nilIfBlank ?? email
            guard let name else { return nil }
            return Attendee(
                name: name,
                email: email,
                responseStatus: row["responseStatus"]?.stringValue?.nilIfBlank
                    ?? row["status"]?.stringValue?.nilIfBlank,
                isOrganizer: row["organizer"]?.boolValue ?? false
            )
        }
    }
}

struct CalendarChoice: Identifiable, Hashable, Sendable {
    let accountID: String
    let calendarID: String
    let name: String
    let isPrimary: Bool
    let isReadOnly: Bool
    let hexColor: String?

    var id: String { "\(accountID):\(calendarID)" }

    init?(json: JSONValue) {
        guard let accountID = json["accountId"]?.stringValue,
              let calendarID = json["calendarId"]?.stringValue else { return nil }
        self.accountID = accountID
        self.calendarID = calendarID
        name = json["name"]?.stringValue?.nilIfBlank ?? "Calendar"
        isPrimary = json["isPrimary"]?.boolValue ?? false
        isReadOnly = json["readOnly"]?.boolValue ?? false
        hexColor = json["hexColor"]?.stringValue?.nilIfBlank
    }
}

struct TaskBoardSummary: Identifiable, Hashable, Codable, Sendable {
    let id: String
    let title: String
    let owned: Bool
    let hasPublicLink: Bool
    let isDefault: Bool

    init?(json: JSONValue) {
        guard let id = json["boardId"]?.stringValue ?? json["_id"]?.stringValue else { return nil }
        self.id = id
        title = json["title"]?.stringValue?.nilIfBlank ?? "Board"
        owned = json["owned"]?.boolValue ?? false
        hasPublicLink = json["hasPublicLink"]?.boolValue ?? false
        isDefault = json["isDefault"]?.boolValue ?? false
    }
}

struct TaskColumnSummary: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let order: Double

    init(id: String, name: String, order: Double) {
        self.id = id
        self.name = name
        self.order = order
    }

    init?(json: JSONValue) {
        guard let id = json["columnId"]?.stringValue, let name = json["name"]?.stringValue else { return nil }
        self.id = id
        self.name = name
        order = json["order"]?.doubleValue ?? 0
    }
}

struct TaskBoardMember: Identifiable, Hashable, Sendable {
    let id: String
    let email: String
    let role: String
    let status: String

    init?(json: JSONValue) {
        guard let id = json["memberId"]?.stringValue, let email = json["email"]?.stringValue else { return nil }
        self.id = id
        self.email = email
        role = json["role"]?.stringValue ?? "viewer"
        status = json["status"]?.stringValue ?? "invited"
    }
}

struct TaskAttachmentSummary: Identifiable, Hashable, Codable, Sendable {
    let name: String
    let url: URL?
    let contentType: String?
    let size: Int?

    var id: String { "\(name):\(url?.absoluteString ?? "")" }

    init(json: JSONValue) {
        name = json["name"]?.stringValue?.nilIfBlank ?? "Attachment"
        url = json["url"]?.stringValue.flatMap(URL.init(string:))
        contentType = json["contentType"]?.stringValue?.nilIfBlank
        size = json["size"]?.doubleValue.map(Int.init)
    }
}

struct TaskCommentSummary: Identifiable, Hashable, Codable, Sendable {
    let id: String
    let author: String
    let body: String
    let createdAt: Date?

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue, let body = json["body"]?.stringValue else { return nil }
        self.id = id
        author = json["authorEmail"]?.stringValue?.nilIfBlank ?? "Collaborator"
        self.body = body
        createdAt = CalendarDateParser.date(json["createdAt"])
    }
}

struct TaskActivitySummary: Identifiable, Hashable, Codable, Sendable {
    let id: String
    let kind: String
    let detail: String?
    let actor: String?
    let createdAt: Date?

    init?(json: JSONValue) {
        kind = json["kind"]?.stringValue ?? json["action"]?.stringValue ?? "updated"
        detail = json["detail"]?.stringValue?.nilIfBlank
        actor = json["actorEmail"]?.stringValue?.nilIfBlank ?? json["authorEmail"]?.stringValue?.nilIfBlank
        createdAt = CalendarDateParser.date(json["createdAt"])
        id = json["id"]?.stringValue
            ?? "\(kind):\(createdAt?.timeIntervalSince1970 ?? 0):\(detail ?? "")"
    }
}

struct TaskSourceSummary: Hashable, Codable, Sendable {
    let kind: String
    let accountID: String?
    let threadID: String?
    let calendarID: String?
    let eventID: String?
    let url: URL?
    let title: String?

    init?(json: JSONValue?) {
        guard let json, let kind = json["kind"]?.stringValue else { return nil }
        self.kind = kind
        accountID = json["accountId"]?.stringValue?.nilIfBlank
        threadID = json["threadId"]?.stringValue?.nilIfBlank
        calendarID = json["calendarId"]?.stringValue?.nilIfBlank
        eventID = json["eventId"]?.stringValue?.nilIfBlank
        url = json["url"]?.stringValue.flatMap(URL.init(string:))
        title = json["title"]?.stringValue?.nilIfBlank
    }
}

struct TaskDraftSuggestion: Sendable {
    let title: String
    let details: String
    let priority: String?
    let due: Date?

    init?(json: JSONValue?) {
        guard let json, let title = json["title"]?.stringValue?.nilIfBlank else { return nil }
        self.title = title
        details = json["description"]?.stringValue ?? ""
        priority = json["priority"]?.stringValue?.nilIfBlank
        due = CalendarDateParser.date(json["dueIso"])
    }
}

struct CaptureSuggestion: Identifiable, Hashable, Sendable {
    let id: UUID
    var title: String
    var rawText: String

    init(id: UUID = UUID(), title: String, rawText: String) {
        self.id = id
        self.title = title
        self.rawText = rawText
    }

    init?(json: JSONValue) {
        guard let title = json["title"]?.stringValue?.nilIfBlank,
              let rawText = json["rawText"]?.stringValue?.nilIfBlank else { return nil }
        id = UUID()
        self.title = title
        self.rawText = rawText
    }
}

struct ProjectSummary: Identifiable, Hashable, Codable, Sendable {
    let id: String
    let title: String
    let status: String
    let areaID: String?

    init?(json: JSONValue) {
        guard let id = json["projectId"]?.stringValue ?? json["_id"]?.stringValue else { return nil }
        self.id = id
        title = json["title"]?.stringValue?.nilIfBlank
            ?? json["name"]?.stringValue?.nilIfBlank
            ?? "Untitled project"
        status = json["status"]?.stringValue ?? "active"
        areaID = json["areaId"]?.stringValue?.nilIfBlank
    }
}

struct TaskSummary: Identifiable, Hashable, Codable, Sendable {
    let id: String
    let title: String
    let column: String
    let due: Date?
    let completed: Bool
    let details: String?
    let priority: String?
    let labels: [String]
    let order: Double
    let weight: Int?
    let assignees: [String]
    let attachments: [TaskAttachmentSummary]
    let comments: [TaskCommentSummary]
    let activity: [TaskActivitySummary]
    let source: TaskSourceSummary?

    init(
        id: String,
        title: String,
        column: String,
        due: Date?,
        completed: Bool,
        details: String? = nil,
        priority: String? = nil,
        labels: [String] = [],
        order: Double = 0,
        weight: Int? = nil,
        assignees: [String] = [],
        attachments: [TaskAttachmentSummary] = [],
        comments: [TaskCommentSummary] = [],
        activity: [TaskActivitySummary] = [],
        source: TaskSourceSummary? = nil
    ) {
        self.id = id
        self.title = title
        self.column = column
        self.due = due
        self.completed = completed
        self.details = details
        self.priority = priority
        self.labels = labels
        self.order = order
        self.weight = weight
        self.assignees = assignees
        self.attachments = attachments
        self.comments = comments
        self.activity = activity
        self.source = source
    }

    init?(json: JSONValue, column: String = "Tasks") {
        guard let id = json["cardId"]?.stringValue
            ?? json["_id"]?.stringValue
            ?? json["id"]?.stringValue else { return nil }
        self.id = id
        title = json["title"]?.stringValue?.nilIfBlank ?? "Untitled task"
        self.column = column
        if var timestamp = json["dueAt"]?.doubleValue {
            if timestamp > 10_000_000_000 { timestamp /= 1_000 }
            due = Date(timeIntervalSince1970: timestamp)
        } else { due = nil }
        completed = json["completed"]?.boolValue
            ?? (json["completedAt"]?.doubleValue != nil || column.lowercased() == "done")
        details = json["description"]?.stringValue?.nilIfBlank
        priority = json["priority"]?.stringValue?.nilIfBlank
        labels = (json["labels"]?.arrayValue ?? []).compactMap(\.stringValue)
        order = json["order"]?.doubleValue ?? 0
        weight = json["weight"]?.doubleValue.map(Int.init)
        assignees = (json["assignees"]?.arrayValue ?? []).compactMap(\.stringValue)
        attachments = (json["attachments"]?.arrayValue ?? []).map(TaskAttachmentSummary.init)
        comments = (json["comments"]?.arrayValue ?? []).compactMap(TaskCommentSummary.init)
        activity = (json["activity"]?.arrayValue ?? []).compactMap(TaskActivitySummary.init)
        source = TaskSourceSummary(json: json["source"])
    }

    // Copy with selective changes — optimistic updates must not drop the
    // fields they don't touch.
    func with(
        column: String? = nil,
        due: Date?? = nil,
        completed: Bool? = nil,
        order: Double? = nil
    ) -> TaskSummary {
        TaskSummary(
            id: id,
            title: title,
            column: column ?? self.column,
            due: due ?? self.due,
            completed: completed ?? self.completed,
            details: details,
            priority: priority,
            labels: labels,
            order: order ?? self.order,
            weight: weight,
            assignees: assignees,
            attachments: attachments,
            comments: comments,
            activity: activity,
            source: source
        )
    }
}

struct AreaOverviewCounts: Hashable, Codable, Sendable {
    let verifiedFacts: Int
    let candidateFacts: Int
    let needsYou: Int
    let plans: Int
    let events: Int
    let tasks: Int
    let unreadMail: Int
    let overdueTasks: Int

    init(workCounts: JSONValue?, factCounts: JSONValue?) {
        verifiedFacts = Int(
            workCounts?["facts"]?["verified"]?.doubleValue ?? factCounts?["verified"]?.doubleValue ?? 0
        )
        candidateFacts = Int(
            workCounts?["facts"]?["candidate"]?.doubleValue ?? factCounts?["candidate"]?.doubleValue ?? 0
        )
        needsYou = Int(workCounts?["needsYou"]?.doubleValue ?? 0)
        plans = Int(workCounts?["plans"]?.doubleValue ?? 0)
        events = Int(workCounts?["events"]?.doubleValue ?? 0)
        tasks = Int(workCounts?["tasks"]?.doubleValue ?? 0)
        unreadMail = Int(workCounts?["unreadMail"]?.doubleValue ?? 0)
        overdueTasks = Int(workCounts?["overdueTasks"]?.doubleValue ?? 0)
    }

    // A compact operational status line for the Work list, most-urgent first.
    var statusLine: String {
        var parts: [String] = []
        if needsYou > 0 { parts.append("\(needsYou) need\(needsYou == 1 ? "s" : "") you") }
        if overdueTasks > 0 { parts.append("\(overdueTasks) overdue") }
        if unreadMail > 0 { parts.append("\(unreadMail) unread") }
        if plans > 0 { parts.append("\(plans) plan\(plans == 1 ? "" : "s")") }
        if events > 0 { parts.append("\(events) event\(events == 1 ? "" : "s")") }
        if tasks > 0 { parts.append("\(tasks) task\(tasks == 1 ? "" : "s")") }
        if parts.isEmpty {
            let waiting = candidateFacts
            return waiting > 0 ? "\(verifiedFacts) verified · \(waiting) suggested" : "Quiet right now"
        }
        return parts.prefix(3).joined(separator: " · ")
    }

    var needsAttention: Bool { needsYou > 0 || overdueTasks > 0 }
}

struct AreaSummary: Identifiable, Hashable, Codable, Sendable {
    let id: String
    let name: String
    let kind: String
    let detail: String?
    // New optional fields keep old ProductSnapshot caches decodable (synthesized
    // Codable uses decodeIfPresent for Optionals).
    let imageURL: String?
    let overview: AreaOverviewCounts?

    init?(json: JSONValue) {
        guard let id = json["_id"]?.stringValue ?? json["id"]?.stringValue,
              let name = json["name"]?.stringValue else { return nil }
        self.id = id
        self.name = name
        kind = json["kind"]?.stringValue ?? "area"
        detail = json["description"]?.stringValue?.nilIfBlank
        imageURL = (json["imageUrl"] ?? json["faviconUrl"])?.stringValue?.nilIfBlank
        let workCounts = json["workCounts"]
        let factCounts = json["factCounts"]
        overview = (workCounts?.objectValue != nil || factCounts?.objectValue != nil)
            ? AreaOverviewCounts(workCounts: workCounts, factCounts: factCounts)
            : nil
    }
}

// Typed Daily Report. Owns the artifact html/status/progress plus a structured
// fallback (narrative, stats, section counts) so Today never reduces the report
// to one lossy string. Codable so the cached edition survives relaunch/offline;
// `init?(json:)` decodes the `get_latest_daily_report` tool result.
struct DailyReportModel: Hashable, Codable, Sendable {
    enum Status: String, Codable, Sendable { case partial, ready }

    struct Progress: Hashable, Codable, Sendable {
        let stage: String
        let done: Int
        let total: Int

        var fraction: Double { total > 0 ? min(1, max(0, Double(done) / Double(total))) : 0 }
    }

    struct Stats: Hashable, Codable, Sendable {
        let scannedThreads: Int
        let needsReply: Int
        let replyOwed: Int
        let dueSoon: Int
        let unread: Int
        let openTasks: Int
        let completedTasks: Int
        let calendarEvents: Int
    }

    struct SectionCounts: Hashable, Codable, Sendable {
        let replyOwed: Int
        let followUpOwed: Int
        let newPeople: Int
        let timeSensitive: Int
        let tracked: Int
        let fyi: Int
        let tasks: Int
        let calendar: Int

        var total: Int {
            replyOwed + followUpOwed + newPeople + timeSensitive + tracked + fyi + tasks + calendar
        }
    }

    let id: String
    let kind: String
    let generatedAt: Date
    let status: Status?
    let progress: Progress?
    let title: String
    let narrative: String
    let html: String?
    let artifactStatus: String?
    let artifactSource: String?
    let hasAreaBrief: Bool
    let stats: Stats
    let sectionCounts: SectionCounts
    let errors: [String]

    var hasArtifact: Bool { !(html ?? "").isEmpty }

    // The edition is still being written when the doc is a partial or the
    // artifact is composing/enriching — Today shows a bounded progress note.
    var isGenerating: Bool {
        status == .partial || artifactStatus == "composing" || artifactStatus == "enriching"
    }

    // Legacy single-string fallback kept for pre-typed caches and the summary
    // fallback surface.
    var legacyText: String? { narrative.nilIfBlank ?? title.nilIfBlank }

    init?(json: JSONValue?) {
        guard let json, json.objectValue != nil,
              let id = json["_id"]?.stringValue ?? json["id"]?.stringValue else { return nil }
        self.id = id
        kind = json["kind"]?.stringValue ?? "manual"
        generatedAt = CalendarDateParser.date(json["generatedAt"]) ?? .now
        status = json["status"]?.stringValue.flatMap(Status.init(rawValue:))
        if let progress = json["progress"], progress.objectValue != nil {
            self.progress = Progress(
                stage: progress["stage"]?.stringValue ?? "working",
                done: Int(progress["done"]?.doubleValue ?? 0),
                total: Int(progress["total"]?.doubleValue ?? 0)
            )
        } else {
            progress = nil
        }
        title = json["title"]?.stringValue?.nilIfBlank ?? "Daily Report"
        narrative = json["narrative"]?.stringValue ?? ""
        html = json["html"]?.stringValue?.nilIfBlank
        artifactStatus = json["artifactStatus"]?.stringValue?.nilIfBlank
        artifactSource = json["artifactSource"]?.stringValue?.nilIfBlank
        let sections = json["sections"]
        hasAreaBrief = sections?["albatross"]?.objectValue != nil
        let stats = json["stats"]
        self.stats = Stats(
            scannedThreads: Int(stats?["scannedThreads"]?.doubleValue ?? 0),
            needsReply: Int(stats?["needsReply"]?.doubleValue ?? 0),
            replyOwed: Int(stats?["replyOwed"]?.doubleValue ?? 0),
            dueSoon: Int(stats?["dueSoon"]?.doubleValue ?? 0),
            unread: Int(stats?["unread"]?.doubleValue ?? 0),
            openTasks: Int(stats?["openTasks"]?.doubleValue ?? 0),
            completedTasks: Int(stats?["completedTasks"]?.doubleValue ?? 0),
            calendarEvents: Int(stats?["calendarEvents"]?.doubleValue ?? 0)
        )
        sectionCounts = SectionCounts(
            replyOwed: sections?["replyOwed"]?.arrayValue?.count ?? 0,
            followUpOwed: sections?["followUpOwed"]?.arrayValue?.count ?? 0,
            newPeople: sections?["newPeople"]?.arrayValue?.count ?? 0,
            timeSensitive: sections?["timeSensitive"]?.arrayValue?.count ?? 0,
            tracked: sections?["tracked"]?.arrayValue?.count ?? 0,
            fyi: sections?["fyi"]?.arrayValue?.count ?? 0,
            tasks: sections?["tasks"]?.arrayValue?.count ?? 0,
            calendar: sections?["calendar"]?.arrayValue?.count ?? 0
        )
        errors = (json["errors"]?.arrayValue ?? []).compactMap { $0.stringValue?.nilIfBlank }
    }
}

// One area's home surface, decoded from the read-only `area_home` server tool
// (convex albatross.areaHome). Views read these typed rows; no JSONValue reaches
// SwiftUI. Server data is authoritative — nothing here is invented on a miss.
struct AreaDetail: Hashable, Codable, Sendable {
    struct Identity: Hashable, Codable, Sendable {
        let id: String
        let name: String
        let kind: String
        let description: String?
        let primaryDomain: String?
        let imageURL: String?
    }

    struct LivingBrief: Hashable, Codable, Sendable {
        let status: String
        let lede: String
        let summary: String
        let generatedAt: Date?
        // Older editions stored their complete HTML artifact; current ones are
        // structured prose. When present, the artifact renders verbatim.
        let artifactHtml: String?

        var isReady: Bool { status == "ready" }
    }

    struct Fact: Identifiable, Hashable, Codable, Sendable {
        let id: String
        let kind: String
        let value: String
        let status: String
    }

    struct MailRow: Identifiable, Hashable, Codable, Sendable {
        let linkID: String?
        let accountID: String
        let threadID: String
        let subject: String
        let sender: String
        let snippet: String
        let date: Date
        let unread: Bool
        let linkStatus: String
        var id: String { "\(accountID):\(threadID)" }
    }

    struct EventRow: Identifiable, Hashable, Codable, Sendable {
        let accountID: String
        let eventID: String
        let title: String
        let start: Date
        let end: Date
        let allDay: Bool
        let location: String?
        let linkStatus: String
        var id: String { "\(accountID):\(eventID)" }

        var summary: CalendarEventSummary {
            CalendarEventSummary(
                id: eventID,
                accountID: accountID,
                calendarID: nil,
                title: title,
                start: start,
                end: end,
                allDay: allDay,
                location: location
            )
        }
    }

    struct TaskRow: Identifiable, Hashable, Codable, Sendable {
        let id: String
        let title: String
        let due: Date?
        let completed: Bool
        let linkStatus: String
    }

    struct PlanRow: Identifiable, Hashable, Codable, Sendable {
        let intentID: String
        let title: String
        let status: String
        let outcome: String?
        let summary: String?
        var id: String { intentID }
    }

    struct WorkRow: Identifiable, Hashable, Codable, Sendable {
        let id: String
        let title: String
        let rawText: String
        let status: String
        let workState: String
        let agentState: String
        let updatedAt: Date?

        var stateLabel: String {
            switch agentState {
            case "needs_input": "Needs you"
            case "researching": "Researching"
            case "applying": "Creating"
            case "error": "Needs attention"
            default: workState == "done" ? "Done" : workState.replacingOccurrences(of: "_", with: " ").capitalized
            }
        }
    }

    struct ProjectRow: Identifiable, Hashable, Codable, Sendable {
        let projectID: String
        let title: String
        let outcome: String?
        let status: String
        let taskCount: Int
        let completedTaskCount: Int
        var id: String { projectID }
    }

    struct PlaceRow: Identifiable, Hashable, Codable, Sendable {
        let name: String
        let detail: String?
        let address: String?
        let mapsURL: String?
        var id: String { "\(name):\(address ?? "")" }
    }

    struct Counts: Hashable, Codable, Sendable {
        let verifiedFacts: Int
        let candidateFacts: Int
        let mail: Int
        let events: Int
        let tasks: Int
        let plans: Int
        let projects: Int
        let places: Int
    }

    let identity: Identity
    let livingBrief: LivingBrief?
    let verifiedFacts: [Fact]
    let candidateFacts: [Fact]
    let mail: [MailRow]
    let events: [EventRow]
    let tasks: [TaskRow]
    let plans: [PlanRow]
    // Optional preserves decoding of Area snapshots written before durable Work
    // was included in the Area read model.
    let work: [WorkRow]?
    let projects: [ProjectRow]
    let places: [PlaceRow]
    let counts: Counts

    var hasAnyLinkedContent: Bool {
        !mail.isEmpty || !events.isEmpty || !tasks.isEmpty || !(work ?? []).isEmpty || !plans.isEmpty || !projects.isEmpty
            || !places.isEmpty || !verifiedFacts.isEmpty || !candidateFacts.isEmpty
    }

    init(json: JSONValue) {
        let area = json["area"]
        identity = Identity(
            id: area?["_id"]?.stringValue ?? area?["id"]?.stringValue ?? "",
            name: area?["name"]?.stringValue?.nilIfBlank ?? "Area",
            kind: area?["kind"]?.stringValue?.nilIfBlank ?? "area",
            description: area?["description"]?.stringValue?.nilIfBlank,
            primaryDomain: area?["primaryDomain"]?.stringValue?.nilIfBlank,
            imageURL: (area?["imageUrl"] ?? area?["faviconUrl"])?.stringValue?.nilIfBlank
        )

        if let brief = json["livingBrief"], brief.objectValue != nil {
            livingBrief = LivingBrief(
                status: brief["status"]?.stringValue ?? "ready",
                lede: brief["lede"]?.stringValue ?? "",
                summary: brief["summary"]?.stringValue ?? "",
                generatedAt: CalendarDateParser.date(brief["generatedAt"]),
                artifactHtml: brief["artifactHtml"]?.stringValue?.nilIfBlank
            )
        } else {
            livingBrief = nil
        }

        let facts = json["facts"]
        verifiedFacts = (facts?["verified"]?.arrayValue ?? []).compactMap(Self.fact)
        candidateFacts = (facts?["candidate"]?.arrayValue ?? []).compactMap(Self.fact)

        let decodedMail = (json["mail"]?.arrayValue ?? []).compactMap { row -> MailRow? in
            guard let threadID = row["providerThreadId"]?.stringValue ?? row["threadId"]?.stringValue else {
                return nil
            }
            return MailRow(
                linkID: row["linkId"]?.stringValue,
                accountID: row["accountId"]?.stringValue ?? "",
                threadID: threadID,
                subject: EmailTextNormalizer.header(row["subject"]?.stringValue).nilIfBlank ?? "(No subject)",
                sender: MailThreadSummary.addressString(row["fromAddress"] ?? row["from"]) ?? "Unknown sender",
                snippet: EmailTextNormalizer.preview(row["snippet"]?.stringValue ?? ""),
                date: CalendarDateParser.date(row["lastDate"]) ?? .distantPast,
                unread: row["unread"]?.boolValue ?? false,
                linkStatus: row["linkStatus"]?.stringValue ?? "verified"
            )
        }
        mail = Self.uniqueMailRows(decodedMail)

        events = (json["events"]?.arrayValue ?? []).compactMap { row in
            guard let eventID = row["providerEventId"]?.stringValue ?? row["eventId"]?.stringValue,
                  let start = CalendarDateParser.date(row["startAt"] ?? row["startIso"] ?? row["start"]),
                  let end = CalendarDateParser.date(row["endAt"] ?? row["endIso"] ?? row["end"]),
                  end >= start else { return nil }
            return EventRow(
                accountID: row["accountId"]?.stringValue ?? "",
                eventID: eventID,
                title: row["title"]?.stringValue?.nilIfBlank ?? "Untitled event",
                start: start,
                end: end,
                allDay: row["allDay"]?.boolValue ?? false,
                location: row["location"]?.stringValue?.nilIfBlank,
                linkStatus: row["linkStatus"]?.stringValue ?? "verified"
            )
        }

        tasks = (json["tasks"]?.arrayValue ?? []).compactMap { row in
            guard let id = row["cardId"]?.stringValue ?? row["_id"]?.stringValue else { return nil }
            return TaskRow(
                id: id,
                title: row["title"]?.stringValue?.nilIfBlank ?? "Untitled task",
                due: CalendarDateParser.date(row["dueAt"]),
                completed: row["completedAt"]?.doubleValue != nil,
                linkStatus: row["linkStatus"]?.stringValue ?? "verified"
            )
        }

        plans = (json["plans"]?.arrayValue ?? []).compactMap { row in
            guard let intentID = row["intentId"]?.stringValue ?? row["_id"]?.stringValue else { return nil }
            return PlanRow(
                intentID: intentID,
                title: row["title"]?.stringValue?.nilIfBlank ?? "Plan",
                status: row["status"]?.stringValue ?? "active",
                outcome: row["outcome"]?.stringValue?.nilIfBlank,
                summary: row["summary"]?.stringValue?.nilIfBlank
            )
        }

        work = (json["work"]?.arrayValue ?? []).compactMap { row in
            guard let id = row["_id"]?.stringValue ?? row["id"]?.stringValue else { return nil }
            let rawText = row["rawText"]?.stringValue?.nilIfBlank ?? ""
            return WorkRow(
                id: id,
                title: row["title"]?.stringValue?.nilIfBlank ?? rawText.nilIfBlank ?? "Work",
                rawText: rawText,
                status: row["status"]?.stringValue ?? "captured",
                workState: row["workState"]?.stringValue ?? "active",
                agentState: row["agentState"]?.stringValue ?? "idle",
                updatedAt: CalendarDateParser.date(row["updatedAt"])
            )
        }

        projects = (json["projects"]?.arrayValue ?? []).compactMap { row in
            guard let projectID = row["projectId"]?.stringValue ?? row["_id"]?.stringValue else { return nil }
            return ProjectRow(
                projectID: projectID,
                title: row["title"]?.stringValue?.nilIfBlank ?? "Project",
                outcome: row["outcome"]?.stringValue?.nilIfBlank,
                status: row["status"]?.stringValue ?? "active",
                taskCount: Int(row["taskCount"]?.doubleValue ?? 0),
                completedTaskCount: Int(row["completedTaskCount"]?.doubleValue ?? 0)
            )
        }

        places = (json["places"]?.arrayValue ?? []).compactMap { row in
            guard let name = row["name"]?.stringValue?.nilIfBlank else { return nil }
            return PlaceRow(
                name: name,
                detail: row["detail"]?.stringValue?.nilIfBlank,
                address: row["address"]?.stringValue?.nilIfBlank,
                mapsURL: row["mapsUrl"]?.stringValue?.nilIfBlank
            )
        }

        let counts = json["counts"]
        self.counts = Counts(
            verifiedFacts: Int(counts?["facts"]?["verified"]?.doubleValue ?? Double(verifiedFacts.count)),
            candidateFacts: Int(counts?["facts"]?["candidate"]?.doubleValue ?? Double(candidateFacts.count)),
            mail: Int(counts?["mail"]?.doubleValue ?? Double(mail.count)),
            events: Int(counts?["events"]?.doubleValue ?? Double(events.count)),
            tasks: Int(counts?["tasks"]?.doubleValue ?? Double(tasks.count)),
            plans: Int(counts?["plans"]?.doubleValue ?? Double(plans.count)),
            projects: Int(counts?["projects"]?.doubleValue ?? Double(projects.count)),
            places: Int(counts?["places"]?.doubleValue ?? Double(places.count))
        )
    }

    private static func fact(_ row: JSONValue) -> Fact? {
        guard let id = row["_id"]?.stringValue ?? row["id"]?.stringValue,
              let value = row["value"]?.stringValue?.nilIfBlank else { return nil }
        return Fact(
            id: id,
            kind: row["kind"]?.stringValue?.nilIfBlank ?? "note",
            value: value,
            status: row["status"]?.stringValue ?? "candidate"
        )
    }

    private static func uniqueMailRows(_ rows: [MailRow]) -> [MailRow] {
        var indexByID: [String: Int] = [:]
        var unique: [MailRow] = []
        for row in rows {
            if let index = indexByID[row.id] {
                if unique[index].linkStatus != "verified", row.linkStatus == "verified" {
                    unique[index] = row
                }
            } else {
                indexByID[row.id] = unique.count
                unique.append(row)
            }
        }
        return unique
    }
}

// One durable Work item and the plan brief generated for it. This is decoded at
// the repository boundary from `work_home`; views never inspect JSONValue.
struct WorkDetail: Hashable, Codable, Sendable {
    struct Work: Identifiable, Hashable, Codable, Sendable {
        let id: String
        let title: String
        let rawText: String
        let status: String
        let workState: String
        let agentState: String
        let planError: String?
        let updatedAt: Date?

        var stateLabel: String {
            switch agentState {
            case "needs_input": "Needs you"
            case "researching": "Researching"
            case "applying": "Creating"
            case "error": "Needs attention"
            default: workState == "done" ? "Done" : workState.replacingOccurrences(of: "_", with: " ").capitalized
            }
        }
    }

    struct Source: Identifiable, Hashable, Codable, Sendable {
        let kind: String
        let referenceID: String
        let label: String?
        let url: String?
        var id: String { "\(kind):\(referenceID)" }
    }

    struct Action: Identifiable, Hashable, Codable, Sendable {
        let id: String
        let kind: String
        let title: String
        let detail: String?
    }

    struct Plan: Identifiable, Hashable, Codable, Sendable {
        let id: String
        let status: String
        let outcome: String?
        let summary: String?
        let artifactHTML: String?
        let artifactTitle: String?
        let assumptions: [String]
        let sources: [Source]
        let actions: [Action]
        let appliedStepKeys: Set<String>
    }

    struct Project: Identifiable, Hashable, Codable, Sendable {
        let id: String
        let title: String
        let outcome: String?
        let status: String
    }

    struct Question: Identifiable, Hashable, Codable, Sendable {
        struct Option: Identifiable, Hashable, Codable, Sendable {
            let id: String
            let label: String
            let detail: String?
        }

        let id: String
        let status: String
        let prompt: String
        let reason: String?
        let options: [Option]
    }

    struct Application: Identifiable, Hashable, Codable, Sendable {
        let id: String
        let status: String
        let operationIDs: [String]
    }

    let work: Work
    let plan: Plan?
    let project: Project?
    let questions: [Question]
    let application: Application?

    init?(json: JSONValue) {
        guard let workID = json["work"]?["_id"]?.stringValue ?? json["work"]?["id"]?.stringValue else {
            return nil
        }
        let workJSON = json["work"]
        let rawText = workJSON?["rawText"]?.stringValue?.nilIfBlank ?? ""
        work = Work(
            id: workID,
            title: workJSON?["title"]?.stringValue?.nilIfBlank ?? rawText.nilIfBlank ?? "Work",
            rawText: rawText,
            status: workJSON?["status"]?.stringValue ?? "captured",
            workState: workJSON?["workState"]?.stringValue ?? "active",
            agentState: workJSON?["agentState"]?.stringValue ?? "idle",
            planError: workJSON?["planError"]?.stringValue?.nilIfBlank,
            updatedAt: CalendarDateParser.date(workJSON?["updatedAt"])
        )

        if let planJSON = json["plan"], planJSON.objectValue != nil,
           let planID = planJSON["_id"]?.stringValue ?? planJSON["id"]?.stringValue {
            let digital = (planJSON["digitalActions"]?.arrayValue ?? []).compactMap { row -> Action? in
                guard let title = row["title"]?.stringValue?.nilIfBlank else { return nil }
                let key = row["actionKey"]?.stringValue ?? row["key"]?.stringValue ?? title
                return Action(id: key, kind: row["kind"]?.stringValue ?? "action", title: title, detail: nil)
            }
            let physical = (planJSON["physicalActions"]?.arrayValue ?? []).compactMap { row -> Action? in
                guard let title = row["title"]?.stringValue?.nilIfBlank else { return nil }
                return Action(
                    id: "physical:\(title)",
                    kind: "physical",
                    title: title,
                    detail: row["detail"]?.stringValue?.nilIfBlank
                )
            }
            plan = Plan(
                id: planID,
                status: planJSON["status"]?.stringValue ?? "draft",
                outcome: planJSON["outcome"]?.stringValue?.nilIfBlank,
                summary: planJSON["summary"]?.stringValue?.nilIfBlank,
                artifactHTML: planJSON["artifactHtml"]?.stringValue?.nilIfBlank,
                artifactTitle: planJSON["artifactTitle"]?.stringValue?.nilIfBlank,
                assumptions: (planJSON["assumptions"]?.arrayValue ?? []).compactMap { $0.stringValue?.nilIfBlank },
                sources: (planJSON["sourceRefs"]?.arrayValue ?? []).compactMap { row in
                    guard let referenceID = row["id"]?.stringValue else { return nil }
                    return Source(
                        kind: row["kind"]?.stringValue ?? "source",
                        referenceID: referenceID,
                        label: row["label"]?.stringValue?.nilIfBlank,
                        url: row["url"]?.stringValue?.nilIfBlank
                    )
                },
                actions: digital + physical,
                appliedStepKeys: Set((planJSON["appliedSteps"]?.arrayValue ?? []).compactMap { $0["stepKey"]?.stringValue })
            )
        } else {
            plan = nil
        }

        if let projectJSON = json["project"], projectJSON.objectValue != nil,
           let projectID = projectJSON["_id"]?.stringValue ?? projectJSON["id"]?.stringValue {
            project = Project(
                id: projectID,
                title: projectJSON["title"]?.stringValue?.nilIfBlank ?? "Project",
                outcome: projectJSON["outcome"]?.stringValue?.nilIfBlank,
                status: projectJSON["status"]?.stringValue ?? "active"
            )
        } else {
            project = nil
        }

        questions = (json["questions"]?.arrayValue ?? []).compactMap { row in
            guard let id = row["_id"]?.stringValue ?? row["id"]?.stringValue,
                  let prompt = row["prompt"]?.stringValue?.nilIfBlank else { return nil }
            return Question(
                id: id,
                status: row["status"]?.stringValue ?? "pending",
                prompt: prompt,
                reason: row["reason"]?.stringValue?.nilIfBlank,
                options: (row["options"]?.arrayValue ?? []).compactMap { option in
                    guard let optionID = option["id"]?.stringValue,
                          let label = option["label"]?.stringValue?.nilIfBlank
                            ?? option["title"]?.stringValue?.nilIfBlank else { return nil }
                    return Question.Option(
                        id: optionID,
                        label: label,
                        detail: option["description"]?.stringValue?.nilIfBlank
                            ?? option["detail"]?.stringValue?.nilIfBlank
                    )
                }
            )
        }

        if let applicationJSON = json["application"], applicationJSON.objectValue != nil,
           let applicationID = applicationJSON["_id"]?.stringValue ?? applicationJSON["id"]?.stringValue {
            application = Application(
                id: applicationID,
                status: applicationJSON["status"]?.stringValue ?? "pending",
                operationIDs: (applicationJSON["operationIds"]?.arrayValue ?? []).compactMap(\.stringValue)
            )
        } else {
            application = nil
        }
    }
}

struct ApprovalSummary: Identifiable, Hashable, Codable, Sendable {
    let id: String
    let title: String
    let detail: String
    let status: String

    init?(json: JSONValue) {
        guard let id = json["_id"]?.stringValue ?? json["id"]?.stringValue else { return nil }
        self.id = id
        title = json["title"]?.stringValue
            ?? json["toolName"]?.stringValue
            ?? "Review action"
        detail = json["summary"]?.stringValue
            ?? json["description"]?.stringValue
            ?? "Albatross needs your approval before continuing."
        status = json["status"]?.stringValue ?? "pending"
    }
}

struct PendingWorkQuestionSummary: Identifiable, Hashable, Sendable {
    let question: WorkDetail.Question
    let workID: String?
    let workTitle: String
    var id: String { question.id }

    init?(json: JSONValue) {
        let row = json["question"]
        guard let id = row?["_id"]?.stringValue ?? row?["id"]?.stringValue,
              let prompt = row?["prompt"]?.stringValue?.nilIfBlank else { return nil }
        question = WorkDetail.Question(
            id: id,
            status: row?["status"]?.stringValue ?? "pending",
            prompt: prompt,
            reason: row?["reason"]?.stringValue?.nilIfBlank,
            options: (row?["options"]?.arrayValue ?? []).compactMap { option in
                guard let optionID = option["id"]?.stringValue,
                      let label = option["label"]?.stringValue?.nilIfBlank else { return nil }
                return WorkDetail.Question.Option(
                    id: optionID,
                    label: label,
                    detail: option["description"]?.stringValue?.nilIfBlank
                )
            }
        )
        workID = json["work"]?["_id"]?.stringValue
        workTitle = json["work"]?["title"]?.stringValue?.nilIfBlank
            ?? json["project"]?["title"]?.stringValue?.nilIfBlank
            ?? "Albatross"
    }
}

struct SuggestionSummary: Identifiable, Hashable, Codable, Sendable {
    let id: String
    let title: String
    let sender: String
    let kind: String
    let accountID: String?
    let threadID: String?
    let start: Date?

    init?(json: JSONValue) {
        guard let id = json["_id"]?.stringValue ?? json["id"]?.stringValue else { return nil }
        self.id = id
        title = json["title"]?.stringValue?.nilIfBlank ?? "Calendar suggestion"
        sender = json["payload"]?["from"]?.stringValue?.nilIfBlank ?? "From your mail"
        kind = json["kind"]?.stringValue ?? "event"
        accountID = json["provenance"]?["accountId"]?.stringValue
        threadID = json["provenance"]?["threadId"]?.stringValue
        if var timestamp = json["payload"]?["event"]?["startAt"]?.doubleValue {
            if timestamp > 10_000_000_000 { timestamp /= 1_000 }
            start = Date(timeIntervalSince1970: timestamp)
        } else {
            start = nil
        }
    }
}

struct CheckinCandidateSummary: Identifiable, Hashable, Codable, Sendable {
    let kind: String
    let sourceID: String
    let title: String
    let suggestedState: String?

    var id: String { "\(kind):\(sourceID)" }

    init?(json: JSONValue) {
        guard let kind = json["kind"]?.stringValue,
              let sourceID = json["id"]?.stringValue,
              let title = json["title"]?.stringValue else { return nil }
        self.kind = kind
        self.sourceID = sourceID
        self.title = title
        suggestedState = json["suggestedState"]?.stringValue
    }
}

struct CheckinSummary: Identifiable, Hashable, Codable, Sendable {
    let id: String
    let localDate: String
    let status: String
    let candidates: [CheckinCandidateSummary]

    init?(json: JSONValue) {
        guard let id = json["_id"]?.stringValue ?? json["id"]?.stringValue else { return nil }
        self.id = id
        localDate = json["localDate"]?.stringValue ?? "Today"
        status = json["status"]?.stringValue ?? "open"
        candidates = (json["candidateItems"]?.arrayValue ?? []).compactMap(CheckinCandidateSummary.init)
    }
}

private extension String {
    var nilIfBlank: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}
