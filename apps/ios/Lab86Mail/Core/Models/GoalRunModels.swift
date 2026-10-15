import Foundation

// Goal runs on the wire (docs/albatross-goal-runs.md and
// lib/albatross/goal-run-contract.ts): the messages a run writes while it
// works, each with its sources; the checklist the run keeps; the package of
// items it hands over; and a draft's attachments. Decoded at the repository
// boundary with the same tolerance as StepRunModels.swift: a missing key
// reads as nil or empty, and an enum word this build does not know reads as
// `.unknown`, so a newer server never breaks decoding or the offline cache.

/// The step key of every goal run. No plan step has this key.
enum GoalRun {
    static let stepKey = "goal"
}

/// Where a fact in a run message came from.
struct RunSource: Identifiable, Hashable, Codable, Sendable {
    enum Kind: String, Hashable, Codable, Sendable {
        case web, mail, file, calendar, jira, document
        case unknown

        init(from decoder: any Decoder) throws {
            self = Self.from(try decoder.singleValueContainer().decode(String.self))
        }

        static func from(_ raw: String?) -> Kind {
            raw.flatMap { Kind(rawValue: $0) } ?? .unknown
        }

        /// The word before the title on a source chip.
        var word: String {
            switch self {
            case .web: "Web"
            case .mail: "Mail"
            case .file: "File"
            case .calendar: "Calendar"
            case .jira: "Jira"
            case .document: "Document"
            case .unknown: "Source"
            }
        }
    }

    let kind: Kind
    let title: String
    let url: String?
    /// The wire `id`: a thread id, an event id, a file id, an issue key.
    let referenceID: String?
    let accountID: String?

    var id: String { "\(kind.rawValue):\(url ?? referenceID ?? title)" }

    init(kind: Kind, title: String, url: String? = nil, referenceID: String? = nil, accountID: String? = nil) {
        self.kind = kind
        self.title = title
        self.url = url
        self.referenceID = referenceID
        self.accountID = accountID
    }

    /// A source needs a title and a place to open (a url or an id).
    init?(json: JSONValue) {
        guard let title = json["title"]?.stringValue?.nilIfBlank else { return nil }
        let url = json["url"]?.stringValue?.nilIfBlank
        let referenceID = json["id"]?.stringValue?.nilIfBlank
        guard url != nil || referenceID != nil else { return nil }
        kind = Kind.from(json["kind"]?.stringValue)
        self.title = title
        self.url = url
        self.referenceID = referenceID
        accountID = json["accountId"]?.stringValue?.nilIfBlank
    }
}

/// Text the run wrote to the user between tool calls.
struct RunMessage: Identifiable, Hashable, Codable, Sendable {
    /// The most sources one message carries (the web `RUN_MESSAGE_SOURCES_MAX`).
    static let sourceLimit = 8

    let id: String
    let at: Date?
    let text: String
    let sources: [RunSource]

    init(id: String, at: Date? = nil, text: String, sources: [RunSource] = []) {
        self.id = id
        self.at = at
        self.text = text
        self.sources = Array(sources.prefix(Self.sourceLimit))
    }

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue?.nilIfBlank,
              let text = json["text"]?.stringValue?.nilIfBlank else { return nil }
        self.id = id
        at = CalendarDateParser.date(json["at"])
        self.text = text
        sources = Array((json["sources"]?.arrayValue ?? []).compactMap(RunSource.init(json:)).prefix(Self.sourceLimit))
    }
}

/// One line of the checklist the run keeps.
struct ChecklistItem: Identifiable, Hashable, Codable, Sendable {
    enum State: String, Hashable, Codable, Sendable {
        case todo, doing, done, yours
        case unknown

        init(from decoder: any Decoder) throws {
            self = Self.from(try decoder.singleValueContainer().decode(String.self))
        }

        static func from(_ raw: String?) -> State {
            raw.flatMap { State(rawValue: $0) } ?? .unknown
        }

        /// The word in the leading column of a row. `doing` draws the live
        /// dot instead; `todo` and an unknown word draw nothing.
        var word: String? {
            switch self {
            case .done: "Done"
            case .yours: "You"
            case .todo, .doing, .unknown: nil
            }
        }
    }

    let id: String
    let text: String
    let state: State

    init(id: String, text: String, state: State) {
        self.id = id
        self.text = text
        self.state = state
    }

    init?(json: JSONValue) {
        guard let text = json["text"]?.stringValue?.nilIfBlank else { return nil }
        id = json["id"]?.stringValue?.nilIfBlank ?? text
        self.text = text
        state = State.from(json["state"]?.stringValue)
    }
}

/// One thing in the package a run hands over (docs/albatross-goal-runs.md, G3).
struct HandoffItem: Identifiable, Hashable, Codable, Sendable {
    enum Kind: String, Hashable, Codable, Sendable {
        case draft, document, sheet, deck, file, approval, event, page
        case unknown

        init(from decoder: any Decoder) throws {
            self = Self.from(try decoder.singleValueContainer().decode(String.self))
        }

        static func from(_ raw: String?) -> Kind {
            raw.flatMap { Kind(rawValue: $0) } ?? .unknown
        }

        var word: String {
            switch self {
            case .draft: "Draft"
            case .document: "Document"
            case .sheet: "Sheet"
            case .deck: "Deck"
            case .file: "File"
            case .approval: "Approval"
            case .event: "Event"
            case .page: "Page"
            case .unknown: "Item"
            }
        }

        /// The one verb on a package row.
        var verb: String {
            switch self {
            case .draft: "Read and send"
            case .approval: "Approve"
            case .page: "Open the page"
            case .document, .sheet, .deck, .file, .event, .unknown: "Open"
            }
        }

        /// The kinds document mode shows as items (one tab each).
        var opensInDocumentMode: Bool {
            switch self {
            case .draft, .document, .sheet, .deck, .file: true
            case .approval, .event, .page, .unknown: false
            }
        }
    }

    enum State: String, Hashable, Codable, Sendable {
        case ready, blanks, check
        case unknown

        init(from decoder: any Decoder) throws {
            self = Self.from(try decoder.singleValueContainer().decode(String.self))
        }

        static func from(_ raw: String?) -> State {
            raw.flatMap { State(rawValue: $0) } ?? .unknown
        }

        /// The state word of a row. `blanks` draws the blank sentence instead.
        var word: String? {
            switch self {
            case .ready: "Ready"
            case .check, .unknown: "Check it"
            case .blanks: nil
            }
        }
    }

    let kind: Kind
    /// The wire `id`: the draft, document, file, approval, or event id.
    let referenceID: String?
    let url: String?
    let accountID: String?
    let title: String
    let state: State
    /// The empty fields of this item, as `next.blanks` (docs/albatross-blank-design.md).
    let blanks: [String]
    /// One sentence about this item, for example which fields fill at send time.
    let note: String?

    var id: String { "\(kind.rawValue):\(referenceID ?? url ?? title)" }

    init(
        kind: Kind,
        referenceID: String? = nil,
        url: String? = nil,
        accountID: String? = nil,
        title: String,
        state: State = .ready,
        blanks: [String] = [],
        note: String? = nil
    ) {
        self.kind = kind
        self.referenceID = referenceID
        self.url = url
        self.accountID = accountID
        self.title = title
        self.state = state
        self.blanks = StepRunView.Next.cleanBlanks(blanks)
        self.note = note?.nilIfBlank
    }

    init?(json: JSONValue) {
        guard let title = json["title"]?.stringValue?.nilIfBlank else { return nil }
        kind = Kind.from(json["kind"]?.stringValue)
        referenceID = json["id"]?.stringValue?.nilIfBlank
        url = json["url"]?.stringValue?.nilIfBlank
        accountID = json["accountId"]?.stringValue?.nilIfBlank
        self.title = title
        let blanks = StepRunView.Next.cleanBlanks((json["blanks"]?.arrayValue ?? []).compactMap(\.stringValue))
        self.blanks = blanks
        let state = State.from(json["state"]?.stringValue)
        // The web `cleanHandoffItems`: a ready item with blanks has blanks.
        self.state = (state == .ready && !blanks.isEmpty) ? .blanks : state
        note = json["note"]?.stringValue?.nilIfBlank
    }

    /// The `?file=<id>` of a saved file's open path, else the id. The client
    /// never builds the path; the server sends it on every item.
    var savedFileID: String? {
        if let url, let id = SavedFileLink.fileID(in: url) { return id }
        return referenceID
    }
}

/// The saved-file link the server puts on a file item (`/?view=files&file=<id>`).
enum SavedFileLink {
    private static let relativeBase = URL(string: "https://app.invalid")!

    /// The file id inside a link in the app. A link on another site names nothing.
    static func fileID(in raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let resolved = URL(string: trimmed, relativeTo: relativeBase)?.absoluteURL,
              let components = URLComponents(url: resolved, resolvingAgainstBaseURL: false),
              components.scheme == relativeBase.scheme, components.host == relativeBase.host, components.port == nil
        else { return nil }
        return components.queryItems?.first { $0.name == "file" }?.value?.nilIfBlank
    }

    /// The bytes of a saved file: `GET /api/files/saved/<fileId>` (the files
    /// builder's route, with the ownership check).
    static func bytesPath(fileID: String) -> String {
        "/api/files/saved/\(fileID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? fileID)"
    }
}

/// A saved file that goes with a draft (lib/shared/types.ts `DraftAttachment`).
/// The server reads the bytes from storage at send time.
struct DraftAttachment: Identifiable, Hashable, Codable, Sendable {
    enum Provider: String, Hashable, Codable, Sendable {
        /// A Word, Excel, or PowerPoint file.
        case office
        /// A saved file, such as a PDF.
        case upload
        /// An Albatross document.
        case albatross
        case unknown

        init(from decoder: any Decoder) throws {
            self = Self.from(try decoder.singleValueContainer().decode(String.self))
        }

        static func from(_ raw: String?) -> Provider {
            raw.flatMap { Provider(rawValue: $0) } ?? .unknown
        }
    }

    enum Format: String, Hashable, Codable, Sendable {
        /// Converts through the document server at send time.
        case pdf
        case native
        case unknown

        init(from decoder: any Decoder) throws {
            self = Self.from(try decoder.singleValueContainer().decode(String.self))
        }

        static func from(_ raw: String?) -> Format {
            raw.flatMap { Format(rawValue: $0) } ?? .unknown
        }

        /// The format word on an attachment row.
        var word: String {
            switch self {
            case .pdf: "PDF"
            case .native, .unknown: "File"
            }
        }
    }

    /// The most attachments one draft carries.
    static let limit = 10

    let fileID: String
    let provider: Provider
    let format: Format
    let name: String
    let size: Int?
    let contentType: String?
    /// A field of this file fills in only at send or download time, from
    /// the secure store (docs/albatross-goal-runs.md, G5).
    let sealed: Bool
    /// The line that names the sealed field ("The tax ID fills in when you
    /// send."). Client side only: the package item's note gives it.
    var sealedLine: String?

    var id: String { fileID }

    init(
        fileID: String,
        provider: Provider,
        format: Format,
        name: String,
        size: Int? = nil,
        contentType: String? = nil,
        sealed: Bool = false,
        sealedLine: String? = nil
    ) {
        self.fileID = fileID
        self.provider = provider
        self.format = format
        self.name = name
        self.size = size
        self.contentType = contentType
        self.sealed = sealed || sealedLine?.nilIfBlank != nil
        self.sealedLine = sealedLine?.nilIfBlank
    }

    init?(json: JSONValue) {
        guard let fileID = json["fileId"]?.stringValue?.nilIfBlank,
              let name = json["name"]?.stringValue?.nilIfBlank else { return nil }
        self.fileID = fileID
        provider = Provider.from(json["provider"]?.stringValue)
        format = Format.from(json["format"]?.stringValue)
        self.name = name
        size = json["size"]?.doubleValue.map { Int($0) }
        contentType = json["contentType"]?.stringValue?.nilIfBlank
        sealed = json["sealed"]?.boolValue ?? false
        sealedLine = nil
    }

    /// The wire shape of a draft row (`attachments` on `save_draft`,
    /// `update_draft`, and `list_drafts`).
    var json: JSONValue {
        var object: [String: JSONValue] = [
            "source": .string("file"),
            "fileId": .string(fileID),
            "provider": .string(provider.rawValue),
            "format": .string(format.rawValue),
            "name": .string(name),
        ]
        if let size { object["size"] = .number(Double(size)) }
        if let contentType { object["contentType"] = .string(contentType) }
        if sealed { object["sealed"] = .bool(true) }
        return .object(object)
    }

    /// The wire shape of the `draftAttachments` field of `POST /api/compose`:
    /// `{ fileId, provider, format, name }`.
    var sendJSON: JSONValue {
        .object([
            "fileId": .string(fileID),
            "provider": .string(provider.rawValue),
            "format": .string(format.rawValue),
            "name": .string(name),
        ])
    }

    /// The line under the name on a composer row.
    var composerLine: String {
        if let sealedLine { return "\(format.word) · \(sealedLine)" }
        if sealed { return "\(format.word) · \(GoalRunCopy.sealedGenericComposerLine)" }
        var parts = [format.word]
        if let size, size > 0 {
            parts.append(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
        }
        parts.append(GoalRunCopy.fromAlbatross)
        return parts.joined(separator: " · ")
    }

    /// The rows of a draft, from `attachments` on a draft row.
    static func list(from json: JSONValue?) -> [DraftAttachment] {
        (json?.arrayValue ?? []).compactMap(DraftAttachment.init(json:))
    }
}
