import Foundation
import Testing
@testable import Lab86Mail

// The step runner on the phone: the wire shape (`StepRunView`), what each
// next action does, the words the Brief and the thread share, the page bar,
// and the Brief's "Ready for you" list. The contract is
// docs/albatross-step-runner.md; the block rules are in RunBlockPresentationTests.
struct StepRunTests {
    // MARK: - Fixtures

    /// One handed-off run as `stepRunView` sends it.
    private static let fullRun: JSONValue = .object([
        "id": .string("run_1"),
        "workId": .string("work_1"),
        "stepKey": .string("step-letter"),
        "stepIdentity": .string("step-letter@2"),
        "stepTitle": .string("Send the dispute letter"),
        "state": .string("handed_off"),
        "trigger": .string("brief"),
        "outcome": .string("ready_for_you"),
        "summary": .string("I wrote the dispute letter and saved it as a draft."),
        "log": .array([
            .object(["at": .number(1_759_800_000_000), "text": .string("Reading the charge timeline")]),
            .object(["at": .number(1_759_800_060_000), "text": .string("Writing the letter")]),
        ]),
        "next": .object([
            "kind": .string("review_draft"),
            "label": .string("Read and send"),
            "detail": .string("The draft is in your Drafts."),
            "target": .object([
                "kind": .string("draft"),
                "id": .string("draft_9"),
                "accountId": .string("acct_1"),
            ]),
        ]),
        "artifacts": .array([
            .object([
                "kind": .string("draft"),
                "id": .string("draft_9"),
                "title": .string("Dispute letter"),
                "accountId": .string("acct_1"),
            ]),
            .object([
                "kind": .string("document"),
                "id": .string("doc_3"),
                "title": .string("Charge timeline"),
                "url": .string("/?view=files&office=doc_3"),
            ]),
        ]),
        "browserSessionId": .string("sess_1"),
        "stoppedBy": .null,
        "error": .null,
        "createdAt": .number(1_759_799_000_000),
        "updatedAt": .number(1_759_800_060_000),
        "finishedAt": .number(1_759_800_060_000),
    ])

    /// A run on the wire, in one state, for the card rules.
    private static func runJSON(
        id: String = "run_x",
        stepKey: String = "step-letter",
        state: String,
        outcome: String? = nil,
        stoppedBy: String? = nil,
        nextKind: String? = nil,
        error: String? = nil
    ) -> JSONValue {
        var row: [String: JSONValue] = [
            "id": .string(id),
            "workId": .string("work_1"),
            "stepKey": .string(stepKey),
            "stepTitle": .string("Send the dispute letter"),
            "state": .string(state),
            "trigger": .string("user"),
            "log": .array([.object(["at": .number(1_759_800_000_000), "text": .string("Starting")])]),
        ]
        if let outcome { row["outcome"] = .string(outcome) }
        if let stoppedBy { row["stoppedBy"] = .string(stoppedBy) }
        if let nextKind { row["next"] = .object(["kind": .string(nextKind), "label": .string("Go")]) }
        if let error { row["error"] = .string(error) }
        return .object(row)
    }

    /// A `work_home` detail with one current step and the runner fields.
    private static func detailJSON(
        run: JSONValue?,
        active: JSONValue?,
        runnerEnabled: Bool?,
        runnable: Bool? = true
    ) -> JSONValue {
        var step: [String: JSONValue] = [
            "key": .string("step-letter"),
            "kind": .string("task"),
            "title": .string("Send the dispute letter"),
        ]
        if let runnable { step["runnable"] = .bool(runnable) }
        if let run { step["run"] = run }
        var execution: [String: JSONValue] = [
            "currentStep": .object(step),
            "guideSteps": .array([.object(step)]),
            "remainingSteps": .number(1),
            "totalSteps": .number(1),
        ]
        if let active { execution["activeRun"] = active }
        if let runnerEnabled { execution["runner"] = .object(["enabled": .bool(runnerEnabled)]) }
        return .object([
            "work": .object(["_id": .string("work_1"), "title": .string("Dispute the charge")]),
            "execution": .object(execution),
        ])
    }

    private static func detail(
        run: JSONValue?,
        active: JSONValue? = nil,
        runnerEnabled: Bool? = true,
        runnable: Bool? = true
    ) throws -> WorkDetail {
        try #require(WorkDetail(json: detailJSON(run: run, active: active, runnerEnabled: runnerEnabled, runnable: runnable)))
    }

    private static func next(
        _ kind: StepRunView.Next.Kind,
        target: StepRunView.Target? = nil
    ) -> StepRunView.Next {
        StepRunView.Next(kind: kind, label: nil, detail: nil, target: target)
    }

    // MARK: - Decoding

    @Test func decodesTheFullRun() throws {
        let run = try #require(StepRunView(json: Self.fullRun))
        #expect(run.id == "run_1")
        #expect(run.workID == "work_1")
        #expect(run.stepKey == "step-letter")
        #expect(run.stepIdentity == "step-letter@2")
        #expect(run.stepTitle == "Send the dispute letter")
        #expect(run.state == .handedOff)
        #expect(run.trigger == .brief)
        #expect(run.outcome == .readyForYou)
        #expect(run.summary == "I wrote the dispute letter and saved it as a draft.")
        #expect(run.log.count == 2)
        #expect(run.log.first?.at == Date(timeIntervalSince1970: 1_759_800_000))
        #expect(run.latestLogLine?.text == "Writing the letter")
        #expect(run.next?.kind == .reviewDraft)
        #expect(run.next?.label == "Read and send")
        #expect(run.next?.detail == "The draft is in your Drafts.")
        #expect(run.next?.target?.kind == .draft)
        #expect(run.next?.target?.id == "draft_9")
        #expect(run.next?.target?.accountID == "acct_1")
        #expect(run.artifacts.map(\.kind) == [.draft, .document])
        #expect(run.artifacts.last?.url == "/?view=files&office=doc_3")
        #expect(run.browserSessionID == "sess_1")
        #expect(run.stoppedBy == nil)
        #expect(run.error == nil)
        #expect(run.createdAt == Date(timeIntervalSince1970: 1_759_799_000))
        #expect(run.finishedAt == Date(timeIntervalSince1970: 1_759_800_060))
        #expect(run.isHandoff)
    }

    @Test func decodesTheMinimalRun() throws {
        let run = try #require(StepRunView(json: .object(["id": .string("run_2")])))
        #expect(run.id == "run_2")
        #expect(run.workID.isEmpty)
        #expect(run.stepTitle == "This step")
        #expect(run.state == .unknown)
        #expect(run.trigger == .unknown)
        #expect(run.outcome == nil)
        #expect(run.summary == nil)
        #expect(run.log.isEmpty)
        #expect(run.next == nil)
        #expect(run.artifacts.isEmpty)
        #expect(run.stoppedBy == nil)
        #expect(run.createdAt == nil)
        #expect(!run.isHandoff)
    }

    @Test func aRunWithoutAnIDIsNotARun() {
        #expect(StepRunView(json: .object(["state": .string("running")])) == nil)
        #expect(StepRunView(json: .null) == nil)
    }

    @Test func unknownWordsReadAsUnknownNotAsAFailure() throws {
        var json = try #require(Self.fullRun.objectValue)
        json["state"] = .string("paused")
        json["trigger"] = .string("cron")
        json["outcome"] = .string("later")
        json["stoppedBy"] = .string("tokens")
        json["next"] = .object([
            "kind": .string("dance"),
            "label": .string("Dance"),
            "target": .object(["kind": .string("thing"), "url": .string("https://example.com/x")]),
        ])
        json["artifacts"] = .array([.object(["kind": .string("video"), "title": .string("Clip")])])
        let run = try #require(StepRunView(json: .object(json)))
        #expect(run.state == .unknown)
        #expect(run.trigger == .unknown)
        #expect(run.outcome == .unknown)
        #expect(run.stoppedBy == .unknown)
        #expect(run.next?.kind == .unknown)
        #expect(run.next?.label == "Dance")
        #expect(run.next?.target?.kind == .unknown)
        #expect(run.artifacts.first?.kind == .unknown)
        #expect(run.artifacts.first?.kind.label == "File")
        // An unknown action with a link still opens the link.
        #expect(StepRunNextBehaviour.from(run.next) == .openURL("https://example.com/x"))
    }

    @Test func blankWordsAndNullsReadAsAbsent() throws {
        var json = try #require(Self.fullRun.objectValue)
        json["summary"] = .string("   ")
        json["next"] = .null
        json["artifacts"] = .array([.object(["kind": .string("draft"), "title": .string("")])])
        json["log"] = .array([.object(["at": .number(1), "text": .string("")])])
        let run = try #require(StepRunView(json: .object(json)))
        #expect(run.summary == nil)
        #expect(run.next == nil)
        #expect(run.artifacts.isEmpty)
        #expect(run.log.isEmpty)
    }

    @Test func theDefaultLabelAndTheLabelLimit() {
        #expect(StepRunView.Next(kind: .signIn).label == "Sign in")
        #expect(StepRunView.Next(kind: .reviewDraft).label == "Read and send")
        #expect(StepRunView.Next(kind: .continueRun).label == "Continue")
        let long = String(repeating: "a", count: 80)
        #expect(StepRunView.Next(kind: .review, label: long).label.count == StepRunView.Next.labelLimit)
        let fromJSON = StepRunView.Next(json: .object(["kind": .string("approve"), "label": .string(" ")]))
        #expect(fromJSON?.label == "Approve")
    }

    // MARK: - The Work detail

    @Test func theDetailCarriesTheRunsOnItsSteps() throws {
        let subject = try Self.detail(run: Self.fullRun, active: Self.runJSON(id: "run_9", state: "running"))
        #expect(subject.execution.runnerIsEnabled)
        #expect(subject.execution.activeRun?.id == "run_9")
        #expect(subject.execution.activeRun?.state == .running)
        #expect(subject.execution.currentStep?.run?.id == "run_1")
        #expect(subject.execution.guideSteps.first?.run?.outcome == .readyForYou)
        #expect(subject.execution.guideSteps.first?.isRunnable == true)
    }

    @Test func anOlderServerLeavesEveryRunFieldAbsent() throws {
        let subject = try Self.detail(run: nil, active: nil, runnerEnabled: nil, runnable: nil)
        #expect(subject.execution.activeRun == nil)
        #expect(subject.execution.runnerEnabled == nil)
        #expect(!subject.execution.runnerIsEnabled)
        #expect(subject.execution.currentStep?.run == nil)
        #expect(subject.execution.currentStep?.runnable == nil)
        #expect(subject.execution.currentStep?.isRunnable == false)
    }

    @Test func aCachedDetailWithoutRunKeysStillDecodes() throws {
        let subject = try Self.detail(run: Self.fullRun, active: Self.runJSON(id: "run_9", state: "running"))
        let data = try JSONEncoder().encode(subject)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        // A snapshot written before the step runner has no run keys at all.
        let older = Self.stripping(["run", "runnable", "activeRun", "runnerEnabled"], from: object)
        let decoded = try JSONDecoder().decode(
            WorkDetail.self,
            from: JSONSerialization.data(withJSONObject: older)
        )
        #expect(decoded.execution.activeRun == nil)
        #expect(decoded.execution.runnerEnabled == nil)
        #expect(decoded.execution.guideSteps.first?.run == nil)
        #expect(decoded.execution.guideSteps.first?.runnable == nil)
        #expect(decoded.work.id == "work_1")
    }

    @Test func aCachedRunWithANewerWordStillDecodes() throws {
        let subject = try Self.detail(run: Self.fullRun, active: nil)
        let data = try JSONEncoder().encode(subject)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let newer = Self.replacing(key: "state", with: "paused", in: object)
        let decoded = try JSONDecoder().decode(
            WorkDetail.self,
            from: JSONSerialization.data(withJSONObject: newer)
        )
        #expect(decoded.execution.guideSteps.first?.run?.state == .unknown)
        #expect(decoded.execution.guideSteps.first?.run?.next?.kind == .reviewDraft)
    }

    @Test func completingAStepKeepsItsRun() throws {
        let subject = try Self.detail(run: Self.fullRun, active: nil)
        let done = subject.completing(stepID: "step-letter")
        #expect(done.execution.guideSteps.first?.done == true)
        #expect(done.execution.guideSteps.first?.run?.id == "run_1")
        #expect(done.execution.runnerIsEnabled)
    }

    // MARK: - Next actions

    @Test func eachNextActionMapsToOneBehaviour() {
        #expect(
            StepRunNextBehaviour.from(Self.next(.reviewDraft, target: .init(kind: .draft, id: "d1", accountID: "a1")))
                == .openDraft(id: "d1", accountID: "a1")
        )
        #expect(StepRunNextBehaviour.from(Self.next(.reviewDraft)) == .none)
        #expect(
            StepRunNextBehaviour.from(Self.next(.reviewDocument, target: .init(kind: .document, url: "/?view=files&office=doc_3")))
                == .openDocument(id: nil, url: "/?view=files&office=doc_3")
        )
        #expect(StepRunNextBehaviour.from(Self.next(.reviewDocument)) == .none)
        #expect(StepRunNextBehaviour.from(Self.next(.approve, target: .init(kind: .approval, id: "ap_1"))) == .openApproval(id: "ap_1"))
        #expect(StepRunNextBehaviour.from(Self.next(.signIn, target: .init(kind: .session, id: "s1"))) == .openBrowser)
        #expect(StepRunNextBehaviour.from(Self.next(.finishOnPage)) == .openBrowser)
        #expect(StepRunNextBehaviour.from(Self.next(.answer, target: .init(kind: .question, id: "q1"))) == .showQuestion(id: "q1"))
        #expect(StepRunNextBehaviour.from(Self.next(.doOffline)) == .markStepDone)
        #expect(StepRunNextBehaviour.from(Self.next(.review, target: .init(kind: .url, url: "https://example.com"))) == .openURL("https://example.com"))
        #expect(StepRunNextBehaviour.from(Self.next(.review)) == .showArtifacts)
        #expect(StepRunNextBehaviour.from(Self.next(.continueRun)) == .resume)
        #expect(StepRunNextBehaviour.from(Self.next(.unknown)) == .none)
        #expect(StepRunNextBehaviour.from(nil) == .none)
    }

    @Test func continueShowsOnlyAfterAPageHandoff() {
        #expect(StepRunNextBehaviour.showsContinue(Self.next(.signIn)))
        #expect(StepRunNextBehaviour.showsContinue(Self.next(.finishOnPage)))
        #expect(!StepRunNextBehaviour.showsContinue(Self.next(.reviewDraft)))
        #expect(!StepRunNextBehaviour.showsContinue(Self.next(.continueRun)))
        #expect(!StepRunNextBehaviour.showsContinue(nil))
    }

    @Test func thePrimaryButtonHidesForQuestionsAndArtifacts() {
        #expect(!StepRunNextBehaviour.showQuestion(id: "q1").showsPrimaryButton)
        #expect(!StepRunNextBehaviour.showArtifacts.showsPrimaryButton)
        #expect(!StepRunNextBehaviour.none.showsPrimaryButton)
        #expect(StepRunNextBehaviour.openBrowser.showsPrimaryButton)
        #expect(StepRunNextBehaviour.resume.showsPrimaryButton)
        #expect(StepRunNextBehaviour.markStepDone.showsPrimaryButton)
    }

    /// A handed-off run with one next action, for the button table.
    private static func handoff(
        _ outcome: StepRunView.Outcome?,
        next: StepRunView.Next?
    ) -> StepRunView {
        StepRunView(
            id: "run_h",
            workID: "work_1",
            stepKey: "step-hours",
            stepTitle: "Fill in the hours",
            state: .handedOff,
            outcome: outcome,
            next: next
        )
    }

    // docs/albatross-document-handoff.md, D2: a result that waits for the
    // user's check opens with the primary button and "Mark step done" beside
    // it; with nothing to open, "Mark step done" is the primary button.
    @Test func theHandoffButtonsFollowTheDocumentHandoffTable() {
        let document = Self.next(.reviewDocument, target: .init(kind: .document, id: "doc_1"))
        let opens = Self.handoff(.readyForYou, next: document)
        #expect(RunBlockHandoffAction.primary(for: opens) == .next(.openDocument(id: "doc_1", url: nil), label: "Open the document"))
        #expect(RunBlockHandoffAction.marksDone(opens))

        let draft = Self.handoff(.readyForYou, next: Self.next(.reviewDraft, target: .init(kind: .draft, id: "d1", accountID: "a1")))
        #expect(RunBlockHandoffAction.primary(for: draft) == .next(.openDraft(id: "d1", accountID: "a1"), label: "Read and send"))
        #expect(RunBlockHandoffAction.marksDone(draft))

        let page = Self.handoff(.readyForYou, next: Self.next(.review, target: .init(kind: .url, url: "https://example.com/r")))
        #expect(RunBlockHandoffAction.primary(for: page) == .next(.openURL("https://example.com/r"), label: "Open"))
        #expect(RunBlockHandoffAction.marksDone(page))

        // Nothing opens: a review with no link, a document with no target.
        let review = Self.handoff(.readyForYou, next: Self.next(.review))
        #expect(RunBlockHandoffAction.primary(for: review) == .markDone)
        #expect(!RunBlockHandoffAction.marksDone(review))
        let noTarget = Self.handoff(.readyForYou, next: Self.next(.reviewDocument))
        #expect(RunBlockHandoffAction.primary(for: noTarget) == .markDone)
        #expect(!RunBlockHandoffAction.marksDone(noTarget))

        // Only a result to check marks done; the user's turn keeps its old rule.
        let yourTurn = Self.handoff(.yourTurn, next: Self.next(.review))
        #expect(RunBlockHandoffAction.primary(for: yourTurn) == .none)
        #expect(!RunBlockHandoffAction.marksDone(yourTurn))
        let offline = Self.handoff(.yourTurn, next: Self.next(.doOffline))
        #expect(RunBlockHandoffAction.primary(for: offline) == .next(.markStepDone, label: "Mark this step done"))
        #expect(!RunBlockHandoffAction.marksDone(offline))
        let signIn = Self.handoff(.yourTurn, next: Self.next(.signIn))
        #expect(RunBlockHandoffAction.primary(for: signIn) == .next(.openBrowser, label: "Sign in"))
        #expect(!RunBlockHandoffAction.marksDone(signIn))

        // A question has no button; a run with no next action continues.
        #expect(RunBlockHandoffAction.primary(for: Self.handoff(.needsAnswer, next: Self.next(.answer))) == .none)
        #expect(RunBlockHandoffAction.primary(for: Self.handoff(.readyForYou, next: nil)) == .next(.resume, label: "Continue"))
        #expect(!RunBlockHandoffAction.marksDone(Self.handoff(.readyForYou, next: nil)))
        // A stopped run and a done run draw other blocks.
        let stopped = StepRunView(id: "r", workID: "w", stepKey: "s", stepTitle: "S", state: .handedOff, outcome: .stopped, stoppedBy: .time)
        #expect(RunBlockHandoffAction.primary(for: stopped) == .none)
        #expect(RunBlockHandoffAction.primary(for: stopped.with(state: .done)) == .none)
        #expect(RunBlockCopy.markStepDone == "Mark step done")
    }

    @Test func theDocumentIDComesFromTheOpenPath() {
        #expect(StepRunCopy.documentID(fromURL: "/?view=files&office=doc_3") == "doc_3")
        #expect(StepRunCopy.documentID(fromURL: "https://mail.lab86.io/?view=files&document=doc_4") == "doc_4")
        #expect(StepRunCopy.documentID(fromURL: "/files") == nil)
        #expect(StepRunCopy.documentID(fromURL: nil) == nil)
        #expect(StepRunCopy.documentID(fromURL: "") == nil)
    }

    // MARK: - Copy

    @Test func theHeadlineFollowsTheOutcome() throws {
        func run(_ outcome: String?, stoppedBy: String? = nil) throws -> StepRunView {
            try #require(StepRunView(json: Self.runJSON(state: "handed_off", outcome: outcome, stoppedBy: stoppedBy)))
        }
        #expect(try StepRunCopy.headline(run("ready_for_you")) == "Ready for you")
        #expect(try StepRunCopy.headline(run("your_turn")) == "Your turn")
        #expect(try StepRunCopy.headline(run("needs_answer")) == "Needs your answer")
        #expect(try StepRunCopy.headline(run("stopped", stoppedBy: "cost")) == "Stopped")
        #expect(try StepRunCopy.headline(run(nil)) == "Ready for you")
        #expect(StepRunCopy.limitLine(nil) == nil)
        #expect(StepRunCopy.limitLine(.time) == "Albatross stopped at its time limit.")
    }

    @Test func theProgressLineIsTheNewestLogLineOrTheState() throws {
        let queued = try #require(StepRunView(json: .object(["id": .string("r"), "state": .string("queued")])))
        #expect(StepRunCopy.progressLine(queued) == "Starts soon.")
        let running = try #require(StepRunView(json: .object(["id": .string("r"), "state": .string("running")])))
        #expect(StepRunCopy.progressLine(running) == "Albatross works on this step.")
        let logged = try #require(StepRunView(json: Self.runJSON(state: "running")))
        #expect(StepRunCopy.progressLine(logged) == "Starting")
        #expect(StepRunCopy.workingLine(logged) == "In progress: Send the dispute letter")
        #expect(StepRunCopy.triggerLine(logged) == "Started by you")
    }

    @Test func theBriefRowSaysWhatWaitsOrWhatHappens() throws {
        let handoff = try #require(StepRunView(json: Self.fullRun))
        #expect(StepRunCopy.readyRowTitle(handoff) == "Send the dispute letter")
        #expect(StepRunCopy.readyRowLine(handoff) == "I wrote the dispute letter and saved it as a draft.")
        let open = try #require(StepRunView(json: Self.runJSON(state: "running")))
        #expect(StepRunCopy.readyRowTitle(open) == "In progress: Send the dispute letter")
        #expect(StepRunCopy.readyRowLine(open) == "Starting")
    }

    // MARK: - Optimistic writes

    @Test func handleItWritesAQueuedRunOnTheDetail() throws {
        let subject = try Self.detail(run: nil)
        let queued = StepRunView.queued(id: "run_new", workID: "work_1", stepKey: "step-letter", stepTitle: "Send the dispute letter")
        let next = subject.withStepRun(queued)
        #expect(next.execution.activeRun?.id == "run_new")
        #expect(next.execution.currentStep?.run?.state == .queued)
        #expect(next.execution.guideSteps.first?.run?.id == "run_new")
        // A queued run shows its block at once: the run state is "Starts soon".
        #expect(RunBlockState.from(queued) == .queued)
    }

    @Test func stopWritesTheCancelOnTheDetail() throws {
        let subject = try Self.detail(run: Self.runJSON(id: "run_9", state: "running"), active: Self.runJSON(id: "run_9", state: "running"))
        let run = try #require(subject.execution.activeRun)
        let next = subject.withStepRun(run.with(state: .cancelled))
        #expect(next.execution.activeRun == nil)
        #expect(next.execution.currentStep?.run?.state == .cancelled)
    }

    @Test func anOpenRunOnAnotherStepLeavesThisStepQuiet() throws {
        let subject = try Self.detail(
            run: nil,
            active: Self.runJSON(id: "run_9", stepKey: "step-else", state: "running"),
            runnable: false
        )
        #expect(subject.execution.currentStep?.run == nil)
        #expect(subject.execution.activeRun?.stepKey == "step-else")
    }

    @Test func aRunOnAnotherStepLeavesTheActiveRunAlone() throws {
        let subject = try Self.detail(run: nil, active: Self.runJSON(id: "run_9", state: "running"))
        let other = StepRunView(id: "run_other", workID: "work_1", stepKey: "step-else", stepTitle: "Else", state: .closed)
        let next = subject.withStepRun(other)
        #expect(next.execution.activeRun?.id == "run_9")
        #expect(next.execution.currentStep?.run == nil)
    }

    // MARK: - The shared browser

    @Test func theBrowserBarSaysWhoHasThePage() throws {
        let run = try #require(StepRunView(json: Self.runJSON(state: "handed_off", outcome: "your_turn", nextKind: "sign_in")))
        func session(_ status: String, detail: String? = nil) -> WorkBrowserSessionPayload {
            WorkBrowserSessionPayload(
                sessionId: "s1",
                status: status,
                statusDetail: detail,
                stepKey: "step-letter",
                liveViewUrl: "https://live.example/s1",
                replayUrl: nil,
                updatedAt: nil
            )
        }
        let agent = StepRunBrowserPresentation(session: session("agent", detail: "Opening the dispute form"), run: run, followed: true)
        #expect(agent.agentHasPage)
        #expect(!agent.showsContinue)
        #expect(agent.statusLine == "Opening the dispute form")
        #expect(agent.liveViewURL == "https://live.example/s1")

        let quietAgent = StepRunBrowserPresentation(session: session("starting"), run: run, followed: true)
        #expect(quietAgent.statusLine == "Albatross has the page.")

        let user = StepRunBrowserPresentation(session: session("user", detail: "Session detail"), run: run, followed: true)
        #expect(!user.agentHasPage)
        #expect(user.showsContinue)
        // This run's next action has no detail, so the session detail shows.
        #expect(user.statusLine == "Session detail")

        let plainUser = StepRunBrowserPresentation(session: session("user"), run: run, followed: true)
        #expect(plainUser.statusLine == "Your turn on the page. Press Continue when you are done.")

        let tookOver = StepRunBrowserPresentation(session: session("agent"), run: run, followed: true, tookOver: true)
        #expect(!tookOver.agentHasPage)
        #expect(tookOver.showsContinue)

        let closed = StepRunBrowserPresentation(session: nil, run: run, followed: true)
        #expect(closed.statusLine == "The page is closed.")
        #expect(closed.showsContinue)
        #expect(closed.liveViewURL == nil)

        let opening = StepRunBrowserPresentation(session: nil, run: run, followed: false)
        #expect(opening.statusLine == "Opening the shared browser…")
        #expect(!opening.showsContinue)
    }

    @Test func theHandoffDetailLeadsTheBrowserBar() throws {
        var json = try #require(Self.runJSON(state: "handed_off", outcome: "your_turn").objectValue)
        json["next"] = .object([
            "kind": .string("sign_in"),
            "label": .string("Sign in"),
            "detail": .string("Sign in, then press Continue."),
        ])
        let run = try #require(StepRunView(json: .object(json)))
        let session = WorkBrowserSessionPayload(
            sessionId: "s1",
            status: "user",
            statusDetail: "Session detail",
            stepKey: nil,
            liveViewUrl: "https://live.example/s1",
            replayUrl: nil,
            updatedAt: nil
        )
        let bar = StepRunBrowserPresentation(session: session, run: run, followed: true)
        #expect(bar.statusLine == "Sign in, then press Continue.")
    }

    // MARK: - The Brief list

    @Test func theHandoffListReadsItemsAndBareArrays() throws {
        let item: JSONValue = .object([
            "workId": .string("work_1"),
            "workTitle": .string("Dispute the charge"),
            "run": Self.fullRun,
        ])
        let wrapped = StepHandoffItem.list(from: .object(["ok": .bool(true), "items": .array([item, .object(["workId": .string("x")])])]))
        #expect(wrapped.count == 1)
        #expect(wrapped.first?.workID == "work_1")
        #expect(wrapped.first?.workTitle == "Dispute the charge")
        #expect(wrapped.first?.run.id == "run_1")
        #expect(wrapped.first?.id == "run_1")
        let bare = StepHandoffItem.list(from: .array([item]))
        #expect(bare.count == 1)
        #expect(StepHandoffItem.list(from: .object(["ok": .bool(true)])).isEmpty)
        // A row without a title falls back to the step title.
        let untitled = try #require(StepHandoffItem(json: .object(["run": Self.fullRun])))
        #expect(untitled.workTitle == "Send the dispute letter")
        #expect(untitled.workID == "work_1")
    }

    @Test func readyForYouMountsOnlyOnTheLatestEdition() {
        #expect(BriefOwnerMounts.mountsReadyForYou(hasReport: true, showsLatest: true))
        #expect(!BriefOwnerMounts.mountsReadyForYou(hasReport: true, showsLatest: false))
        #expect(!BriefOwnerMounts.mountsReadyForYou(hasReport: false, showsLatest: true))
    }

    private struct ScriptedHandoffs: StepHandoffTransport {
        let result: Result<[StepHandoffItem], TestFailure>
        func listHandoffs() async throws -> [StepHandoffItem] { try result.get() }
    }

    private struct TestFailure: Error {}

    @Test @MainActor func theListStoreHidesUntilThereIsARow() async throws {
        let store = ReadyForYouStore()
        #expect(!store.isVisible)
        #expect(!store.loaded)
        let item = try #require(StepHandoffItem(json: .object([
            "workId": .string("work_1"),
            "workTitle": .string("Dispute the charge"),
            "run": Self.fullRun,
        ])))
        await store.load(ScriptedHandoffs(result: .success([item])))
        #expect(store.loaded)
        #expect(store.isVisible)
        #expect(store.items.map(\.id) == ["run_1"])
        #expect(store.error == nil)

        // A failed poll keeps the last list and never shows on the Brief.
        await store.load(ScriptedHandoffs(result: .failure(TestFailure())))
        #expect(store.items.count == 1)
        #expect(store.error != nil)
        #expect(store.isVisible)

        store.remove(id: "run_1")
        #expect(!store.isVisible)

        await store.load(ScriptedHandoffs(result: .success([])))
        #expect(!store.isVisible)
        #expect(store.error == nil)
    }

    // MARK: - Saved sign-ins

    @Test func theBrowserContextReadsSaved() {
        let saved = BrowserContextStatus(json: .object([
            "ok": .bool(true),
            "saved": .bool(true),
            "createdAt": .number(1_759_700_000_000),
            "lastUsedAt": .number(1_759_800_000_000),
        ]))
        #expect(saved.saved)
        #expect(saved.lastUsedAt == Date(timeIntervalSince1970: 1_759_800_000))
        #expect(saved.line(locale: Locale(identifier: "en_US")).hasPrefix("Saved · last used "))
        let none = BrowserContextStatus(json: .object(["ok": .bool(true), "saved": .bool(false)]))
        #expect(!none.saved)
        #expect(none.line() == "None saved")
        #expect(BrowserContextStatus(json: .object([:])).saved == false)
        #expect(BrowserContextStatus(saved: true).line() == "Saved")
        #expect(SavedSignInsCopy.explanation.contains("Albatross never sees a password."))
    }

    // MARK: - JSON helpers

    private static func stripping(_ keys: Set<String>, from value: Any) -> Any {
        if let object = value as? [String: Any] {
            var next: [String: Any] = [:]
            for (key, inner) in object where !keys.contains(key) {
                next[key] = stripping(keys, from: inner)
            }
            return next
        }
        if let array = value as? [Any] {
            return array.map { stripping(keys, from: $0) }
        }
        return value
    }

    private static func replacing(key target: String, with replacement: Any, in value: Any) -> Any {
        if let object = value as? [String: Any] {
            var next: [String: Any] = [:]
            for (key, inner) in object {
                next[key] = key == target ? replacement : replacing(key: target, with: replacement, in: inner)
            }
            return next
        }
        if let array = value as? [Any] {
            return array.map { replacing(key: target, with: replacement, in: $0) }
        }
        return value
    }
}
