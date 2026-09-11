import Foundation
import Observation

/// The tool call behind a rendered card, kept so the transcript can carry the
/// card to history and back and so an artifact keeps one identity.
struct AssistantToolCardSource: Equatable, Sendable {
    let toolName: String
    let toolCallID: String
    let input: JSONValue?
    let output: JSONValue
}

enum AssistantChatPart: Identifiable, Equatable, Sendable {
    case text(id: String, String)
    case reasoning(AssistantReasoningPart)
    case toolRow(AssistantToolRow)
    case card(id: String, AssistantToolCard, source: AssistantToolCardSource?)
    case approval(AssistantInlineApproval)
    case question(AssistantQuestionPart)

    var id: String {
        switch self {
        case .text(let id, _): id
        case .reasoning(let reasoning): reasoning.id
        case .toolRow(let row): row.id
        case .card(let id, _, _): id
        case .approval(let approval): approval.id
        case .question(let question): question.id
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
    // Ordered content: streamed text, reasoning, tool rows, designed cards,
    // and questions, in arrival order.
    var parts: [AssistantChatPart]
    // Web or connector sources the reply cited.
    var sources: [AssistantSourceLink] = []
    var endedTextIDs: Set<String> = []

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

    /// Tool rows, questions, and cards count as content: a turn that only ran
    /// tools still shows its work log.
    var isVisuallyEmpty: Bool {
        parts.allSatisfy { part in
            switch part {
            case .text(_, let text):
                return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            case .reasoning(let reasoning):
                return reasoning.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            default:
                return false
            }
        }
    }

    var toolRows: [AssistantToolRow] {
        parts.compactMap { part in
            if case .toolRow(let row) = part { return row }
            return nil
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

    // The bar route, the Hold landing, and the receipts. Receipts are client
    // state; a Hold never writes a chat message.
    private(set) var route: BarRoute = .ask
    private(set) var routePinned = false
    private(set) var holdCards: [HoldCardModel] = []
    private(set) var holdPhase: HoldPhase = .collapse
    private(set) var isHolding = false
    private(set) var holdError: String?
    private(set) var receipts: [HoldCardModel] = []
    private(set) var heldMessageIDs: Set<String> = []
    private(set) var holdingMessageID: String?
    private var routeTask: Task<Void, Never>?

    private let backend: BackendClient
    private let baseURL: URL?
    private let session: URLSession
    private let tokenProvider: @Sendable () async throws -> String
    // Inline email drafts live in their own owner so they outlive this
    // conversation object, the chat tab, and a relaunch.
    private let draftStore: AssistantDraftStore?
    private let ownerIDProvider: @MainActor () -> String?
    private var streamTask: Task<Void, Never>?
    private var activeReplyID: String?
    // toolCallId → toolName; the output chunk carries only the call id.
    private var toolNamesByCallID: [String: String] = [:]
    private var approvalInputsByCallID: [String: JSONValue] = [:]
    private var partCounter = 0
    private var uploadContext = ""
    private var currentApprovalContinuationID: String?
    private var lastFailedApprovalID: String?
    /// Wall clock for row and reasoning timestamps. Tests pin it.
    var clock: @MainActor () -> Date = { Date() }

    init(
        backend: BackendClient,
        baseURL: URL?,
        scope: AssistantChatScope = .global,
        sessionID: String? = nil,
        session: URLSession = .shared,
        tokenProvider: @escaping @Sendable () async throws -> String = {
            try await ClerkSessionAccess.activeToken()
        },
        draftStore: AssistantDraftStore? = nil,
        ownerIDProvider: @escaping @MainActor () -> String? = { nil }
    ) {
        self.backend = backend
        self.baseURL = baseURL
        self.scope = scope
        self.session = session
        self.tokenProvider = tokenProvider
        self.draftStore = draftStore
        self.ownerIDProvider = ownerIDProvider
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
        let replyID = appendAssistantReply()
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

    /// Records the answer to an `ask_*` question and resumes the turn. The
    /// answer travels as the tool output of that call, the way the web's
    /// `addToolResult` does it.
    func answerQuestion(_ questionID: String, output: JSONValue) {
        guard !isStreaming, !isUploading else { return }
        for messageIndex in messages.indices {
            for partIndex in messages[messageIndex].parts.indices {
                guard case .question(var question) = messages[messageIndex].parts[partIndex],
                      question.id == questionID, !question.isAnswered else { continue }
                question.answer = output
                messages[messageIndex].parts[partIndex] = .question(question)
                beginApprovalContinuation(approvalID: questionID)
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
        let replyID = appendAssistantReply()
        streamTask = Task { [weak self] in
            await self?.streamReply(into: replyID)
        }
    }

    /// Opens the assistant turn that stream events fill in.
    @discardableResult
    func appendAssistantReply() -> String {
        let reply = AssistantChatMessage(id: Self.newMessageID(), role: .assistant, text: "")
        messages.append(reply)
        isStreaming = true
        activeReplyID = reply.id
        return reply.id
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
        canContinue = true
        finishStreaming()
        activeReplyID = nil
        Task { await persistTranscript() }
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
            if !Task.isCancelled, activeReplyID == replyID {
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
        guard activeReplyID == replyID else { return }
        finishStreaming()
        activeReplyID = nil
        await persistTranscript()
    }

    /// One UI-message stream event. The network reader is the only production
    /// caller; tests feed the same events to exercise the same transitions.
    func apply(event: JSONValue, to replyID: String) {
        guard let type = event["type"]?.stringValue,
              activeReplyID == replyID,
              let index = messages.firstIndex(where: { $0.id == replyID }) else { return }
        switch type {
        case "text-start":
            partCounter += 1
            let id = event["id"]?.stringValue.map { "\(replyID)-text-\($0)" } ?? "\(replyID)-t\(partCounter)"
            messages[index].parts.append(.text(id: id, ""))
        case "text-delta":
            guard let delta = event["delta"]?.stringValue else { return }
            let expectedID = event["id"]?.stringValue.map { "\(replyID)-text-\($0)" }
            if let partIndex = messages[index].parts.lastIndex(where: { part in
                if case .text(let id, _) = part { return expectedID == nil || id == expectedID }
                return false
            }), case .text(let id, let existing) = messages[index].parts[partIndex] {
                messages[index].parts[partIndex] = .text(id: id, existing + delta)
            } else {
                partCounter += 1
                messages[index].parts.append(.text(id: expectedID ?? "\(replyID)-t\(partCounter)", delta))
            }
        case "text-end":
            if let streamID = event["id"]?.stringValue {
                messages[index].endedTextIDs.insert("\(replyID)-text-\(streamID)")
            } else if let part = messages[index].parts.last, case .text(let id, _) = part {
                messages[index].endedTextIDs.insert(id)
            }
        case "reasoning-start":
            partCounter += 1
            let id = event["id"]?.stringValue ?? "r\(partCounter)"
            messages[index].parts.append(
                .reasoning(AssistantReasoningPart(id: "\(replyID)-reasoning-\(id)", text: "", startedAt: clock()))
            )
        case "reasoning-delta":
            guard let delta = event["delta"]?.stringValue else { return }
            let id = event["id"]?.stringValue.map { "\(replyID)-reasoning-\($0)" }
            if let partIndex = reasoningIndex(in: index, id: id),
               case .reasoning(var reasoning) = messages[index].parts[partIndex] {
                reasoning.text += delta
                messages[index].parts[partIndex] = .reasoning(reasoning)
            } else {
                partCounter += 1
                messages[index].parts.append(
                    .reasoning(AssistantReasoningPart(
                        id: id ?? "\(replyID)-reasoning-\(partCounter)",
                        text: delta,
                        startedAt: clock()
                    ))
                )
            }
        case "reasoning-end":
            let id = event["id"]?.stringValue.map { "\(replyID)-reasoning-\($0)" }
            guard let partIndex = reasoningIndex(in: index, id: id),
                  case .reasoning(var reasoning) = messages[index].parts[partIndex] else { return }
            reasoning.endedAt = clock()
            messages[index].parts[partIndex] = .reasoning(reasoning)
        case "tool-input-start":
            guard let callID = event["toolCallId"]?.stringValue,
                  let name = event["toolName"]?.stringValue else { return }
            toolNamesByCallID[callID] = name
            // Questions render as forms once their input is complete; they
            // never take a row.
            guard !name.hasPrefix("ask_") else { return }
            if rowIndex(in: index, callID: callID) == nil {
                messages[index].parts.append(
                    .toolRow(AssistantToolRow(callID: callID, toolName: name, startedAt: clock()))
                )
            }
        case "tool-input-delta":
            guard let callID = event["toolCallId"]?.stringValue,
                  let delta = event["inputTextDelta"]?.stringValue,
                  let partIndex = rowIndex(in: index, callID: callID),
                  case .toolRow(var row) = messages[index].parts[partIndex] else { return }
            row.inputText += delta
            messages[index].parts[partIndex] = .toolRow(row)
        case "tool-input-available":
            guard let callID = event["toolCallId"]?.stringValue else { return }
            let name = event["toolName"]?.stringValue ?? toolNamesByCallID[callID] ?? "tool"
            toolNamesByCallID[callID] = name
            let input = event["input"] ?? .object([:])
            approvalInputsByCallID[callID] = input
            if name == "ask_approval" {
                if !Self.containsApproval(callID: callID, in: messages[index].parts) {
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
            } else if let kind = AssistantQuestionPart.Kind(rawValue: name) {
                if !Self.containsQuestion(callID: callID, in: messages[index].parts) {
                    messages[index].parts.append(
                        .question(AssistantQuestionPart(
                            id: "question-\(callID)",
                            toolCallID: callID,
                            kind: kind,
                            input: input,
                            answer: nil
                        ))
                    )
                }
            } else if let partIndex = rowIndex(in: index, callID: callID),
                      case .toolRow(var row) = messages[index].parts[partIndex] {
                row.input = input
                row.toolName = name
                messages[index].parts[partIndex] = .toolRow(row)
            } else if !name.hasPrefix("ask_") {
                messages[index].parts.append(
                    .toolRow(AssistantToolRow(callID: callID, toolName: name, input: input, startedAt: clock()))
                )
            }
        case "tool-approval-request":
            guard let approvalID = event["approvalId"]?.stringValue,
                  let callID = event["toolCallId"]?.stringValue,
                  let input = approvalInputsByCallID[callID] else { return }
            let approval = Self.makeApproval(
                id: approvalID, callID: callID,
                toolName: toolNamesByCallID[callID] ?? "ask_approval",
                input: input, usesApprovalResponse: true
            )
            if let existing = messages[index].parts.firstIndex(where: { part in
                if case .approval(let value) = part { return value.toolCallID == callID }
                return false
            }) {
                messages[index].parts[existing] = .approval(approval)
            } else {
                messages[index].parts.removeAll { part in
                    if case .toolRow(let row) = part { return row.callID == callID }
                    return false
                }
                messages[index].parts.append(.approval(approval))
            }
        case "tool-output-available":
            guard let callID = event["toolCallId"]?.stringValue else { return }
            let name = toolNamesByCallID[callID] ?? "tool"
            guard !name.hasPrefix("ask_") else { return }
            let output = event["output"] ?? .null
            let card = name.hasPrefix("show_") ? AssistantToolCard.parse(toolName: name, output: output, toolCallID: callID) : nil
            if let partIndex = rowIndex(in: index, callID: callID),
               case .toolRow(var row) = messages[index].parts[partIndex] {
                row.state = output["ok"]?.boolValue == false ? .failed : .done
                row.errorText = output["error"]?.stringValue
                row.output = output
                row.card = card
                row.endedAt = clock()
                messages[index].parts[partIndex] = .toolRow(row)
            } else {
                messages[index].parts.append(
                    .toolRow(AssistantToolRow(
                        callID: callID,
                        toolName: name,
                        state: .done,
                        input: approvalInputsByCallID[callID],
                        output: output,
                        card: card,
                        startedAt: clock(),
                        endedAt: clock()
                    ))
                )
            }
            if let card { ingestDraft(card) }
        case "tool-output-error":
            guard let callID = event["toolCallId"]?.stringValue else { return }
            let name = toolNamesByCallID[callID] ?? "tool"
            let errorText = event["errorText"]?.stringValue?.nilIfBlank ?? "The step failed."
            if let partIndex = rowIndex(in: index, callID: callID),
               case .toolRow(var row) = messages[index].parts[partIndex] {
                row.state = .failed
                row.errorText = errorText
                row.endedAt = clock()
                messages[index].parts[partIndex] = .toolRow(row)
            } else {
                messages[index].parts.append(
                    .toolRow(AssistantToolRow(
                        callID: callID,
                        toolName: name,
                        state: .failed,
                        input: approvalInputsByCallID[callID],
                        errorText: errorText,
                        startedAt: clock(),
                        endedAt: clock()
                    ))
                )
            }
        case "data-tool-shape":
            guard let callID = event["id"]?.stringValue, let data = event["data"],
                  let partIndex = rowIndex(in: index, callID: callID),
                  case .toolRow(var row) = messages[index].parts[partIndex] else { return }
            row.shapeJSON = data
            row.shape = ToolShape.decode(data)
            messages[index].parts[partIndex] = .toolRow(row)
        case "source-url":
            guard let url = event["url"]?.stringValue?.nilIfBlank else { return }
            let id = event["sourceId"]?.stringValue ?? url
            guard !messages[index].sources.contains(where: { $0.id == id }) else { return }
            messages[index].sources.append(
                AssistantSourceLink(id: id, url: url, title: event["title"]?.stringValue?.nilIfBlank)
            )
        case "error":
            errorMessage = event["errorText"]?.stringValue ?? "Albatross couldn’t finish that."
            canContinue = !messages[index].isVisuallyEmpty
            if let continuation = currentApprovalContinuationID {
                lastFailedApprovalID = continuation
            } else if !canContinue {
                lastFailedUserText = messages.last(where: { $0.role == .user })?.text
            }
        case "finish":
            canContinue = canContinue || event["finishReason"]?.stringValue == "length"
        default:
            break
        }
    }

    private func rowIndex(in messageIndex: Int, callID: String) -> Int? {
        messages[messageIndex].parts.lastIndex { part in
            if case .toolRow(let row) = part { return row.callID == callID }
            return false
        }
    }

    /// The reasoning part with the given id, else the last open one.
    private func reasoningIndex(in messageIndex: Int, id: String?) -> Int? {
        let parts = messages[messageIndex].parts
        if let id, let exact = parts.lastIndex(where: { $0.id == id }) { return exact }
        return parts.lastIndex { part in
            if case .reasoning(let reasoning) = part { return reasoning.isStreaming }
            return false
        }
    }

    private func finishStreaming() {
        isStreaming = false
        let now = clock()
        for index in messages.indices {
            for partIndex in messages[index].parts.indices {
                switch messages[index].parts[partIndex] {
                case .toolRow(var row) where row.state == .running:
                    // A row that never got its output cannot stay live once
                    // the stream is gone.
                    row.state = .failed
                    row.errorText = row.errorText ?? "Did not finish"
                    row.endedAt = now
                    messages[index].parts[partIndex] = .toolRow(row)
                case .reasoning(var reasoning) where reasoning.isStreaming:
                    reasoning.endedAt = now
                    messages[index].parts[partIndex] = .reasoning(reasoning)
                default:
                    continue
                }
            }
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
            scopeLine = nil
            if let workID = scope.contextID {
                body["contextAttachments"] = .array([
                    .object(["kind": .string("work"), "id": .string(workID)])
                ])
            }
        }
        let context = [scopeLine, uploadContext.nilIfBlank].compactMap { $0 }.joined(separator: "\n\n")
        if !context.isEmpty { body["extraSystem"] = .string(context) }
        return .object(body)
    }

    /// The transcript as sent to the agent and saved to history. Internal so
    /// tests can prove a saved card restores with the same identity. Display
    /// parts (shapes, sources) only travel to history; the agent request
    /// carries the parts the model reads.
    func transcriptJSON(includeDisplayParts: Bool = false) -> JSONValue {
        .array(messages.compactMap { message in
            var parts: [JSONValue] = []
            for part in message.parts {
                switch part {
                case .text(_, let text):
                    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                    parts.append(.object(["type": .string("text"), "text": .string(text)]))
                case .reasoning(let reasoning):
                    guard !reasoning.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                    var saved: [String: JSONValue] = ["type": .string("reasoning"), "text": .string(reasoning.text)]
                    if includeDisplayParts {
                        saved["startedAt"] = reasoning.startedAt.map { .number($0.timeIntervalSince1970 * 1_000) }
                        saved["endedAt"] = reasoning.endedAt.map { .number($0.timeIntervalSince1970 * 1_000) }
                    }
                    parts.append(.object(saved))
                case .toolRow(let row):
                    var saved = Self.toolRowPartJSON(row)
                    if includeDisplayParts, case .object(var fields) = saved {
                        fields["startedAt"] = row.startedAt.map { .number($0.timeIntervalSince1970 * 1_000) }
                        fields["endedAt"] = row.endedAt.map { .number($0.timeIntervalSince1970 * 1_000) }
                        saved = .object(fields)
                    }
                    parts.append(saved)
                    if includeDisplayParts, let shapeJSON = row.shapeJSON {
                        parts.append(.object([
                            "type": .string("data-tool-shape"),
                            "id": .string(row.callID),
                            "data": shapeJSON,
                        ]))
                    }
                case .approval(let approval):
                    parts.append(Self.approvalPartJSON(approval))
                case .question(let question):
                    parts.append(Self.questionPartJSON(question))
                case .card(_, _, let source):
                    // Cards travel with the transcript so reopening the chat
                    // brings them back, in the same tool-part shape the web
                    // product writes.
                    guard let source else { continue }
                    parts.append(Self.cardPartJSON(source))
                }
            }
            if includeDisplayParts {
                for source in message.sources {
                    var part: [String: JSONValue] = [
                        "type": .string("source-url"),
                        "sourceId": .string(source.id),
                        "url": .string(source.url),
                    ]
                    if let title = source.title { part["title"] = .string(title) }
                    parts.append(.object(part))
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

    static func toolRowPartJSON(_ row: AssistantToolRow) -> JSONValue {
        var part: [String: JSONValue] = [
            "type": .string("dynamic-tool"),
            "toolName": .string(row.toolName),
            "toolCallId": .string(row.callID),
            "input": row.input ?? .object([:]),
        ]
        switch row.state {
        case .running:
            part["state"] = .string(row.input == nil ? "input-streaming" : "input-available")
        case .done:
            part["state"] = .string("output-available")
            part["output"] = row.output ?? .null
        case .failed:
            part["state"] = .string("output-error")
            part["errorText"] = .string(row.errorText ?? "The step failed.")
        }
        return .object(part)
    }

    static func questionPartJSON(_ question: AssistantQuestionPart) -> JSONValue {
        var part: [String: JSONValue] = [
            "type": .string("dynamic-tool"),
            "toolName": .string(question.toolName),
            "toolCallId": .string(question.toolCallID),
            "input": question.input,
        ]
        if let answer = question.answer {
            part["state"] = .string("output-available")
            part["output"] = answer
        } else {
            part["state"] = .string("input-available")
        }
        return .object(part)
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

    static func cardPartJSON(_ source: AssistantToolCardSource) -> JSONValue {
        .object([
            "type": .string("dynamic-tool"),
            "toolName": .string(source.toolName),
            "toolCallId": .string(source.toolCallID),
            "state": .string("output-available"),
            "input": source.input ?? .object([:]),
            "output": source.output,
        ])
    }

    /// Hands a drafted email to its owner. Idempotent: a replay of the same
    /// content changes nothing, and different content waits as a suggestion.
    private func ingestDraft(_ card: AssistantToolCard) {
        guard case .draft(let draft) = card, let toolCallID = draft.toolCallID,
              let draftStore, let ownerID = ownerIDProvider() else { return }
        draftStore.receive(
            draft.seed,
            key: AssistantDraftKey(sessionID: sessionID, toolCallID: toolCallID),
            ownerID: ownerID
        )
    }

    private static func containsApproval(callID: String, in parts: [AssistantChatPart]) -> Bool {
        parts.contains { part in
            if case .approval(let approval) = part {
                return approval.toolCallID == callID
            }
            return false
        }
    }

    private static func containsQuestion(callID: String, in parts: [AssistantChatPart]) -> Bool {
        parts.contains { part in
            if case .question(let question) = part {
                return question.toolCallID == callID
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
        guard case let .array(items) = transcriptJSON(includeDisplayParts: true), !items.isEmpty else { return }
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

    // MARK: - Ask or hold

    /// The chip value while the person types. The heuristic answers at once.
    /// The endpoint confirms after `RoutePredictor.confirmDelay`.
    func updateDraft(_ text: String) {
        routeTask?.cancel()
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.isEmpty {
            // A route the person chose by hand stays through an empty field,
            // so flipping before typing (or after clearing) means something.
            if !routePinned { route = .ask }
            return
        }
        if !routePinned {
            route = RouteHeuristic.instant(clean, current: route).route
        }
        routeTask = Task { [weak self] in
            try? await Task.sleep(for: RoutePredictor.confirmDelay)
            guard !Task.isCancelled else { return }
            await self?.confirmRoute(for: clean)
        }
    }

    /// Flip the chip by hand. The route stays pinned until the field clears.
    func flipRoute() {
        route = route.flipped
        routePinned = true
        routeTask?.cancel()
    }

    /// Open the bar already set to hold, for the one entry point.
    func presetRoute(_ next: BarRoute) {
        route = next
        routePinned = true
    }

    func clearRoute() {
        routeTask?.cancel()
        route = .ask
        routePinned = false
    }

    private func confirmRoute(for text: String) async {
        guard !routePinned else { return }
        let verdict = await routeVerdict(for: text)
        guard !Task.isCancelled, !routePinned else { return }
        guard RoutePredictor.shouldAdopt(verdict, pinned: routePinned) else { return }
        route = verdict.route
    }

    private func routeVerdict(for text: String) async -> RouteVerdict {
        do {
            let result = try await backend.post(
                path: "/api/mobile/v1/assistant/route",
                body: .object(["text": .string(text)])
            )
            guard let raw = result["route"]?.stringValue,
                  let parsed = BarRoute(rawValue: raw) else { return .askFallback }
            return RouteVerdict(
                route: parsed,
                confidence: result["confidence"]?.doubleValue ?? 0,
                reason: "server"
            )
        } catch {
            return .askFallback
        }
    }

    /// Keep the text as Work. No chat reply follows.
    func hold(_ raw: String) async {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isHolding else { return }
        isHolding = true
        holdError = nil
        holdPhase = .collapse
        defer { isHolding = false }
        do {
            let cards = try await captureFromChat(text: text, replyText: nil, messageID: nil)
            guard !cards.isEmpty else {
                holdError = "Could not hold that. Try again."
                return
            }
            await runLanding(cards)
        } catch {
            holdError = "Could not hold that. Try again."
        }
    }

    /// Keep an assistant reply. The same landing runs from the message.
    func holdReply(messageID: String, userText: String, replyText: String) async {
        guard !heldMessageIDs.contains(messageID), holdingMessageID == nil else { return }
        holdingMessageID = messageID
        holdError = nil
        defer { holdingMessageID = nil }
        do {
            let cards = try await captureFromChat(
                text: userText,
                replyText: replyText,
                messageID: messageID
            )
            guard !cards.isEmpty else {
                holdError = "Could not hold that. Try again."
                return
            }
            heldMessageIDs.insert(messageID)
            await runLanding(cards)
        } catch {
            holdError = "Could not hold that. Try again."
        }
    }

    private func runLanding(_ cards: [HoldCardModel]) async {
        holdCards = cards
        holdPhase = .collapse
        try? await Task.sleep(for: .seconds(HoldPhase.collapseDuration))
        holdPhase = .hold
        try? await Task.sleep(for: .seconds(HoldPhase.holdDuration))
        holdPhase = .travel
        try? await Task.sleep(for: .seconds(HoldPhase.travelDuration))
        receipts.append(contentsOf: cards)
        holdCards = []
        clearRoute()
    }

    private func captureFromChat(
        text: String,
        replyText: String?,
        messageID: String?
    ) async throws -> [HoldCardModel] {
        var body: [String: JSONValue] = [
            "text": .string(text),
            "source": .string("chat"),
            "conversationId": .string(sessionID),
        ]
        if let replyText { body["replyText"] = .string(replyText) }
        if let messageID { body["sourceMessageId"] = .string(messageID) }
        let result = try await backend.post(path: "/api/albatross/capture", body: .object(body))
        guard let rows = result["work"]?.arrayValue else { return [] }
        return rows.compactMap { row in
            guard let id = row["id"]?.stringValue,
                  let title = row["title"]?.stringValue?.nilIfBlank else { return nil }
            let shape = row["shape"]?.stringValue.flatMap { WorkShape(rawValue: $0) } ?? .quick
            let horizon = WorkHorizon(json: row["horizon"])
            return HoldCardModel(
                id: id,
                title: title,
                shapeWord: shape.label,
                horizonLine: horizon?.line(at: Date())
            )
        }
    }

    func dismissHoldError() {
        holdError = nil
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
            lastFailedApprovalID = nil
            currentApprovalContinuationID = nil
            canContinue = false
            for message in restored {
                for part in message.parts {
                    switch part {
                    case .card(_, let card, _): ingestDraft(card)
                    case .toolRow(let row): if let card = row.card { ingestDraft(card) }
                    default: continue
                    }
                }
            }
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

    static func message(from json: JSONValue) -> AssistantChatMessage? {
        guard let id = json["id"]?.stringValue,
              let roleValue = json["role"]?.stringValue,
              let role = AssistantChatMessage.Role(rawValue: roleValue) else { return nil }
        var parts: [AssistantChatPart] = []
        var sources: [AssistantSourceLink] = []
    var endedTextIDs: Set<String> = []
        for (offset, part) in (json["parts"]?.arrayValue ?? []).enumerated() {
            let type = part["type"]?.stringValue ?? ""
            switch type {
            case "text":
                guard let text = part["text"]?.stringValue, !text.isEmpty else { continue }
                if case .text(let textID, let existing)? = parts.last, !existing.isEmpty {
                    parts[parts.count - 1] = .text(id: textID, existing + "\n\n" + text)
                } else {
                    parts.append(.text(id: "\(id)-t\(offset)", text))
                }
            case "reasoning":
                guard let text = (part["text"] ?? part["reasoning"])?.stringValue?.nilIfBlank else { continue }
                parts.append(.reasoning(AssistantReasoningPart(
                    id: "\(id)-reasoning-\(offset)", text: text,
                    startedAt: CalendarDateParser.date(part["startedAt"]),
                    endedAt: CalendarDateParser.date(part["endedAt"]) ?? .distantPast
                )))
            case "data-tool-shape":
                guard let callID = part["id"]?.stringValue, let data = part["data"],
                      let rowIndex = parts.lastIndex(where: { candidate in
                          if case .toolRow(let row) = candidate { return row.callID == callID }
                          return false
                      }),
                      case .toolRow(var row) = parts[rowIndex] else { continue }
                row.shapeJSON = data
                row.shape = ToolShape.decode(data)
                parts[rowIndex] = .toolRow(row)
            case "source-url":
                guard let url = part["url"]?.stringValue?.nilIfBlank else { continue }
                sources.append(AssistantSourceLink(
                    id: part["sourceId"]?.stringValue ?? url,
                    url: url,
                    title: part["title"]?.stringValue?.nilIfBlank
                ))
            default:
                guard let restored = restoredToolPart(part, type: type, callID: nil) else { continue }
                parts.append(restored)
            }
        }
        var message = AssistantChatMessage(id: id, role: role, parts: parts)
        message.sources = sources
        return message
    }

    /// One saved tool part: the web writes `tool-<name>` parts, this client
    /// writes `dynamic-tool`. Questions and approvals come back as forms,
    /// answered or still open; everything else is a work log row.
    private static func restoredToolPart(_ part: JSONValue, type: String, callID: String?) -> AssistantChatPart? {
        let toolName: String
        if type == "dynamic-tool" || type == "tool" {
            guard let name = part["toolName"]?.stringValue else { return nil }
            toolName = name
        } else if type.hasPrefix("tool-") {
            toolName = part["toolName"]?.stringValue ?? String(type.dropFirst("tool-".count))
        } else {
            return nil
        }
        guard let callID = callID ?? part["toolCallId"]?.stringValue else { return nil }
        let state = part["state"]?.stringValue ?? "output-available"
        let input = part["input"] ?? .object([:])
        if toolName == "ask_approval" || state.hasPrefix("approval-") {
            let usesApprovalResponse = state.hasPrefix("approval-")
            var approval = makeApproval(
                id: part["approval"]?["id"]?.stringValue ?? "approval-\(callID)",
                callID: callID,
                toolName: toolName,
                input: input,
                usesApprovalResponse: usesApprovalResponse
            )
            if usesApprovalResponse {
                approval.decision = part["approval"]?["approved"]?.boolValue
            } else if state == "output-available", let decision = part["output"]?["decision"]?.stringValue {
                approval.decision = decision == "approved"
            }
            return .approval(approval)
        }
        if let kind = AssistantQuestionPart.Kind(rawValue: toolName) {
            return .question(AssistantQuestionPart(
                id: "question-\(callID)",
                toolCallID: callID,
                kind: kind,
                input: input,
                answer: state == "output-available" ? part["output"] : nil
            ))
        }
        var row = AssistantToolRow(
            callID: callID, toolName: toolName, input: part["input"],
            startedAt: CalendarDateParser.date(part["startedAt"]),
            endedAt: CalendarDateParser.date(part["endedAt"])
        )
        switch state {
        case "output-available":
            row.state = .done
            row.output = part["output"] ?? .null
            row.card = toolName.hasPrefix("show_") ? AssistantToolCard.parse(toolName: toolName, output: row.output ?? .null, toolCallID: callID) : nil
        case "output-error":
            row.state = .failed
            row.errorText = part["errorText"]?.stringValue
        default:
            // A call saved mid-flight has no result to show.
            row.state = .failed
            row.errorText = "Did not finish"
        }
        return .toolRow(row)
    }

    private static func newMessageID() -> String {
        "msg-" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }
}
