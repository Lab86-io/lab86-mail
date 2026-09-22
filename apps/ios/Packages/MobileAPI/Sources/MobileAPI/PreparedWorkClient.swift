import Foundation

// "Prepared for you": research and draft files the server prepares in the
// background and keeps in the Brief until the user adopts them. The web reads
// and writes them through `GET/POST /api/content?view=brief`; this is the
// same transport, decoded defensively — every field is optional and unknown
// keys are ignored, so a newer server never blanks the section.

public struct PreparedFile: Codable, Hashable, Sendable {
    public let name: String
    public let content: String

    public init(name: String, content: String) {
        self.name = name
        self.content = content
    }

    /// The file's extension as the row prints it, upper case.
    public var kind: String {
        let ext = (name as NSString).pathExtension
        return ext.isEmpty ? "File" : ext.uppercased()
    }

    /// The UTF-8 size of the content, in bytes.
    public var byteCount: Int { content.utf8.count }
}

public struct PreparedEvidence: Hashable, Sendable {
    public let sourceID: String
    public let quote: String

    public init(sourceID: String, quote: String) {
        self.sourceID = sourceID
        self.quote = quote
    }
}

public struct PreparedSource: Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String
    public let url: URL?
    public let source: String
    public let version: String?
    public let modifiedAt: Date?
    public let partial: Bool

    public init(
        id: String,
        title: String,
        url: URL? = nil,
        source: String = "",
        version: String? = nil,
        modifiedAt: Date? = nil,
        partial: Bool = false
    ) {
        self.id = id
        self.title = title
        self.url = url
        self.source = source
        self.version = version
        self.modifiedAt = modifiedAt
        self.partial = partial
    }
}

public struct PreparedDraft: Hashable, Sendable {
    public let title: String
    public let shape: String
    public let situation: String
    public let background: String
    public let assessment: String
    public let recommendation: String
    public let questions: [String]
    public let steps: [String]
    public let files: [PreparedFile]
    public let evidence: [PreparedEvidence]

    public init(
        title: String,
        shape: String = "quick",
        situation: String = "",
        background: String = "",
        assessment: String = "",
        recommendation: String = "",
        questions: [String] = [],
        steps: [String] = [],
        files: [PreparedFile] = [],
        evidence: [PreparedEvidence] = []
    ) {
        self.title = title
        self.shape = shape
        self.situation = situation
        self.background = background
        self.assessment = assessment
        self.recommendation = recommendation
        self.questions = questions
        self.steps = steps
        self.files = files
        self.evidence = evidence
    }
}

public struct PreparedItem: Identifiable, Hashable, Sendable {
    public let id: String
    public let revision: Int
    public let draft: PreparedDraft?
    public let workID: String?
    public let userNotes: String
    public let userFiles: [PreparedFile]?
    public let needsRefresh: Bool
    public let preparedAt: Date?
    public let updatedAt: Date?
    public let error: String?
    public let sources: [PreparedSource]

    public init(
        id: String,
        revision: Int = 0,
        draft: PreparedDraft? = nil,
        workID: String? = nil,
        userNotes: String = "",
        userFiles: [PreparedFile]? = nil,
        needsRefresh: Bool = false,
        preparedAt: Date? = nil,
        updatedAt: Date? = nil,
        error: String? = nil,
        sources: [PreparedSource] = []
    ) {
        self.id = id
        self.revision = revision
        self.draft = draft
        self.workID = workID
        self.userNotes = userNotes
        self.userFiles = userFiles
        self.needsRefresh = needsRefresh
        self.preparedAt = preparedAt
        self.updatedAt = updatedAt
        self.error = error
        self.sources = sources
    }

    /// The files the card shows: the user's saved edits win over the draft.
    public var files: [PreparedFile] { userFiles ?? draft?.files ?? [] }

    public func source(for evidence: PreparedEvidence) -> PreparedSource? {
        sources.first { $0.id == evidence.sourceID }
    }
}

// MARK: - Decoding

// Hand-written decoders: a field of the wrong type or a malformed array
// element degrades to its default instead of failing the whole payload.

private struct Lenient: Decodable {
    let value: PreparedJSON

    init(from decoder: Decoder) throws {
        value = try PreparedJSON(from: decoder)
    }
}

/// A tiny JSON value, private to this decoder, so each field can be read
/// without depending on the app's JSONValue.
enum PreparedJSON: Decodable, Sendable {
    case object([String: PreparedJSON])
    case array([PreparedJSON])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        if let container = try? decoder.container(keyedBy: PreparedCodingKey.self) {
            var object: [String: PreparedJSON] = [:]
            for key in container.allKeys {
                object[key.stringValue] = try container.decode(PreparedJSON.self, forKey: key)
            }
            self = .object(object)
            return
        }
        if var container = try? decoder.unkeyedContainer() {
            var values: [PreparedJSON] = []
            while !container.isAtEnd { values.append(try container.decode(PreparedJSON.self)) }
            self = .array(values)
            return
        }
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else { self = .string(try container.decode(String.self)) }
    }

    subscript(key: String) -> PreparedJSON? {
        guard case .object(let object) = self else { return nil }
        return object[key]
    }

    var string: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }

    var number: Double? {
        guard case .number(let value) = self else { return nil }
        return value
    }

    var bool: Bool? {
        guard case .bool(let value) = self else { return nil }
        return value
    }

    var array: [PreparedJSON] {
        guard case .array(let values) = self else { return [] }
        return values
    }

    var strings: [String] { array.compactMap(\.string).filter { !$0.isEmpty } }

    /// Milliseconds since 1970, the way Convex stores timestamps.
    var date: Date? { number.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

private struct PreparedCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil
    init(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

extension PreparedFile {
    init?(json: PreparedJSON) {
        guard let name = json["name"]?.string, !name.isEmpty,
              let content = json["content"]?.string else { return nil }
        self.init(name: name, content: content)
    }
}

extension PreparedEvidence {
    init?(json: PreparedJSON) {
        guard let sourceID = json["sourceId"]?.string, !sourceID.isEmpty,
              let quote = json["quote"]?.string, !quote.isEmpty else { return nil }
        self.init(sourceID: sourceID, quote: quote)
    }
}

extension PreparedSource {
    init?(json: PreparedJSON) {
        guard let id = json["_id"]?.string, !id.isEmpty else { return nil }
        self.init(
            id: id,
            title: json["title"]?.string ?? "Source",
            url: json["url"]?.string.flatMap { URL(string: $0) },
            source: json["source"]?.string ?? "",
            version: json["version"]?.string,
            modifiedAt: json["modifiedAt"]?.date,
            partial: json["partial"]?.bool ?? false
        )
    }
}

extension PreparedDraft {
    init?(json: PreparedJSON?) {
        guard let json, case .object = json, let title = json["title"]?.string, !title.isEmpty else { return nil }
        self.init(
            title: title,
            shape: json["shape"]?.string ?? "quick",
            situation: json["situation"]?.string ?? "",
            background: json["background"]?.string ?? "",
            assessment: json["assessment"]?.string ?? "",
            recommendation: json["recommendation"]?.string ?? "",
            questions: json["questions"]?.strings ?? [],
            steps: json["steps"]?.strings ?? [],
            files: json["files"]?.array.compactMap(PreparedFile.init(json:)) ?? [],
            evidence: json["evidence"]?.array.compactMap(PreparedEvidence.init(json:)) ?? []
        )
    }
}

extension PreparedItem {
    init?(json: PreparedJSON) {
        guard let id = json["_id"]?.string, !id.isEmpty else { return nil }
        let userFiles: [PreparedFile]?
        if case .array = json["userFiles"] ?? .null {
            userFiles = json["userFiles"]?.array.compactMap(PreparedFile.init(json:))
        } else {
            userFiles = nil
        }
        self.init(
            id: id,
            revision: json["revision"]?.number.flatMap { $0.isFinite ? Int(exactly: $0.rounded()) : nil } ?? 0,
            draft: PreparedDraft(json: json["draft"]),
            workID: json["workId"]?.string,
            userNotes: json["userNotes"]?.string ?? "",
            userFiles: userFiles,
            needsRefresh: json["needsRefresh"]?.bool ?? false,
            preparedAt: json["preparedAt"]?.date,
            updatedAt: json["updatedAt"]?.date,
            error: json["error"]?.string,
            sources: json["sources"]?.array.compactMap(PreparedSource.init(json:)) ?? []
        )
    }

    /// Decodes the `GET /api/content?view=brief` body: `{ items: [...] }`.
    /// Rows without an id are dropped; everything else degrades to defaults.
    public static func decodeList(_ data: Data) throws -> [PreparedItem] {
        let root = try JSONDecoder().decode(Lenient.self, from: data).value
        return root["items"]?.array.compactMap(PreparedItem.init(json:)) ?? []
    }
}

// MARK: - Actions

/// One write to `POST /api/content?view=brief`. The same discriminated body
/// the web sends: operation, id, revision, and for edits the notes and files.
public struct PreparedWorkAction: Encodable, Hashable, Sendable {
    public enum Operation: String, Codable, Sendable {
        case edit, dismiss, refresh, adopt
    }

    public let operation: Operation
    public let id: String
    public let revision: Int
    public let notes: String?
    public let files: [PreparedFile]?

    public init(operation: Operation, id: String, revision: Int, notes: String? = nil, files: [PreparedFile]? = nil) {
        self.operation = operation
        self.id = id
        self.revision = revision
        self.notes = notes
        self.files = files
    }

    public static func adopt(_ item: PreparedItem) -> PreparedWorkAction {
        PreparedWorkAction(operation: .adopt, id: item.id, revision: item.revision)
    }

    public static func dismiss(_ item: PreparedItem) -> PreparedWorkAction {
        PreparedWorkAction(operation: .dismiss, id: item.id, revision: item.revision)
    }

    public static func refresh(_ item: PreparedItem) -> PreparedWorkAction {
        PreparedWorkAction(operation: .refresh, id: item.id, revision: item.revision)
    }

    /// Saves the user's answers and notes. Files are sent only when edited.
    public static func edit(_ item: PreparedItem, notes: String, files: [PreparedFile]? = nil) -> PreparedWorkAction {
        PreparedWorkAction(operation: .edit, id: item.id, revision: item.revision, notes: notes, files: files)
    }

    private enum CodingKeys: String, CodingKey { case operation, id, revision, notes, files }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(operation, forKey: .operation)
        try container.encode(id, forKey: .id)
        try container.encode(revision, forKey: .revision)
        try container.encodeIfPresent(notes, forKey: .notes)
        try container.encodeIfPresent(files, forKey: .files)
    }
}

public struct PreparedWorkActionResult: Hashable, Sendable {
    public let ok: Bool
    public let workID: String?
    public let dismissed: Bool
    public let saved: Bool
    public let queued: Bool

    public init(ok: Bool, workID: String? = nil, dismissed: Bool = false, saved: Bool = false, queued: Bool = false) {
        self.ok = ok
        self.workID = workID
        self.dismissed = dismissed
        self.saved = saved
        self.queued = queued
    }

    public static func decode(_ data: Data) -> PreparedWorkActionResult? {
        guard let root = try? JSONDecoder().decode(Lenient.self, from: data).value else { return nil }
        let result = root["result"]
        return PreparedWorkActionResult(
            ok: root["ok"]?.bool ?? true,
            workID: result?["workId"]?.string,
            dismissed: result?["dismissed"]?.bool ?? false,
            saved: result?["saved"]?.bool ?? false,
            queued: result?["queued"]?.bool ?? false
        )
    }
}

// MARK: - Client

public enum PreparedWorkError: LocalizedError, Sendable, Equatable {
    case invalidURL
    case unauthorized
    case invalidResponse
    case server(status: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .invalidURL: "The Albatross server is not configured."
        case .unauthorized: "Sign in again to see what was prepared for you."
        case .invalidResponse: "The server returned an unreadable response."
        case .server(_, let message): message
        }
    }
}

public struct PreparedWorkClient: Sendable {
    public static let path = "/api/content?view=brief"

    private let baseURL: URL
    private let session: URLSession
    private let tokenProvider: MobileAPITokenProvider

    public init(
        baseURL: URL,
        session: URLSession = .shared,
        tokenProvider: @escaping MobileAPITokenProvider
    ) {
        self.baseURL = baseURL
        self.session = session
        self.tokenProvider = tokenProvider
    }

    /// The pending preparations, newest first, as the server orders them.
    public func list() async throws -> [PreparedItem] {
        let data = try await send(method: "GET", body: nil)
        do {
            return try PreparedItem.decodeList(data)
        } catch {
            throw PreparedWorkError.invalidResponse
        }
    }

    public func act(_ action: PreparedWorkAction) async throws -> PreparedWorkActionResult {
        let data = try await send(method: "POST", body: try JSONEncoder().encode(action))
        guard let result = PreparedWorkActionResult.decode(data) else { throw PreparedWorkError.invalidResponse }
        return result
    }

    private func send(method: String, body: Data?) async throws -> Data {
        guard let url = URL(string: Self.path, relativeTo: baseURL)?.absoluteURL else {
            throw PreparedWorkError.invalidURL
        }
        let token = try await tokenProvider()
        guard !token.isEmpty else { throw PreparedWorkError.unauthorized }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        request.setValue(TimeZone.current.identifier, forHTTPHeaderField: "x-user-timezone")
        request.setValue(UUID().uuidString, forHTTPHeaderField: "x-request-id")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = body
        }
        let (data, urlResponse) = try await session.data(for: request)
        guard let http = urlResponse as? HTTPURLResponse else { throw PreparedWorkError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw PreparedWorkError.unauthorized }
            let message = (try? JSONDecoder().decode(Lenient.self, from: data))?.value["error"]?.string
            throw PreparedWorkError.server(
                status: http.statusCode,
                message: message ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            )
        }
        return data
    }
}
