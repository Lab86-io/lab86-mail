import Foundation
import Testing
@testable import Lab86Mail

// The pure rules of a goal run (docs/albatross-goal-runs.md and the native
// design note of 2026-10-15): a goal Work is never "planning", its plan line
// has no position, the block's subtitle, "Done, continue" on a goal handoff,
// which messages fold, the checklist summary, the package rows, the Brief
// line, and the words. Sample data is invented: Sam Rivera bills Harbor
// Design for the quarter.
@MainActor
struct GoalRunPresentationTests {
    // MARK: - Fixtures

    private static func run(
        id: String = "run_goal",
        state: StepRunView.State,
        outcome: StepRunView.Outcome? = nil,
        stoppedBy: StepRunView.StoppedBy? = nil,
        next: StepRunView.Next? = nil,
        goal: Bool = true,
        messages: [RunMessage] = [],
        checklist: [ChecklistItem] = [],
        items: [HandoffItem] = [],
        unsure: [String] = []
    ) -> ThreadRunView {
        ThreadRunView(run: StepRunView(
            id: id,
            workID: "work_invoice",
            stepKey: goal ? GoalRun.stepKey : "step-invoice",
            stepTitle: goal ? "Bill Harbor Design for the quarter" : "Send the invoice",
            state: state,
            outcome: outcome,
            next: next,
            stoppedBy: stoppedBy,
            goal: goal,
            messages: messages,
            checklist: checklist,
            items: items,
            unsure: unsure
        ))
    }

    private static func detail(goal: Bool, steps: Int = 0, workState: String = "active") throws -> WorkDetail {
        let guide: [JSONValue] = (0..<steps).map { index in
            .object(["key": .string("s\(index)"), "kind": .string("task"), "title": .string("Step \(index)"), "done": .bool(false), "runnable": .bool(true)])
        }
        var json: [String: JSONValue] = [
            "work": .object([
                "_id": .string("work_invoice"),
                "title": .string("Bill Harbor Design for the quarter"),
                "workState": .string(workState),
            ]),
            "execution": .object([
                "guideSteps": .array(guide),
                "remainingSteps": .number(Double(steps)),
                "totalSteps": .number(Double(steps)),
                "runner": .object(["enabled": .bool(true)]),
            ]),
        ]
        if goal { json["goalRuns"] = .bool(true) }
        return try #require(WorkDetail(json: .object(json)))
    }

    private static func message(_ id: String, _ text: String) -> RunMessage {
        RunMessage(id: id, text: text)
    }

    private static let checklist = [
        ChecklistItem(id: "c1", text: "Find the billing address", state: .done),
        ChecklistItem(id: "c2", text: "Find the hours for each month", state: .doing),
        ChecklistItem(id: "c3", text: "Make the invoice", state: .todo),
        ChecklistItem(id: "c4", text: "Sign the W-9", state: .yours),
    ]

    private static let draft = HandoffItem(
        kind: .draft, referenceID: "draft_7", accountID: "acct_1",
        title: "Draft to Priya Shah", state: .check, note: "2 files attached"
    )
    private static let invoice = HandoffItem(
        kind: .document, referenceID: "doc_inv", url: "/?view=files&office=doc_inv",
        title: "Invoice 2026-10 for Harbor Design", state: .blanks, blanks: ["hours for September", "hourly rate"]
    )
    private static let w9 = HandoffItem(
        kind: .file, referenceID: "file_w9", url: "/?view=files&file=file_w9",
        title: "Form W-9", state: .check, note: "The tax ID fills in when you send."
    )
    private static let deck = HandoffItem(
        kind: .deck, referenceID: "doc_deck", url: "/?view=files&document=doc_deck", title: "Quarter review", state: .ready
    )
    private static let portal = HandoffItem(kind: .page, url: "https://harbordesign.example/portal", title: "Client portal")

    private static let readAndSend = StepRunView.Next(
        kind: .reviewDraft, label: "Read and send",
        target: StepRunView.Target(kind: .draft, id: "draft_7", accountID: "acct_1")
    )

    // MARK: - The thread state and the plan line

    @Test func aGoalWorkWithZeroStepsIsNotPlanning() throws {
        let goal = try Self.detail(goal: true)
        #expect(ThreadState.resolve(detail: goal, runs: []) == .ready)
        #expect(ThreadState.resolve(detail: goal, runs: [Self.run(state: .running)]) == .running)
        #expect(ThreadState.resolve(detail: goal, runs: [Self.run(state: .handedOff, outcome: .readyForYou)]) == .readyForYou)
        #expect(ThreadState.resolve(detail: goal, runs: [Self.run(state: .handedOff, outcome: .needsAnswer)]) == .needsAnswer)
        #expect(ThreadState.resolve(detail: goal, runs: [Self.run(state: .handedOff, outcome: .stopped, stoppedBy: .time)]) == .readyForYou)
        #expect(ThreadState.resolve(detail: goal, runs: [Self.run(state: .failed)]) == .ready)
        #expect(ThreadState.resolve(detail: try Self.detail(goal: true, workState: "done"), runs: []) == .done)
        // An older `work_home` without the flag: the goal run alone says so.
        let older = try Self.detail(goal: false)
        #expect(ThreadState.resolve(detail: older, runs: [Self.run(state: .done)]) == .ready)
        #expect(ThreadGoal.isGoalWork(detail: older, runs: [Self.run(state: .done)]))
        #expect(!ThreadGoal.isGoalWork(detail: older, runs: [Self.run(state: .done, goal: false)]))
    }

    @Test func aStepWorkWithZeroStepsStillPlans() throws {
        #expect(ThreadState.resolve(detail: try Self.detail(goal: false), runs: []) == .planning)
        #expect(ThreadState.resolve(detail: try Self.detail(goal: false, steps: 2), runs: []) == .ready)
    }

    @Test func thePlanLineOfAGoalWorkHasNoPosition() {
        #expect(ThreadState.running.planLine(stepNumber: nil, total: 0, goal: true) == "Albatross works on it")
        #expect(ThreadState.running.planLine(stepNumber: 1, total: 2, goal: true) == "Albatross works on it")
        #expect(ThreadState.ready.planLine(stepNumber: nil, total: 0, goal: true) == "Ready")
        #expect(ThreadState.readyForYou.planLine(stepNumber: nil, total: 0, goal: true) == "Ready for you")
        #expect(ThreadState.yourTurn.planLine(stepNumber: nil, total: 0, goal: true) == "Your turn")
        #expect(ThreadState.needsAnswer.planLine(stepNumber: nil, total: 0, goal: true) == "Needs your answer")
        #expect(ThreadState.done.planLine(stepNumber: nil, total: 0, goal: true) == "Done")
        // A step Work keeps its position and its words.
        #expect(ThreadState.running.planLine(stepNumber: 1, total: 2) == "Step 1 of 2 · Albatross works")
    }

    // MARK: - The block

    @Test func theSubtitleNamesTheDoingItemOnlyOnAnOpenGoalRun() {
        let open = Self.run(state: .running, checklist: Self.checklist).run
        #expect(RunBlockCopy.subtitle(open) == "Now: Find the hours for each month")
        // The open checklist says the current item once, on its live row.
        #expect(RunBlockCopy.subtitle(open, checklistOpen: true) == nil)
        #expect(RunBlockCopy.subtitle(Self.run(state: .queued).run) == nil)
        #expect(RunBlockCopy.subtitle(Self.run(state: .handedOff, outcome: .readyForYou, checklist: Self.checklist).run) == nil)
        #expect(RunBlockCopy.subtitle(Self.run(state: .running, goal: false).run) == "Send the invoice")
    }

    @Test func theSecondButtonReadsDoneContinueOnAGoalRun() {
        #expect(RunBlockCopy.secondButtonLabel(Self.run(state: .handedOff, outcome: .readyForYou).run) == "Done, continue")
        #expect(RunBlockCopy.secondButtonLabel(Self.run(state: .handedOff, outcome: .readyForYou, goal: false).run) == "Mark step done")
        #expect(GoalRunCopy.doneContinue == DocumentHandoffCopy.done)
    }

    @Test func aGoalHandoffWithNoNextOffersContinue() {
        let quiet = Self.run(state: .handedOff, outcome: .readyForYou).run
        #expect(RunBlockHandoffAction.primary(for: quiet) == .next(.resume, label: "Continue"))
        #expect(!RunBlockHandoffAction.marksDone(quiet))
        // Nothing opens: the one button is the second button's words.
        let review = Self.run(state: .handedOff, outcome: .readyForYou, next: StepRunView.Next(kind: .review)).run
        #expect(RunBlockHandoffAction.primary(for: review) == .markDone)
        // The draft opens, and "Done, continue" sits beside it.
        let package = Self.run(state: .handedOff, outcome: .readyForYou, next: Self.readAndSend, items: [Self.draft, Self.invoice, Self.w9]).run
        #expect(RunBlockHandoffAction.primary(for: package) == .next(.openDraft(id: "draft_7", accountID: "acct_1"), label: "Read and send"))
        #expect(RunBlockHandoffAction.marksDone(package))
    }

    @Test func doneContinueSitsOnAGoalYourTurnThatIsNotAPage() {
        let document = StepRunView.Next(
            kind: .reviewDocument, label: "Open the document",
            target: StepRunView.Target(kind: .document, id: "doc_inv", url: "/?view=files&office=doc_inv")
        )
        #expect(RunBlockHandoffAction.marksDone(Self.run(state: .handedOff, outcome: .yourTurn, next: document).run))
        #expect(!RunBlockHandoffAction.marksDone(Self.run(state: .handedOff, outcome: .yourTurn, next: document, goal: false).run))
        let signIn = StepRunView.Next(kind: .signIn, target: StepRunView.Target(kind: .session, url: "https://irs.gov"))
        #expect(!RunBlockHandoffAction.marksDone(Self.run(state: .handedOff, outcome: .yourTurn, next: signIn).run))
    }

    @Test func theRowsCarryTheBlanksWhenThereIsAPackage() {
        let next = StepRunView.Next(kind: .reviewDocument, detail: "Fill in the invoice.", blanks: ["hours for September"])
        #expect(RunBlockBlanks.draws(Self.run(state: .handedOff, outcome: .readyForYou, next: next).run))
        #expect(!RunBlockBlanks.draws(Self.run(state: .handedOff, outcome: .readyForYou, next: next, items: [Self.invoice]).run))
    }

    // MARK: - Messages and the checklist

    @Test func anOpenRunShowsThreeMessagesAndAnEndedRunOne() {
        let messages = (1...5).map { Self.message("m\($0)", "Message \($0)") }
        let open = GoalRunMessages.split(messages, state: .running)
        #expect(open.shown.map(\.id) == ["m3", "m4", "m5"])
        #expect(open.earlier.map(\.id) == ["m1", "m2"])
        let ended = GoalRunMessages.split(messages, state: .handedOff(.readyForYou))
        #expect(ended.shown.map(\.id) == ["m5"])
        #expect(ended.earlier.count == 4)
        let few = GoalRunMessages.split(Array(messages.prefix(2)), state: .running)
        #expect(few.earlier.isEmpty)
        #expect(few.shown.count == 2)
        #expect(GoalRunMessages.split([], state: .stopped).shown.isEmpty)
    }

    @Test func theChecklistSummaryCountsDoneAndYours() {
        #expect(ChecklistSummary.count(Self.checklist) == "1 of 4 done, 1 for you")
        #expect(ChecklistSummary.count(Array(Self.checklist.prefix(3))) == "1 of 3 done")
        #expect(ChecklistSummary.count([]) == nil)
        #expect(ChecklistSummary.accessibilityLine(Self.checklist) == "Checklist, 1 of 4 done, 1 for you. Now: Find the hours for each month.")
        #expect(ChecklistSummary.accessibilityLine([]) == "Checklist.")
        #expect(ChecklistItem.State.done.word == "Done")
        #expect(ChecklistItem.State.yours.word == "You")
        #expect(ChecklistItem.State.doing.word == nil)
        #expect(ChecklistItem.State.todo.word == nil)
    }

    @Test func theChecklistOpensOnTheNewestOpenOrStoppedRun() {
        #expect(ChecklistSummary.expandedByDefault(isNewest: true, state: .running))
        #expect(ChecklistSummary.expandedByDefault(isNewest: true, state: .stopped))
        #expect(!ChecklistSummary.expandedByDefault(isNewest: true, state: .handedOff(.readyForYou)))
        #expect(!ChecklistSummary.expandedByDefault(isNewest: false, state: .running))
    }

    @Test func markdownKeepsListsAndDropsImagesAndTags() {
        let text = "I found **three** things:\n- the hours\n- the rate\n![chart](https://x.example/c.png) <img src=\"x\"> and <b>bold</b> [HD-214](https://jira.example/HD-214)"
        let safe = RunMessageText.safe(text)
        #expect(safe.contains("**three**"))
        #expect(safe.contains("- the hours"))
        #expect(safe.contains("[HD-214](https://jira.example/HD-214)"))
        #expect(safe.contains("chart"))
        #expect(!safe.contains("!["))
        #expect(!safe.contains("<img"))
        #expect(!safe.contains("<b>"))
        #expect(safe.contains("bold"))
        #expect(RunMessageText.safe("  plain  ") == "plain")
    }

    // MARK: - The package

    @Test func eachPackageRowSaysItsStateAndVerb() {
        // The state word is one short sentence; the note is its own line, no dot joins them.
        #expect(PackageRows.stateWord(Self.draft) == "Check it.")
        #expect(PackageRows.noteLine(Self.draft) == "2 files attached")
        #expect(PackageRows.stateWord(Self.w9) == "Check it.")
        #expect(PackageRows.noteLine(Self.w9) == "The tax ID fills in when you send.")
        #expect(PackageRows.stateWord(Self.deck) == "Ready.")
        #expect(PackageRows.noteLine(Self.deck) == nil)
        let event = HandoffItem(kind: .event, title: "Call", state: .ready, note: "Tuesday at 10")
        #expect(PackageRows.stateWord(event) == "Ready.")
        #expect(PackageRows.noteLine(event) == "Tuesday at 10")
        #expect(PackageRows.stateWord(Self.invoice) == nil)
        #expect(PackageRows.stateLine(Self.invoice) == .blanks(["hours for September", "hourly rate"], note: nil))
        #expect(PackageRows.verb(Self.draft) == "Read and send")
        #expect(PackageRows.verb(Self.invoice) == "Open")
        #expect(PackageRows.verb(Self.portal) == "Open the page")
        #expect(PackageRows.verb(HandoffItem(kind: .approval, title: "Pay the fee")) == "Approve")
        #expect(PackageRows.accessibilityLabel(Self.invoice) == "Invoice 2026-10 for Harbor Design. Document. Fill in hours for September and hourly rate.")
        #expect(PackageRows.accessibilityLabel(Self.deck) == "Quarter review. Deck. Ready.")
        #expect(PackageRows.accessibilityLabel(Self.w9) == "Form W-9. File. Check it. The tax ID fills in when you send.")
    }

    @Test func aSourceCapsuleShowsTheTitleThenOneLocator() {
        let web = RunSource(kind: .web, title: "Form W-9", url: "https://www.irs.gov/forms/w9")
        #expect(RunSourceLocator.text(web) == "irs.gov")
        let jiraByLink = RunSource(kind: .jira, title: "Invoice hours for the quarter", url: "https://harbordesign.example/browse/HD-214?page=worklog")
        #expect(RunSourceLocator.text(jiraByLink) == "HD-214")
        let jiraByTitle = RunSource(kind: .jira, title: "HD-214 worklog", referenceID: "HD-214")
        #expect(RunSourceLocator.text(jiraByTitle) == "HD-214")
        // The title is the key: nothing repeats.
        #expect(RunSourceLocator.text(RunSource(kind: .jira, title: "HD-214", referenceID: "HD-214")) == nil)
        #expect(RunSourceLocator.text(RunSource(kind: .mail, title: "Re: Q3 hours", referenceID: "t1")) == "Mail")
        #expect(RunSourceLocator.text(RunSource(kind: .calendar, title: "Invoice review", referenceID: "ev1")) == "Calendar")
        #expect(RunSourceLocator.text(RunSource(kind: .file, title: "Invoice 2026-09.pdf", referenceID: "f1")) == nil)
        #expect(RunSourceLocator.text(RunSource(kind: .document, title: "Hours sheet", referenceID: "d1")) == nil)
        #expect(RunSourceLocator.text(RunSource(kind: .web, title: "Page", referenceID: "x")) == nil)
    }

    @Test func theBriefLineNamesUpToThreeItems() {
        #expect(PackageRows.line([]) == nil)
        #expect(PackageRows.line([Self.draft]) == "1 item: Draft to Priya Shah.")
        #expect(PackageRows.line([Self.draft, Self.w9]) == "2 items: Draft to Priya Shah and Form W-9.")
        #expect(PackageRows.line([Self.draft, Self.invoice, Self.w9]) == "3 items: Draft to Priya Shah, Invoice 2026-10 for Harbor Design, and Form W-9.")
        #expect(PackageRows.line([Self.draft, Self.invoice, Self.w9, Self.deck, Self.portal]) == "5 items: Draft to Priya Shah, Invoice 2026-10 for Harbor Design, Form W-9, and 2 more.")
        let package = Self.run(state: .handedOff, outcome: .readyForYou, items: [Self.draft, Self.w9]).run
        #expect(StepRunCopy.readyRowPackageLine(package) == "2 items: Draft to Priya Shah and Form W-9.")
        #expect(StepRunCopy.readyRowPackageLine(Self.run(state: .running, items: [Self.draft]).run) == nil)
    }

    @Test func eachItemKindMapsToOneBehaviour() {
        #expect(PackageItemBehaviour.from(Self.draft) == .openDraft(id: "draft_7", accountID: "acct_1"))
        #expect(PackageItemBehaviour.from(HandoffItem(kind: .draft, title: "No id")) == .none)
        #expect(PackageItemBehaviour.from(Self.invoice) == .openDocument(DocumentTarget(provider: .office, id: "doc_inv")))
        #expect(PackageItemBehaviour.from(Self.deck) == .openDocument(DocumentTarget(provider: .albatross, id: "doc_deck")))
        #expect(PackageItemBehaviour.from(Self.w9) == .openFile(fileID: "file_w9", title: "Form W-9"))
        #expect(PackageItemBehaviour.from(HandoffItem(kind: .file, referenceID: "file_2", title: "Lease")) == .openFile(fileID: "file_2", title: "Lease"))
        #expect(PackageItemBehaviour.from(Self.portal) == .openURL("https://harbordesign.example/portal"))
        #expect(PackageItemBehaviour.from(HandoffItem(kind: .approval, referenceID: "ap_1", title: "Pay the fee")) == .openApproval(id: "ap_1"))
        #expect(PackageItemBehaviour.from(HandoffItem(kind: .event, referenceID: "ev_1", accountID: "acct_1", title: "Call")) == .openEvent(accountID: "acct_1", id: "ev_1"))
        #expect(PackageItemBehaviour.from(HandoffItem(kind: .event, url: "https://cal.example/ev", title: "Call")) == .openURL("https://cal.example/ev"))
        #expect(PackageItemBehaviour.from(HandoffItem(kind: .unknown, title: "Walkthrough")) == .none)
        // An id with no link takes the link of the run's own file, as the primary button does.
        let artifacts = [StepRunView.Artifact(kind: .document, referenceID: "doc_inv", title: "Invoice", url: "/?view=files&office=doc_inv")]
        let byID = HandoffItem(kind: .document, referenceID: "doc_inv", title: "Invoice")
        #expect(PackageItemBehaviour.from(byID, artifacts: artifacts) == .openDocument(DocumentTarget(provider: .office, id: "doc_inv")))
        #expect(PackageItemBehaviour.from(Self.draft).opensInDocumentMode)
        #expect(PackageItemBehaviour.from(Self.w9).opensInDocumentMode)
        #expect(!PackageItemBehaviour.from(Self.portal).opensInDocumentMode)
    }

    // MARK: - The Brief and the list

    @Test func theBriefCaptionOfAGoalRunIsTheStateWord() {
        #expect(StepRunCopy.readyRowTitle(Self.run(state: .running).run) == "In progress")
        #expect(StepRunCopy.readyRowTitle(Self.run(state: .queued).run) == "Starts soon")
        #expect(StepRunCopy.readyRowTitle(Self.run(state: .handedOff, outcome: .readyForYou).run) == "Ready for you")
        #expect(StepRunCopy.readyRowTitle(Self.run(state: .running, goal: false).run) == "In progress: Send the invoice")
        #expect(StepRunCopy.readyRowTitle(Self.run(state: .handedOff, outcome: .readyForYou, goal: false).run) == "Send the invoice")
    }

    @Test func theThreadRowNeverRepeatsTheWorkTitle() throws {
        let title = "Bill Harbor Design for the quarter"
        let item = try #require(WorkListItem(json: .object([
            "_id": .string("work_invoice"), "title": .string(title), "rawText": .string(title), "status": .string("ready"),
        ])))
        let goal = ThreadRow(workID: "work_invoice", title: title, status: .inProgress, stepTitle: title, working: true)
        let goalLine = ThreadRowPresentation.statusLine(ThreadListRow(item: item, live: goal))
        #expect(!goalLine.contains(title))
        let step = ThreadRow(workID: "work_invoice", title: title, status: .inProgress, stepTitle: "Find the hours", working: true)
        #expect(ThreadRowPresentation.statusLine(ThreadListRow(item: item, live: step)).hasSuffix("Find the hours"))
    }

    @Test func theCopyHasNoIngForms() {
        let words = [
            GoalRunCopy.earlierMessages, GoalRunCopy.checklist, GoalRunCopy.noChecklist, GoalRunCopy.checklistFooter,
            GoalRunCopy.notSure, GoalRunCopy.openOnWeb, GoalRunCopy.doneContinue, GoalRunCopy.fromAlbatross,
            GoalRunCopy.worksOnIt, GoalRunCopy.now("x"), GoalRunCopy.ready, GoalRunCopy.checkIt, GoalRunCopy.sealedLine(field: "tax ID"),
            GoalRunCopy.sealedComposerLine(field: "tax ID"), GoalRunCopy.tab(index: 1, count: 3),
        ] + HandoffItem.Kind.allWords + HandoffItem.Kind.allVerbs + RunSource.Kind.allWords
        for word in words {
            for token in word.split(separator: " ") {
                #expect(!token.lowercased().hasSuffix("ing"), "\(word)")
            }
        }
    }
}

private extension HandoffItem.Kind {
    static let all: [HandoffItem.Kind] = [.draft, .document, .sheet, .deck, .file, .approval, .event, .page, .unknown]
    static var allWords: [String] { all.map(\.word) }
    static var allVerbs: [String] { all.map(\.verb) }
}

private extension RunSource.Kind {
    static var allWords: [String] {
        [RunSource.Kind.web, .mail, .file, .calendar, .jira, .document, .unknown].map(\.word)
    }
}
