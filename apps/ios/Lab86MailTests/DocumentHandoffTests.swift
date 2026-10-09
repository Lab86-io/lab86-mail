import Foundation
import Testing
@testable import Lab86Mail

// Document mode in the thread (docs/albatross-document-handoff.md, D3 and
// D5): which editor a target names, the handoff a document belongs to, the
// step check with `continue`, and the document the chat carries. The web
// pins the same rules in lib/albatross/document-handoff.ts.
@MainActor
struct DocumentHandoffTests {
    // MARK: - Fixtures: hours for the Harbor Design studio

    private static func run(
        id: String,
        state: StepRunView.State,
        outcome: StepRunView.Outcome? = nil,
        next: StepRunView.Next? = nil,
        artifacts: [StepRunView.Artifact] = []
    ) -> ThreadRunView {
        ThreadRunView(run: StepRunView(
            id: id,
            workID: "work_hours",
            stepKey: "step-hours",
            stepTitle: "Fill in the hours",
            state: state,
            outcome: outcome,
            next: next,
            artifacts: artifacts
        ))
    }

    private static let hoursSheet = StepRunView.Artifact(
        kind: .document,
        referenceID: "doc_hours",
        title: "September hours, Harbor Design",
        url: "/?view=files&office=doc_hours"
    )

    private static let handoffNext = StepRunView.Next(
        kind: .reviewDocument,
        label: "Fill in hours",
        detail: "Fill in the months and hours you worked, the rate, the invoice number and date.",
        target: StepRunView.Target(kind: .document, id: "doc_hours", url: "/?view=files&office=doc_hours")
    )

    // MARK: - The editor a target names

    @Test func theLinkDecidesTheEditor() {
        #expect(DocumentTarget.of(url: "/?view=files&office=doc_1", id: nil) == DocumentTarget(provider: .office, id: "doc_1"))
        #expect(DocumentTarget.of(url: "/?view=files&document=doc_2", id: "other") == DocumentTarget(provider: .albatross, id: "doc_2"))
        // The office link wins over a document link in the same URL.
        #expect(DocumentTarget.of(url: "/?document=a&office=b", id: nil) == DocumentTarget(provider: .office, id: "b"))
        // The old Files link form, on this app only.
        #expect(DocumentTarget.of(url: "/files/doc_4", id: nil) == DocumentTarget(provider: .albatross, id: "doc_4"))
        #expect(DocumentTarget.of(url: "https://evil.example.com/files/doc_5", id: nil) == nil)
        #expect(DocumentTarget.of(url: "https://evil.example.com/files/doc_5", id: "doc_6") == DocumentTarget(provider: .albatross, id: "doc_6"))
        #expect(DocumentTarget.of(url: "/files/doc_7/extra", id: nil) == nil)
        #expect(DocumentTarget.of(url: "/files", id: nil) == nil)
        // A bare id is an Albatross document; a link that is no link falls back to it.
        #expect(DocumentTarget.of(url: nil, id: " doc_8 ") == DocumentTarget(provider: .albatross, id: "doc_8"))
        #expect(DocumentTarget.of(url: "not a url at all", id: "doc_9") == DocumentTarget(provider: .albatross, id: "doc_9"))
        #expect(DocumentTarget.of(url: "/?view=files&office=", id: nil) == nil)
        #expect(DocumentTarget.of(url: nil, id: nil) == nil)
        #expect(DocumentTarget.of(url: "", id: "") == nil)
    }

    @Test func aLinkOnAnotherSiteNeverNamesADocument() {
        // An absolute link, or a protocol-relative one, is not inside the app:
        // its query and path say nothing, and the bare id decides.
        #expect(DocumentTarget.of(url: "https://evil.example/?view=files&document=doc_9", id: nil) == nil)
        #expect(DocumentTarget.of(url: "//evil.example/?office=word_9", id: "doc_own") == DocumentTarget(provider: .albatross, id: "doc_own"))
        #expect(DocumentTarget.of(url: "https://mail.example.com/?view=files&office=doc_3", id: nil) == nil)
        #expect(DocumentTarget.of(url: "https://mail.example.com/?view=files&office=doc_3", id: "doc_own") == DocumentTarget(provider: .albatross, id: "doc_own"))
        #expect(DocumentTarget.of(url: "mailto:someone@example.com?document=doc_9", id: nil) == nil)
        // A relative link is inside the app.
        #expect(DocumentTarget.of(url: "?office=word_2", id: nil) == DocumentTarget(provider: .office, id: "word_2"))
        #expect(DocumentTarget.of(url: "/?view=files&document=doc_2", id: nil) == DocumentTarget(provider: .albatross, id: "doc_2"))
        #expect(DocumentTarget.of(url: "/files/doc%202", id: nil) == DocumentTarget(provider: .albatross, id: "doc 2"))
    }

    @Test func theWorkspaceDestinationFollowsTheProvider() {
        #expect(DocumentTarget(provider: .office, id: "doc_1").workspaceDestination.path == "/native/files?view=files&office=doc_1")
        #expect(DocumentTarget(provider: .albatross, id: "doc_2").workspaceDestination.path == "/native/files?view=files&document=doc_2")
        #expect(NativeWorkspaceDestination.officeDocument("a b").path == "/native/files?view=files&office=a%20b")
    }

    // MARK: - The handoff a document belongs to

    @Test func theDocumentHandoffIsTheNewestRunThatNamesTheDocument() {
        let target = DocumentTarget(provider: .office, id: "doc_hours")
        let older = Self.run(id: "r1", state: .closed, outcome: .readyForYou, next: Self.handoffNext, artifacts: [Self.hoursSheet])
        let made = Self.run(id: "r2", state: .handedOff, outcome: .readyForYou, next: Self.handoffNext, artifacts: [Self.hoursSheet])
        let other = Self.run(
            id: "r3",
            state: .handedOff,
            outcome: .readyForYou,
            next: StepRunView.Next(kind: .review, target: StepRunView.Target(kind: .url, url: "https://example.com/portal"))
        )
        #expect(DocumentHandoff.run(for: [older, made, other], target: target)?.id == "r2")
        // A closed handoff does not count; nothing waits on the document.
        #expect(DocumentHandoff.run(for: [older], target: target) == nil)
        // The artifact alone names it, with no next target.
        let byArtifact = Self.run(id: "r4", state: .handedOff, outcome: .yourTurn, next: StepRunView.Next(kind: .review), artifacts: [Self.hoursSheet])
        #expect(DocumentHandoff.run(for: [byArtifact], target: target)?.id == "r4")
        // Another document, or a question, is not this handoff.
        #expect(DocumentHandoff.run(for: [made], target: DocumentTarget(provider: .albatross, id: "doc_else")) == nil)
        let asked = Self.run(id: "r5", state: .handedOff, outcome: .needsAnswer, next: Self.handoffNext)
        #expect(DocumentHandoff.run(for: [asked], target: target) == nil)
    }

    @Test func theYourPartTextIsTheHandoffDetail() {
        let made = Self.run(id: "r2", state: .handedOff, outcome: .readyForYou, next: Self.handoffNext)
        #expect(DocumentHandoff.detail(of: made) == "Fill in the months and hours you worked, the rate, the invoice number and date.")
        let quiet = Self.run(id: "r6", state: .handedOff, outcome: .readyForYou, next: StepRunView.Next(kind: .reviewDocument, detail: "  "))
        #expect(DocumentHandoff.detail(of: quiet) == nil)
        #expect(DocumentHandoff.detail(of: nil) == nil)
    }

    @Test func theCopyHasNoIngForms() {
        let words = [
            DocumentHandoffCopy.yourPart, DocumentHandoffCopy.done, DocumentHandoffCopy.backToThread,
            DocumentHandoffCopy.close, DocumentHandoffCopy.chat, DocumentHandoffCopy.placeholder, DocumentHandoffCopy.failed,
        ]
        #expect(DocumentHandoffCopy.done == "Done, continue")
        #expect(DocumentHandoffCopy.placeholder == "Tell Albatross what to put in the document")
        for word in words {
            #expect(!word.lowercased().contains("ing "), "\(word)")
        }
    }

    // MARK: - The step check with continue (D3)

    @Test func theStepRequestCarriesContinue() throws {
        let plain = WorkStepRequest.body(stepKey: "step-hours", timezone: "Europe/Oslo")
        #expect(plain["stepKey"] == .string("step-hours"))
        #expect(plain["timezone"] == .string("Europe/Oslo"))
        #expect(plain["continue"] == nil)
        #expect(plain["note"] == nil)
        let continued = WorkStepRequest.body(stepKey: "step-hours", note: "  Sent the sheet.  ", continues: true, timezone: "Europe/Oslo")
        #expect(continued["continue"] == .bool(true))
        #expect(continued["note"] == .string("Sent the sheet."))
        #expect(WorkStepRequest.body(stepKey: nil, timezone: "UTC")["stepKey"] == nil)

        let started = WorkStepContinuation(json: .object([
            "ok": .bool(true),
            "nextRunId": .string("run_next"),
            "nextStepKey": .string("step-invoice"),
            "allStepsComplete": .bool(false),
        ]))
        #expect(started == WorkStepContinuation(nextRunID: "run_next", nextStepKey: "step-invoice", allStepsComplete: false))
        let ended = WorkStepContinuation(json: .object(["ok": .bool(true), "allStepsComplete": .bool(true)]))
        #expect(ended.nextRunID == nil)
        #expect(ended.allStepsComplete)
        #expect(WorkStepContinuation(json: .object([:])) == WorkStepContinuation())
    }

    // MARK: - The chat carries the open document (D5)

    @Test func theChatRequestNamesTheOpenDocument() throws {
        let chat = AssistantChatModel(
            backend: BackendClient(baseURL: nil),
            baseURL: nil,
            scope: AssistantChatScope(kind: .work, contextID: "work_hours", label: "Hours"),
            sessionID: WorkThreadSession.id(for: "work_hours")
        )
        let closed = try chat.requestBody()["contextAttachments"]?.arrayValue ?? []
        #expect(closed == [.object(["kind": .string("work"), "id": .string("work_hours")])])

        chat.documentAttachment = DocumentTarget(provider: .office, id: "doc_hours").attachment
        let open = try chat.requestBody()["contextAttachments"]?.arrayValue ?? []
        #expect(open.count == 2)
        #expect(open.first?["kind"] == .string("work"))
        #expect(open.last == .object(["kind": .string("document"), "id": .string("doc_hours"), "provider": .string("office")]))

        chat.documentAttachment = nil
        #expect(try chat.requestBody()["contextAttachments"]?.arrayValue?.count == 1)
    }

    @Test func aTurnThatEditedTheDocumentAsksForAReload() {
        func reply(_ tools: [String]) -> AssistantChatMessage {
            AssistantChatMessage(
                id: "m1",
                role: .assistant,
                parts: tools.map { .toolRow(AssistantToolRow(callID: "c-\($0)", toolName: $0)) }
            )
        }
        #expect(DocumentHandoff.turnEditedDocument(reply(["document_get", "document_edit"])))
        #expect(DocumentHandoff.turnEditedDocument(reply(["word_document_edit"])))
        #expect(!DocumentHandoff.turnEditedDocument(reply(["calendar_create_event", "corpus_count"])))
        #expect(!DocumentHandoff.turnEditedDocument(AssistantChatMessage(id: "m2", role: .assistant, text: "Done.")))
        #expect(DocumentHandoff.editsDocument(toolName: "document_create"))
        #expect(!DocumentHandoff.editsDocument(toolName: "documents_more"))
    }

    // MARK: - A target named by id only (runs from before the server filled the link)

    private static let summaryDoc = StepRunView.Artifact(
        kind: .document,
        referenceID: "doc_summary",
        title: "Hours summary, Harbor Design",
        url: "/?view=files&document=doc_summary"
    )

    @Test func anIDWithNoLinkTakesTheLinkOfTheRunFile() {
        let files = [Self.summaryDoc, Self.hoursSheet]
        #expect(DocumentTarget.resolve(url: nil, id: "doc_hours", artifacts: files) == DocumentTarget(provider: .office, id: "doc_hours"))
        #expect(DocumentTarget.resolve(url: "  ", id: "doc_summary", artifacts: files) == DocumentTarget(provider: .albatross, id: "doc_summary"))
        // A link wins; an unknown id stays an Albatross document; nothing names nothing.
        #expect(DocumentTarget.resolve(url: "/?view=files&document=doc_x", id: "doc_hours", artifacts: files) == DocumentTarget(provider: .albatross, id: "doc_x"))
        #expect(DocumentTarget.resolve(url: nil, id: "doc_unknown", artifacts: files) == DocumentTarget(provider: .albatross, id: "doc_unknown"))
        #expect(DocumentTarget.resolve(url: nil, id: nil, artifacts: files) == nil)
    }

    @Test func theHandoffOfAWordFileNamedByIDMatchesItsDocumentMode() {
        let next = StepRunView.Next(
            kind: .reviewDocument,
            label: "Fill in hours",
            detail: "Fill in the hours.",
            target: StepRunView.Target(kind: .document, id: "doc_hours")
        )
        let view = Self.run(id: "run_old", state: .handedOff, outcome: .readyForYou, next: next, artifacts: [Self.summaryDoc, Self.hoursSheet])
        #expect(DocumentHandoff.run(for: [view], target: DocumentTarget(provider: .office, id: "doc_hours"))?.id == "run_old")
    }

    // MARK: - The plan's open questions

    @Test func theThreadShowsPendingQuestionsThatNoRunOwns() {
        let questions = [
            WorkDetail.Question(id: "q_plan", status: "pending", prompt: "Which weeks does the invoice cover?", reason: "No email lists the hours.", options: []),
            WorkDetail.Question(id: "q_run", status: "pending", prompt: "Which rate?", reason: nil, options: []),
            WorkDetail.Question(id: "q_done", status: "answered", prompt: "Which studio?", reason: nil, options: []),
        ]
        let owned = ThreadRunView(
            run: Self.run(id: "run_q", state: .handedOff, outcome: .needsAnswer).run,
            question: ThreadQuestion(id: "q_run", prompt: "Which rate?")
        )
        let open = WorkQuestions.open(questions, runs: [owned])
        #expect(open.map(\.id) == ["q_plan"])
        #expect(open.first?.reason == "No email lists the hours.")
        #expect(WorkQuestions.open([], runs: []).isEmpty)
        #expect(WorkQuestions.label == "Albatross asks")
    }
}
