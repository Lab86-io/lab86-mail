import Foundation

// Native mirror of `lib/ai/tool-shapes.ts` (docs/chat-agentic-pass.md, section
// 3). The server follows every tool result with `{ type: 'data-tool-shape',
// id: <toolCallId>, data: ToolShape }`. This file decodes that payload with
// tolerance: an unknown shape kind or action kind decodes to `.unknown`, and
// every optional field stays nil when the server omits it. The raw JSON is
// kept next to the decoded value so the transcript can carry it unchanged.

/// The three sentences for the tool row that owns a shape.
struct ShapeActivity: Codable, Equatable, Sendable {
    let running: String
    let done: String
    let failed: String
}

enum ShapeAction: Equatable, Sendable, Identifiable {
    case openThread(account: String, threadID: String)
    case replyThread(account: String, threadID: String)
    case archiveThread(account: String, threadID: String)
    case snoozeThread(account: String, threadID: String, messageID: String?)
    case openEvent(account: String, calendarID: String?, eventID: String, startISO: String?)
    case rsvpEvent(account: String, calendarID: String?, eventID: String)
    case deleteEvent(account: String, calendarID: String?, eventID: String)
    case holdSlot(account: String?, startISO: String, endISO: String, title: String?)
    case openTask(boardID: String?, cardID: String)
    case completeTask(cardID: String)
    case openBoard(boardID: String)
    case openWork(workID: String)
    case openArea(areaID: String)
    case openDocument(documentID: String, path: String?)
    case openURL(url: String, label: String?)
    case importFile(connectionID: String, fileID: String, mimeType: String?)
    case undoOperation(operationID: String)
    case rememberSender(email: String)
    case unknown(kind: String)

    /// The wire discriminator.
    var kind: String {
        switch self {
        case .openThread: "open_thread"
        case .replyThread: "reply_thread"
        case .archiveThread: "archive_thread"
        case .snoozeThread: "snooze_thread"
        case .openEvent: "open_event"
        case .rsvpEvent: "rsvp_event"
        case .deleteEvent: "delete_event"
        case .holdSlot: "hold_slot"
        case .openTask: "open_task"
        case .completeTask: "complete_task"
        case .openBoard: "open_board"
        case .openWork: "open_work"
        case .openArea: "open_area"
        case .openDocument: "open_document"
        case .openURL: "open_url"
        case .importFile: "import_file"
        case .undoOperation: "undo_operation"
        case .rememberSender: "remember_sender"
        case .unknown(let kind): kind
        }
    }

    /// Stable identity for buttons and outcome bookkeeping.
    var id: String {
        switch self {
        case .openThread(let account, let threadID): "open_thread:\(account):\(threadID)"
        case .replyThread(let account, let threadID): "reply_thread:\(account):\(threadID)"
        case .archiveThread(let account, let threadID): "archive_thread:\(account):\(threadID)"
        case .snoozeThread(let account, let threadID, _): "snooze_thread:\(account):\(threadID)"
        case .openEvent(let account, _, let eventID, _): "open_event:\(account):\(eventID)"
        case .rsvpEvent(let account, _, let eventID): "rsvp_event:\(account):\(eventID)"
        case .deleteEvent(let account, _, let eventID): "delete_event:\(account):\(eventID)"
        case .holdSlot(_, let start, let end, _): "hold_slot:\(start):\(end)"
        case .openTask(_, let cardID): "open_task:\(cardID)"
        case .completeTask(let cardID): "complete_task:\(cardID)"
        case .openBoard(let boardID): "open_board:\(boardID)"
        case .openWork(let workID): "open_work:\(workID)"
        case .openArea(let areaID): "open_area:\(areaID)"
        case .openDocument(let documentID, _): "open_document:\(documentID)"
        case .openURL(let url, _): "open_url:\(url)"
        case .importFile(let connectionID, let fileID, _): "import_file:\(connectionID):\(fileID)"
        case .undoOperation(let operationID): "undo_operation:\(operationID)"
        case .rememberSender(let email): "remember_sender:\(email)"
        case .unknown(let kind): "unknown:\(kind)"
        }
    }

    /// The text-button label. Verb first, no icons.
    var label: String {
        switch self {
        case .openThread: "Open"
        case .replyThread: "Reply"
        case .archiveThread: "Archive"
        case .snoozeThread: "Snooze"
        case .openEvent: "Open"
        case .rsvpEvent: "RSVP"
        case .deleteEvent: "Delete"
        case .holdSlot: "Hold"
        case .openTask: "Open"
        case .completeTask: "Complete"
        case .openBoard: "Open board"
        case .openWork: "Open"
        case .openArea: "Open"
        case .openDocument: "Open"
        case .openURL(_, let label): label?.nilIfBlank ?? "Open link"
        case .importFile: "Import"
        case .undoOperation: "Undo"
        case .rememberSender: "Remember"
        case .unknown: "Unavailable"
        }
    }

    /// Navigation actions leave the chat for a destination; mutations change
    /// data and show their outcome in place.
    var isMutation: Bool {
        switch self {
        case .archiveThread, .snoozeThread, .rsvpEvent, .deleteEvent, .holdSlot, .completeTask,
             .importFile, .undoOperation, .rememberSender:
            true
        default:
            false
        }
    }
}

extension ShapeAction: Decodable {
    private enum Keys: String, CodingKey {
        case kind, account, threadId, messageId, calendarId, eventId, startIso, endIso, title
        case boardId, cardId, workId, areaId, documentId, path, url, label, connectionId, fileId
        case mimeType, operationId, email
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Keys.self)
        let kind = (try? values.decodeIfPresent(String.self, forKey: .kind)) ?? "unknown"
        func text(_ key: Keys) -> String? {
            (try? values.decodeIfPresent(String.self, forKey: key))?.nilIfBlank
        }
        switch kind {
        case "open_thread":
            guard let account = text(.account), let threadID = text(.threadId) else { self = .unknown(kind: kind); return }
            self = .openThread(account: account, threadID: threadID)
        case "reply_thread":
            guard let account = text(.account), let threadID = text(.threadId) else { self = .unknown(kind: kind); return }
            self = .replyThread(account: account, threadID: threadID)
        case "archive_thread":
            guard let account = text(.account), let threadID = text(.threadId) else { self = .unknown(kind: kind); return }
            self = .archiveThread(account: account, threadID: threadID)
        case "snooze_thread":
            guard let account = text(.account), let threadID = text(.threadId) else { self = .unknown(kind: kind); return }
            self = .snoozeThread(account: account, threadID: threadID, messageID: text(.messageId))
        case "open_event":
            guard let account = text(.account), let eventID = text(.eventId) else { self = .unknown(kind: kind); return }
            self = .openEvent(account: account, calendarID: text(.calendarId), eventID: eventID, startISO: text(.startIso))
        case "rsvp_event":
            guard let account = text(.account), let eventID = text(.eventId) else { self = .unknown(kind: kind); return }
            self = .rsvpEvent(account: account, calendarID: text(.calendarId), eventID: eventID)
        case "delete_event":
            guard let account = text(.account), let eventID = text(.eventId) else { self = .unknown(kind: kind); return }
            self = .deleteEvent(account: account, calendarID: text(.calendarId), eventID: eventID)
        case "hold_slot":
            guard let start = text(.startIso), let end = text(.endIso) else { self = .unknown(kind: kind); return }
            self = .holdSlot(account: text(.account), startISO: start, endISO: end, title: text(.title))
        case "open_task":
            guard let cardID = text(.cardId) else { self = .unknown(kind: kind); return }
            self = .openTask(boardID: text(.boardId), cardID: cardID)
        case "complete_task":
            guard let cardID = text(.cardId) else { self = .unknown(kind: kind); return }
            self = .completeTask(cardID: cardID)
        case "open_board":
            guard let boardID = text(.boardId) else { self = .unknown(kind: kind); return }
            self = .openBoard(boardID: boardID)
        case "open_work":
            guard let workID = text(.workId) else { self = .unknown(kind: kind); return }
            self = .openWork(workID: workID)
        case "open_area":
            guard let areaID = text(.areaId) else { self = .unknown(kind: kind); return }
            self = .openArea(areaID: areaID)
        case "open_document":
            guard let documentID = text(.documentId) else { self = .unknown(kind: kind); return }
            self = .openDocument(documentID: documentID, path: text(.path))
        case "open_url":
            guard let url = text(.url) else { self = .unknown(kind: kind); return }
            self = .openURL(url: url, label: text(.label))
        case "import_file":
            guard let connectionID = text(.connectionId), let fileID = text(.fileId) else { self = .unknown(kind: kind); return }
            self = .importFile(connectionID: connectionID, fileID: fileID, mimeType: text(.mimeType))
        case "undo_operation":
            guard let operationID = text(.operationId) else { self = .unknown(kind: kind); return }
            self = .undoOperation(operationID: operationID)
        case "remember_sender":
            guard let email = text(.email) else { self = .unknown(kind: kind); return }
            self = .rememberSender(email: email)
        default:
            self = .unknown(kind: kind)
        }
    }
}

// MARK: - Rows

struct ShapeThreadRow: Decodable, Equatable, Sendable, Identifiable {
    let account: String
    let threadId: String
    let messageId: String?
    let subject: String
    let from: String
    let fromEmail: String?
    let dateIso: String?
    let snippet: String?
    let unread: Bool?
    let messageCount: Int?
    let attachmentCount: Int?
    let actions: [ShapeAction]

    var id: String { "\(account):\(threadId)" }
    var date: Date? { dateIso.flatMap(CalendarDateParser.date(fromString:)) }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Keys.self)
        account = try values.decodeIfPresent(String.self, forKey: .account) ?? ""
        threadId = try values.decodeIfPresent(String.self, forKey: .threadId) ?? ""
        messageId = try values.decodeIfPresent(String.self, forKey: .messageId)
        subject = try values.decodeIfPresent(String.self, forKey: .subject) ?? "(No subject)"
        from = try values.decodeIfPresent(String.self, forKey: .from) ?? "Unknown sender"
        fromEmail = try values.decodeIfPresent(String.self, forKey: .fromEmail)
        dateIso = try values.decodeIfPresent(String.self, forKey: .dateIso)
        snippet = try values.decodeIfPresent(String.self, forKey: .snippet)
        unread = try values.decodeIfPresent(Bool.self, forKey: .unread)
        messageCount = ShapeDecoding.int(values, .messageCount)
        attachmentCount = ShapeDecoding.int(values, .attachmentCount)
        actions = ShapeDecoding.actions(values, .actions)
    }

    private enum Keys: String, CodingKey {
        case account, threadId, messageId, subject, from, fromEmail, dateIso, snippet, unread
        case messageCount, attachmentCount, actions
    }
}

struct ShapeEventRow: Decodable, Equatable, Sendable, Identifiable {
    let account: String
    let calendarId: String?
    let eventId: String
    let title: String
    let startIso: String?
    let endIso: String?
    let allDay: Bool?
    let location: String?
    let attendees: [String]?
    let calendarName: String?
    let status: String?
    let actions: [ShapeAction]

    var id: String { "\(account):\(eventId)" }
    var start: Date? { startIso.flatMap(CalendarDateParser.date(fromString:)) }
    var end: Date? { endIso.flatMap(CalendarDateParser.date(fromString:)) }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Keys.self)
        account = try values.decodeIfPresent(String.self, forKey: .account) ?? ""
        calendarId = try values.decodeIfPresent(String.self, forKey: .calendarId)
        eventId = try values.decodeIfPresent(String.self, forKey: .eventId) ?? ""
        title = try values.decodeIfPresent(String.self, forKey: .title) ?? "(No title)"
        startIso = try values.decodeIfPresent(String.self, forKey: .startIso)
        endIso = try values.decodeIfPresent(String.self, forKey: .endIso)
        allDay = try values.decodeIfPresent(Bool.self, forKey: .allDay)
        location = try values.decodeIfPresent(String.self, forKey: .location)
        attendees = try values.decodeIfPresent([String].self, forKey: .attendees)
        calendarName = try values.decodeIfPresent(String.self, forKey: .calendarName)
        status = try values.decodeIfPresent(String.self, forKey: .status)
        actions = ShapeDecoding.actions(values, .actions)
    }

    private enum Keys: String, CodingKey {
        case account, calendarId, eventId, title, startIso, endIso, allDay, location, attendees
        case calendarName, status, actions
    }
}

struct ShapeSlotRow: Decodable, Equatable, Sendable, Identifiable {
    let startIso: String
    let endIso: String
    let actions: [ShapeAction]

    var id: String { "\(startIso):\(endIso)" }
    var start: Date? { CalendarDateParser.date(fromString: startIso) }
    var end: Date? { CalendarDateParser.date(fromString: endIso) }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Keys.self)
        startIso = try values.decodeIfPresent(String.self, forKey: .startIso) ?? ""
        endIso = try values.decodeIfPresent(String.self, forKey: .endIso) ?? ""
        actions = ShapeDecoding.actions(values, .actions)
    }

    private enum Keys: String, CodingKey { case startIso, endIso, actions }
}

struct ShapeTaskRow: Decodable, Equatable, Sendable, Identifiable {
    let cardId: String
    let boardId: String?
    let title: String
    let description: String?
    let column: String?
    let dueIso: String?
    let priority: String?
    let labels: [String]?
    let completed: Bool?
    let actions: [ShapeAction]

    var id: String { cardId }
    var due: Date? { dueIso.flatMap(CalendarDateParser.date(fromString:)) }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Keys.self)
        cardId = try values.decodeIfPresent(String.self, forKey: .cardId) ?? ""
        boardId = try values.decodeIfPresent(String.self, forKey: .boardId)
        title = try values.decodeIfPresent(String.self, forKey: .title) ?? "(Untitled task)"
        description = try values.decodeIfPresent(String.self, forKey: .description)
        column = try values.decodeIfPresent(String.self, forKey: .column)
        dueIso = try values.decodeIfPresent(String.self, forKey: .dueIso)
        priority = try values.decodeIfPresent(String.self, forKey: .priority)
        labels = try values.decodeIfPresent([String].self, forKey: .labels)
        completed = try values.decodeIfPresent(Bool.self, forKey: .completed)
        actions = ShapeDecoding.actions(values, .actions)
    }

    private enum Keys: String, CodingKey {
        case cardId, boardId, title, description, column, dueIso, priority, labels, completed, actions
    }
}

struct ShapeWorkRow: Decodable, Equatable, Sendable, Identifiable {
    struct Progress: Decodable, Equatable, Sendable {
        let done: Int
        let total: Int
    }

    let workId: String
    let title: String
    let shape: String?
    let horizon: String?
    let status: String?
    let currentStep: String?
    let progress: Progress?
    let actions: [ShapeAction]

    var id: String { workId }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Keys.self)
        workId = try values.decodeIfPresent(String.self, forKey: .workId) ?? ""
        title = try values.decodeIfPresent(String.self, forKey: .title) ?? "(Untitled)"
        shape = try values.decodeIfPresent(String.self, forKey: .shape)
        horizon = try values.decodeIfPresent(String.self, forKey: .horizon)
        status = try values.decodeIfPresent(String.self, forKey: .status)
        currentStep = try values.decodeIfPresent(String.self, forKey: .currentStep)
        progress = try? values.decodeIfPresent(Progress.self, forKey: .progress)
        actions = ShapeDecoding.actions(values, .actions)
    }

    private enum Keys: String, CodingKey {
        case workId, title, shape, horizon, status, currentStep, progress, actions
    }
}

struct ShapeFileRow: Decodable, Equatable, Sendable, Identifiable {
    let connectionId: String
    let fileId: String
    let name: String
    let kind: String?
    let source: String?
    let mimeType: String?
    let webUrl: String?
    let modifiedIso: String?
    let actions: [ShapeAction]

    var id: String { "\(connectionId):\(fileId)" }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Keys.self)
        connectionId = try values.decodeIfPresent(String.self, forKey: .connectionId) ?? ""
        fileId = try values.decodeIfPresent(String.self, forKey: .fileId) ?? ""
        name = try values.decodeIfPresent(String.self, forKey: .name) ?? "(Untitled file)"
        kind = try values.decodeIfPresent(String.self, forKey: .kind)
        source = try values.decodeIfPresent(String.self, forKey: .source)
        mimeType = try values.decodeIfPresent(String.self, forKey: .mimeType)
        webUrl = try values.decodeIfPresent(String.self, forKey: .webUrl)
        modifiedIso = try values.decodeIfPresent(String.self, forKey: .modifiedIso)
        actions = ShapeDecoding.actions(values, .actions)
    }

    private enum Keys: String, CodingKey {
        case connectionId, fileId, name, kind, source, mimeType, webUrl, modifiedIso, actions
    }
}

struct ShapeSourceRow: Decodable, Equatable, Sendable, Identifiable {
    let title: String
    let url: String?
    let snippet: String?
    let source: String?
    let actions: [ShapeAction]

    var id: String { url ?? title }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Keys.self)
        title = try values.decodeIfPresent(String.self, forKey: .title) ?? "(Untitled)"
        url = try values.decodeIfPresent(String.self, forKey: .url)
        snippet = try values.decodeIfPresent(String.self, forKey: .snippet)
        source = try values.decodeIfPresent(String.self, forKey: .source)
        actions = ShapeDecoding.actions(values, .actions)
    }

    private enum Keys: String, CodingKey { case title, url, snippet, source, actions }
}

struct ShapeBoardColumn: Decodable, Equatable, Sendable, Identifiable {
    let name: String
    let count: Int

    var id: String { name }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Keys.self)
        name = try values.decodeIfPresent(String.self, forKey: .name) ?? ""
        count = ShapeDecoding.int(values, .count) ?? 0
    }

    private enum Keys: String, CodingKey { case name, count }
}

// MARK: - Shape

struct ToolShape: Equatable, Sendable {
    enum Content: Equatable, Sendable {
        case threads(items: [ShapeThreadRow], total: Int?)
        case thread(item: ShapeThreadRow, excerpt: String?)
        case events(items: [ShapeEventRow], total: Int?)
        case event(item: ShapeEventRow)
        case slots(items: [ShapeSlotRow])
        case tasks(items: [ShapeTaskRow], boardID: String?, boardTitle: String?)
        case task(item: ShapeTaskRow)
        case board(boardID: String, columns: [ShapeBoardColumn])
        case work(item: ShapeWorkRow)
        case works(items: [ShapeWorkRow])
        case area(areaID: String, name: String, areaKind: String?, domain: String?, description: String?)
        case document(documentID: String, docKind: String?, status: String?, revision: Int?, path: String?, webURL: String?)
        case files(items: [ShapeFileRow])
        case contact(name: String?, email: String, totalMessages: Int?, lastSeenISO: String?, memory: String?)
        case count(value: Double, label: String)
        case receipt(surface: String, operationID: String?, target: JSONValue?)
        case sources(items: [ShapeSourceRow])
        case text(String)
        case unknown(kind: String)
    }

    /// The wire kind, kept verbatim so an unknown kind still names itself.
    let kind: String
    let title: String
    let summary: String?
    let activity: ShapeActivity?
    let actions: [ShapeAction]
    let account: String?
    let content: Content
    private let rawJSON: JSONValue

    var isUnknown: Bool {
        if case .unknown = content { return true }
        return false
    }

    /// Decodes the `data` object of a `data-tool-shape` part. Returns nil only
    /// when the payload is not an object; every other problem degrades to a
    /// text or unknown shape so the row never loses its card silently.
    static func decode(_ json: JSONValue) -> ToolShape? {
        guard case .object = json else { return nil }
        guard let data = try? JSONEncoder().encode(json) else { return nil }
        return try? JSONDecoder().decode(ToolShape.self, from: data)
    }
}

extension ToolShape: Codable {
    func encode(to encoder: Encoder) throws {
        try rawJSON.encode(to: encoder)
    }
    private enum Keys: String, CodingKey {
        case kind, title, summary, activity, actions, account
        case items, item, total, excerpt, boardId, boardTitle, columns
        case areaId, name, areaKind, domain, description
        case documentId, docKind, status, revision, path, webUrl
        case email, totalMessages, lastSeenIso, memory
        case value, label, surface, operationId, target, text
    }

    init(from decoder: Decoder) throws {
        rawJSON = try JSONValue(from: decoder)
        let values = try decoder.container(keyedBy: Keys.self)
        let kind = try values.decodeIfPresent(String.self, forKey: .kind) ?? "unknown"
        self.kind = kind
        title = try values.decodeIfPresent(String.self, forKey: .title) ?? ""
        summary = try values.decodeIfPresent(String.self, forKey: .summary)?.nilIfBlank
        activity = try? values.decodeIfPresent(ShapeActivity.self, forKey: .activity)
        actions = ShapeDecoding.actions(values, .actions)
        account = try values.decodeIfPresent(String.self, forKey: .account)?.nilIfBlank

        func text(_ key: Keys) -> String? {
            (try? values.decodeIfPresent(String.self, forKey: key))?.nilIfBlank
        }
        func rows<T: Decodable>(_ type: T.Type) -> [T] {
            (try? values.decodeIfPresent(ShapeDecoding.Lenient<T>.self, forKey: .items))?.rows ?? []
        }

        switch kind {
        case "threads":
            content = .threads(items: rows(ShapeThreadRow.self), total: ShapeDecoding.int(values, .total))
        case "thread":
            guard let item = try? values.decodeIfPresent(ShapeThreadRow.self, forKey: .item) else {
                content = .unknown(kind: kind)
                return
            }
            content = .thread(item: item, excerpt: text(.excerpt))
        case "events":
            content = .events(items: rows(ShapeEventRow.self), total: ShapeDecoding.int(values, .total))
        case "event":
            guard let item = try? values.decodeIfPresent(ShapeEventRow.self, forKey: .item) else {
                content = .unknown(kind: kind)
                return
            }
            content = .event(item: item)
        case "slots":
            content = .slots(items: rows(ShapeSlotRow.self))
        case "tasks":
            content = .tasks(items: rows(ShapeTaskRow.self), boardID: text(.boardId), boardTitle: text(.boardTitle))
        case "task":
            guard let item = try? values.decodeIfPresent(ShapeTaskRow.self, forKey: .item) else {
                content = .unknown(kind: kind)
                return
            }
            content = .task(item: item)
        case "board":
            let columns = (try? values.decodeIfPresent(ShapeDecoding.Lenient<ShapeBoardColumn>.self, forKey: .columns))?.rows ?? []
            content = .board(boardID: text(.boardId) ?? "", columns: columns)
        case "work":
            guard let item = try? values.decodeIfPresent(ShapeWorkRow.self, forKey: .item) else {
                content = .unknown(kind: kind)
                return
            }
            content = .work(item: item)
        case "works":
            content = .works(items: rows(ShapeWorkRow.self))
        case "area":
            content = .area(
                areaID: text(.areaId) ?? "",
                name: text(.name) ?? title,
                areaKind: text(.areaKind),
                domain: text(.domain),
                description: text(.description)
            )
        case "document":
            content = .document(
                documentID: text(.documentId) ?? "",
                docKind: text(.docKind),
                status: text(.status),
                revision: ShapeDecoding.int(values, .revision),
                path: text(.path),
                webURL: text(.webUrl)
            )
        case "files":
            content = .files(items: rows(ShapeFileRow.self))
        case "contact":
            content = .contact(
                name: text(.name),
                email: text(.email) ?? "",
                totalMessages: ShapeDecoding.int(values, .totalMessages),
                lastSeenISO: text(.lastSeenIso),
                memory: text(.memory)
            )
        case "count":
            content = .count(
                value: (try? values.decodeIfPresent(Double.self, forKey: .value)) ?? 0,
                label: text(.label) ?? title
            )
        case "receipt":
            content = .receipt(
                surface: text(.surface) ?? "other",
                operationID: text(.operationId),
                target: try? values.decodeIfPresent(JSONValue.self, forKey: .target)
            )
        case "sources":
            content = .sources(items: rows(ShapeSourceRow.self))
        case "text":
            content = .text(text(.text) ?? summary ?? title)
        default:
            content = .unknown(kind: kind)
        }
    }
}

/// Shared tolerant decoders. Numbers may arrive as `3` or `3.0`; a bad row in
/// a list drops that row instead of the whole list.
enum ShapeDecoding {
    struct Lenient<T: Decodable>: Decodable {
        let rows: [T]

        init(from decoder: Decoder) throws {
            var container = try decoder.unkeyedContainer()
            var rows: [T] = []
            while !container.isAtEnd {
                if let row = try? container.decode(T.self) {
                    rows.append(row)
                } else {
                    _ = try? container.decode(JSONValue.self)
                }
            }
            self.rows = rows
        }
    }

    static func int<K: CodingKey>(_ values: KeyedDecodingContainer<K>, _ key: K) -> Int? {
        if let value = try? values.decodeIfPresent(Int.self, forKey: key) { return value }
        if let value = try? values.decodeIfPresent(Double.self, forKey: key), value.isFinite, value >= Double(Int.min), value < Double(Int.max) {
            return Int(value)
        }
        return nil
    }

    static func actions<K: CodingKey>(_ values: KeyedDecodingContainer<K>, _ key: K) -> [ShapeAction] {
        (try? values.decodeIfPresent(Lenient<ShapeAction>.self, forKey: key))?.rows ?? []
    }
}
