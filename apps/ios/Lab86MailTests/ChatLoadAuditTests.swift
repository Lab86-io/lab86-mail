import Foundation
import Testing
@testable import Lab86Mail

// The load audit of the chat (C1, C2, C6, C7, C8, C10): the reply id from
// the stream, the idle watchdog, the detached thread reply, the upload that
// keeps the draft, and the two caches.
@MainActor
struct ChatLoadAuditTests {
    private func event(_ name: String, _ fields: [String: JSONValue] = [:]) -> JSONValue {
        .object(fields.merging(["type": .string(name)]) { _, latest in latest })
    }

    private func model(_ server: StubBackendServer, sessionID: String? = nil) -> AssistantChatModel {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return AssistantChatModel(
            backend: server.backend,
            baseURL: URL(string: "https://\(server.host)"),
            sessionID: sessionID,
            session: URLSession(configuration: configuration),
            tokenProvider: { "test-token" }
        )
    }

    private func waitUntilIdle(_ model: AssistantChatModel) async throws {
        for _ in 0..<400 where model.isStreaming || model.isUploading {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(!model.isStreaming)
        #expect(!model.isUploading)
    }

    // MARK: - C2

    @Test
    func theReplyTakesTheServerIDFromTheStartEvent() throws {
        let chat = AssistantChatModel(backend: BackendClient(baseURL: nil), baseURL: nil, sessionID: "work-w-course")
        let reply = chat.appendAssistantReply()
        chat.apply(event: event("start", ["messageId": .string("srv-1"), "messageMetadata": .object(["createdAt": .number(1_000)])]), to: reply)
        // Later events still arrive under the id this client made.
        chat.apply(event: event("text-delta", ["delta": .string("Hello")]), to: reply)
        let message = try #require(chat.messages.last)
        #expect(message.id == "srv-1")
        #expect(message.text == "Hello")
        #expect(message.createdAt == Date(timeIntervalSince1970: 1))
        #expect(chat.transcriptJSON().arrayValue?.first?["id"] == .string("srv-1"))
        #expect(!chat.messages.contains { $0.id == reply })
        // A second start with the same id changes nothing.
        chat.apply(event: event("start", ["messageId": .string("srv-1")]), to: reply)
        #expect(chat.messages.count == 1)
        chat.stop()
    }

    @Test
    func aStartWithoutAnIDKeepsTheLocalOne() {
        let chat = AssistantChatModel(backend: BackendClient(baseURL: nil), baseURL: nil)
        let reply = chat.appendAssistantReply()
        chat.apply(event: event("start"), to: reply)
        chat.apply(event: event("text-delta", ["delta": .string("Hi")]), to: reply)
        #expect(chat.messages.last?.id == reply)
        chat.stop()
    }

    // MARK: - C6 and C1

    @Test
    func theWatchdogReadsTheIdleLimitAndTheTransportErrors() {
        let start = Date(timeIntervalSince1970: 100)
        #expect(!AssistantChatModel.streamIsStalled(lastEventAt: start, now: start.addingTimeInterval(44)))
        #expect(AssistantChatModel.streamIsStalled(lastEventAt: start, now: start.addingTimeInterval(46)))
        #expect(AssistantChatModel.streamIdleLimit == 45)
        #expect(AssistantChatModel.isTransportError(URLError(.networkConnectionLost)))
        #expect(!AssistantChatModel.isTransportError(BackendError.configuration))
        #expect(URLError(.cancelled).isCancellation)
        #expect(!URLError(.networkConnectionLost).isCancellation)
    }

    @Test
    func aServerErrorOnAThreadReplyIsNotDetached() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes["/api/agent"] = .object(["ok": .bool(false)])
        server.statuses["/api/agent"] = 500
        let chat = model(server, sessionID: "work-w-course")
        chat.send("Register me")
        try await waitUntilIdle(chat)
        #expect(!chat.needsServerCopy)
        #expect(chat.canRetry)
        #expect(chat.errorMessage != AssistantChatModel.detachedReplyText)
    }

    // MARK: - C10

    @Test
    func aFailedUploadKeepsTheDraftAndOffersNoStaleRetry() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes["/api/agent/uploads"] = .object(["ok": .bool(false), "error": .string("Too large")])
        server.statuses["/api/agent/uploads"] = 500
        server.routes["/api/agent"] = .object([:])
        let chat = model(server)
        let file = ComposeAttachment(filename: "notes.txt", contentType: "text/plain", data: Data("hello".utf8))
        let started = await chat.sendDraft("Read this", attachments: [file])
        #expect(!started)
        #expect(chat.messages.isEmpty)
        #expect(!chat.canRetry)
        #expect(!chat.isUploading)
        #expect(chat.errorMessage?.hasPrefix("Could not upload the file") == true)
        #expect(server.recorded.filter { $0.path == "/api/agent" }.isEmpty)

        // The same draft sends once the upload lands.
        server.statuses["/api/agent/uploads"] = 200
        server.routes["/api/agent/uploads"] = .object(["uploads": .array([.object(["uploadId": .string("u1"), "name": .string("notes.txt")])])])
        let sent = await chat.sendDraft("Read this", attachments: [file])
        #expect(sent)
        try await waitUntilIdle(chat)
        #expect(chat.messages.first?.text == "Read this")
        #expect(chat.messages.first?.files.map(\.url) == ["/api/agent/uploads/u1"])
        // The stub answers with no tokens: the turn retries once, then says so.
        #expect(chat.errorMessage == AssistantChatModel.emptyReplyText)
    }

    @Test
    func aPlainSendStartsAtOnce() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes["/api/agent"] = .object([:])
        let chat = model(server)
        let sent = await chat.sendDraft("  Plan the week  ")
        #expect(sent)
        #expect(chat.messages.first?.text == "Plan the week")
        let empty = await chat.sendDraft("   ")
        #expect(!empty)
        try await waitUntilIdle(chat)
        #expect(AssistantChatModel.uploadErrorText(count: 2, detail: "Too large") == "Could not upload the 2 files: Too large")
    }

    // MARK: - C8

    @Test
    func thePartialInputParsesOncePerRowAndLength() throws {
        PartialInputCache.shared.removeAll()
        let text = "{\"query\":\"lake"
        let first = try #require(AssistantToolGrammar.partialInput(from: text, cacheKey: "c1"))
        #expect(first["query"]?.stringValue == "lake")
        #expect(PartialInputCache.shared.entry(for: "c1", length: text.count) != nil)
        #expect(PartialInputCache.shared.entry(for: "c1", length: text.count + 1) == nil)
        let second = AssistantToolGrammar.partialInput(from: text, cacheKey: "c1")
        #expect(second == first)
        let longer = try #require(AssistantToolGrammar.partialInput(from: text + " house", cacheKey: "c1"))
        #expect(longer["query"]?.stringValue == "lake house")
        #expect(PartialInputCache.shared.entry(for: "c1", length: text.count) == nil)
        // Without a key nothing is kept.
        #expect(AssistantToolGrammar.partialInput(from: "{\"a\":\"b")?["a"]?.stringValue == "b")
        #expect(PartialInputCache.shared.count == 1)
        let row = AssistantToolRow(callID: "c2", toolName: "search_threads", inputText: "{\"query\":\"pier")
        #expect(row.sentence.contains("pier"))
        #expect(PartialInputCache.shared.entry(for: "c2", length: row.inputText.count) != nil)
    }

    // MARK: - C7

    @Test
    func theRevealSplitCacheMatchesTheFullSplitAsTheTextGrows() {
        var cache = RevealSplit.Cache()
        let steps = [
            "Hello",
            "Hello world",
            "Hello world\n\nNext para",
            "Hello world\n\nNext para``",
            "Hello world\n\nNext para```swift\nlet a",
            "Hello world\n\nNext para```swift\nlet a = 1\n```\n\nAfter the code",
            "Hello world\n\nNext para```swift\nlet a = 1\n```\n\nAfter the code\n- one\n- two",
        ]
        for step in steps {
            let cached = cache.split(step)
            #expect(cached == RevealSplit.split(step), "\(step)")
        }
        // A text that does not extend the previous one starts over.
        let fresh = cache.split("Brand new ```code")
        #expect(fresh == RevealSplit.split("Brand new ```code"))
        #expect(RevealSplit.fenceCount(in: "a```b```c") == 2)

        // A scan that ends in a closed fence, then one more backtick: the
        // four backticks are one fence, not two.
        var seam = RevealSplit.Cache()
        let closed = "Intro\n\n```\ncode\n```"
        #expect(seam.split(closed) == RevealSplit.split(closed))
        let extra = closed + "`\n\nAfter"
        #expect(seam.split(extra) == RevealSplit.split(extra))
        let more = extra + " words"
        #expect(seam.split(more) == RevealSplit.split(more))
    }

    @Test
    func theHeadingStyleScalesWithTheTextSize() {
        let base = ChatMarkdownStyle.config(for: .serif, dynamicTypeSize: .large)
        let large = ChatMarkdownStyle.config(for: .serif, dynamicTypeSize: .accessibility3)
        #expect(ChatMarkdownStyle.config(for: .serif, dynamicTypeSize: .large) == base)
        #if os(iOS)
        #expect(large.headingStyle.h1Font.normal.pointSize > base.headingStyle.h1Font.normal.pointSize)
        #expect(ChatMarkdownStyle.headingScale(for: .accessibility3, size: 28) > 1)
        #expect(ChatMarkdownStyle.contentSizeCategory(for: .accessibility3) == .accessibilityExtraLarge)
        #expect(ChatMarkdownStyle.contentSizeCategory(for: .large) == .large)
        #else
        #expect(large == base)
        #endif
        #expect(ChatMarkdownStyle.headingScale(for: .large, size: 28) == 1)
    }
}
