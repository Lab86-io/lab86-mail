import Foundation
import Observation

enum AssistantChatPart: Identifiable, Equatable, Sendable {
    case text(id: String, String)
    case card(id: String, AssistantToolCard)

    var id: String {
        switch self {
        case .text(let id, _): id
        case .card(let id, _): id
        }
    }
}

struct AssistantChatMessage: Identifiable, Equatable, Sendable {
    enum Role: String, Sendable {
        case user
        case assistant
    }

    let id: String
    let role: Role
    // Ordered content: streamed text blocks interleaved with native renderings
    // of the agent's display-tool outputs, in arrival order.
    var parts: [AssistantChatPart]
    // Human-readable description of the tool the agent is currently running,
    // shown inline while the turn streams.
    var toolActivity: String?

    init(id: String, role: Role, text: String = "", parts: [AssistantChatPart]? = nil) {
        self.id = id
        self.role = role
        self.parts = parts ?? (text.isEmpty ? [] : [.text(id: id + "-t0", text)])
    }

    var text: String {
        parts.compactMap { part in
            if case .text(_, let text) = part { return text }
            return nil
        }.joined(separator: "\n\n")
    }

    var isVisuallyEmpty: Bool {
        parts.allSatisfy { part in
            if case .text(_, let text) = part {
                return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            return false
        }
    }
}

// One intent conversation with the Albatross agent. Streams the server's
// UI-message event stream from /api/agent and saves the transcript through
// /api/chats so the conversation also appears in the web product's history.
@MainActor
@Observable
final class AssistantChatModel {
    let sessionID: String
    private(set) var messages: [AssistantChatMessage] = []
    private(set) var isStreaming = false
    private(set) var errorMessage: String?

    private let backend: BackendClient
    private let baseURL: URL?
    private let session: URLSession
    private let tokenProvider: @Sendable () async throws -> String
    private var streamTask: Task<Void, Never>?
    // toolCallId → toolName; the output chunk carries only the call id.
    private var toolNamesByCallID: [String: String] = [:]
    private var partCounter = 0

    init(
        backend: BackendClient,
        baseURL: URL?,
        session: URLSession = .shared,
        tokenProvider: @escaping @Sendable () async throws -> String = {
            try await ClerkSessionAccess.activeToken()
        }
    ) {
        self.backend = backend
        self.baseURL = baseURL
        self.session = session
        self.tokenProvider = tokenProvider
        sessionID = "ios-" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    var hasStarted: Bool { !messages.isEmpty }

    func send(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isStreaming else { return }
        errorMessage = nil
        messages.append(AssistantChatMessage(id: Self.newMessageID(), role: .user, text: text))
        let reply = AssistantChatMessage(id: Self.newMessageID(), role: .assistant, text: "")
        messages.append(reply)
        isStreaming = true
        let replyID = reply.id
        streamTask = Task { [weak self] in
            await self?.streamReply(into: replyID)
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
        finishStreaming()
    }

    private func streamReply(into replyID: String) async {
        do {
            guard let baseURL, let url = URL(string: "/api/agent", relativeTo: baseURL)?.absoluteURL else {
                throw BackendError.configuration
            }
            let token = try await tokenProvider()
            guard !token.isEmpty else { throw BackendError.unauthorized }

            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = 300
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue(TimeZone.current.identifier, forHTTPHeaderField: "x-user-timezone")
            request.httpBody = try JSONEncoder().encode(requestBody())

            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse else { throw BackendError.invalidResponse }
            guard (200..<300).contains(http.statusCode) else {
                if http.statusCode == 401 { throw BackendError.unauthorized }
                throw BackendError.server(
                    status: http.statusCode,
                    message: HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
                )
            }

            for try await line in bytes.lines {
                guard !Task.isCancelled else { break }
                guard line.hasPrefix("data:") else { continue }
                let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                guard !payload.isEmpty, payload != "[DONE]" else { continue }
                guard let data = payload.data(using: .utf8),
                      let event = try? JSONDecoder().decode(JSONValue.self, from: data) else { continue }
                apply(event: event, to: replyID)
            }
        } catch is CancellationError {
            // A stopped turn keeps whatever text already arrived.
        } catch {
            if !Task.isCancelled {
                errorMessage = (error as? BackendError)?.errorDescription ?? error.localizedDescription
            }
        }
        finishStreaming()
        await persistTranscript()
    }

    private func apply(event: JSONValue, to replyID: String) {
        guard let type = event["type"]?.stringValue,
              let index = messages.firstIndex(where: { $0.id == replyID }) else { return }
        switch type {
        case "text-start":
            partCounter += 1
            messages[index].parts.append(.text(id: "\(replyID)-t\(partCounter)", ""))
            messages[index].toolActivity = nil
        case "text-delta":
            guard let delta = event["delta"]?.stringValue else { return }
            if case .text(let id, let existing) = messages[index].parts.last {
                messages[index].parts[messages[index].parts.count - 1] = .text(id: id, existing + delta)
            } else {
                partCounter += 1
                messages[index].parts.append(.text(id: "\(replyID)-t\(partCounter)", delta))
            }
            messages[index].toolActivity = nil
        case "tool-input-start", "tool-input-available":
            if let name = event["toolName"]?.stringValue {
                if let callID = event["toolCallId"]?.stringValue {
                    toolNamesByCallID[callID] = name
                }
                messages[index].toolActivity = Self.describeTool(name)
            }
        case "tool-output-available":
            guard let callID = event["toolCallId"]?.stringValue,
                  let name = toolNamesByCallID[callID] else { return }
            if let card = AssistantToolCard.parse(toolName: name, output: event["output"] ?? .null) {
                partCounter += 1
                messages[index].parts.append(.card(id: "\(replyID)-c\(partCounter)", card))
                messages[index].toolActivity = nil
            }
        case "error":
            errorMessage = event["errorText"]?.stringValue ?? "Albatross couldn’t finish that."
        default:
            break
        }
    }

    private func finishStreaming() {
        isStreaming = false
        for index in messages.indices {
            messages[index].toolActivity = nil
        }
        // An assistant turn that produced nothing at all should not linger as
        // an empty row.
        if let last = messages.last, last.role == .assistant, last.isVisuallyEmpty {
            messages.removeLast()
        }
    }

    private func requestBody() throws -> JSONValue {
        .object([
            "messages": transcriptJSON(),
            "timezone": .string(TimeZone.current.identifier),
        ])
    }

    private func transcriptJSON() -> JSONValue {
        .array(messages.compactMap { message in
            let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return .object([
                "id": .string(message.id),
                "role": .string(message.role.rawValue),
                "parts": .array([.object(["type": .string("text"), "text": .string(text)])]),
            ])
        })
    }

    // Best-effort history save; a failure never interrupts the conversation.
    private func persistTranscript() async {
        guard case let .array(items) = transcriptJSON(), !items.isEmpty else { return }
        let title = messages.first(where: { $0.role == .user }).map { String($0.text.prefix(64)) }
        _ = try? await backend.post(
            path: "/api/chats",
            body: .object([
                "id": .string(sessionID),
                "title": title.map(JSONValue.string) ?? .null,
                "messages": .array(items),
                "scopeKind": .string("global"),
            ])
        )
    }

    private static func newMessageID() -> String {
        "msg-" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    private static func describeTool(_ name: String) -> String {
        let readable = name.replacingOccurrences(of: "_", with: " ")
        return "Working — \(readable)"
    }
}
