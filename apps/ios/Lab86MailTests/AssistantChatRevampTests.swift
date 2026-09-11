import Foundation
import XCTest
@testable import Lab86Mail

@MainActor
final class AssistantChatRevampTests: XCTestCase {
    private func model() -> AssistantChatModel {
        AssistantChatModel(backend: BackendClient(baseURL: nil), baseURL: nil)
    }

    private func json(_ string: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(string.utf8))
    }

    private func event(_ name: String, _ fields: [String: JSONValue] = [:]) -> JSONValue {
        .object(fields.merging(["type": .string(name)]) { _, latest in latest })
    }

    func testStreamKeepsParallelCallsAndMatchesTextByID() throws {
        let model = model()
        let reply = model.appendAssistantReply()
        model.apply(event: event("text-start", ["id": .string("intro")]), to: reply)
        for id in ["one", "two"] {
            model.apply(event: event("tool-input-start", ["toolCallId": .string(id), "toolName": .string("search_threads")]), to: reply)
        }
        model.apply(event: event("tool-input-delta", ["toolCallId": .string("one"), "inputTextDelta": .string("{\"query\":\"lake")]), to: reply)
        XCTAssertTrue(try XCTUnwrap(model.messages.last?.toolRows.first).sentence.contains("lake"))
        model.apply(event: event("tool-input-available", ["toolCallId": .string("one"), "input": .object(["query": .string("lake")])]), to: reply)
        model.apply(event: event("text-delta", ["id": .string("intro"), "delta": .string("I will check.")]), to: reply)
        model.apply(event: event("text-end", ["id": .string("intro")]), to: reply)
        model.apply(event: event("tool-output-available", ["toolCallId": .string("two"), "output": .object([:])]), to: reply)
        model.apply(event: event("tool-output-error", ["toolCallId": .string("one"), "errorText": .string("Search unavailable")]), to: reply)
        let message = try XCTUnwrap(model.messages.last)
        XCTAssertEqual(message.text, "I will check.")
        XCTAssertTrue(message.endedTextIDs.contains(reply + "-text-intro"))
        XCTAssertEqual(message.toolRows.map(\.callID), ["one", "two"])
        XCTAssertEqual(message.toolRows.map(\.state), [.failed, .done])
        XCTAssertTrue(message.toolRows[0].sentence.contains("Search unavailable"))
    }

    func testReasoningSourcesAndShapePersistInHistory() throws {
        let model = model()
        let reply = model.appendAssistantReply()
        model.clock = { Date(timeIntervalSince1970: 100) }
        model.apply(event: event("reasoning-start", ["id": .string("r")]), to: reply)
        model.apply(event: event("reasoning-delta", ["id": .string("r"), "delta": .string("Check the corpus.")]), to: reply)
        model.clock = { Date(timeIntervalSince1970: 103) }
        model.apply(event: event("reasoning-end", ["id": .string("r")]), to: reply)
        model.apply(event: event("tool-input-start", ["toolCallId": .string("count"), "toolName": .string("corpus_count")]), to: reply)
        model.apply(event: event("tool-output-available", ["toolCallId": .string("count"), "output": .object(["count": .number(3)])]), to: reply)
        let shape = try json(#"{"kind":"count","title":"Matches","value":3,"label":"messages","activity":{"running":"Counting","done":"Counted messages","failed":"Count failed"},"actions":[]}"#)
        model.apply(event: event("data-tool-shape", ["id": .string("count"), "data": shape]), to: reply)
        let source = event("source-url", ["sourceId": .string("s"), "url": .string("https://example.com"), "title": .string("Reference")])
        model.apply(event: source, to: reply)
        model.apply(event: source, to: reply)
        let saved = try XCTUnwrap(model.transcriptJSON(includeDisplayParts: true).arrayValue?.first)
        let restored = try XCTUnwrap(AssistantChatModel.message(from: saved))
        XCTAssertEqual(restored.sources.count, 1)
        XCTAssertEqual(restored.toolRows.first?.shapeJSON, shape)
        XCTAssertEqual(restored.toolRows.first?.sentence, "Counted messages")
        guard case .reasoning(let reasoning)? = restored.parts.first else { return XCTFail("Missing reasoning") }
        XCTAssertEqual(reasoning.label, "Thought for 3s")
        XCTAssertEqual(reasoning.text, "Check the corpus.")
        XCTAssertFalse(reasoning.isStreaming)
        XCTAssertFalse(model.transcriptJSON().arrayValue?.first?["parts"]?.arrayValue?.contains { $0["type"]?.stringValue == "data-tool-shape" } ?? true)
    }

    func testTranscriptMillisecondsRestoreNearEpochAndAtCurrentDates() throws {
        for epoch in [0.0, 1_753_000_000.0] {
            let model = model()
            let reply = model.appendAssistantReply()
            model.clock = { Date(timeIntervalSince1970: epoch) }
            model.apply(event: event("reasoning-start", ["id": .string("r")]), to: reply)
            model.apply(event: event("reasoning-delta", ["id": .string("r"), "delta": .string("Check")]), to: reply)
            model.apply(event: event("tool-input-start", ["toolCallId": .string("call"), "toolName": .string("search_threads")]), to: reply)
            model.clock = { Date(timeIntervalSince1970: epoch + 3) }
            model.apply(event: event("reasoning-end", ["id": .string("r")]), to: reply)
            model.apply(event: event("tool-output-available", ["toolCallId": .string("call"), "output": .object([:])]), to: reply)
            let saved = try XCTUnwrap(model.transcriptJSON(includeDisplayParts: true).arrayValue?.first)
            let restored = try XCTUnwrap(AssistantChatModel.message(from: saved))
            guard case .reasoning(let reasoning)? = restored.parts.first else { return XCTFail("Missing reasoning") }
            XCTAssertEqual(reasoning.startedAt, Date(timeIntervalSince1970: epoch))
            XCTAssertEqual(reasoning.endedAt, Date(timeIntervalSince1970: epoch + 3))
            XCTAssertEqual(reasoning.label, "Thought for 3s")
            XCTAssertEqual(restored.toolRows.first?.startedAt, Date(timeIntervalSince1970: epoch))
            XCTAssertEqual(restored.toolRows.first?.endedAt, Date(timeIntervalSince1970: epoch + 3))
            XCTAssertEqual(AssistantWorkLog.duration(rows: restored.toolRows), 3)
        }
    }

    func testPendingQuestionsAndApprovalSurviveHistory() throws {
        let model = model()
        let reply = model.appendAssistantReply()
        for name in ["ask_user", "ask_parameters", "ask_preferences", "ask_question_flow", "ask_approval"] {
            model.apply(event: event("tool-input-available", ["toolCallId": .string(name), "toolName": .string(name), "input": .object(["title": .string("Choose")])]), to: reply)
        }
        let saved = try XCTUnwrap(model.transcriptJSON(includeDisplayParts: true).arrayValue?.first)
        let restored = try XCTUnwrap(AssistantChatModel.message(from: saved))
        XCTAssertEqual(restored.parts.count, 5)
        for part in restored.parts {
            switch part {
            case .question(let question): XCTAssertNil(question.answer)
            case .approval(let approval): XCTAssertNil(approval.decision)
            default: XCTFail("Expected an unanswered form")
            }
        }
    }

    func testErrorsKeepContinueAfterFinishAndStopRejectsLateEvents() throws {
        let model = model()
        let reply = model.appendAssistantReply()
        model.apply(event: event("text-delta", ["delta": .string("Partial reply")]), to: reply)
        model.apply(event: event("error", ["errorText": .string("Connection lost")]), to: reply)
        model.apply(event: event("finish", ["finishReason": .string("error")]), to: reply)
        XCTAssertTrue(model.canContinue)
        model.stop()
        let next = model.appendAssistantReply()
        model.apply(event: event("text-delta", ["delta": .string("Late stale output")]), to: reply)
        XCTAssertEqual(model.messages.first?.text, "Partial reply")
        XCTAssertEqual(model.messages.last?.id, next)
        XCTAssertTrue(model.isStreaming)
    }

    func testWorkLogGroupingAndCollapse() {
        let done = AssistantToolRow(callID: "a", toolName: "search_threads", state: .done)
        let failed = AssistantToolRow(callID: "b", toolName: "get_thread", state: .failed, errorText: "Unavailable")
        let parts: [AssistantChatPart] = [.text(id: "t", "Checking"), .toolRow(done), .toolRow(failed), .text(id: "reply", "Done"), .toolRow(done)]
        let blocks = AssistantWorkLog.group(parts: parts)
        XCTAssertEqual(blocks.count, 4)
        guard case .workLog(_, let rows) = blocks[1] else { return XCTFail("Missing log") }
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(AssistantWorkLog.headerText(AssistantWorkLog.headerState(rows: rows, turnFinished: true)), "1 step failed")
        XCTAssertFalse(AssistantWorkLog.collapsesByDefault(rows: [done, done], turnFinished: true))
        XCTAssertTrue(AssistantWorkLog.collapsesByDefault(rows: [done, done, done], turnFinished: true))
        XCTAssertFalse(AssistantWorkLog.collapsesByDefault(rows: [done, done, failed], turnFinished: true))
        XCTAssertFalse(AssistantWorkLog.collapsesByDefault(rows: [done, done, done], turnFinished: false))
    }

    func testRevealMeterWaitsForWholeWordsAndDrainsLargeReply() {
        var meter = RevealMeter()
        meter.update(text: "Hello wor")
        XCTAssertEqual(meter.availableWords, 1)
        meter.advance()
        XCTAssertEqual(meter.revealedText, "Hello ")
        meter.update(text: "Hello world ")
        meter.advance()
        XCTAssertEqual(meter.revealedText, "Hello world ")
        meter.update(text: String(repeating: "word ", count: 2_000) + "last")
        meter.finish()
        meter.advance(elapsed: 0.401)
        XCTAssertTrue(meter.isDrained)
        XCTAssertEqual(meter.revealedText, meter.buffer)
        meter.update(text: "New reply")
        XCTAssertFalse(meter.isFinished)
        XCTAssertEqual(meter.revealedWords, 0)
        meter.revealAll()
        XCTAssertEqual(meter.revealedText, "New reply")
    }

    func testRevealCatchUpUsesOneBudgetForTheWholeBacklog() {
        var meter = RevealMeter()
        meter.update(text: String(repeating: "word ", count: 1_000))
        meter.advance(elapsed: 0.601)
        XCTAssertTrue(meter.isDrained)
        XCTAssertFalse(meter.isFinished)
    }

    func testAllShapeKindsAndUnknownDecode() throws {
        let payloads: [String: String] = [
            "threads": #""items":[]"#, "thread": #""item":{"threadId":"t"}"#,
            "events": #""items":[]"#, "event": #""item":{"eventId":"e"}"#,
            "slots": #""items":[]"#, "tasks": #""items":[]"#, "task": #""item":{"cardId":"t"}"#,
            "board": #""boardId":"b","columns":[]"#, "work": #""item":{"workId":"w"}"#,
            "works": #""items":[]"#, "area": #""areaId":"a","name":"Area""#,
            "document": #""documentId":"d""#, "files": #""items":[]"#,
            "contact": #""email":"sam@example.com""#, "count": #""value":2,"label":"matches""#,
            "receipt": #""surface":"mail""#, "sources": #""items":[]"#, "text": #""text":"Summary""#,
        ]
        for (kind, fields) in payloads {
            let shape = try XCTUnwrap(ToolShape.decode(json("{\"kind\":\"\(kind)\",\"title\":\"Result\",\(fields)}")))
            XCTAssertEqual(shape.kind, kind)
            XCTAssertFalse(shape.isUnknown, kind)
            XCTAssertNil(shape.summary)
            XCTAssertTrue(shape.actions.isEmpty)
        }
        let unknown = try XCTUnwrap(ToolShape.decode(json(#"{"kind":"future","actions":[{"kind":"future_action"}]}"#)))
        XCTAssertTrue(unknown.isUnknown)
        XCTAssertEqual(unknown.actions, [.unknown(kind: "future_action")])
    }

    func testQuestionOutputMatchesEachWireContract() throws {
        let outputs: [(AssistantQuestionPart.Kind, JSONValue)] = [
            (.user, AssistantQuestionOutput.answers([("Choose", "One, Two")])),
            (.questionFlow, AssistantQuestionOutput.answers([("Step 1", "One"), ("Step 2", "Two")])),
            (.parameters, AssistantQuestionOutput.parameters(["budget": 25.5])),
            (.preferences, AssistantQuestionOutput.preferences(["notify": .bool(true), "mode": .string("daily")])),
        ]
        for (kind, output) in outputs {
            let part = AssistantQuestionPart(id: "q", toolCallID: "call", kind: kind, input: .object([:]), answer: output)
            let saved = AssistantChatModel.questionPartJSON(part)
            XCTAssertEqual(saved["state"]?.stringValue, "output-available")
            XCTAssertEqual(saved["toolName"]?.stringValue, kind.rawValue)
            XCTAssertEqual(saved["output"], output)
            let restored = try XCTUnwrap(AssistantChatModel.message(from: .object(["id": .string("m"), "role": .string("assistant"), "parts": .array([saved])])))
            guard case .question(let question)? = restored.parts.first else { return XCTFail("Missing answer") }
            XCTAssertEqual(question.answer, output)
        }
        XCTAssertEqual(outputs[2].1["values"]?["budget"], .number(25.5))
        XCTAssertEqual(outputs[3].1["values"]?["notify"], .bool(true))
    }

    func testDisplayToolsUseBriefNodesAndKeepEveryTableColumn() throws {
        let table = try AssistantToolCard.parse(toolName: "show_table", output: json(#"{"payload":{"columns":[{"key":"a"},{"key":"b"},{"key":"c"},{"key":"d"}],"rows":[{"a":1,"b":2,"c":3,"d":4}]}}"#))
        guard case .table(let card) = table else { return XCTFail("Missing table") }
        XCTAssertEqual(card.columns.count, 4)
        XCTAssertEqual(card.rows.first?.count, 4)
        for (tool, payload, kind) in [
            ("show_weather", #"{"location":{"name":"Rochester"},"current":{"conditionCode":"clear","temperature":70,"tempMin":60,"tempMax":75},"forecast":[]}"#, "weather"),
            ("show_map", #"{"markers":[{"id":"a","lat":43,"lng":-77}]}"#, "geo_map"),
            ("show_code_diff", #"{"filename":"x.swift","oldCode":"a","newCode":"b"}"#, "code_diff"),
            ("show_terminal", #"{"command":"pwd","stdout":"/tmp","exitCode":0}"#, "terminal"),
        ] {
            let node = try XCTUnwrap(AssistantDisplayNode.decode(toolName: tool, payload: json(payload)))
            XCTAssertEqual(node.kind, kind)
        }
    }

    func testMutationOutcomeDoesNotReportQueuedAsApplied() throws {
        XCTAssertEqual(try AssistantShapeMutationOutcome.message(status: .applied, success: "Archived", error: nil, retryable: false), "Archived")
        XCTAssertEqual(try AssistantShapeMutationOutcome.message(status: .queued, success: "Archived", error: nil, retryable: false), "Saved. Waiting to sync.")
        XCTAssertThrowsError(try AssistantShapeMutationOutcome.message(status: .conflicted, success: "Archived", error: "Conflict", retryable: false))
    }
}
