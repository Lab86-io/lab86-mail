import Foundation
import Testing
import UniformTypeIdentifiers
@testable import Lab86Mail

// Phase 2 of the chat: files the model can read, app links, the full work
// line grammar, the web's duration format, and the empty reply retry.
@MainActor
struct ChatPhaseTwoTests {
    private func event(_ name: String, _ fields: [String: JSONValue] = [:]) -> JSONValue {
        .object(fields.merging(["type": .string(name)]) { _, latest in latest })
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

    private func waitUntilIdle(_ model: AssistantChatModel) async throws {
        for _ in 0..<400 where model.isStreaming || model.isUploading {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(!model.isStreaming)
    }

    private func agentBodies(_ server: StubBackendServer) -> [JSONValue] {
        server.recorded.filter { $0.path == "/api/agent" }.compactMap(\.body)
    }

    // MARK: - Files

    @Test
    func aFilePartRoundTripsThroughHistory() throws {
        let saved: JSONValue = .object([
            "id": .string("u1"), "role": .string("user"),
            "parts": .array([
                .object(["type": .string("text"), "text": .string("Read this")]),
                .object(["type": .string("file"), "mediaType": .string("text/plain"), "url": .string("/api/agent/uploads/abc_1"), "filename": .string("notes.txt")]),
                .object(["type": .string("file"), "url": .string("data:image/png;base64,AAAA")]),
                .object(["type": .string("file"), "mediaType": .string("text/plain")]),
            ]),
        ])
        let message = try #require(AssistantChatModel.message(from: saved))
        #expect(message.files.count == 2)
        #expect(message.files[0].filename == "notes.txt")
        #expect(message.files[0].uploadID == "abc_1")
        #expect(message.files[1].filename == ChatAttachmentRules.defaultFilename)
        #expect(message.files[1].mediaType == ChatAttachmentRules.defaultMediaType)
        #expect(message.files[1].uploadID == nil)
        #expect(message.text == "Read this")
        // A file is content; the reply grouping leaves it to the user's turn.
        let fileOnly = AssistantChatMessage(id: "m", role: .user, parts: [.file(message.files[0])])
        #expect(!fileOnly.isVisuallyEmpty)
        #expect(AssistantWorkLog.group(parts: fileOnly.parts).isEmpty)
        #expect(message.files[0].json["type"] == .string("file"))
        #expect(message.files[0].json["url"] == .string("/api/agent/uploads/abc_1"))
    }

    @Test
    func anUploadSendsFilePartsTheModelReads() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes["/api/agent/uploads"] = .object([
            "uploads": .array([.object([
                "uploadId": .string("u9"), "name": .string("notes.txt"),
                "contentType": .string("text/plain"), "size": .number(5),
            ])]),
        ])
        server.routes["/api/agent"] = .object([:])
        let chat = model(server)
        let file = ComposeAttachment(filename: "notes.txt", contentType: "text/plain", data: Data("hello".utf8))
        let sent = await chat.sendDraft("", attachments: [file])
        #expect(sent)
        try await waitUntilIdle(chat)

        let user = try #require(chat.messages.first { $0.role == .user })
        #expect(user.text == AssistantChatModel.attachedFilesText)
        let part = try #require(user.files.first)
        #expect(part.url == "/api/agent/uploads/u9")
        #expect(part.mediaType == "text/plain")
        #expect(part.size == 5)
        #expect(ChatAttachmentCache.shared.url(for: "u9") != nil)

        let body = try #require(agentBodies(server).first)
        let parts = body["messages"]?.arrayValue?.first?["parts"]?.arrayValue ?? []
        let filePart = try #require(parts.first { $0["type"] == .string("file") })
        #expect(filePart["url"] == .string("/api/agent/uploads/u9"))
        #expect(filePart["filename"] == .string("notes.txt"))
        #expect(body["extraSystem"]?.stringValue?.contains("chatUploadId=u9") == true)
        #expect(body["extraSystem"]?.stringValue?.contains("(text/plain, 5 bytes)") == true)
    }

    @Test
    func theAttachmentRulesMatchTheWeb() {
        #expect(ChatAttachmentRules.mediaType(filename: "a.PDF", declared: nil) == "application/pdf")
        #expect(ChatAttachmentRules.mediaType(filename: "a.heic", declared: "image/heic") == nil)
        #expect(ChatAttachmentRules.mediaType(filename: "photo", declared: "image/png") == "image/png")
        #expect(ChatAttachmentRules.mediaType(filename: "deck.pptx", declared: "application/octet-stream")
            == "application/vnd.openxmlformats-officedocument.presentationml.presentation")
        #expect(ChatAttachmentRules.uploadID(from: "/api/agent/uploads/abc-1_2") == "abc-1_2")
        #expect(ChatAttachmentRules.uploadID(from: "/api/agent/uploads/") == nil)
        #expect(ChatAttachmentRules.uploadID(from: "/api/agent/uploads/a/b") == nil)
        #expect(ChatAttachmentRules.uploadID(from: "data:image/png;base64,AAAA") == nil)
        #expect(ChatAttachmentRules.uploadPath("u 1") == "/api/agent/uploads/u%201")
        #expect(ChatAttachmentRules.uploadContextLine(name: "a.txt", contentType: "text/plain", size: 12, uploadID: "u1")
            == "- a.txt (text/plain, 12 bytes): chatUploadId=u1")
        let small = ComposeAttachment(filename: "a.txt", contentType: "text/plain", data: Data("a".utf8))
        #expect(ChatAttachmentRules.validationError([small]) == nil)
        #expect(ChatAttachmentRules.validationError(Array(repeating: small, count: 6)) == "Attach at most 5 files per message.")
        #expect(ChatAttachmentRules.validationError([ComposeAttachment(filename: "e.txt", contentType: "text/plain", data: Data())])
            == "e.txt is empty. Choose a file with content.")
        #expect(ChatAttachmentRules.validationError([ComposeAttachment(filename: "x.heic", contentType: "image/heic", data: Data("a".utf8))])?
            .hasPrefix("x.heic is not supported.") == true)
        #expect(!ChatAttachmentRules.sizeText(1_200).isEmpty)
        #expect(AssistantComposerFiles.fits(small, with: []))
        #expect(!AssistantComposerFiles.fits(small, with: Array(repeating: small, count: 5)))
    }

    @Test
    func aPhotoKeepsItsTypeWhenTheServerTakesIt() {
        let bytes = Data([0x89, 0x50, 0x4E, 0x47])
        let png = PhotoAttachment.attachment(data: bytes, declaredType: .png, index: 2)
        #expect(png?.filename == "Photo 2.png")
        #expect(png?.contentType == "image/png")
        #expect(png?.data == bytes)
        // Bytes that are not an image cannot become a JPEG.
        #expect(PhotoAttachment.attachment(data: Data("text".utf8), declaredType: nil, index: 1) == nil)
        #expect(ComposerAttachSource.available.contains(.files))
        #expect(ComposerAttachSource.available.contains(.photos))
        #expect(ComposerAttachSource.camera.label == "Camera")
    }

    // MARK: - App links

    @Test
    func appLinksOpenInTheAppAndTheRestOutside() {
        #expect(AppLinks.appPath(for: "https://mail.lab86.io/?view=files&file=abc") == "/?view=files&file=abc")
        #expect(AppLinks.appPath(for: "https://mail.lab86.io/work/w1") == "/work/w1")
        #expect(AppLinks.appPath(for: "/?view=mail") == "/?view=mail")
        #expect(AppLinks.appPath(for: "lab86://open/mail") == "lab86://open/mail")
        #expect(AppLinks.appPath(for: "mailto:sam@example.com") == "mailto:sam@example.com")
        let navigation = NavigationModel()
        #expect(!AppLinks.open("https://example.com/report", navigation: navigation))
        #expect(!NavigationModel.isAppLink("https://example.com/report"))
        #expect(NavigationModel.isAppLink("/?view=files&file=abc"))
        #expect(AppLinks.open("/?view=mail", navigation: navigation))
    }

    // MARK: - The grammar

    /// The keys of `TOOL_SENTENCES` in lib/albatross/teach-ui.ts.
    static let webToolNames = [
        "enable_tools", "corpus_search", "mcp_search", "mcp_list_items", "corpus_count", "thread_timeline",
        "sender_profile", "area_domain_activity", "area_discover_context", "area_artifact_set_status",
        "mcp_connection_status", "area_list", "area_create", "area_archive", "area_add_fact", "area_fact_set_status",
        "salvage_context", "ask_user", "ask_approval", "ask_parameters", "ask_preferences", "ask_question_flow",
        "ask_presentation_choices", "show_weather", "show_chart", "show_stats", "show_table", "show_code",
        "show_code_diff", "show_terminal", "show_plan", "show_progress", "show_citations", "show_link_preview",
        "show_image", "show_image_gallery", "show_video", "show_audio", "show_map", "show_carousel",
        "show_order_summary", "show_social_post", "show_message_draft", "search_threads", "nl_search", "get_thread",
        "get_message", "list_account_threads", "list_accounts", "list_labels", "list_attachments",
        "mail_attachment_save", "archive_thread", "trash_thread", "restore_from_trash", "mark_read", "mark_unread",
        "star", "unstar", "add_label", "remove_label", "create_label", "mute_thread", "snooze_thread",
        "unsnooze_thread", "save_draft", "update_draft", "delete_draft", "list_drafts", "send_message", "reply",
        "reply_all", "forward", "schedule_send", "cancel_scheduled", "undo_send", "summarize_thread", "triage_thread",
        "draft_reply", "presentation_plan", "document_create", "document_review_slides", "word_document_create",
        "word_document_get", "word_document_edit", "document_list", "document_get", "document_edit",
        "document_suggest_changes", "document_apply_instruction", "document_publish_google", "document_export",
        "cloud_file_search", "google_file_import", "bulk_triage", "extract_action_items", "translate_thread",
        "pre_send_critique", "remember", "recall", "forget", "list_memories", "albatross_handle_step",
        "personal_details_get", "personal_details_save", "secure_details_list", "pdf_form_fields", "pdf_form_fill",
        "ask_secure_detail", "calendar_free_busy", "calendar_suggest_times", "calendar_create_event",
        "calendar_list_events", "calendar_update_event", "calendar_delete_event", "calendar_delete_recurring_series",
        "calendar_unsubscribe_calendar", "tasks_list_boards", "tasks_get_board", "tasks_create_board",
        "tasks_create_card", "tasks_update_card", "tasks_move_card", "tasks_delete_card", "tasks_attach_link",
        "tasks_attach_file", "tasks_attach_calendar_event_link", "contact_lookup", "expand_alias",
        "browserbase_search", "browserbase_fetch", "web_research", "web_file_save", "browser_download",
        "ui_focus_thread", "ui_set_query", "ui_open_compose", "ui_open_reply", "ui_toast", "ui_close_bar",
        "ui_switch_account",
    ]

    @Test
    func everyWebToolNameReadsAsASentence() {
        for name in Self.webToolNames {
            let activity = AssistantToolGrammar.sentences(toolName: name, input: .object([:]), output: .object([:]))
            #expect(!AssistantToolGrammar.isGeneric(activity), "\(name)")
            #expect(!activity.done.isEmpty && !activity.running.isEmpty && !activity.failed.isEmpty, "\(name)")
            #expect(!activity.done.contains("_"), "\(name)")
        }
        let generic = AssistantToolGrammar.sentences(toolName: "something_new", input: nil, output: nil)
        #expect(AssistantToolGrammar.isGeneric(generic))
    }

    @Test
    func theWebVariantsOfTheSharedSentencesMatch() throws {
        let mixed = AssistantToolGrammar.sentences(
            toolName: "corpus_search",
            input: .object(["query": .string("invoice")]),
            output: .object(["items": .array([.object(["source": .string("mail")]), .object(["source": .string("mcp")])]), "errors": .array([.string("x")])])
        )
        #expect(mixed.done == "Searched for “invoice” — 1 mail result, 1 connected result; some searches failed")
        #expect(mixed.running == "Searching mail and connected sources for “invoice”")
        let saved = AssistantToolGrammar.sentences(
            toolName: "personal_details_save", input: nil,
            output: .object(["saved": .array([.object(["label": .string("Phone")]), .object(["label": .string("Address")])])])
        )
        #expect(saved.done == "Saved to your details: Phone, Address")
        #expect(AssistantToolGrammar.sentences(toolName: "personal_details_save", input: nil, output: .object([:])).done == "Saved nothing to your details")
        let download = AssistantToolGrammar.sentences(toolName: "browser_download", input: nil, output: .object(["title": .string("W-9.pdf")]))
        #expect(download.done == "Saved W-9.pdf in Files")
        #expect(AssistantToolGrammar.sentences(toolName: "ask_secure_detail", input: .object(["kind": .string("sign_in"), "site": .string("ny.gov")]), output: nil).done == "Asked you to add a sign-in for ny.gov")
        #expect(AssistantToolGrammar.sentences(toolName: "area_fact_set_status", input: .object(["status": .string("rejected")]), output: nil).done == "Fact rejected")
    }

    @Test
    func connectorToolsReadByFamilyAndVerb() throws {
        #expect(AssistantToolGrammar.connectorSentences(toolName: "slack_search_messages")?.done == "Searched Slack")
        #expect(AssistantToolGrammar.connectorSentences(toolName: "jira_get_issue")?.done == "Read Jira")
        #expect(AssistantToolGrammar.connectorSentences(toolName: "atlassian_jira_create_issue")?.done == "Posted to Jira")
        #expect(AssistantToolGrammar.connectorSentences(toolName: "atlassian_confluence_search")?.done == "Searched Confluence")
        #expect(AssistantToolGrammar.connectorSentences(toolName: "bitbucket_list_pull_requests")?.done == "Loaded Bitbucket items")
        #expect(AssistantToolGrammar.connectorSentences(toolName: "bitbucket_add_comment")?.done == "Commented in Bitbucket")
        #expect(AssistantToolGrammar.connectorSentences(toolName: "slack_do_something")?.done == "Worked in Slack")
        #expect(AssistantToolGrammar.connectorSentences(toolName: "search_threads") == nil)
        let viaGrammar = AssistantToolGrammar.sentences(toolName: "slack_search_messages", input: nil, output: nil)
        #expect(!AssistantToolGrammar.isGeneric(viaGrammar))
    }

    // MARK: - Durations

    @Test
    func durationsReadLikeTheWeb() {
        #expect(AssistantWorkLog.durationText(seconds: 0) == "1s")
        #expect(AssistantWorkLog.durationText(seconds: 3) == "3s")
        #expect(AssistantWorkLog.durationText(seconds: 59) == "59s")
        #expect(AssistantWorkLog.durationText(seconds: 60) == "1m")
        #expect(AssistantWorkLog.durationText(seconds: 75) == "1m 15s")
        #expect(AssistantWorkLog.durationText(seconds: 3_605) == "60m 5s")
        let start = Date(timeIntervalSince1970: 100)
        let reasoning = AssistantReasoningPart(id: "r", text: "Check", startedAt: start, endedAt: start.addingTimeInterval(75))
        #expect(reasoning.label == "Thought for 1m 15s")
        #expect(AssistantReasoningPart(id: "r", text: "Check", startedAt: start, endedAt: nil).label == "Thought")
    }

    // MARK: - The empty reply

    @Test
    func anEmptyReplyRunsOnceMoreThenAsksThePerson() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes["/api/agent"] = .object([:])
        let chat = model(server)
        chat.send("Plan the week")
        try await waitUntilIdle(chat)

        var bodies = agentBodies(server)
        #expect(bodies.count == 2)
        #expect(bodies[0]["continuation"] == nil)
        #expect(bodies[1]["continuation"] == .bool(true))
        #expect(chat.messages.count == 1)
        #expect(chat.errorMessage == AssistantChatModel.emptyReplyText)
        #expect(chat.canRetry)
        #expect(!chat.canContinue)

        // Retry is one more turn, with no second automatic retry behind it.
        chat.retryLastTurn()
        try await waitUntilIdle(chat)
        bodies = agentBodies(server)
        #expect(bodies.count == 3)
        #expect(chat.errorMessage == AssistantChatModel.emptyReplyText)
        #expect(chat.messages.count == 1)

        // A fresh send starts the count again.
        chat.send("Again")
        try await waitUntilIdle(chat)
        #expect(agentBodies(server).count == 5)
        #expect(chat.messages.filter { $0.role == .user }.count == 2)
    }

    @Test
    func aServerErrorIsNotAnEmptyReply() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes["/api/agent"] = .object(["ok": .bool(false)])
        server.statuses["/api/agent"] = 500
        let chat = model(server)
        chat.send("Plan the week")
        try await waitUntilIdle(chat)
        #expect(agentBodies(server).count == 1)
        #expect(chat.errorMessage != AssistantChatModel.emptyReplyText)
        #expect(chat.canRetry)
    }
}
