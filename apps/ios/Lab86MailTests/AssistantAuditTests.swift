import Foundation
import Testing
@testable import Lab86Mail

// AI-1, AI-11, AI-2, NAT-6, NAT-11 (audit 2026-09-26).
@MainActor
struct AssistantAuditTests {
    private func waitUntilIdle(_ model: AssistantChatModel) async throws {
        for _ in 0..<400 where model.isStreaming {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(!model.isStreaming)
    }

    private func agentBodies(_ server: StubBackendServer) -> [JSONValue] {
        server.recorded.filter { $0.path == "/api/agent" }.compactMap(\.body)
    }

    private func model(_ server: StubBackendServer) -> AssistantChatModel {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return AssistantChatModel(
            backend: server.backend,
            baseURL: URL(string: "https://\(server.host)"),
            session: URLSession(configuration: configuration),
            tokenProvider: { "test-token" }
        )
    }

    @Test
    func retryAndContinueResumeTheSameTurnWithoutANewUserMessage() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes["/api/agent"] = .object(["ok": .bool(false), "error": .string("busy")])
        server.statuses["/api/agent"] = 500
        let chat = model(server)

        chat.send("Create the launch doc")
        try await waitUntilIdle(chat)
        #expect(chat.canRetry)
        let userID = try #require(chat.messages.first(where: { $0.role == .user })?.id)

        server.statuses["/api/agent"] = 200
        chat.retryLastTurn()
        try await waitUntilIdle(chat)
        chat.continueResponse()
        try await waitUntilIdle(chat)

        // One user message in the whole exchange.
        #expect(chat.messages.filter { $0.role == .user }.count == 1)
        let bodies = agentBodies(server)
        #expect(bodies.count == 3)
        #expect(bodies[0]["continuation"] == nil)
        for body in bodies.dropFirst() {
            #expect(body["continuation"] == .bool(true))
            // The latest user message is the original, so the server reuses its run.
            let users = (body["messages"]?.arrayValue ?? []).filter { $0["role"] == .string("user") }
            #expect(users.count == 1)
            #expect(users.last?["id"] == .string(userID))
        }
    }

    @Test
    func aNewSendIsNotAContinuation() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes["/api/agent"] = .object([:])
        let chat = model(server)
        chat.send("First")
        try await waitUntilIdle(chat)
        chat.continueResponse()
        try await waitUntilIdle(chat)
        chat.send("Second")
        try await waitUntilIdle(chat)
        let bodies = agentBodies(server)
        #expect(bodies.map { $0["continuation"] } == [nil, .bool(true), nil])
    }

    @Test
    func everyAgentRequestNamesTheClientPlatform() throws {
        let chat = AssistantChatModel(backend: BackendClient(baseURL: nil), baseURL: nil)
        let body = try chat.requestBody()
        #if os(macOS)
        #expect(body["clientPlatform"] == .string("macos"))
        #else
        #expect(body["clientPlatform"] == .string("ios"))
        #endif
    }

    @Test
    func aToolInputErrorShowsTheRealError() {
        let chat = AssistantChatModel(backend: BackendClient(baseURL: nil), baseURL: nil)
        let reply = chat.appendAssistantReply()
        chat.apply(event: .object([
            "type": .string("tool-input-start"),
            "toolCallId": .string("c1"),
            "toolName": .string("calendar_create_event"),
        ]), to: reply)
        chat.apply(event: .object([
            "type": .string("tool-input-error"),
            "toolCallId": .string("c1"),
            "toolName": .string("calendar_create_event"),
            "errorText": .string("startIso is required"),
        ]), to: reply)
        let rows = chat.messages.last?.parts.compactMap { part -> AssistantToolRow? in
            if case .toolRow(let row) = part { return row }
            return nil
        } ?? []
        #expect(rows.count == 1)
        #expect(rows.first?.state == .failed)
        #expect(rows.first?.errorText == "startIso is required")
    }

    @Test
    func theSenderNoteFieldStartsWithTheSavedNote() {
        let saved: JSONValue = .object(["memory": .object(["email": .string("a@b.c"), "notes": .string("Prefers mornings")])])
        #expect(AssistantShapeActions.savedNote(from: saved) == "Prefers mornings")
        #expect(AssistantShapeActions.savedNote(from: .object(["memory": .null])) == nil)
        #expect(AssistantShapeActions.savedNote(from: nil) == nil)
    }

    private func parse(_ tool: String, _ payload: JSONValue, summary: String? = nil) -> AssistantToolCard? {
        var output: [String: JSONValue] = ["ok": .bool(true), "payload": payload]
        if let summary { output["summary"] = .string(summary) }
        return AssistantToolCard.parse(toolName: tool, output: .object(output))
    }

    @Test
    func theSixDisplayCardsParseIntoNativeCards() {
        guard case .media(let video) = parse("show_video", .object([
            "src": .string("https://cdn.example.com/a.mp4"), "title": .string("Demo"),
            "poster": .string("https://cdn.example.com/a.jpg"),
        ])) else { Issue.record("video"); return }
        #expect(video.isVideo && video.title == "Demo" && video.artwork != nil)

        guard case .media(let audio) = parse("show_audio", .object([
            "src": .string("https://cdn.example.com/a.mp3"),
        ])) else { Issue.record("audio"); return }
        #expect(!audio.isVideo)
        // Only web links play.
        if case .media = parse("show_audio", .object(["src": .string("javascript:alert(1)")])) {
            Issue.record("A non-web URL must not become a player")
        }

        guard case .code(let code) = parse("show_code", .object([
            "code": .string("let a = 1"), "language": .string("swift"), "filename": .string("a.swift"),
        ])) else { Issue.record("code"); return }
        #expect(code.filename == "a.swift" && code.code == "let a = 1")

        guard case .carousel(let carousel) = parse("show_carousel", .object([
            "title": .string("Options"),
            "items": .array([.object(["name": .string("One"), "subtitle": .string("First")])]),
        ])) else { Issue.record("carousel"); return }
        #expect(carousel.items.map(\.name) == ["One"])

        guard case .order(let order) = parse("show_order_summary", .object([
            "items": .array([.object(["name": .string("Cable"), "quantity": .number(2), "unitPrice": .number(5)])]),
            "pricing": .object(["subtotal": .number(10), "total": .number(10.8), "tax": .number(0.8), "currency": .string("USD")]),
        ])) else { Issue.record("order"); return }
        #expect(order.lines.first?.quantity == 2)
        #expect(order.total == 10.8)
        #expect(order.currency == "USD")

        guard case .socialPost(let post) = parse("show_social_post", .object([
            "network": .string("linkedin"),
            "post": .object([
                "author": .object(["name": .string("Sam")]),
                "text": .string("Hello"),
                "stats": .object(["likes": .number(4)]),
            ]),
        ])) else { Issue.record("social"); return }
        #expect(post.network == "linkedin" && post.authorName == "Sam" && post.likes == 4)
    }

    @Test
    func aFailedMapDecodeKeepsItsOwnTitleNotWeather() {
        let card = parse("show_map", .object(["markers": .string("not a list")]), summary: "Three coffee shops")
        guard case .summary(let tool, let text) = card else {
            Issue.record("Expected a summary fallback, got \(String(describing: card))")
            return
        }
        #expect(tool == "show_map")
        #expect(text == "Three coffee shops")
        #expect(AssistantToolCard.displayName("show_map") == "Map")
        #expect(AssistantToolCard.displayName("show_terminal") == "Terminal output")
        #expect(AssistantToolCard.displayName("show_something_new") == "Something new")
        // Weather still falls back to its weather line.
        if case .weather = parse(
            "show_weather",
            .object(["locationName": .string("Rochester"), "forecast": .string("not a list")]),
            summary: "Sunny"
        ) {
        } else {
            Issue.record("Weather keeps its fallback card")
        }
    }
}
