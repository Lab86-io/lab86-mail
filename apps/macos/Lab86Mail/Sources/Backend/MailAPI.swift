import ClerkKit
import Foundation

// HTTPS client for the Next.js API at mail.lab86.io. Mutating thread actions
// go through the same tool layer the web UI uses (POST /api/tools/{name});
// sending goes through /api/compose. Auth is the Clerk session token as a
// Bearer header.
@MainActor
final class MailAPI {
    enum APIError: LocalizedError {
        case notSignedIn
        case http(Int, String)

        var errorDescription: String? {
            switch self {
            case .notSignedIn: "Not signed in."
            case let .http(code, message): "Request failed (\(code)): \(message)"
            }
        }
    }

    private func bearerToken() async throws -> String {
        guard let session = Clerk.shared.session, session.status == .active else {
            throw APIError.notSignedIn
        }
        guard let token = try await session.getToken(.init()) else {
            throw APIError.notSignedIn
        }
        return token
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            throw APIError.http(code, String(data: data, encoding: .utf8) ?? "")
        }
        return data
    }

    // MARK: - Tools

    struct ToolResponse: Decodable {
        var ok: Bool
        var error: String?
    }

    @discardableResult
    func invokeTool(_ name: String, args: [String: Any]) async throws -> ToolResponse {
        var request = URLRequest(url: Config.apiBase.appending(path: "/api/tools/\(name)"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(try await bearerToken())", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: args)
        let data = try await send(request)
        return try JSONDecoder().decode(ToolResponse.self, from: data)
    }

    func archiveThread(account: String, threadId: String) async throws {
        try await invokeTool("archive_thread", args: ["account": account, "threadId": threadId])
    }

    func trashThread(account: String, threadId: String) async throws {
        try await invokeTool("trash_thread", args: ["account": account, "threadId": threadId])
    }

    func markThreadRead(account: String, threadId: String) async throws {
        try await invokeTool("mark_thread_read", args: ["account": account, "threadId": threadId])
    }

    func setStar(account: String, messageId: String, starred: Bool) async throws {
        try await invokeTool(starred ? "star" : "unstar", args: ["account": account, "messageId": messageId])
    }

    // MARK: - Compose

    struct ComposeResult: Decodable {
        var ok: Bool
        var id: String?
        var scheduled: Bool?
        var state: String?
        var error: String?
    }

    struct OutgoingAttachment {
        var filename: String
        var contentType: String
        var data: Data
    }

    func compose(
        mode: String,  // "new" | "reply" | "reply_all" | "forward"
        account: String,
        to: String,
        cc: String? = nil,
        bcc: String? = nil,
        subject: String,
        body: String,
        threadId: String? = nil,
        messageId: String? = nil,
        undoSeconds: Int = 5,
        sendAt: Date? = nil,
        attachments: [OutgoingAttachment] = []
    ) async throws -> ComposeResult {
        var fields: [String: String] = [
            "mode": mode,
            "account": account,
            "to": to,
            "subject": subject,
            "body": body,
            "undoSeconds": String(undoSeconds),
        ]
        if let cc, !cc.isEmpty { fields["cc"] = cc }
        if let bcc, !bcc.isEmpty { fields["bcc"] = bcc }
        if let threadId { fields["threadId"] = threadId }
        if let messageId { fields["messageId"] = messageId }
        if let sendAt { fields["sendAt"] = String(Int(sendAt.timeIntervalSince1970 * 1000)) }

        let boundary = "lab86-\(UUID().uuidString)"
        var bodyData = Data()
        for (key, value) in fields {
            bodyData.append("--\(boundary)\r\n")
            bodyData.append("Content-Disposition: form-data; name=\"\(key)\"\r\n\r\n")
            bodyData.append("\(value)\r\n")
        }
        for attachment in attachments {
            bodyData.append("--\(boundary)\r\n")
            bodyData.append(
                "Content-Disposition: form-data; name=\"attachments\"; filename=\"\(attachment.filename)\"\r\n")
            bodyData.append("Content-Type: \(attachment.contentType)\r\n\r\n")
            bodyData.append(attachment.data)
            bodyData.append("\r\n")
        }
        bodyData.append("--\(boundary)--\r\n")

        var request = URLRequest(url: Config.apiBase.appending(path: "/api/compose"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(try await bearerToken())", forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = bodyData
        let data = try await send(request)
        return try JSONDecoder().decode(ComposeResult.self, from: data)
    }

    func undoSend(pendingId: String) async throws {
        var request = URLRequest(url: Config.apiBase.appending(path: "/api/compose/undo/\(pendingId)"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(try await bearerToken())", forHTTPHeaderField: "Authorization")
        _ = try await send(request)
    }

    // MARK: - Attachments

    func downloadAttachment(message: MailMessage, attachment: MailAttachment) async throws -> Data {
        var components = URLComponents(
            url: Config.apiBase.appending(path: "/api/attachments/\(message._id)/\(attachment.id)"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [
            URLQueryItem(name: "account", value: message.account),
            URLQueryItem(name: "name", value: attachment.filename),
            URLQueryItem(name: "mime", value: attachment.contentType),
        ]
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(try await bearerToken())", forHTTPHeaderField: "Authorization")
        return try await send(request)
    }
}

private extension Data {
    mutating func append(_ string: String) {
        append(string.data(using: .utf8)!)
    }
}
