import Foundation

// The pure rules behind the thread surfaces: which block a run draws, the
// words of each state (docs/albatross-thread.md, "Cross-platform decisions",
// item 6: no -ing forms), the thread state and its plan line, the composer
// placeholder, and the jump pill. Views stay thin and these rules stay
// testable. The web and the Mac pin the same words.

/// What the run block draws for one run.
enum RunBlockState: Equatable, Sendable {
    /// The run waits for a worker.
    case queued
    /// The run works. The block shows the log and "Stop".
    case running
    /// The run ended with a handoff that waits for the user.
    case handedOff(StepRunView.Outcome)
    /// The run hit its time or cost limit. The block offers "Continue".
    case stopped
    /// The step is done. The block shows the proof line.
    case done
    /// The run failed. The block shows the error and "Try again".
    case failed
    /// The user stopped it. The block offers "Continue".
    case cancelled
    /// The user dismissed the handoff. One quiet line.
    case closed

    static func from(_ run: StepRunView) -> RunBlockState {
        switch run.state {
        case .queued: return .queued
        case .running: return .running
        case .handedOff:
            if run.stoppedBy != nil || run.outcome == .stopped { return .stopped }
            return .handedOff(run.outcome ?? .readyForYou)
        case .done: return .done
        case .failed: return .failed
        case .cancelled: return .cancelled
        case .closed, .unknown: return .closed
        }
    }

    var isOpen: Bool { self == .queued || self == .running }

    /// The block waits for the user: a handoff, a limit, or a stop.
    var waitsForUser: Bool {
        switch self {
        case .handedOff, .stopped, .cancelled: true
        default: false
        }
    }
}

/// The words of the run block.
enum RunBlockCopy {
    /// The header line.
    static func headline(_ run: StepRunView) -> String {
        switch RunBlockState.from(run) {
        case .queued: return "Starts soon"
        case .running: return "In progress"
        case .handedOff(let outcome):
            switch outcome {
            case .yourTurn: return "Your turn"
            case .needsAnswer: return "Needs your answer"
            case .readyForYou, .done, .stopped, .unknown: return "Ready for you"
            }
        case .stopped: return "Stopped"
        case .done: return "Done"
        case .failed: return "Did not finish"
        case .cancelled: return "Stopped by you"
        case .closed: return "Dismissed"
        }
    }

    /// "In progress: {step}" for an open run; the step title otherwise.
    static func title(_ run: StepRunView) -> String {
        run.state.isOpen ? "In progress: \(run.stepTitle)" : run.stepTitle
    }

    /// The line that names the limit a stopped run hit.
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
        return run.state == .queued ? "Starts soon." : "Albatross works on this step."
    }

    /// "Done · Verified on the page", from the step's verification word.
    static func doneLine(verification: String?) -> String {
        guard let verification = verification?.nilIfBlank else { return "Done" }
        return "Done · \(verification)"
    }

    /// The log disclosure: "What Albatross did" with the count as a quiet number.
    static let logTitle = "What Albatross did"

    /// "Continued · 9:41" between a run and its continuation.
    static func continuedLine(at date: Date?, locale: Locale = .current) -> String {
        guard let date else { return "Continued" }
        return "Continued · " + date.formatted(.dateTime.hour().minute().locale(locale))
    }

    /// The page row: "Albatross is on the page · aliveat25.com".
    static func pageLine(host: String?) -> String {
        guard let host = host?.nilIfBlank else { return "Albatross is on the page" }
        return "Albatross is on the page · \(host)"
    }

    /// The done label of a page handoff: `next.doneLabel`, else "Continue".
    static func doneLabel(_ next: StepRunView.Next?) -> String {
        next?.doneLabel?.nilIfBlank ?? "Continue"
    }

    static let failedFallback = "Albatross could not finish this run."
    static let stopButton = "Stop"
    static let stopBusy = "Stopping…"
    static let continueButton = "Continue"
    static let continueBusy = "Continuing…"
    static let tryAgain = "Try again"
    static let dismiss = "Dismiss"
    static let handleIt = "Handle it"
    static let handleItBusy = "Starting…"
    static let openPage = "Open"
    static let showPage = "Show the page"
    static let hidePage = "Hide the page"

    /// The page row's verb: "Open" on the phone, where the page is a sheet;
    /// "Show the page" on the Mac, where it is a pane.
    static var openPageLabel: String {
        #if os(macOS)
        return showPage
        #else
        return openPage
        #endif
    }
}

/// Where the thread stands, for the plan line, the composer placeholder, and
/// the jump pill.
enum ThreadState: Equatable, Sendable {
    case planning
    case needsAnswer
    case ready
    case running
    case yourTurn
    case readyForYou
    case done
    case putDown

    /// "Handle it" shows only when nothing works on the step and nothing waits
    /// on the user (a question, a sign-in, a final page).
    var offersHandleIt: Bool { self == .ready }

    /// The rule, in priority order: put down, done, planning, a pending
    /// answer, an open run, a handoff, else ready.
    static func resolve(detail: WorkDetail?, runs: [ThreadRunView]) -> ThreadState {
        guard let detail else { return .planning }
        if detail.work.workState == "paused" || detail.work.horizon?.isDormant(at: .now) == true { return .putDown }
        if detail.work.workState == "done" { return .done }
        let steps = detail.execution.guideSteps
        if steps.isEmpty { return .planning }
        if !steps.isEmpty, steps.allSatisfy(\.done) { return .done }
        let newest = runs.last?.run ?? detail.execution.activeRun
        if detail.questions.contains(where: { $0.status == "pending" }) { return .needsAnswer }
        if let newest {
            switch RunBlockState.from(newest) {
            case .queued, .running: return .running
            case .handedOff(let outcome):
                switch outcome {
                case .needsAnswer: return .needsAnswer
                case .yourTurn: return .yourTurn
                case .readyForYou, .done, .stopped, .unknown: return .readyForYou
                }
            case .stopped, .cancelled: return .readyForYou
            case .done, .failed, .closed: break
            }
        }
        if let active = detail.execution.activeRun, active.state.isOpen { return .running }
        return .ready
    }

    /// The plan line under the title: "Step 1 of 2 · Your turn".
    func planLine(stepNumber: Int?, total: Int) -> String {
        let position: String? = {
            guard let stepNumber, total > 0 else { return nil }
            return "Step \(stepNumber) of \(total)"
        }()
        switch self {
        case .planning: return "Albatross makes the plan"
        case .done: return "Done"
        case .putDown: return "Put down"
        case .ready: return position ?? "Ready"
        case .running: return Self.join(position, "Albatross works")
        case .yourTurn: return Self.join(position, "Your turn")
        case .needsAnswer: return Self.join(position, "Needs your answer")
        case .readyForYou: return Self.join(position, "Ready for you")
        }
    }

    /// The composer placeholder (decision 11).
    var composerPlaceholder: String {
        switch self {
        case .needsAnswer: "Answer here, or tell Albatross what to change"
        case .running: "Tell Albatross what to change"
        default: "Tell Albatross what to do"
        }
    }

    private static func join(_ position: String?, _ word: String) -> String {
        guard let position else { return word }
        return "\(position) · \(word)"
    }
}

/// The jump pill above the composer (decision 12).
enum ThreadJumpPill {
    static let newest = "Newest"
    static let answer = "Albatross needs an answer"

    /// Nil when the user is at the bottom. The answer line wins while a
    /// pending form is off screen.
    static func text(atBottom: Bool, pendingFormOffscreen: Bool) -> String? {
        if pendingFormOffscreen { return answer }
        return atBottom ? nil : newest
    }
}

/// The step position of the thread: the current step's number and the total.
enum ThreadPlanPosition {
    static func stepNumber(_ detail: WorkDetail?) -> Int? {
        guard let detail, let current = detail.execution.currentStep else { return nil }
        guard let index = detail.execution.guideSteps.firstIndex(where: { $0.id == current.id }) else { return nil }
        return index + 1
    }

    static func total(_ detail: WorkDetail?) -> Int {
        guard let detail else { return 0 }
        return max(detail.execution.totalSteps, detail.execution.guideSteps.count)
    }
}
