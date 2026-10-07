import Foundation
import Testing
@testable import Lab86Mail

// The thread contract on the wire: form questions, Work questions, runs with
// their questions, the canonical session id, and the `step_run` shape. The
// contract is lib/albatross/thread-contract.ts.
@MainActor
struct ThreadModelsTests {
    private static let formJSON: JSONValue = .object([
        "title": .string("Which class?"),
        "detail": .string("All three are before November 2."),
        "submitLabel": .string("Pick this class"),
        "fields": .array([
            .object([
                "id": .string("class"),
                "label": .string("Class"),
                "kind": .string("choice"),
                "options": .array([
                    .object([
                        "id": .string("mon"),
                        "label": .string("Monday, October 19"),
                        "detail": .string("4:00–8:00 PM · Zoom · $70"),
                        "recommended": .string("Matches what you said"),
                        "calendar": .object(["fit": .string("free"), "note": .string("Free on your calendar")]),
                    ]),
                    .object([
                        "id": .string("wed"),
                        "label": .string("Wednesday, October 21"),
                        "calendar": .object(["fit": .string("conflict"), "note": .string("Conflicts with Team sync")]),
                    ]),
                ]),
            ]),
            .object([
                "id": .string("phone"),
                "label": .string("Phone"),
                "kind": .string("phone"),
                "detailKey": .string("phone"),
                "value": .string("(555) 010-0100"),
                "valueSource": .string("From your email signature"),
            ]),
            .object([
                "id": .string("note"),
                "label": .string("Note"),
                "kind": .string("hologram"),
                "required": .bool(false),
            ]),
        ]),
    ])

    @Test func aFormDecodesItsFieldsOptionsAndTags() throws {
        let form = try #require(FormQuestion(json: Self.formJSON))
        #expect(form.title == "Which class?")
        #expect(form.submitTitle == "Pick this class")
        #expect(form.fields.count == 3)
        let choice = form.fields[0]
        #expect(choice.kind == .choice)
        #expect(choice.options.count == 2)
        #expect(choice.recommendedOption?.id == "mon")
        #expect(choice.options[0].calendar == FormOption.CalendarNote(fit: .free, note: "Free on your calendar"))
        #expect(choice.options[1].calendar?.fit == .conflict)
        let phone = form.fields[1]
        #expect(phone.boundDetail == .phone)
        #expect(phone.value == .string("(555) 010-0100"))
        #expect(phone.valueSource == "From your email signature")
        #expect(phone.required)
        // An unknown kind reads as text, and stays optional.
        #expect(form.fields[2].kind == .text)
        #expect(!form.fields[2].required)
        #expect(form.bindsDetails)
    }

    @Test func aFormWithoutFieldsOrATitleIsNotAForm() {
        #expect(FormQuestion(json: .object(["title": .string("x"), "fields": .array([])])) == nil)
        #expect(FormQuestion(json: .object(["fields": .array([.object(["id": .string("a"), "label": .string("A")])])])) == nil)
        #expect(FormQuestion(json: .object(["title": .string("x")]))?.submitTitle == nil)
    }

    @Test func anOlderQuestionBecomesAOneFieldFormWithOther() {
        let options = [ThreadQuestion.Option(id: "a", label: "Monday"), ThreadQuestion.Option(id: "b", label: "Wednesday", description: "Later")]
        let form = FormQuestion.legacy(prompt: "Which day?", reason: "Both are open.", options: options)
        #expect(form.title == "Which day?")
        #expect(form.detail == "Both are open.")
        #expect(form.fields.count == 1)
        #expect(form.fields[0].kind == .choice)
        #expect(form.fields[0].allowOther)
        #expect(form.fields[0].options.map(\.id) == ["a", "b"])
        #expect(form.fields[0].options[1].detail == "Later")
        let free = FormQuestion.legacy(prompt: "What is the fee?", reason: nil, options: [])
        #expect(free.fields[0].kind == .text)
    }

    @Test func aWorkQuestionDecodesWithWhereItWasAnswered() throws {
        let pending = try #require(ThreadQuestion(json: .object([
            "id": .string("q1"),
            "form": Self.formJSON,
            "prompt": .string("Which class?"),
            "status": .string("pending"),
            "reason": .null,
            "options": .null,
            "answer": .null,
            "answeredIn": .null,
        ])))
        #expect(pending.isPending)
        #expect(pending.form?.fields.count == 3)
        #expect(pending.resolvedForm.title == "Which class?")
        let answered = try #require(ThreadQuestion(json: .object([
            "id": .string("q2"),
            "prompt": .string("Which day?"),
            "options": .array([.object(["id": .string("a"), "label": .string("Monday")]), .object(["id": .string("b"), "label": .string("Wednesday")])]),
            "status": .string("answered"),
            "answer": .string("Answered in the chat: Monday works"),
            "answeredIn": .string("chat"),
        ])))
        #expect(answered.status == .answered)
        #expect(answered.answeredIn == .chat)
        #expect(answered.answerLine == "Monday works")
        #expect(answered.form == nil)
        #expect(answered.resolvedForm.fields[0].options.count == 2)
        #expect(RunBlockView.receipt(for: answered) == .answeredInChat("Monday works"))
        #expect(RunBlockView.receipt(for: pending) == nil)
        let dismissed = try #require(ThreadQuestion(json: .object(["id": .string("q3"), "prompt": .string("x"), "status": .string("dismissed")])))
        #expect(RunBlockView.receipt(for: dismissed) == .dismissed)
    }

    @Test func aRunInTheThreadCarriesItsParentDoneLabelAndQuestion() throws {
        let json: JSONValue = .object([
            "ok": .bool(true),
            "runs": .array([
                .object([
                    "id": .string("run_2"),
                    "workId": .string("work_1"),
                    "stepKey": .string("step-register"),
                    "stepTitle": .string("Register for the course"),
                    "state": .string("handed_off"),
                    "trigger": .string("resume"),
                    "outcome": .string("your_turn"),
                    "parentRunId": .string("run_1"),
                    "next": .object([
                        "kind": .string("finish_on_page"),
                        "label": .string("Check and pay"),
                        "doneLabel": .string("I paid"),
                        "detail": .string("Everything is filled in. Check it and pay the $70."),
                    ]),
                    "question": .null,
                    "createdAt": .number(1_791_392_640_000),
                ]),
                .object([
                    "id": .string("run_3"),
                    "stepKey": .string("step-register"),
                    "stepTitle": .string("Register for the course"),
                    "state": .string("handed_off"),
                    "outcome": .string("needs_answer"),
                    "question": .object(["id": .string("q1"), "form": Self.formJSON, "status": .string("pending")]),
                ]),
                .object(["stepTitle": .string("no id")]),
            ]),
        ])
        let runs = ThreadRunView.list(from: json)
        #expect(runs.count == 2)
        #expect(runs[0].run.parentRunID == "run_1")
        #expect(runs[0].run.next?.doneLabel == "I paid")
        #expect(RunBlockCopy.doneLabel(runs[0].run.next) == "I paid")
        #expect(RunBlockCopy.doneLabel(StepRunView.Next(kind: .signIn)) == "Continue")
        #expect(runs[0].question == nil)
        #expect(runs[0].pendingQuestion == nil)
        #expect(runs[1].pendingQuestion?.id == "q1")
        #expect(runs[1].question?.resolvedForm.fields.count == 3)
    }

    @Test func theDoneLabelKeepsTheLabelLimit() {
        let next = StepRunView.Next(kind: .finishOnPage, doneLabel: String(repeating: "x", count: 60))
        #expect(next.doneLabel?.count == StepRunView.Next.labelLimit)
        #expect(StepRunView.Next(kind: .finishOnPage, doneLabel: "  ").doneLabel == nil)
    }

    @Test func theCanonicalSessionIDFitsTheChatsRule() {
        #expect(WorkThreadSession.id(for: "k57abc_123-x") == "work-k57abc_123-x")
        #expect(WorkThreadSession.id(for: "a b/c") == "work-abc")
        #expect(WorkThreadSession.id(for: String(repeating: "a", count: 80)).count == 64)
        #expect(WorkThreadSession.isThreadID("work-k57abc"))
        #expect(!WorkThreadSession.isThreadID("work-ab"))
        #expect(!WorkThreadSession.isThreadID("ios-abcdef"))
        #expect(!WorkThreadSession.isThreadID("work-a b"))
    }

    @Test func theStepRunShapeDecodesAndSaysWhatRendersInline() throws {
        let started = try #require(ThreadStepRunShape(json: .object([
            "kind": .string("step_run"), "runId": .string("run_1"), "workId": .string("work_1"), "action": .string("started"),
        ])))
        #expect(started.rendersRunInline)
        let steered = try #require(ThreadStepRunShape(json: .object(["kind": .string("step_run"), "runId": .string("run_1"), "action": .string("steered")])))
        #expect(!steered.rendersRunInline)
        #expect(steered.workID == "")
        #expect(ThreadStepRunShape(json: .object(["kind": .string("receipt"), "runId": .string("run_1")])) == nil)
        let shape = try #require(ToolShape.decode(.object([
            "kind": .string("step_run"), "title": .string(""), "runId": .string("run_9"), "workId": .string("work_1"), "action": .string("resumed"),
        ])))
        #expect(shape.stepRun == ThreadStepRunShape(runID: "run_9", workID: "work_1", action: .resumed))
        #expect(!shape.isUnknown)
    }

    @Test func theMemoryReceiptNamesTheDetailsItSavedAndOffersUndo() throws {
        let shape = try #require(ToolShape.decode(.object([
            "kind": .string("receipt"),
            "title": .string("Saved to your details"),
            "surface": .string("memory"),
            "target": .object(["personalDetails": .array([.string("phone")])]),
            "actions": .array([.object(["kind": .string("undo_personal_details"), "keys": .array([.string("phone")])])]),
        ])))
        #expect(shape.personalDetailKeys == ["phone"])
        #expect(shape.actions == [.undoPersonalDetails(keys: ["phone"])])
        #expect(shape.actions.first?.label == "Undo")
        #expect(shape.actions.first?.isMutation == true)
        let empty = try #require(ToolShape.decode(.object([
            "kind": .string("receipt"), "surface": .string("memory"),
            "actions": .array([.object(["kind": .string("undo_personal_details"), "keys": .array([])])]),
        ])))
        #expect(empty.actions == [.unknown(kind: "undo_personal_details")])
    }

    @Test func aMessageKeepsItsTimeAndTheRunsItStarted() throws {
        let message = try #require(AssistantChatModel.message(from: .object([
            "id": .string("m1"),
            "role": .string("assistant"),
            "metadata": .object(["createdAt": .number(1_791_392_640_000)]),
            "parts": .array([
                .object(["type": .string("text"), "text": .string("On it.")]),
                .object([
                    "type": .string("tool-albatross_handle_step"),
                    "toolCallId": .string("call_1"),
                    "state": .string("output-available"),
                    "input": .object(["workId": .string("work_1")]),
                    "output": .object(["ok": .bool(true), "action": .string("started"), "runId": .string("run_1")]),
                ]),
                .object([
                    "type": .string("data-tool-shape"),
                    "id": .string("call_1"),
                    "data": .object(["kind": .string("step_run"), "runId": .string("run_1"), "workId": .string("work_1"), "action": .string("started")]),
                ]),
            ]),
        ])))
        #expect(message.createdAtMilliseconds == 1_791_392_640_000)
        #expect(message.startedRunIDs == ["run_1"])
        let undated = try #require(AssistantChatModel.message(from: .object([
            "id": .string("m0"), "role": .string("user"), "parts": .array([.object(["type": .string("text"), "text": .string("hi")])]),
        ])))
        #expect(undated.createdAt == nil)
        #expect(undated.startedRunIDs.isEmpty)
        #expect(AssistantChatModel.updatedAtMilliseconds(.object(["updatedAt": .number(12_345)])) == 12_345)
        #expect(AssistantChatModel.updatedAtMilliseconds(.object(["updatedAt": .string("2026-10-07T17:04:00.000Z")])) == 1_791_392_640_000)
        #expect(AssistantChatModel.updatedAtMilliseconds(nil) == nil)
    }
}
