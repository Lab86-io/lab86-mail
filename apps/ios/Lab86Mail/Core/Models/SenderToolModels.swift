import Foundation

// Unsubscribe, block sender, and sender cleanup (round 2, FEATURES item 13).
// An unsubscribe asks first and cannot be undone. A block records an
// operation, so it has Undo in the toast and in Activity. The tools are
// `get_unsubscribe_options`, `unsubscribe_sender`, `block_sender`, and
// `list_sender_cleanup`.

enum UnsubscribeMethod: String, Sendable {
    case oneClick = "one_click"
    case mailto
    case link
}

struct UnsubscribeOptions: Equatable, Sendable {
    let sender: String
    let senderEmail: String?
    let method: UnsubscribeMethod?
    let destination: String?
    let url: URL?

    init(sender: String, senderEmail: String? = nil, method: UnsubscribeMethod?, destination: String?, url: URL? = nil) {
        self.sender = sender
        self.senderEmail = senderEmail
        self.method = method
        self.destination = destination
        self.url = url
    }

    init?(json: JSONValue) {
        guard json.objectValue != nil else { return nil }
        sender = json["sender"]?.stringValue?.nilIfBlank ?? json["senderEmail"]?.stringValue ?? ""
        senderEmail = json["senderEmail"]?.stringValue?.nilIfBlank
        method = json["method"]?.stringValue.flatMap(UnsubscribeMethod.init(rawValue:))
        destination = json["destination"]?.stringValue?.nilIfBlank
        // Only a web page opens in the browser.
        url = json["url"]?.stringValue.flatMap(URL.init(string:)).flatMap { url in
            ["https", "http"].contains(url.scheme?.lowercased() ?? "") ? url : nil
        }
    }
}

/// The confirmation copy, the same sentences as the web dialog.
struct UnsubscribeConfirmCopy: Equatable, Sendable {
    enum Action: Equatable, Sendable {
        case unsubscribe
        case openLink
        case block
    }

    let title: String
    let message: String
    let confirmLabel: String
    let action: Action

    static func make(_ options: UnsubscribeOptions, mailbox: String?) -> UnsubscribeConfirmCopy {
        let sender = options.sender.nilIfBlank ?? "this sender"
        switch options.method {
        case .oneClick:
            return UnsubscribeConfirmCopy(
                title: "Unsubscribe from \(sender)?",
                message: "Albatross sends a one-click unsubscribe request to \(options.destination ?? "the sender"). An unsubscribe cannot be undone.",
                confirmLabel: "Unsubscribe",
                action: .unsubscribe
            )
        case .mailto:
            let from = mailbox?.nilIfBlank.map { " from \($0)" } ?? ""
            return UnsubscribeConfirmCopy(
                title: "Unsubscribe from \(sender)?",
                message: "Albatross sends an email\(from) to \(options.destination ?? "the sender") that asks to take you off the list. An unsubscribe cannot be undone.",
                confirmLabel: "Send the request",
                action: .unsubscribe
            )
        case .link:
            return UnsubscribeConfirmCopy(
                title: "Unsubscribe from \(sender)",
                message: "\(sender) only offers an unsubscribe page on \(options.destination ?? "its website"). Open it to finish there.",
                confirmLabel: "Open the page",
                action: .openLink
            )
        case nil:
            return UnsubscribeConfirmCopy(
                title: "\(options.sender.nilIfBlank ?? "This sender") has no unsubscribe option",
                message: "Block the sender instead. Their mail goes to Noise from now on, and their threads leave the inbox. You can undo a block from Activity.",
                confirmLabel: "Block sender",
                action: .block
            )
        }
    }
}

struct UnsubscribeResult: Equatable, Sendable {
    enum Status: String, Sendable {
        case unsubscribed
        case requested
        case openLink = "open_link"
    }

    let status: Status
    let sender: String
    let url: URL?

    init?(json: JSONValue) {
        guard let status = json["status"]?.stringValue.flatMap(Status.init(rawValue:)) else { return nil }
        self.status = status
        sender = json["sender"]?.stringValue?.nilIfBlank ?? "the sender"
        url = json["url"]?.stringValue.flatMap(URL.init(string:))
    }

    var message: String {
        switch status {
        case .unsubscribed: "Unsubscribed from \(sender)"
        case .requested: "Unsubscribe request sent to \(sender)"
        case .openLink: "Opened the unsubscribe page for \(sender)"
        }
    }
}

struct BlockSenderResult: Equatable, Sendable {
    let sender: String
    let archived: Int
    let failed: Int
    let operationID: String?

    init(sender: String, archived: Int, failed: Int, operationID: String?) {
        self.sender = sender
        self.archived = archived
        self.failed = failed
        self.operationID = operationID
    }

    init?(json: JSONValue) {
        guard let sender = json["sender"]?.stringValue?.nilIfBlank else { return nil }
        self.sender = sender
        archived = Int(json["archived"]?.doubleValue ?? 0)
        failed = Int(json["failed"]?.doubleValue ?? 0)
        operationID = json["operationId"]?.stringValue?.nilIfBlank
    }

    /// "Blocked news@example.com" or "Blocked 3 senders", with the threads
    /// that left the inbox.
    static func summary(_ results: [BlockSenderResult]) -> String {
        let count = results.count
        let who = count == 1 ? results[0].sender : "\(count) senders"
        let archived = results.reduce(0) { $0 + $1.archived }
        let threads = archived == 0 ? "" : ". \(archived) \(archived == 1 ? "thread" : "threads") left the inbox"
        return "Blocked \(who)\(threads)"
    }
}

struct SenderCleanupRow: Identifiable, Equatable, Sendable {
    let sender: String
    let name: String
    let threads: Int
    let unread: Int
    let lastDate: Date?
    let latestAccountID: String?
    let latestThreadID: String?
    let reason: String

    var id: String { sender }

    init?(json: JSONValue) {
        guard let sender = json["sender"]?.stringValue?.nilIfBlank else { return nil }
        self.sender = sender
        name = json["name"]?.stringValue?.nilIfBlank ?? sender
        threads = Int(json["threads"]?.doubleValue ?? 0)
        unread = Int(json["unread"]?.doubleValue ?? 0)
        lastDate = CalendarDateParser.date(json["lastDate"])
        latestAccountID = json["latest"]?["accountId"]?.stringValue?.nilIfBlank
        latestThreadID = json["latest"]?["threadId"]?.stringValue?.nilIfBlank
        reason = json["reason"]?.stringValue ?? ""
    }

    /// The thread whose headers carry the unsubscribe options.
    var unsubscribeTarget: SenderTarget? {
        guard let latestAccountID, let latestThreadID else { return nil }
        return SenderTarget(accountID: latestAccountID, threadID: latestThreadID, sender: name)
    }
}

/// A conversation whose sender the user acts on.
struct SenderTarget: Identifiable, Equatable, Sendable {
    let accountID: String
    let threadID: String
    var sender: String? = nil
    var mailbox: String? = nil

    var id: String { "\(accountID):\(threadID)" }
}

struct SenderToolsClient: Sendable {
    let tools: any ToolInvoking

    func unsubscribeOptions(_ target: SenderTarget) async throws -> UnsubscribeOptions {
        let result = try await tools.invoke(
            "get_unsubscribe_options",
            arguments: ["account": .string(target.accountID), "threadId": .string(target.threadID)]
        )
        guard let options = UnsubscribeOptions(json: result) else { throw BackendError.invalidResponse }
        return options
    }

    /// Runs only after the user confirmed: `confirmed` is always true.
    func unsubscribe(_ target: SenderTarget, method: UnsubscribeMethod?) async throws -> UnsubscribeResult {
        var arguments: [String: JSONValue] = [
            "account": .string(target.accountID),
            "threadId": .string(target.threadID),
            "confirmed": .bool(true),
        ]
        if let method { arguments["method"] = .string(method.rawValue) }
        let result = try await tools.invoke("unsubscribe_sender", arguments: arguments)
        guard let outcome = UnsubscribeResult(json: result) else { throw BackendError.invalidResponse }
        return outcome
    }

    func block(_ target: SenderTarget) async throws -> BlockSenderResult {
        try await block(arguments: [
            "account": .string(target.accountID),
            "threadId": .string(target.threadID),
        ])
    }

    func block(sender: String, batchID: String?) async throws -> BlockSenderResult {
        var arguments: [String: JSONValue] = ["sender": .string(sender)]
        if let batchID { arguments["operationBatchId"] = .string(batchID) }
        return try await block(arguments: arguments)
    }

    private func block(arguments: [String: JSONValue]) async throws -> BlockSenderResult {
        let result = try await tools.invoke("block_sender", arguments: arguments)
        guard let outcome = BlockSenderResult(json: result) else { throw BackendError.invalidResponse }
        return outcome
    }

    func cleanup(limit: Int = 40) async throws -> (senders: [SenderCleanupRow], scanned: Int) {
        let result = try await tools.invoke("list_sender_cleanup", arguments: ["limit": .number(Double(min(max(limit, 1), 100)))])
        let senders = (result["senders"]?.arrayValue ?? []).compactMap(SenderCleanupRow.init(json:))
        return (senders, Int(result["scanned"]?.doubleValue ?? 0))
    }

    /// One batch id for a batch block, so Activity reads it as one change.
    static func newBatchID() -> String { "batch_\(UUID().uuidString.lowercased())" }
}
