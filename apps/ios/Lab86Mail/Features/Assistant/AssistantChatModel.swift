import Foundation
import Observation

enum AssistantChatPart: Identifiable, Equatable, Sendable {
    case text(id: String, String)
    case card(id: String, AssistantToolCard)
    case approval(AssistantInlineApproval)

    var id: String {
        switch self {
        case .text(let id, _): id
        case .card(let id, _): id
        case .approval(let approval): approval.id
        }
    }
}

struct AssistantChatScope: Equatable, Sendable {
    enum Kind: String, Sendable {
        case global
        case area
        case work
    }

    let kind: Kind
    let contextID: String?
    let label: String?

    static let global = AssistantChatScope(kind: .global, contextID: nil, label: nil)
}

struct AssistantInlineApproval: Identifiable, Equatable, Sendable {
    struct Metadata: Identifiable, Equatable, Sendable {
        let label: String
        let value: String
        var id: String { "\(label):\(value)" }
    }

    let id: String
    let toolCallID: String
    let toolName: String
    let input: JSONValue
    let usesApprovalResponse: Bool
    let title: String
    let description: String?
    let metadata: [Metadata]
    let confirmLabel: String
    let denyLabel: String
    let destructive: Bool
    var decision: Bool?
}

struct AssistantChatSessionSummary: Identifiable, Sendable {
    let id: String
    let title: String
    let updatedAt: Date
    let scopeLabel: String?

    init?(json: JSONValue) {
        guard let id = json["_id"]?.stringValue else { return nil }
        self.id = id
        title = json["title"]?.stringValue?.nilIfBlank ?? "New chat"
        updatedAt = CalendarDateParser.date(json["updatedAt"]) ?? .distantPast
        let kind = json["scope"]?["kind"]?.stringValue
        scopeLabel = kind == "global" || kind == nil ? nil : kind?.capitalized
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
    private(set) var sessionID: String
    let scope: AssistantChatScope
    private(set) var messages: [AssistantChatMessage] = []
    private(set) var isStreaming = false
    private(set) var isUploading = false
    private(set) var errorMessage: String?
    private(set) var lastFailedUserText: String?
    private(set) var canContinue = false
    var canRetry: Bool { lastFailedUserText != nil || lastFailedApprovalID != nil }

    private let backend: BackendClient
    private let baseURL: URL?
    private let session: URLSession
    private let tokenProvider: @Sendable () async throws -> String
    private var streamTask: Task<Void, Never>?
    // toolCallId → toolName; the output chunk carries only the call id.
    private var toolNamesByCallID: [String: String] = [:]
    private var approvalInputsByCallID: [String: JSONValue] = [:]
    private var partCounter = 0
    private var uploadContext = ""
    private var currentApprovalContinuationID: String?
    private var lastFailedApprovalID: String?

    init(
        backend: BackendClient,
        baseURL: URL?,
        scope: AssistantChatScope = .global,
        sessionID: String? = nil,
        session: URLSession = .shared,
        tokenProvider: @escaping @Sendable () async throws -> String = {
            try await ClerkSessionAccess.activeToken()
        }
    ) {
        self.backend = backend
        self.baseURL = baseURL
        self.scope = scope
        self.session = session
        self.tokenProvider = tokenProvider
        self.sessionID = sessionID
            ?? "ios-" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    var hasStarted: Bool { !messages.isEmpty }

    func send(_ raw: String, attachments: [ComposeAttachment] = []) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!text.isEmpty || !attachments.isEmpty), !isStreaming, !isUploading else { return }
        if !attachments.isEmpty {
            isUploading = true
            Task { [weak self] in
                await self?.stageAndSend(text: text, attachments: attachments)
            }
            return
        }
        beginSend(text.isEmpty ? "Use the attached file(s)." : text)
    }

    private func beginSend(_ text: String) {
        errorMessage = nil
        lastFailedUserText = nil
        lastFailedApprovalID = nil
        currentApprovalContinuationID = nil
        canContinue = false
        messages.append(AssistantChatMessage(id: Self.newMessageID(), role: .user, text: text))
        let reply = AssistantChatMessage(id: Self.newMessageID(), role: .assistant, text: "")
        messages.append(reply)
        isStreaming = true
        let replyID = reply.id
        streamTask = Task { [weak self] in
            await self?.streamReply(into: replyID)
        }
    }

    func retryLastTurn() {
        guard !isStreaming, !isUploading else { return }
        errorMessage = nil
        if let approvalID = lastFailedApprovalID {
            beginApprovalContinuation(approvalID: approvalID)
        } else if let text = lastFailedUserText {
            beginSend(text)
        }
    }

    func continueResponse() {
        guard !isStreaming, !isUploading else { return }
        beginSend("Continue from where you stopped. Do not repeat completed work.")
    }

    func answerApproval(_ approvalID: String, approved: Bool) {
        guard !isStreaming, !isUploading else { return }
        for messageIndex in messages.indices {
            for partIndex in messages[messageIndex].parts.indices {
                guard case .approval(var approval) = messages[messageIndex].parts[partIndex],
                      approval.id == approvalID else { continue }
                approval.decision = approved
                messages[messageIndex].parts[partIndex] = .approval(approval)
                beginApprovalContinuation(approvalID: approvalID)
                return
            }
        }
    }

    private func beginApprovalContinuation(approvalID: String) {
        errorMessage = nil
        lastFailedUserText = nil
        lastFailedApprovalID = nil
        currentApprovalContinuationID = approvalID
        canContinue = false
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
        canContinue = true
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
            uploadContext = ""

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
                if let approvalID = currentApprovalContinuationID {
                    lastFailedApprovalID = approvalID
                    lastFailedUserText = nil
                } else {
                    lastFailedUserText = messages.last(where: { $0.role == .user })?.text
                }
                if let lastAssistant = messages.last(where: { $0.role == .assistant }) {
                    canContinue = !lastAssistant.isVisuallyEmpty
                }
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
                    if let input = event["input"] {
                        approvalInputsByCallID[callID] = input
                        if name == "ask_approval",
                           !Self.containsApproval(callID: callID, in: messages[index].parts) {
                            messages[index].parts.append(
                                .approval(
                                    Self.makeApproval(
                                        id: "approval-\(callID)",
                                        callID: callID,
                                        toolName: name,
                                        input: input,
                                        usesApprovalResponse: false
                                    )
                                )
                            )
                        }
                    }
                }
                messages[index].toolActivity = Self.describeTool(name)
            }
        case "tool-approval-request":
            guard let approvalID = event["approvalId"]?.stringValue,
                  let callID = event["toolCallId"]?.stringValue,
                  let input = approvalInputsByCallID[callID] else { return }
            if !Self.containsApproval(callID: callID, in: messages[index].parts) {
                messages[index].parts.append(
                    .approval(
                        Self.makeApproval(
                            id: approvalID,
                            callID: callID,
                            toolName: toolNamesByCallID[callID] ?? "ask_approval",
                            input: input,
                            usesApprovalResponse: true
                        )
                    )
                )
            }
            messages[index].toolActivity = nil
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
            canContinue = !messages[index].isVisuallyEmpty
        case "finish":
            canContinue = event["finishReason"]?.stringValue == "length"
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
        // an empty row, but keep the failed user turn for explicit Retry.
        if let last = messages.last, last.role == .assistant, last.isVisuallyEmpty {
            messages.removeLast()
        }
    }

    private func requestBody() throws -> JSONValue {
        var body: [String: JSONValue] = [
            "messages": transcriptJSON(),
            "timezone": .string(TimeZone.current.identifier),
        ]
        let scopeLine: String?
        switch scope.kind {
        case .global:
            scopeLine = nil
        case .area:
            scopeLine = scope.contextID.map {
                "This conversation is scoped to Albatross Area \($0). Keep context and actions within that Area unless the user explicitly broadens scope."
            }
            if let areaID = scope.contextID {
                body["areaDiscovery"] = .object(["mode": .string("area"), "areaId": .string(areaID)])
            }
        case .work:
            scopeLine = scope.contextID.map {
                "This conversation is scoped to Albatross Work \($0). Keep context and actions within that Work unless the user explicitly broadens scope."
            }
        }
        let context = [scopeLine, uploadContext.nilIfBlank].compactMap { $0 }.joined(separator: "\n\n")
        if !context.isEmpty { body["extraSystem"] = .string(context) }
        return .object(body)
    }

    private func transcriptJSON() -> JSONValue {
        .array(messages.compactMap { message in
            let parts = message.parts.compactMap { part -> JSONValue? in
                switch part {
                case .text(_, let text):
                    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                        return nil
                    }
                    return .object(["type": .string("text"), "text": .string(text)])
                case .approval(let approval):
                    return Self.approvalPartJSON(approval)
                case .card:
                    return nil
                }
            }
            guard !parts.isEmpty else { return nil }
            return .object([
                "id": .string(message.id),
                "role": .string(message.role.rawValue),
                "parts": .array(parts),
            ])
        })
    }

    static func approvalPartJSON(_ approval: AssistantInlineApproval) -> JSONValue {
        var part: [String: JSONValue] = [
            "type": .string("dynamic-tool"),
            "toolName": .string(approval.toolName),
            "toolCallId": .string(approval.toolCallID),
            "input": approval.input,
        ]
        if approval.usesApprovalResponse {
            if let decision = approval.decision {
                part["state"] = .string("approval-responded")
                part["approval"] = .object([
                    "id": .string(approval.id),
                    "approved": .bool(decision),
                ])
            } else {
                part["state"] = .string("approval-requested")
                part["approval"] = .object(["id": .string(approval.id)])
            }
        } else if let decision = approval.decision {
            part["state"] = .string("output-available")
            part["output"] = .object([
                "decision": .string(decision ? "approved" : "denied")
            ])
        } else {
            part["state"] = .string("input-available")
        }
        return .object(part)
    }

    private static func containsApproval(callID: String, in parts: [AssistantChatPart]) -> Bool {
        parts.contains { part in
            if case .approval(let approval) = part {
                return approval.toolCallID == callID
            }
            return false
        }
    }

    private static func makeApproval(
        id: String,
        callID: String,
        toolName: String,
        input: JSONValue,
        usesApprovalResponse: Bool
    ) -> AssistantInlineApproval {
        let metadata = (input["metadata"]?.arrayValue ?? []).compactMap {
            row -> AssistantInlineApproval.Metadata? in
            guard let label = row["label"]?.stringValue, let value = row["value"]?.stringValue else {
                return nil
            }
            return .init(label: label, value: value)
        }
        return AssistantInlineApproval(
            id: id,
            toolCallID: callID,
            toolName: toolName,
            input: input,
            usesApprovalResponse: usesApprovalResponse,
            title: input["title"]?.stringValue ?? "Approve action",
            description: input["description"]?.stringValue?.nilIfBlank,
            metadata: metadata,
            confirmLabel: input["confirmLabel"]?.stringValue?.nilIfBlank ?? "Approve",
            denyLabel: input["denyLabel"]?.stringValue?.nilIfBlank ?? "Cancel",
            destructive: input["intent"]?.stringValue == "destructive",
            decision: nil
        )
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
                "scopeKind": .string(scope.kind.rawValue),
                "areaId": scope.kind == .area ? scope.contextID.map(JSONValue.string) ?? .null : .null,
                "workId": scope.kind == .work ? scope.contextID.map(JSONValue.string) ?? .null : .null,
            ])
        )
    }

    func history() async -> [AssistantChatSessionSummary] {
        do {
            var path = "/api/chats?scopeKind=\(scope.kind.rawValue)"
            if scope.kind == .area, let contextID = scope.contextID {
                path += "&areaId=\(contextID.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")"
            } else if scope.kind == .work, let contextID = scope.contextID {
                path += "&workId=\(contextID.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")"
            }
            let result = try await backend.get(path: path)
            return (result["sessions"]?.arrayValue ?? []).compactMap(AssistantChatSessionSummary.init)
        } catch {
            errorMessage = error.localizedDescription
            return []
        }
    }

    func restore(sessionID: String) async {
        guard !isStreaming, !isUploading else { return }
        do {
            let encoded = sessionID.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? sessionID
            let result = try await backend.get(path: "/api/chats?id=\(encoded)")
            guard let session = result["session"] else { throw BackendError.invalidResponse }
            let restored = (session["messages"]?.arrayValue ?? []).compactMap(Self.message(from:))
            self.sessionID = sessionID
            messages = restored
            errorMessage = nil
            lastFailedUserText = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func stageAndSend(text: String, attachments: [ComposeAttachment]) async {
        defer { isUploading = false }
        do {
            let result = try await backend.postMultipart(
                path: "/api/agent/uploads",
                fields: [:],
                files: attachments.map {
                    MultipartFile(
                        fieldName: "files",
                        filename: $0.filename,
                        contentType: $0.contentType,
                        data: $0.data
                    )
                }
            )
            let rows = result["uploads"]?.arrayValue ?? []
            guard rows.count == attachments.count else { throw BackendError.invalidResponse }
            uploadContext = [
                "Files uploaded in this user turn. Use these exact chatUploadId values when a tool needs the file:",
                rows.compactMap { row in
                    guard let id = row["uploadId"]?.stringValue,
                          let name = row["name"]?.stringValue else { return nil }
                    return "- \(name): chatUploadId=\(id)"
                }.joined(separator: "\n"),
            ].joined(separator: "\n")
            beginSend(text.isEmpty ? "Use the attached file(s)." : text)
        } catch {
            errorMessage = error.localizedDescription
            lastFailedUserText = text.nilIfBlank
        }
    }

    private static func message(from json: JSONValue) -> AssistantChatMessage? {
        guard let id = json["id"]?.stringValue,
              let roleValue = json["role"]?.stringValue,
              let role = AssistantChatMessage.Role(rawValue: roleValue) else { return nil }
        let text = (json["parts"]?.arrayValue ?? []).compactMap { part in
            part["type"]?.stringValue == "text" ? part["text"]?.stringValue : nil
        }.joined(separator: "\n\n")
        return AssistantChatMessage(id: id, role: role, text: text)
    }

    private static func newMessageID() -> String {
        "msg-" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    private static func describeTool(_ name: String) -> String {
        let readable = name.replacingOccurrences(of: "_", with: " ")
        return "Working — \(readable)"
    }
}

private extension String {
    var nilIfBlank: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
