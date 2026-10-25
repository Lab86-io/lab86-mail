import Foundation
import Testing
@testable import Lab86Mail

// The crash audit of the chat: the recorder's input format check, the slider
// value text, the unknown `ask_*` fallback, the gated-tool list, and the
// approval text that survives a reopen.
@MainActor
struct ChatCrashAuditTests {
    private func event(_ name: String, _ fields: [String: JSONValue] = [:]) -> JSONValue {
        .object(fields.merging(["type": .string(name)]) { _, latest in latest })
    }

    private func questions(_ chat: AssistantChatModel) -> [AssistantQuestionPart] {
        chat.messages.flatMap(\.parts).compactMap { part in
            if case .question(let question) = part { return question }
            return nil
        }
    }

    private func approvals(_ chat: AssistantChatModel) -> [AssistantInlineApproval] {
        chat.messages.flatMap(\.parts).compactMap { part in
            if case .approval(let approval) = part { return approval }
            return nil
        }
    }

    @Test
    func theRecorderRefusesAnEmptyInputFormat() {
        #expect(CaptureVoiceCoordinator.inputFormatIsUsable(sampleRate: 48_000, channelCount: 1))
        #expect(!CaptureVoiceCoordinator.inputFormatIsUsable(sampleRate: 0, channelCount: 1))
        #expect(!CaptureVoiceCoordinator.inputFormatIsUsable(sampleRate: 44_100, channelCount: 0))
        #expect(!CaptureVoiceCoordinator.unusableInputText.isEmpty)
    }

    @Test
    func theSliderValueNeverConvertsWhatIntCannotHold() {
        #expect(SliderValueText.make(25, unit: nil) == "25")
        #expect(SliderValueText.make(25, unit: "min") == "25 min")
        #expect(SliderValueText.make(2.5, unit: nil) == "2.5")
        #expect(SliderValueText.make(.infinity, unit: nil) == "inf")
        #expect(SliderValueText.make(-.infinity, unit: "km") == "-inf km")
        #expect(SliderValueText.make(1e18, unit: nil).hasSuffix(".0"))
        #expect(SliderValueText.make(.nan, unit: nil) == "nan")
    }

    @Test
    func anUnknownAskToolShowsACardThatCanSkip() throws {
        let chat = AssistantChatModel(backend: BackendClient(baseURL: nil), baseURL: nil)
        let reply = chat.appendAssistantReply()
        chat.apply(event: event("tool-input-start", ["toolCallId": .string("p1"), "toolName": .string("ask_presentation_choices")]), to: reply)
        chat.apply(event: event("tool-input-available", [
            "toolCallId": .string("p1"), "toolName": .string("ask_presentation_choices"),
            "input": .object(["stage": .string("brief"), "presentationId": .string("deck-1")]),
        ]), to: reply)
        let question = try #require(questions(chat).first)
        #expect(question.kind == .unknown)
        #expect(question.toolName == "ask_presentation_choices")
        #expect(!question.isAnswered)
        #expect(chat.messages.last?.toolRows.isEmpty == true)

        // The saved part keeps the server's tool name, and it comes back the same.
        let saved = AssistantChatModel.questionPartJSON(question)
        #expect(saved["toolName"] == .string("ask_presentation_choices"))
        #expect(saved["state"] == .string("input-available"))
        let restored = try #require(AssistantChatModel.message(from: .object([
            "id": .string("m"), "role": .string("assistant"), "parts": .array([saved]),
        ])))
        guard case .question(let again)? = restored.parts.first else {
            Issue.record("Expected the question back")
            return
        }
        #expect(again.kind == .unknown)
        #expect(again.toolName == "ask_presentation_choices")

        // Known kinds keep their names; approvals are not questions.
        #expect(AssistantQuestionPart.kind(forToolName: "ask_form") == .form)
        #expect(AssistantQuestionPart.kind(forToolName: "ask_approval") == nil)
        #expect(AssistantQuestionPart.kind(forToolName: "search_threads") == nil)
        #expect(UnsupportedQuestionCard.skippedAnswer["skipped"] == .bool(true))
        #expect(UnsupportedQuestionCard.skippedAnswer["reason"]?.stringValue?.isEmpty == false)
        chat.stop()
    }

    @Test
    func theGatedToolsMatchTheServerList() {
        let server: Set<String> = [
            "schedule_send", "calendar_create_event", "calendar_update_event", "calendar_delete_event",
            "calendar_delete_recurring_series", "calendar_rsvp_event", "cancel_scheduled", "delete_draft",
            "delete_smart_label", "forget", "calendar_unsubscribe_calendar", "tasks_delete_board",
            "tasks_delete_column", "unsubscribe_sender",
        ]
        #expect(AssistantInlineApproval.gatedTools == server)
        #expect(AssistantInlineApproval.destructiveGatedTools.isSubset(of: server))
        #expect(!AssistantInlineApproval.destructiveGatedTools.contains("schedule_send"))
        #expect(AssistantInlineApproval.destructiveGatedTools.contains("forget"))
        for tool in server {
            let title = AssistantInlineApproval.gatedTitle(toolName: tool, input: .object([:]))
            #expect(!title.isEmpty && title != "Approve this step", "\(tool)")
        }
        #expect(AssistantInlineApproval.gatedTitle(toolName: "delete_smart_label", input: .object(["name": .string("Receipts")])) == "Delete the label “Receipts”")
        #expect(AssistantInlineApproval.gatedTitle(toolName: "unsubscribe_sender", input: .object(["email": .string("news@example.com")])) == "Unsubscribe from news@example.com")
        #expect(AssistantInlineApproval.gatedTitle(toolName: "calendar_rsvp_event", input: .object(["title": .string("Standup")])) == "Answer the invitation to “Standup”")
    }

    @Test
    func aGatedCallOnANewToolMakesADestructiveCard() throws {
        let chat = AssistantChatModel(backend: BackendClient(baseURL: nil), baseURL: nil)
        let reply = chat.appendAssistantReply()
        chat.apply(event: event("tool-input-start", ["toolCallId": .string("c1"), "toolName": .string("tasks_delete_board")]), to: reply)
        chat.apply(event: event("tool-input-available", [
            "toolCallId": .string("c1"), "toolName": .string("tasks_delete_board"), "input": .object(["name": .string("Launch")]),
        ]), to: reply)
        chat.apply(event: event("tool-approval-request", ["toolCallId": .string("c1"), "approvalId": .string("ap1")]), to: reply)
        let approval = try #require(approvals(chat).first)
        #expect(approval.title == "Delete the board “Launch”")
        #expect(approval.destructive)
        #expect(chat.messages.last?.toolRows.isEmpty == true)
        chat.stop()
    }

    @Test
    func theApprovalTextSurvivesAReopen() throws {
        let chat = AssistantChatModel(backend: BackendClient(baseURL: nil), baseURL: nil, sessionID: "work-w-1")
        let reply = chat.appendAssistantReply()
        chat.apply(event: event("tool-input-start", ["toolCallId": .string("c1"), "toolName": .string("calendar_create_event")]), to: reply)
        chat.apply(event: event("tool-input-available", [
            "toolCallId": .string("c1"), "toolName": .string("calendar_create_event"), "input": .object(["title": .string("Standup")]),
        ]), to: reply)
        chat.apply(event: event("tool-approval-request", ["toolCallId": .string("c1"), "approvalId": .string("ap1")]), to: reply)
        chat.apply(event: event("data-tool-approval", [
            "id": .string("c1"),
            "data": .object([
                "title": .string("Send invitations for “Standup”"),
                "description": .string("This emails an invitation to each attendee."),
                "confirmLabel": .string("Send invitations"),
                "intent": .string("default"),
            ]),
        ]), to: reply)
        let saved = try #require(chat.transcriptJSON(includeDisplayParts: true).arrayValue?.first)
        let types = saved["parts"]?.arrayValue?.compactMap { $0["type"]?.stringValue } ?? []
        #expect(types.contains("data-tool-approval"))
        // The agent request never carries the display part.
        #expect(!(chat.transcriptJSON().arrayValue?.first?["parts"]?.arrayValue ?? []).contains { $0["type"]?.stringValue == "data-tool-approval" })

        let restored = try #require(AssistantChatModel.message(from: saved))
        guard case .approval(let approval)? = restored.parts.first else {
            Issue.record("Expected the approval back")
            return
        }
        #expect(approval.description == "This emails an invitation to each attendee.")
        #expect(approval.confirmLabel == "Send invitations")
        #expect(approval.decision == nil)

        // The web may save the summary before the call.
        let parts = saved["parts"]?.arrayValue ?? []
        let reversed = try #require(AssistantChatModel.message(from: .object([
            "id": .string("m2"), "role": .string("assistant"), "parts": .array(parts.reversed()),
        ])))
        guard case .approval(let early)? = reversed.parts.first else {
            Issue.record("Expected the approval back")
            return
        }
        #expect(early.confirmLabel == "Send invitations")
        chat.stop()
    }
}
