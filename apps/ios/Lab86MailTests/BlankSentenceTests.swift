import Foundation
import Testing
@testable import Lab86Mail

// The blank (docs/albatross-blank-design.md): the sentence rules that mirror
// lib/albatross/blanks.ts, the `next.blanks` field on the wire and in the
// offline cache, the list row's blanks, and when a run block draws them.
@MainActor
struct BlankSentenceTests {
    // MARK: - Sentence rules

    @Test func noBlanksMakeNoSentence() {
        #expect(BlankSentenceRules.parts([]).isEmpty)
        #expect(BlankSentenceRules.parts(["  ", ""]).isEmpty)
        #expect(BlankSentenceRules.text([]) == "")
    }

    @Test func oneBlank() {
        #expect(BlankSentenceRules.parts(["hourly rate"]) == [.text("Fill in "), .blank("hourly rate"), .text(".")])
        #expect(BlankSentenceRules.text(["hourly rate"]) == "Fill in hourly rate.")
    }

    @Test func twoBlanksJoinWithAnd() {
        #expect(
            BlankSentenceRules.parts(["hours", "rate"])
                == [.text("Fill in "), .blank("hours"), .text(" and "), .blank("rate"), .text(".")]
        )
        #expect(BlankSentenceRules.text(["hours", "rate"]) == "Fill in hours and rate.")
    }

    @Test func threeBlanksJoinWithCommasAndAnd() {
        #expect(
            BlankSentenceRules.parts(["hours", "rate", "invoice number"])
                == [
                    .text("Fill in "), .blank("hours"), .text(", "), .blank("rate"),
                    .text(", and "), .blank("invoice number"), .text("."),
                ]
        )
        #expect(
            BlankSentenceRules.text(["hours", "rate", "invoice number"])
                == "Fill in hours, rate, and invoice number."
        )
    }

    @Test func namesAreTrimmedAndEmptyNamesDrop() {
        #expect(BlankSentenceRules.text(["  hours for each week ", "", " rate"]) == "Fill in hours for each week and rate.")
        #expect(BlankSentenceRules.parts([" rate\n"]) == [.text("Fill in "), .blank("rate"), .text(".")])
    }

    @Test func punctuationAfterABlankHasNoSpace() {
        let tokens = BlankSentenceRules.tokens(BlankSentenceRules.parts(["hours", "rate", "invoice number"]))
        typealias Token = BlankSentenceRules.Token
        #expect(
            tokens == [
                Token(kind: .word("Fill"), spaceBefore: false),
                Token(kind: .word("in"), spaceBefore: true),
                Token(kind: .blank("hours"), spaceBefore: true),
                Token(kind: .word(","), spaceBefore: false),
                Token(kind: .blank("rate"), spaceBefore: true),
                Token(kind: .word(","), spaceBefore: false),
                Token(kind: .word("and"), spaceBefore: true),
                Token(kind: .blank("invoice number"), spaceBefore: true),
                Token(kind: .word("."), spaceBefore: false),
            ]
        )
    }

    // MARK: - next.blanks on the wire

    private static func nextJSON(blanks: JSONValue?) -> JSONValue {
        var next: [String: JSONValue] = [
            "kind": .string("review_document"),
            "label": .string("Fill in hours"),
            "detail": .string("Fill them in, or answer in the box below."),
        ]
        if let blanks { next["blanks"] = blanks }
        return .object(next)
    }

    @Test func blanksDecodeWhenPresent() throws {
        let next = try #require(
            StepRunView.Next(json: Self.nextJSON(blanks: .array([.string("hours, 4 weeks"), .string("rate")])))
        )
        #expect(next.blanks == ["hours, 4 weeks", "rate"])
    }

    @Test func blanksReadAsEmptyWhenAbsent() throws {
        let next = try #require(StepRunView.Next(json: Self.nextJSON(blanks: nil)))
        #expect(next.blanks.isEmpty)
        #expect(StepRunView.Next(kind: .reviewDocument).blanks.isEmpty)
    }

    @Test func blanksDropEmptyNamesTrimAndKeepSix() throws {
        let raw: [JSONValue] = [
            .string(" hours "), .string(""), .string("   "),
            .string("rate"), .string("c"), .string("d"), .string("e"), .string("f"), .string("g"),
        ]
        let next = try #require(StepRunView.Next(json: Self.nextJSON(blanks: .array(raw))))
        #expect(next.blanks == ["hours", "rate", "c", "d", "e", "f"])
        #expect(StepRunView.Next(kind: .answer, blanks: [" a ", ""]).blanks == ["a"])
    }

    @Test func aCachedNextWithoutBlanksStillDecodes() throws {
        let next = StepRunView.Next(kind: .reviewDocument, detail: "Check the table.", doneLabel: "I checked it", blanks: ["rate"])
        let data = try JSONEncoder().encode(next)
        let roundTrip = try JSONDecoder().decode(StepRunView.Next.self, from: data)
        #expect(roundTrip == next)
        #expect(roundTrip.blanks == ["rate"])

        var object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        object.removeValue(forKey: "blanks")
        let older = try JSONDecoder().decode(
            StepRunView.Next.self,
            from: JSONSerialization.data(withJSONObject: object)
        )
        #expect(older.blanks.isEmpty)
        #expect(older.doneLabel == "I checked it")
        #expect(older.kind == .reviewDocument)
    }

    // MARK: - The run block

    private static func run(outcome: StepRunView.Outcome?, next: StepRunView.Next?) -> StepRunView {
        StepRunView(
            id: "run_1",
            workID: "work_1",
            stepKey: "step-hours",
            stepTitle: "Make the hours summary and invoice",
            state: .handedOff,
            outcome: outcome,
            next: next
        )
    }

    @Test func aReadyHandoffDrawsTheBlankSentence() {
        let withBlanks = StepRunView.Next(kind: .reviewDocument, blanks: ["rate"])
        let withDetail = StepRunView.Next(kind: .reviewDocument, detail: "Check the table.")
        #expect(RunBlockBlanks.draws(Self.run(outcome: .readyForYou, next: withBlanks)))
        #expect(RunBlockBlanks.draws(Self.run(outcome: .yourTurn, next: withDetail)))
        #expect(!RunBlockBlanks.draws(Self.run(outcome: .needsAnswer, next: withBlanks)))
        #expect(!RunBlockBlanks.draws(Self.run(outcome: .readyForYou, next: StepRunView.Next(kind: .reviewDocument))))
        #expect(!RunBlockBlanks.draws(Self.run(outcome: .yourTurn, next: StepRunView.Next(kind: .allowSecure, detail: "Allow?"))))
        #expect(!RunBlockBlanks.draws(Self.run(outcome: .readyForYou, next: nil)))
    }

    // MARK: - The list row

    @Test func aThreadRowDecodesItsBlanks() throws {
        let row = try #require(
            ThreadRow(json: .object([
                "workId": .string("w-1"),
                "status": .string("ready_for_you"),
                "blanks": .array([.string(" hours "), .string(""), .string("rate")]),
            ]))
        )
        #expect(row.blanks == ["hours", "rate"])
        #expect(row.with(unread: true).blanks == ["hours", "rate"])
        #expect(row.with(status: .inProgress, statusLabel: nil, preview: nil).blanks.isEmpty)

        let older = try #require(ThreadRow(json: .object(["workId": .string("w-2")])))
        #expect(older.blanks.isEmpty)
    }
}
