#if os(macOS)
import Foundation
import Testing
@testable import Lab86Mail

// The Mac split of the step runner: when the live pane shows beside the
// step, how wide it is, and what an empty pane says. The shared rules are in
// StepRunTests; these are the Mac additions.
struct MacStepRunTests {
    private static func run(
        state: StepRunView.State,
        session: String? = "sess_1",
        next: StepRunView.Next? = nil
    ) -> StepRunView {
        StepRunView(
            id: "run_1",
            workID: "work_1",
            stepKey: "step-form",
            stepTitle: "Open the dispute form",
            state: state,
            next: next,
            browserSessionID: session
        )
    }

    @Test func aNarrowColumnNeverShowsThePane() {
        let run = Self.run(state: .running)
        #expect(!MacStepRunSplitLayout.showsLivePane(width: 959, run: run))
        #expect(MacStepRunSplitLayout.showsLivePane(width: 960, run: run))
    }

    @Test func anOpenRunShowsThePaneOnlyWithASession() {
        #expect(MacStepRunSplitLayout.showsLivePane(width: 1_200, run: Self.run(state: .queued)))
        #expect(!MacStepRunSplitLayout.showsLivePane(width: 1_200, run: Self.run(state: .running, session: nil)))
    }

    @Test func aPageHandoffShowsThePaneAndADraftHandoffDoesNot() {
        let signIn = Self.run(state: .handedOff, session: nil, next: StepRunView.Next(kind: .signIn))
        let finish = Self.run(state: .handedOff, next: StepRunView.Next(kind: .finishOnPage))
        let draft = Self.run(
            state: .handedOff,
            next: StepRunView.Next(kind: .reviewDraft, target: StepRunView.Target(kind: .draft, id: "d1"))
        )
        #expect(MacStepRunSplitLayout.showsLivePane(width: 1_200, run: signIn))
        #expect(MacStepRunSplitLayout.showsLivePane(width: 1_200, run: finish))
        #expect(!MacStepRunSplitLayout.showsLivePane(width: 1_200, run: draft))
    }

    @Test func aClosedRunShowsNoPane() {
        #expect(!MacStepRunSplitLayout.showsLivePane(width: 1_200, run: Self.run(state: .done)))
        #expect(!MacStepRunSplitLayout.showsLivePane(width: 1_200, run: Self.run(state: .failed)))
        #expect(!MacStepRunSplitLayout.showsLivePane(width: 1_200, run: nil))
    }

    @Test func thePaneTakesAboutHalfTheColumnWithinItsLimits() {
        #expect(MacStepRunSplitLayout.paneWidth(for: 960) == 499)
        #expect(MacStepRunSplitLayout.paneWidth(for: 800) == MacStepRunSplitLayout.paneMinWidth)
        #expect(MacStepRunSplitLayout.paneWidth(for: 1_600) == MacStepRunSplitLayout.paneMaxWidth)
    }

    @Test func anEmptyPaneSaysWhatHappens() {
        let open = Self.run(state: .running)
        let handoff = Self.run(state: .handedOff, next: StepRunView.Next(kind: .signIn))
        #expect(MacStepRunLiveCopy.placeholder(run: open, followed: false) == MacStepRunLiveCopy.opening)
        #expect(MacStepRunLiveCopy.placeholder(run: open, followed: true) == MacStepRunLiveCopy.noPageYet)
        #expect(MacStepRunLiveCopy.placeholder(run: handoff, followed: true) == MacStepRunLiveCopy.closed)
    }
}
#endif
