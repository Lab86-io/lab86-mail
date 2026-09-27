import Foundation

// Signatures and saved replies (round 2, FEATURES item 11). One signature for
// each mailbox, added below outgoing mail when it is on; named saved replies
// the composer inserts. The tools are `list_signatures`, `set_signature`,
// `list_saved_replies`, `save_saved_reply`, and `delete_saved_reply`.

struct MailSignature: Identifiable, Equatable, Sendable {
    static let textLimit = 2_000
    static let htmlLimit = 10_000

    let accountID: String
    let email: String?
    let displayName: String?
    var enabled: Bool
    var text: String
    var html: String?
    let updatedAt: Date?

    var id: String { accountID }

    init(accountID: String, email: String? = nil, displayName: String? = nil, enabled: Bool, text: String, html: String? = nil, updatedAt: Date? = nil) {
        self.accountID = accountID
        self.email = email
        self.displayName = displayName
        self.enabled = enabled
        self.text = text
        self.html = html
        self.updatedAt = updatedAt
    }

    init?(json: JSONValue) {
        guard let accountID = json["accountId"]?.stringValue?.nilIfBlank else { return nil }
        self.accountID = accountID
        email = json["email"]?.stringValue?.nilIfBlank
        displayName = json["displayName"]?.stringValue?.nilIfBlank
        enabled = json["enabled"]?.boolValue ?? false
        text = json["text"]?.stringValue ?? ""
        html = json["html"]?.stringValue?.nilIfBlank
        updatedAt = CalendarDateParser.date(json["updatedAt"])
    }

    /// The mailbox name for a row.
    var mailboxLabel: String { email ?? displayName ?? accountID }

    /// The signature a message from this account carries: on, and not empty.
    static func active(in signatures: [MailSignature], account: String) -> MailSignature? {
        let lowered = account.lowercased()
        let match = signatures.first {
            $0.accountID == account || $0.email?.lowercased() == lowered
        }
        guard let match, match.enabled, match.text.nilIfBlank != nil else { return nil }
        return match
    }

    /// `set_signature` arguments. The server caps the text and the HTML.
    func arguments() -> [String: JSONValue] {
        var arguments: [String: JSONValue] = [
            "account": .string(accountID),
            "enabled": .bool(enabled),
            "text": .string(String(text.prefix(Self.textLimit))),
        ]
        if let html = html?.nilIfBlank { arguments["html"] = .string(String(html.prefix(Self.htmlLimit))) }
        return arguments
    }
}

struct SavedReply: Identifiable, Equatable, Sendable {
    static let nameLimit = 80
    static let bodyLimit = 5_000

    let id: String
    var name: String
    var body: String
    let updatedAt: Date?

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue?.nilIfBlank,
              let name = json["name"]?.stringValue?.nilIfBlank else { return nil }
        self.id = id
        self.name = name
        body = json["body"]?.stringValue ?? ""
        updatedAt = CalendarDateParser.date(json["updatedAt"])
    }

    /// The first line, for a menu row.
    var preview: String {
        body.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? ""
    }

    /// `save_saved_reply` arguments: a new reply has no id.
    static func saveArguments(id: String?, name: String, body: String) -> [String: JSONValue] {
        var arguments: [String: JSONValue] = [
            "name": .string(String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(nameLimit))),
            "body": .string(String(body.prefix(bodyLimit))),
        ]
        if let id = id?.nilIfBlank { arguments["id"] = .string(id) }
        return arguments
    }

    /// Puts a saved reply after what the user wrote, with one blank line.
    static func insert(_ text: String, into current: String) -> String {
        guard current.nilIfBlank != nil else { return text }
        var trimmed = current
        while let last = trimmed.last, last.isWhitespace { trimmed.removeLast() }
        return "\(trimmed)\n\n\(text)"
    }
}

struct MailTemplatesClient: Sendable {
    let tools: any ToolInvoking

    func signatures() async throws -> [MailSignature] {
        let result = try await tools.invoke("list_signatures")
        return (result["signatures"]?.arrayValue ?? []).compactMap(MailSignature.init(json:))
    }

    func save(_ signature: MailSignature) async throws -> MailSignature {
        let result = try await tools.invoke("set_signature", arguments: signature.arguments())
        return result["signature"].flatMap(MailSignature.init(json:)) ?? signature
    }

    func savedReplies() async throws -> [SavedReply] {
        let result = try await tools.invoke("list_saved_replies")
        return (result["replies"]?.arrayValue ?? []).compactMap(SavedReply.init(json:))
    }

    func saveReply(id: String?, name: String, body: String) async throws -> SavedReply {
        let result = try await tools.invoke(
            "save_saved_reply",
            arguments: SavedReply.saveArguments(id: id, name: name, body: body)
        )
        guard let reply = result["reply"].flatMap(SavedReply.init(json:)) else { throw BackendError.invalidResponse }
        return reply
    }

    func deleteReply(id: String) async throws {
        _ = try await tools.invoke("delete_saved_reply", arguments: ["id": .string(id)])
    }
}
