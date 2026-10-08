import SwiftUI

// A run as the thread shows it (docs/albatross-thread.md, S6 to S16): one
// block on the work-log rule with a header, the newest log lines, the page
// row, the handoff with its form or its one button, and the quiet "Dismiss".
// The owner supplies every action; the block never talks to the server.

/// What the owner does for each control of a run block. Every closure has
/// a no-op default, so a chat outside the thread can show a block read-only.
struct RunBlockActions {
    var stop: (ThreadRunView) -> Void = { _ in }
    var resume: (ThreadRunView) -> Void = { _ in }
    var dismiss: (ThreadRunView) -> Void = { _ in }
    var tryAgain: (ThreadRunView) -> Void = { _ in }
    var primary: (ThreadRunView, StepRunNextBehaviour) -> Void = { _, _ in }
    /// "Mark step done" on a result that waits for the user's check
    /// (docs/albatross-document-handoff.md, D2). Albatross then continues.
    var markDone: (ThreadRunView) -> Void = { _ in }
    var artifact: (StepRunView.Artifact) -> Void = { _ in }
    var showPage: (ThreadRunView) -> Void = { _ in }
    var hidePage: (ThreadRunView) -> Void = { _ in }
    var answer: (ThreadQuestion, FormAnswer, [String]) -> Void = { _, _, _ in }
    /// An answer to an `allow_secure` handoff (V6).
    var allow: (ThreadRunView, SecureAllowRequest, SecureAllowScope) -> Void = { _, _, _ in }
    /// "Open on the web", when this device cannot do the identity check.
    var openWeb: (ThreadRunView) -> Void = { _ in }
    /// "Save a sign-in" on a `sign_in` handoff (V13).
    var saveSignIn: (ThreadRunView, SecureSaveSignInOffer) -> Void = { _, _ in }
    /// "Stop and redirect" on an open run (docs/albatross-threads.md, T8).
    /// The button shows only when the owner handles it.
    var redirect: ((ThreadRunView) -> Void)? = nil
}

/// A V13 save offer the user opened: the run, for the receipt, and its site.
struct SignInSaveOffer: Identifiable, Hashable {
    let run: ThreadRunView
    let site: String

    var id: String { run.id }
}

struct RunBlockView: View {
    @Environment(AppEnvironment.self) private var environment
    let view: ThreadRunView
    /// The step the run belongs to, for the verification word of a done run.
    var step: WorkDetail.ExecutionStep? = nil
    /// True when this run continues the one before it in the thread.
    var continues = false
    /// Command-Return goes to this block (the newest run, no form waiting).
    var ownsWaitingShortcut = false
    /// A later run continues this one: its "Continue" buttons hide.
    var hasContinuation = false
    var busy = false
    var pageShown = false
    var questionState = WorkThreadModel.QuestionState()
    /// How this run's allow goes on this device (an `allow_secure` handoff).
    var allowState = SecureAllowState.idle
    /// The user saved a sign-in from this handoff (V13): the done label
    /// reads "Continue", because the user did not sign in.
    var signInSaved = false
    /// The session's first factor is under 10 minutes old: the allow card
    /// shows no warning line.
    var identityWindowOpen = false
    var actions = RunBlockActions()

    @State private var showsWholeLog = false
    @State private var showsLog = false

    private static let shortLogLimit = 3

    private var run: StepRunView { view.run }
    private var state: RunBlockState { RunBlockState.from(run) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if continues {
                Text(RunBlockCopy.continuedLine(at: run.createdAt))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            header
            switch state {
            case .queued, .running:
                openBody
            case .handedOff(let outcome):
                handoffBody(outcome)
            case .stopped:
                stoppedBody
            case .done:
                doneBody
            case .failed:
                failedBody
            case .cancelled:
                cancelledBody
            case .closed:
                EmptyView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 14)
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 1)
                .fill(state.isOpen ? environment.theme.accentColor.opacity(0.5) : environment.theme.hairlineColor)
                .frame(width: 2)
                .padding(.vertical, 2)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityHeader)
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if state.isOpen {
                    RevealDot()
                }
                Text(RunBlockCopy.headline(run))
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(headlineColor)
                Text("· \(StepRunCopy.triggerLine(run))")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            Text(run.stepTitle)
                .font(.subheadline.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var headlineColor: Color {
        switch state {
        case .queued, .running, .closed: .secondary
        case .handedOff, .stopped, .cancelled: environment.theme.accentColor
        case .done: .green
        case .failed: .primary
        }
    }

    private var accessibilityHeader: String {
        var parts = ["\(RunBlockCopy.headline(run)). \(run.stepTitle)."]
        if state.isOpen { parts.append("Newest: \(RunBlockCopy.progressLine(run))") }
        else if let summary = run.summary { parts.append(summary) }
        parts.append(StepRunCopy.triggerLine(run))
        return parts.joined(separator: " ")
    }

    // MARK: - Open

    private var openBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            if run.log.count <= 1 {
                Text(RunBlockCopy.progressLine(run))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .contentTransition(.opacity)
            } else {
                logWell
            }
            pageRow
            HStack(spacing: 10) {
                Spacer(minLength: 0)
                if let redirect = actions.redirect {
                    Button(busy ? RunBlockCopy.stopBusy : RunBlockCopy.stopAndRedirect) { redirect(view) }
                        .buttonStyle(.bordered)
                        .disabled(busy)
                        .help(RunBlockCopy.stopAndRedirectHelp)
                        .frame(minHeight: 44)
                }
                Button(busy ? RunBlockCopy.stopBusy : RunBlockCopy.stopButton) { actions.stop(view) }
                    .buttonStyle(.bordered)
                    .disabled(busy)
                    .stopShortcut()
                    .help("Albatross stops this run.")
                    .frame(minHeight: 44)
            }
        }
    }

    private var logWell: some View {
        VStack(alignment: .leading, spacing: 8) {
            StepRunLogView(lines: run.log, limit: showsWholeLog ? nil : Self.shortLogLimit)
            if run.log.count > Self.shortLogLimit {
                Button(showsWholeLog ? "Show less" : "Show all \(run.log.count) lines") {
                    withAnimation(.easeInOut(duration: 0.18)) { showsWholeLog.toggle() }
                }
                .buttonStyle(.borderless)
                .font(.caption)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            environment.theme.subtleColor,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
    }

    /// "Albatross is on the page · firstaidclass.example.com" with "Open" or "Hide the page".
    @ViewBuilder private var pageRow: some View {
        if run.browserSessionID != nil {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(RunBlockCopy.pageLine(host: pageHost))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Button(pageShown ? RunBlockCopy.hidePage : RunBlockCopy.openPageLabel) {
                    if pageShown { actions.hidePage(view) } else { actions.showPage(view) }
                }
                .buttonStyle(.borderless)
                .font(.footnote.weight(.medium))
            }
        }
    }

    private var pageHost: String? {
        let raw = run.artifacts.first { $0.kind == .page }?.url
            ?? run.next?.target?.url
        return raw.flatMap(URL.init(string:))?.host()
    }

    // MARK: - Handoff

    private func handoffBody(_ outcome: StepRunView.Outcome) -> some View {
        let behaviour = StepRunNextBehaviour.from(run.next)
        return VStack(alignment: .leading, spacing: 12) {
            summary
            if let detail = run.next?.detail, outcome != .needsAnswer {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if run.next?.kind == .signIn, let offer = run.next?.saveSignIn {
                saveSignInRow(offer)
            }
            artifactRows
            if case .allowSecure(let allow) = behaviour {
                SecureAllowCard(
                    request: allow,
                    answer: run.next?.allowAnswer,
                    state: allowState,
                    busy: busy,
                    windowOpen: identityWindowOpen,
                    ownsWaitingShortcut: ownsWaitingShortcut,
                    onAllow: { scope in actions.allow(view, allow, scope) },
                    onOpenWeb: { actions.openWeb(view) }
                )
            } else if outcome == .needsAnswer || behaviour == .showQuestion(id: run.next?.target?.id) {
                questionBody
            }
            pageRow
            logDisclosure
            if handoffAction != .none || marksDone || StepRunNextBehaviour.showsContinue(run.next) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) { handoffButtons }
                    VStack(alignment: .leading, spacing: 10) { handoffButtons }
                }
            }
            dismissRow
        }
        .pointerMenu { blockMenu(continues: StepRunNextBehaviour.showsContinue(run.next)) }
    }

    /// The primary button of the handoff (docs/albatross-document-handoff.md, D2).
    private var handoffAction: RunBlockHandoffAction { RunBlockHandoffAction.primary(for: run) }

    /// "Mark step done" beside a primary button that opens the result.
    private var marksDone: Bool { RunBlockHandoffAction.marksDone(run) }

    @ViewBuilder private var handoffButtons: some View {
        switch handoffAction {
        case .next(let behaviour, let label):
            // Command-Return does the one action that waits on the Mac: the
            // done label of a page handoff, else the primary button.
            Button(label) { actions.primary(view, behaviour) }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
                .waitingActionShortcut(ownsWaitingShortcut && !StepRunNextBehaviour.showsContinue(run.next))
                .frame(minHeight: 44)
        case .markDone:
            Button(busy ? RunBlockCopy.markStepDoneBusy : RunBlockCopy.markStepDone) { actions.markDone(view) }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
                .waitingActionShortcut(ownsWaitingShortcut)
                .frame(minHeight: 44)
        case .none:
            EmptyView()
        }
        if marksDone {
            Button(busy ? RunBlockCopy.markStepDoneBusy : RunBlockCopy.markStepDone) { actions.markDone(view) }
                .buttonStyle(.bordered)
                .disabled(busy)
                .frame(minHeight: 44)
        }
        if StepRunNextBehaviour.showsContinue(run.next), !hasContinuation {
            Button(busy ? RunBlockCopy.continueBusy : doneLabel) { actions.resume(view) }
                .buttonStyle(.bordered)
                .disabled(busy)
                .waitingActionShortcut(ownsWaitingShortcut)
                .frame(minHeight: 44)
        }
    }

    /// "I signed in", or "Continue" once the user saved a sign-in instead (V13).
    private var doneLabel: String {
        signInSaved ? RunBlockCopy.continueButton : RunBlockCopy.doneLabel(run.next)
    }

    /// V13: "Save a sign-in for chase.com, and the next run signs in by
    /// itself." Then "Saved. Press Continue, and Albatross signs in."
    private func saveSignInRow(_ offer: SecureSaveSignInOffer) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(signInSaved ? SecureAllowCopy.signInSaved : SecureAllowCopy.saveSignInOffer(site: offer.site))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if !signInSaved {
                Spacer(minLength: 8)
                Button(SecureAllowCopy.saveSignIn) { actions.saveSignIn(view, offer) }
                    .buttonStyle(.borderless)
                    .font(.footnote.weight(.medium))
                    .disabled(busy)
            }
        }
    }

    @ViewBuilder private var questionBody: some View {
        if let question = view.question {
            FormQuestionCard(
                form: question.resolvedForm,
                receipt: Self.receipt(for: question),
                allowsSkip: false,
                fieldErrors: questionState.fieldErrors,
                sendError: questionState.error,
                isSending: questionState.isSending,
                onSubmit: { answer, labels in actions.answer(question, answer, labels) }
            )
        } else {
            Text("Answer in the conversation. Albatross continues after your answer.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    /// How an answered question reads.
    static func receipt(for question: ThreadQuestion) -> FormQuestionCard.Receipt? {
        switch question.status {
        case .pending, .unknown:
            return nil
        case .answered:
            return question.answeredIn == .chat
                ? .answeredInChat(question.answerLine)
                : .answeredText(question.answerLine)
        case .dismissed, .superseded:
            return .dismissed
        }
    }

    private var dismissRow: some View {
        Button(RunBlockCopy.dismiss) { actions.dismiss(view) }
            .buttonStyle(.borderless)
            .font(.subheadline)
            .disabled(busy)
    }

    /// The same verbs as the block, for a secondary click on the Mac.
    @ViewBuilder private func blockMenu(continues: Bool) -> some View {
        switch handoffAction {
        case .next(let behaviour, let label):
            Button(label) { actions.primary(view, behaviour) }
        case .markDone:
            Button(RunBlockCopy.markStepDone) { actions.markDone(view) }
        case .none:
            EmptyView()
        }
        if marksDone {
            Button(RunBlockCopy.markStepDone) { actions.markDone(view) }
        }
        if continues {
            Button(doneLabel) { actions.resume(view) }
        }
        if let summary = run.summary {
            Button("Copy the summary") { PlatformPasteboard.copy(summary) }
        }
        if !run.log.isEmpty {
            Button("Copy the log") { PlatformPasteboard.copy(run.log.map(\.text).joined(separator: "\n")) }
        }
        Divider()
        Button(RunBlockCopy.dismiss) { actions.dismiss(view) }
    }

    // MARK: - Stopped, done, failed, cancelled

    private var stoppedBody: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let limit = RunBlockCopy.limitLine(run.stoppedBy) {
                Text(limit)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            summary
            artifactRows
            logDisclosure
            if !hasContinuation {
                Button(busy ? RunBlockCopy.continueBusy : RunBlockCopy.continueButton) { actions.resume(view) }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy)
                    .waitingActionShortcut(ownsWaitingShortcut)
                    .frame(minHeight: 44)
            }
            dismissRow
        }
        .pointerMenu { blockMenu(continues: true) }
    }

    private var doneBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(RunBlockCopy.doneLine(verification: step?.verificationLabel))
                .font(.footnote.weight(.medium))
                .foregroundStyle(.green)
            summary
            artifactRows
            logDisclosure
        }
    }

    private var failedBody: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(run.error ?? RunBlockCopy.failedFallback)
                .font(.subheadline)
                .foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
            logDisclosure
            Button(busy ? RunBlockCopy.handleItBusy : RunBlockCopy.tryAgain) { actions.tryAgain(view) }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
                .frame(minHeight: 44)
        }
    }

    private var cancelledBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            summary
            pageRow
            if !hasContinuation {
                Button(busy ? RunBlockCopy.continueBusy : RunBlockCopy.continueButton) { actions.resume(view) }
                    .buttonStyle(.bordered)
                    .disabled(busy)
                    .waitingActionShortcut(ownsWaitingShortcut)
                    .frame(minHeight: 44)
            }
        }
    }

    // MARK: - Shared parts

    @ViewBuilder private var summary: some View {
        if let summary = run.summary {
            Text(summary)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }

    @ViewBuilder private var artifactRows: some View {
        if !run.artifacts.isEmpty {
            VStack(spacing: 0) {
                ForEach(Array(run.artifacts.enumerated()), id: \.element.id) { offset, artifact in
                    Button {
                        actions.artifact(artifact)
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(artifact.title)
                                .font(.subheadline)
                                .foregroundStyle(.primary)
                                .lineLimit(2)
                            Spacer(minLength: 8)
                            Text(artifact.kind.label)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .hoverHighlight()
                    if offset < run.artifacts.count - 1 { Divider() }
                }
            }
            .padding(.horizontal, 12)
            .surfaceCard(theme: environment.theme, cornerRadius: 12)
        }
    }

    /// "What Albatross did" with the count as a quiet number.
    @ViewBuilder private var logDisclosure: some View {
        if !run.log.isEmpty {
            DisclosureGroup(isExpanded: $showsLog) {
                StepRunLogView(lines: run.log, limit: nil)
                    .padding(.top, 6)
            } label: {
                HStack(spacing: 6) {
                    Text(RunBlockCopy.logTitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Text("\(run.log.count)")
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }
}
