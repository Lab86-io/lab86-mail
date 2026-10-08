import Foundation
import Testing
@testable import Lab86Mail

// The receipt under a note to a run (docs/albatross-threads.md, T7 and T9):
// sent, read, carried to the next run, not read, not sent, and a redirect.
@MainActor
struct NoteReceiptPresentationTests {
    private static let t0 = Date(timeIntervalSince1970: 1_760_000_000)

    private static func run(
        _ id: String,
        state: StepRunView.State,
        stepKey: String = "step-pay",
        createdAt: Date = t0,
        startedAt: Date? = nil,
        parentRunID: String? = nil,
        log: [String] = [],
        notes: [ThreadNote] = []
    ) -> ThreadRunView {
        ThreadRunView(
            run: StepRunView(
                id: id,
                workID: "w-water",
                stepKey: stepKey,
                stepTitle: "Pay the bill",
                state: state,
                log: log.map { StepRunView.LogLine(at: t0, text: $0) },
                createdAt: createdAt,
                startedAt: startedAt,
                parentRunID: parentRunID
            ),
            notes: notes
        )
    }

    private static func receipt(
        noteID: String = "msg-1",
        runID: String = "run-1",
        redirect: Bool = false,
        text: String = "Use the checking account, not the card",
        failed: Bool = false,
        runs: [ThreadRunView]
    ) -> NoteReceipt {
        NoteReceiptPresentation.receipt(noteID: noteID, runID: runID, redirect: redirect, text: text, failed: failed, runs: runs)
    }

    @Test("Sent to an open run that has not read it")
    func sent() {
        let runs = [Self.run("run-1", state: .running, notes: [ThreadNote(id: "msg-1", text: "x")])]
        #expect(Self.receipt(runs: runs) == .sent)
        // Before the server links the note, the open run alone says sent.
        #expect(Self.receipt(runs: [Self.run("run-1", state: .running)]) == .sent)
    }

    @Test("Read by Albatross, with the time")
    func read() {
        let at = Self.t0.addingTimeInterval(60)
        let runs = [Self.run("run-1", state: .running, notes: [ThreadNote(id: "msg-1", text: "x", readAt: at)])]
        #expect(Self.receipt(runs: runs) == .read(at))
    }

    @Test("A note carried to the next run of the step reads there")
    func carried() {
        let at = Self.t0.addingTimeInterval(600)
        let runs = [
            Self.run("run-1", state: .handedOff, notes: [ThreadNote(id: "msg-1", text: "x")]),
            Self.run("run-2", state: .running, createdAt: Self.t0.addingTimeInterval(300), notes: [ThreadNote(id: "msg-1", text: "x", readAt: at)]),
        ]
        #expect(Self.receipt(runs: runs) == .read(at))
        // The next run is open and has not read it yet: still sent.
        let waiting = [
            Self.run("run-1", state: .handedOff, notes: [ThreadNote(id: "msg-1", text: "x")]),
            Self.run("run-2", state: .running, createdAt: Self.t0.addingTimeInterval(300), notes: [ThreadNote(id: "msg-1", text: "x")]),
        ]
        #expect(Self.receipt(runs: waiting) == .sent)
        // The next run is open but the note is not linked to it yet: sent.
        let unlinked = [
            Self.run("run-1", state: .handedOff, notes: [ThreadNote(id: "msg-1", text: "x")]),
            Self.run("run-2", state: .running, createdAt: Self.t0.addingTimeInterval(300)),
        ]
        #expect(Self.receipt(runs: unlinked) == .sent)
    }

    @Test("Not read: the run ended first and no run continues")
    func notRead() {
        let runs = [Self.run("run-1", state: .failed, notes: [ThreadNote(id: "msg-1", text: "x")])]
        #expect(Self.receipt(runs: runs) == .notRead)
        // The note never linked and the run closed: the same.
        #expect(Self.receipt(runs: [Self.run("run-1", state: .cancelled)]) == .notRead)
        // A later run of another step does not carry it.
        let other = [
            Self.run("run-1", state: .failed, notes: [ThreadNote(id: "msg-1", text: "x")]),
            Self.run("run-2", state: .running, stepKey: "step-other", createdAt: Self.t0.addingTimeInterval(300)),
        ]
        #expect(Self.receipt(runs: other) == .notRead)
    }

    @Test("The log line is the receipt when the note has no link")
    func logLine() {
        let runs = [Self.run("run-1", state: .done, log: ["Opened springfield.example", "Read your note: Use the checking account, not the card"])]
        #expect(Self.receipt(runs: runs) == .read(Self.t0))
    }

    @Test("Not sent, and a redirect note")
    func notSentAndRedirect() {
        let runs = [Self.run("run-1", state: .running)]
        #expect(Self.receipt(failed: true, runs: runs) == .notSent)
        #expect(Self.receipt(redirect: true, runs: runs) == .redirectSent)
        #expect(Self.receipt(runs: []) == .sent)
    }

    @Test("A redirect note is read when the run that continues the stopped one begins work")
    func redirectRead() {
        let began = Self.t0.addingTimeInterval(30)
        let stopped = Self.run("run-1", state: .cancelled)
        let waiting = Self.run("run-2", state: .queued, parentRunID: "run-1")
        #expect(Self.receipt(redirect: true, runs: [stopped, waiting]) == .redirectSent)
        let working = Self.run("run-2", state: .running, startedAt: began, parentRunID: "run-1")
        #expect(Self.receipt(redirect: true, runs: [stopped, working]) == .read(began))
        // A run that continues another stopped run does not count.
        let other = Self.run("run-3", state: .running, startedAt: began, parentRunID: "run-9")
        #expect(Self.receipt(redirect: true, runs: [stopped, other]) == .redirectSent)
    }

    @Test("The words, and which receipts offer Send again")
    func words() {
        let locale = Locale(identifier: "en_US")
        #expect(NoteReceiptPresentation.line(.sent) == "Sent to the run")
        #expect(NoteReceiptPresentation.line(.read(nil)) == "Read by Albatross")
        #expect(NoteReceiptPresentation.line(.read(Self.t0), locale: locale).hasPrefix("Read by Albatross · "))
        #expect(NoteReceiptPresentation.line(.notRead) == "Not read: the run ended first")
        #expect(NoteReceiptPresentation.line(.notSent) == "Not sent. Check your connection.")
        #expect(NoteReceiptPresentation.line(.redirectSent) == "Sent. The run restarts with this note.")
        #expect(NoteReceiptPresentation.sendAgain == "Send again")
        #expect(NoteReceipt.notRead.offersSendAgain)
        #expect(NoteReceipt.notSent.offersSendAgain)
        #expect(!NoteReceipt.sent.offersSendAgain)
        #expect(!NoteReceipt.read(nil).offersSendAgain)
        #expect(!NoteReceipt.redirectSent.offersSendAgain)
    }

    @Test("A steer message keeps its note on the wire and reads back")
    func messageMetadata() throws {
        let message = try #require(AssistantChatModel.message(from: .object([
            "id": .string("msg-1"),
            "role": .string("user"),
            "metadata": .object([
                "createdAt": .number(1_760_000_000_000),
                "steer": .object(["runId": .string("run-1")]),
            ]),
            "parts": .array([.object(["type": .string("text"), "text": .string("Use the checking account")])]),
        ])))
        #expect(message.steer == AssistantChatMessage.SteerNote(runID: "run-1", redirect: false))
        let redirect = try #require(AssistantChatModel.message(from: .object([
            "id": .string("msg-2"),
            "role": .string("user"),
            "metadata": .object(["steer": .object(["runId": .string("run-2"), "redirect": .bool(true)])]),
            "parts": .array([.object(["type": .string("text"), "text": .string("Go back")])]),
        ])))
        #expect(redirect.steer?.redirect == true)
        let plain = try #require(AssistantChatModel.message(from: .object([
            "id": .string("msg-3"),
            "role": .string("user"),
            "parts": .array([.object(["type": .string("text"), "text": .string("Hello")])]),
        ])))
        #expect(plain.steer == nil)
    }
}
