import Foundation
import Testing
@testable import Lab86Mail

// The thread's pure rules: the block each run state draws and its words
// (docs/albatross-thread.md, decision 6), the thread state and its plan
// line, the composer placeholder, the jump pill, and the step words.
struct RunBlockPresentationTests {
    private static func run(
        state: StepRunView.State,
        outcome: StepRunView.Outcome? = nil,
        stoppedBy: StepRunView.StoppedBy? = nil,
        next: StepRunView.Next? = nil,
        log: [String] = [],
        question: ThreadQuestion? = nil
    ) -> ThreadRunView {
        ThreadRunView(
            run: StepRunView(
                id: "run_\(state.rawValue)",
                workID: "work_1",
                stepKey: "step-register",
                stepTitle: "Register for the course",
                state: state,
                outcome: outcome,
                log: log.map { StepRunView.LogLine(at: nil, text: $0) },
                next: next,
                stoppedBy: stoppedBy
            ),
            question: question
        )
    }

    /// A `work_home` detail with the given steps and run fields.
    private static func detail(
        steps: [(key: String, done: Bool, runnable: Bool)],
        workState: String = "active",
        active: Bool = false,
        pendingQuestion: Bool = false
    ) throws -> WorkDetail {
        let guide: [JSONValue] = steps.map { step in
            .object([
                "key": .string(step.key),
                "kind": .string("task"),
                "title": .string("Step \(step.key)"),
                "done": .bool(step.done),
                "runnable": .bool(step.runnable),
            ])
        }
        let current = steps.first { !$0.done }
        var execution: [String: JSONValue] = [
            "guideSteps": .array(guide),
            "remainingSteps": .number(Double(steps.filter { !$0.done }.count)),
            "totalSteps": .number(Double(steps.count)),
            "runner": .object(["enabled": .bool(true)]),
        ]
        if let current {
            execution["currentStep"] = .object([
                "key": .string(current.key), "kind": .string("task"), "title": .string("Step \(current.key)"),
                "done": .bool(false), "runnable": .bool(current.runnable),
            ])
        }
        if active {
            execution["activeRun"] = .object([
                "id": .string("run_open"), "stepKey": .string(current?.key ?? "x"), "stepTitle": .string("Step"), "state": .string("running"),
            ])
        }
        var questions: [JSONValue] = []
        if pendingQuestion {
            questions.append(.object(["id": .string("q1"), "status": .string("pending"), "prompt": .string("Which class?"), "options": .array([])]))
        }
        return try #require(WorkDetail(json: .object([
            "work": .object(["_id": .string("work_1"), "title": .string("Register for Alive at 25"), "workState": .string(workState)]),
            "execution": .object(execution),
            "questions": .array(questions),
        ])))
    }

    // MARK: - The block

    @Test func eachRunStateDrawsOneBlock() {
        #expect(RunBlockState.from(Self.run(state: .queued).run) == .queued)
        #expect(RunBlockState.from(Self.run(state: .running).run) == .running)
        #expect(RunBlockState.from(Self.run(state: .handedOff, outcome: .yourTurn).run) == .handedOff(.yourTurn))
        #expect(RunBlockState.from(Self.run(state: .handedOff, outcome: .stopped).run) == .stopped)
        #expect(RunBlockState.from(Self.run(state: .handedOff, outcome: .readyForYou, stoppedBy: .time).run) == .stopped)
        #expect(RunBlockState.from(Self.run(state: .handedOff).run) == .handedOff(.readyForYou))
        #expect(RunBlockState.from(Self.run(state: .done).run) == .done)
        #expect(RunBlockState.from(Self.run(state: .failed).run) == .failed)
        #expect(RunBlockState.from(Self.run(state: .cancelled).run) == .cancelled)
        #expect(RunBlockState.from(Self.run(state: .closed).run) == .closed)
        #expect(RunBlockState.from(Self.run(state: .unknown).run) == .closed)
        #expect(RunBlockState.queued.isOpen)
        #expect(RunBlockState.handedOff(.yourTurn).waitsForUser)
        #expect(!RunBlockState.done.waitsForUser)
    }

    @Test func theHeadlinesHaveNoIngForms() {
        #expect(RunBlockCopy.headline(Self.run(state: .queued).run) == "Starts soon")
        #expect(RunBlockCopy.headline(Self.run(state: .running).run) == "In progress")
        #expect(RunBlockCopy.headline(Self.run(state: .handedOff, outcome: .yourTurn).run) == "Your turn")
        #expect(RunBlockCopy.headline(Self.run(state: .handedOff, outcome: .needsAnswer).run) == "Needs your answer")
        #expect(RunBlockCopy.headline(Self.run(state: .handedOff, outcome: .readyForYou).run) == "Ready for you")
        #expect(RunBlockCopy.headline(Self.run(state: .handedOff, outcome: .stopped, stoppedBy: .cost).run) == "Stopped")
        #expect(RunBlockCopy.headline(Self.run(state: .done).run) == "Done")
        #expect(RunBlockCopy.headline(Self.run(state: .failed).run) == "Did not finish")
        #expect(RunBlockCopy.headline(Self.run(state: .cancelled).run) == "Stopped by you")
        #expect(RunBlockCopy.headline(Self.run(state: .closed).run) == "Dismissed")
        #expect(RunBlockCopy.title(Self.run(state: .running).run) == "In progress: Register for the course")
        #expect(RunBlockCopy.title(Self.run(state: .done).run) == "Register for the course")
        #expect(RunBlockCopy.limitLine(.cost) == "Albatross stopped at its cost limit.")
        #expect(RunBlockCopy.limitLine(nil) == nil)
        #expect(RunBlockCopy.doneLine(verification: "Verified on the page") == "Done · Verified on the page")
        #expect(RunBlockCopy.doneLine(verification: nil) == "Done")
        #expect(RunBlockCopy.pageLine(host: "aliveat25.com") == "Albatross is on the page · aliveat25.com")
        #expect(RunBlockCopy.pageLine(host: nil) == "Albatross is on the page")
        #expect(RunBlockCopy.logTitle == "What Albatross did")
    }

    @Test func theProgressLineIsTheNewestLogLineOrTheState() {
        #expect(RunBlockCopy.progressLine(Self.run(state: .queued).run) == "Starts soon.")
        #expect(RunBlockCopy.progressLine(Self.run(state: .running).run) == "Albatross works on this step.")
        #expect(RunBlockCopy.progressLine(Self.run(state: .running, log: ["Opened the class list", "Read your details"]).run) == "Read your details")
    }

    @Test func theContinuedLineNamesTheTime() {
        #expect(RunBlockCopy.continuedLine(at: nil) == "Continued")
        #expect(RunBlockCopy.continuedLine(at: Date(timeIntervalSince1970: 1_791_392_640), locale: Locale(identifier: "en_US")).hasPrefix("Continued · "))
    }

    // MARK: - The thread

    @Test func theThreadStateFollowsTheWorkAndTheNewestRun() throws {
        #expect(ThreadState.resolve(detail: nil, runs: []) == .planning)
        #expect(ThreadState.resolve(detail: try Self.detail(steps: []), runs: []) == .planning)
        let ready = try Self.detail(steps: [("a", false, true), ("b", false, false)])
        #expect(ThreadState.resolve(detail: ready, runs: []) == .ready)
        #expect(ThreadState.resolve(detail: ready, runs: [Self.run(state: .running)]) == .running)
        #expect(ThreadState.resolve(detail: ready, runs: [Self.run(state: .handedOff, outcome: .yourTurn)]) == .yourTurn)
        #expect(ThreadState.resolve(detail: ready, runs: [Self.run(state: .handedOff, outcome: .needsAnswer)]) == .needsAnswer)
        #expect(ThreadState.resolve(detail: ready, runs: [Self.run(state: .handedOff, outcome: .readyForYou)]) == .readyForYou)
        #expect(ThreadState.resolve(detail: ready, runs: [Self.run(state: .handedOff, outcome: .stopped, stoppedBy: .time)]) == .readyForYou)
        #expect(ThreadState.resolve(detail: ready, runs: [Self.run(state: .failed)]) == .ready)
        #expect(ThreadState.resolve(detail: ready, runs: [Self.run(state: .done)]) == .ready)
        #expect(ThreadState.resolve(detail: try Self.detail(steps: [("a", false, true)], active: true), runs: []) == .running)
        #expect(ThreadState.resolve(detail: try Self.detail(steps: [("a", false, true)], pendingQuestion: true), runs: []) == .needsAnswer)
        #expect(ThreadState.resolve(detail: try Self.detail(steps: [("a", true, false)]), runs: []) == .done)
        #expect(ThreadState.resolve(detail: try Self.detail(steps: [("a", false, true)], workState: "done"), runs: []) == .done)
        #expect(ThreadState.resolve(detail: try Self.detail(steps: [("a", false, true)], workState: "paused"), runs: [Self.run(state: .running)]) == .putDown)
    }

    @Test func thePlanLineNamesTheStepAndTheState() {
        #expect(ThreadState.planning.planLine(stepNumber: nil, total: 0) == "Albatross makes the plan")
        #expect(ThreadState.ready.planLine(stepNumber: 1, total: 2) == "Step 1 of 2")
        #expect(ThreadState.running.planLine(stepNumber: 1, total: 2) == "Step 1 of 2 · Albatross works")
        #expect(ThreadState.yourTurn.planLine(stepNumber: 1, total: 2) == "Step 1 of 2 · Your turn")
        #expect(ThreadState.needsAnswer.planLine(stepNumber: 2, total: 3) == "Step 2 of 3 · Needs your answer")
        #expect(ThreadState.readyForYou.planLine(stepNumber: 1, total: 2) == "Step 1 of 2 · Ready for you")
        #expect(ThreadState.done.planLine(stepNumber: 2, total: 2) == "Done")
        #expect(ThreadState.putDown.planLine(stepNumber: 1, total: 2) == "Put down")
        #expect(ThreadState.yourTurn.planLine(stepNumber: nil, total: 0) == "Your turn")
    }

    @Test func theStepPositionComesFromTheCurrentStep() throws {
        let detail = try Self.detail(steps: [("a", true, false), ("b", false, true), ("c", false, false)])
        #expect(ThreadPlanPosition.stepNumber(detail) == 2)
        #expect(ThreadPlanPosition.total(detail) == 3)
        #expect(ThreadPlanPosition.stepNumber(nil) == nil)
        #expect(ThreadPlanPosition.total(nil) == 0)
    }

    @Test func theComposerPlaceholderAndTheJumpPillFollowTheState() {
        #expect(ThreadState.needsAnswer.composerPlaceholder == "Answer here, or tell Albatross what to change")
        #expect(ThreadState.running.composerPlaceholder == "Tell Albatross what to change")
        #expect(ThreadState.ready.composerPlaceholder == "Tell Albatross what to do")
        #expect(ThreadJumpPill.text(atBottom: true, pendingFormOffscreen: false) == nil)
        #expect(ThreadJumpPill.text(atBottom: false, pendingFormOffscreen: false) == "Newest")
        #expect(ThreadJumpPill.text(atBottom: false, pendingFormOffscreen: true) == "Albatross needs an answer")
    }

    @Test func theStepWordsSayWhoseTurnItIs() throws {
        let detail = try Self.detail(steps: [("a", true, false), ("b", false, true), ("c", false, false)])
        let done = detail.execution.guideSteps[0]
        let current = detail.execution.guideSteps[1]
        let next = detail.execution.guideSteps[2]
        #expect(OutcomeBlockView.stateWord(step: done, isCurrent: false, threadState: .ready) == "Done")
        #expect(OutcomeBlockView.stateWord(step: next, isCurrent: false, threadState: .ready) == "Next")
        #expect(OutcomeBlockView.stateWord(step: current, isCurrent: true, threadState: .ready) == "Albatross can handle it")
        #expect(OutcomeBlockView.stateWord(step: current, isCurrent: true, threadState: .running) == "Albatross works")
        #expect(OutcomeBlockView.stateWord(step: current, isCurrent: true, threadState: .yourTurn) == "Your turn")
        #expect(OutcomeBlockView.stateWord(step: current, isCurrent: true, threadState: .needsAnswer) == "Needs your answer")
        #expect(PlanListView.proofLine(step: done, isCurrent: false, threadState: .ready) == "Done")
        #expect(PlanListView.proofLine(step: current, isCurrent: true, threadState: .readyForYou) == "Ready for you")
    }

    @Test func theDetailsSheetListsTheFilesOfEveryRunNewestFirst() {
        let older = ThreadRunView(run: StepRunView(
            id: "r1", workID: "w", stepKey: "s", stepTitle: "Step", state: .done,
            artifacts: [StepRunView.Artifact(kind: .document, referenceID: "doc_1", title: "Class options")]
        ))
        let newer = ThreadRunView(run: StepRunView(
            id: "r2", workID: "w", stepKey: "s", stepTitle: "Step", state: .done,
            artifacts: [
                StepRunView.Artifact(kind: .page, title: "Confirmation page", url: "https://example.com/confirm"),
                StepRunView.Artifact(kind: .document, referenceID: "doc_1", title: "Class options"),
            ]
        ))
        let files = WorkDetailsBody.artifacts(of: [older, newer])
        #expect(files.map(\.title) == ["Confirmation page", "Class options"])
    }

    @Test func theOutcomeBlockSummarisesAShapeBody() throws {
        let list = try #require(WorkDetail(json: .object([
            "work": .object([
                "_id": .string("w"), "title": .string("Pack for Denver"), "shape": .string("list"),
                "listItems": .array([
                    .object(["id": .string("i1"), "text": .string("Passport"), "done": .bool(true), "addedAt": .number(1_791_392_640_000)]),
                    .object(["id": .string("i2"), "text": .string("Charger"), "done": .bool(false), "addedAt": .number(1_791_392_640_000)]),
                ]),
            ]),
        ])))
        #expect(OutcomeBlockView.shapeLine(list) == "2 items, 1 done")
        let guided = try Self.detail(steps: [("a", false, true)])
        #expect(OutcomeBlockView.shapeLine(guided) == nil)
    }
}

struct HandleItOfferTests {
    @Test func handleItShowsOnlyWhenNothingWorksOrWaits() {
        #expect(ThreadState.ready.offersHandleIt)
        for state: ThreadState in [.planning, .needsAnswer, .running, .yourTurn, .readyForYou, .done, .putDown] {
            #expect(!state.offersHandleIt)
        }
    }
}
