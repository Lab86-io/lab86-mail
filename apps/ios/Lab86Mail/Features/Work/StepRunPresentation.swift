import Foundation

// The pure rules behind the step runner surfaces: which card the "Do this
// next" section draws, what the primary button of a handoff does, and the
// words each state uses. Views stay thin and these rules stay testable.
// The web pins the same rules in `components/albatross/StepRunPanel`.

/// What the "Do this next" section shows for the current step.
enum StepRunCardState: Equatable, Sendable {
    /// No run controls: the runner is off, or the step is not runnable.
    case quiet
    /// The step is runnable. The section offers "Handle it".
    case eligible
    /// The run works. The section shows the log and "Stop".
    case open(StepRunView)
    /// The run ended with a handoff. The section shows the handoff card.
    case handedOff(StepRunView)
    /// The run hit its time or cost limit. The section offers "Continue".
    case stopped(StepRunView)
    /// The run failed. The section shows the error and "Try again".
    case failed(StepRunView)

    var run: StepRunView? {
        switch self {
        case .quiet, .eligible: nil
        case .open(let run), .handedOff(let run), .stopped(let run), .failed(let run): run
        }
    }

    /// The usual step buttons ("Mark this step done", the site buttons) hide
    /// while Albatross works or a handoff waits. "Dismiss" brings them back.
    /// A failed run keeps them: the user can still do the step by hand.
    var hidesStepActions: Bool {
        switch self {
        case .quiet, .eligible, .failed: false
        case .open, .handedOff, .stopped: true
        }
    }
}

enum StepRunCardPolicy {
    static func state(step: WorkDetail.ExecutionStep, execution: WorkDetail.Execution) -> StepRunCardState {
        guard execution.runnerIsEnabled else { return .quiet }
        // The open run belongs to the whole Work; it shows here only under its
        // own step. Another step's run leaves this step quiet (the server marks
        // it not runnable while that run is open).
        if let active = execution.activeRun, active.state.isOpen, active.stepKey == step.id {
            return .open(active)
        }
        if let run = step.run {
            switch run.state {
            case .queued, .running:
                return .open(run)
            case .handedOff:
                if run.stoppedBy != nil || run.outcome == .stopped { return .stopped(run) }
                return .handedOff(run)
            case .failed:
                return .failed(run)
            case .done, .cancelled, .closed, .unknown:
                break
            }
        }
        return step.isRunnable ? .eligible : .quiet
    }
}

/// What the primary button of a handoff does on this client. The contract's
/// next-action table, as a value the views switch on.
enum StepRunNextBehaviour: Equatable, Sendable {
    case openDraft(id: String, accountID: String?)
    case openDocument(id: String?, url: String?)
    case openApproval(id: String?)
    /// `sign_in` and `finish_on_page`: the shared browser, then "Continue".
    case openBrowser
    /// The Work question with its choices; the answer resumes the run.
    case showQuestion(id: String?)
    /// `do_offline`: the usual step check.
    case markStepDone
    case openURL(String)
    /// `review` with no url: the artifacts are the result.
    case showArtifacts
    /// `continue`: send resume.
    case resume
    case none

    static func from(_ next: StepRunView.Next?) -> StepRunNextBehaviour {
        guard let next else { return .none }
        let target = next.target
        switch next.kind {
        case .reviewDraft:
            guard let id = target?.id else { return .none }
            return .openDraft(id: id, accountID: target?.accountID)
        case .reviewDocument:
            guard target?.id != nil || target?.url != nil else { return .none }
            return .openDocument(id: target?.id, url: target?.url)
        case .approve:
            return .openApproval(id: target?.id)
        case .signIn, .finishOnPage:
            return .openBrowser
        case .answer:
            return .showQuestion(id: target?.id)
        case .doOffline:
            return .markStepDone
        case .review:
            if let url = target?.url { return .openURL(url) }
            return .showArtifacts
        case .continueRun:
            return .resume
        case .unknown:
            if let url = target?.url { return .openURL(url) }
            return .none
        }
    }

    /// The card draws a primary button for these. A question shows its
    /// choices instead, and the artifacts already list themselves.
    var showsPrimaryButton: Bool {
        switch self {
        case .showQuestion, .showArtifacts, .none: false
        default: true
        }
    }

    /// "Continue" is a second button after the user did their part on a page.
    static func showsContinue(_ next: StepRunView.Next?) -> Bool {
        switch next?.kind {
        case .signIn, .finishOnPage: true
        default: false
        }
    }
}

/// The words of each state. One table for the Work page and the Brief.
enum StepRunCopy {
    static func sectionTitle(_ state: StepRunCardState) -> String {
        switch state {
        case .open: "Albatross works on this"
        case .quiet, .eligible, .handedOff, .stopped, .failed: "Do this next"
        }
    }

    /// The headline of a handoff, stopped, or failed card.
    static func headline(_ run: StepRunView) -> String {
        switch run.state {
        case .failed:
            return "This run did not finish."
        case .handedOff:
            if let line = limitLine(run.stoppedBy) { return line }
            switch run.outcome {
            case .yourTurn: return "Your turn"
            case .needsAnswer: return "Albatross needs one answer"
            case .stopped: return "Albatross stopped. Continue when you are ready."
            case .readyForYou, .done, .unknown, .none: return "Ready for you"
            }
        case .queued:
            return "Waiting to start."
        case .running:
            return "Albatross works on this step."
        case .done:
            return "Done"
        case .cancelled:
            return "Stopped"
        case .closed, .unknown:
            return "Ready for you"
        }
    }

    static func limitLine(_ stoppedBy: StepRunView.StoppedBy?) -> String? {
        switch stoppedBy {
        case .time: "Albatross stopped at its time limit."
        case .cost: "Albatross stopped at its cost limit."
        case .unknown: "Albatross stopped at a limit."
        case .none: nil
        }
    }

    /// The one line under an open run: the newest log line, or the state.
    static func progressLine(_ run: StepRunView) -> String {
        if let line = run.latestLogLine { return line.text }
        return run.state == .queued ? "Waiting to start." : "Albatross works on this step."
    }

    static func workingLine(_ run: StepRunView) -> String {
        "Working on: \(run.stepTitle)"
    }

    static func triggerLine(_ run: StepRunView) -> String {
        switch run.trigger {
        case .user: "Started by you"
        case .brief: "Started by the Brief"
        case .conductor: "Started on schedule"
        case .resume: "Continued"
        case .unknown: "Started"
        }
    }

    /// The row title in the Brief: what Albatross does, or the step that waits.
    static func readyRowTitle(_ run: StepRunView) -> String {
        run.state.isOpen ? workingLine(run) : run.stepTitle
    }

    /// The one line of a Brief row.
    static func readyRowLine(_ run: StepRunView) -> String {
        if run.state.isOpen { return progressLine(run) }
        return run.summary ?? run.next?.detail ?? headline(run)
    }

    /// The document id inside an `openPath` (`/?view=files&office=<id>`).
    static func documentID(fromURL raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        let absolute = raw.hasPrefix("/") ? "https://albatross.invalid\(raw)" : raw
        guard let components = URLComponents(string: absolute) else { return nil }
        for item in components.queryItems ?? [] where ["office", "document", "documentId"].contains(item.name) {
            if let value = item.value?.nilIfBlank { return value }
        }
        return nil
    }
}

/// The status bar of the shared browser while a run owns or hands over the
/// page: who has it, and which one control the toolbar offers.
struct StepRunBrowserPresentation: Equatable, Sendable {
    let agentHasPage: Bool
    let statusLine: String
    let showsContinue: Bool
    let liveViewURL: String?

    init(session: WorkBrowserSessionPayload?, run: StepRunView, followed: Bool, tookOver: Bool = false) {
        if let session {
            liveViewURL = session.liveViewUrl
            if session.agentHasPage, !tookOver {
                agentHasPage = true
                showsContinue = false
                statusLine = session.statusDetail?.nilIfBlank ?? "Albatross has the page."
            } else {
                agentHasPage = false
                showsContinue = true
                statusLine = tookOver
                    ? "You have the page. Press Continue when Albatross should go on."
                    : run.next?.detail?.nilIfBlank
                        ?? session.statusDetail?.nilIfBlank
                        ?? "Your turn on the page. Press Continue when you are done."
            }
        } else {
            liveViewURL = nil
            agentHasPage = false
            showsContinue = followed && (run.isHandoff || tookOver)
            statusLine = followed ? "The shared browser is closed." : "Opening the shared browser…"
        }
    }
}
