import SwiftUI

/// The run states of the "Do this next" section, drawn from one
/// `StepRunCardState`. The owner supplies every action; the card never
/// talks to the server itself. The quiet and eligible states draw nothing
/// here: the owner keeps its own step buttons for them.
struct StepRunCardView: View {
    @Environment(AppEnvironment.self) private var environment
    let state: StepRunCardState
    let questions: [WorkDetail.Question]
    let busy: Bool
    let onStop: (StepRunView) -> Void
    let onResume: (StepRunView) -> Void
    let onDismiss: (StepRunView) -> Void
    let onTryAgain: (StepRunView) -> Void
    let onDiscuss: () -> Void
    let onPrimary: (StepRunView, StepRunNextBehaviour) -> Void
    let onArtifact: (StepRunView.Artifact) -> Void
    let onQuestionAnswered: () async -> Void

    @State private var showsWholeLog = false

    private static let shortLogLimit = 4

    var body: some View {
        switch state {
        case .quiet, .eligible:
            EmptyView()
        case .open(let run):
            openBody(run)
        case .handedOff(let run):
            handoffBody(run)
        case .stopped(let run):
            stoppedBody(run)
        case .failed(let run):
            failedBody(run)
        }
    }

    // MARK: - Open

    private func openBody(_ run: StepRunView) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                ProgressView()
                    .controlSize(.small)
                Text(StepRunCopy.workingLine(run))
                    .font(.subheadline.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if run.log.count <= 1 {
                Text(StepRunCopy.progressLine(run))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .contentTransition(.opacity)
            } else {
                logWell(run)
            }
            Text(StepRunCopy.triggerLine(run))
                .font(.caption)
                .foregroundStyle(.tertiary)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { openActions(run) }
                VStack(alignment: .leading, spacing: 10) { openActions(run) }
            }
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func openActions(_ run: StepRunView) -> some View {
        Button(busy ? "Stopping…" : "Stop") { onStop(run) }
            .buttonStyle(.bordered)
            .disabled(busy)
            .frame(minHeight: 44)
        Button("Discuss this") { onDiscuss() }
            .buttonStyle(.bordered)
            .frame(minHeight: 44)
    }

    private func logWell(_ run: StepRunView) -> some View {
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

    // MARK: - Handoff

    private func handoffBody(_ run: StepRunView) -> some View {
        let behaviour = StepRunNextBehaviour.from(run.next)
        return VStack(alignment: .leading, spacing: 12) {
            headline(run)
            summary(run)
            if let detail = run.next?.detail {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            artifactRows(run)
            whatIDid(run)
            if case .showQuestion(let questionID) = behaviour {
                questionCard(questionID)
            }
            if behaviour.showsPrimaryButton || StepRunNextBehaviour.showsContinue(run.next) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) { handoffActions(run, behaviour: behaviour) }
                    VStack(alignment: .leading, spacing: 10) { handoffActions(run, behaviour: behaviour) }
                }
            }
            quietActions(run)
            Text(StepRunCopy.triggerLine(run))
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func handoffActions(_ run: StepRunView, behaviour: StepRunNextBehaviour) -> some View {
        if behaviour.showsPrimaryButton, let next = run.next {
            Button(next.label) { onPrimary(run, behaviour) }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
                .frame(minHeight: 44)
        }
        if StepRunNextBehaviour.showsContinue(run.next) {
            Button(busy ? "Continuing…" : "Continue") { onResume(run) }
                .buttonStyle(.bordered)
                .disabled(busy)
                .frame(minHeight: 44)
        }
    }

    /// "Dismiss" and "Discuss this": one quiet row under the primary buttons.
    private func quietActions(_ run: StepRunView) -> some View {
        HStack(spacing: 18) {
            Button("Dismiss") { onDismiss(run) }
                .disabled(busy)
            Button("Discuss this") { onDiscuss() }
        }
        .buttonStyle(.borderless)
        .font(.subheadline)
    }

    @ViewBuilder
    private func questionCard(_ questionID: String?) -> some View {
        let question = questions.first(where: { $0.id == questionID })
            ?? questions.first(where: { $0.status == "pending" })
        if let question {
            VStack(alignment: .leading, spacing: 10) {
                Text(question.prompt)
                    .font(.body.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
                if let reason = question.reason {
                    Text(reason)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                WorkQuestionOptionsView(
                    question: question,
                    onAnswered: onQuestionAnswered,
                    onAnswerInChat: onDiscuss
                )
            }
        } else {
            Text("Answer in chat. Albatross continues after your answer.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Stopped

    private func stoppedBody(_ run: StepRunView) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            headline(run)
            summary(run)
            artifactRows(run)
            whatIDid(run)
            Button(busy ? "Continuing…" : "Continue") { onResume(run) }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
                .frame(minHeight: 44)
            quietActions(run)
            Text(StepRunCopy.triggerLine(run))
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .accessibilityElement(children: .contain)
    }

    // MARK: - Failed

    private func failedBody(_ run: StepRunView) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            headline(run)
            if let error = run.error {
                Text(error)
                    .font(.subheadline)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            whatIDid(run)
            Button(busy ? "Starting…" : "Try again") { onTryAgain(run) }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
                .frame(minHeight: 44)
        }
        .accessibilityElement(children: .contain)
    }

    // MARK: - Shared parts

    private func headline(_ run: StepRunView) -> some View {
        Text(StepRunCopy.headline(run))
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(run.state == .failed ? Color.primary : environment.theme.accentColor)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }

    @ViewBuilder
    private func summary(_ run: StepRunView) -> some View {
        if let summary = run.summary {
            Text(summary)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }

    @ViewBuilder
    private func artifactRows(_ run: StepRunView) -> some View {
        if !run.artifacts.isEmpty {
            VStack(spacing: 0) {
                ForEach(Array(run.artifacts.enumerated()), id: \.element.id) { offset, artifact in
                    Button {
                        onArtifact(artifact)
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
                    if offset < run.artifacts.count - 1 { Divider() }
                }
            }
            .padding(.horizontal, 12)
            .surfaceCard(theme: environment.theme, cornerRadius: 12)
        }
    }

    @ViewBuilder
    private func whatIDid(_ run: StepRunView) -> some View {
        if !run.log.isEmpty {
            DisclosureGroup {
                StepRunLogView(lines: run.log, limit: nil)
                    .padding(.top, 6)
            } label: {
                Text("What I did")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// The live lines of a run, oldest first, each with its time.
struct StepRunLogView: View {
    let lines: [StepRunView.LogLine]
    var limit: Int?

    private var shown: [StepRunView.LogLine] {
        guard let limit, lines.count > limit else { return lines }
        return Array(lines.suffix(limit))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(shown.enumerated()), id: \.offset) { _, line in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(line.at.map { $0.formatted(date: .omitted, time: .shortened) } ?? "")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.tertiary)
                        .frame(width: 56, alignment: .leading)
                    Text(line.text)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// What a handoff's primary button opens on this client. Shared by the
/// Work page and the Brief's "Ready for you" list, so one tap means the
/// same thing on both.
@MainActor
enum StepRunActions {
    /// Returns false when this surface cannot do it here; the caller then
    /// opens the Work page, where the sheet and the question live.
    static func open(
        _ behaviour: StepRunNextBehaviour,
        environment: AppEnvironment,
        openURL: OpenURLAction
    ) async -> Bool {
        switch behaviour {
        case .openDraft(let id, let accountID):
            guard let prefill = await environment.store.loadDraftPrefill(draftID: id, accountID: accountID) else {
                return false
            }
            environment.navigation.pendingCompose = prefill
            environment.navigation.sheet = .compose
            return true
        case .openDocument(let id, let url):
            if let documentID = id ?? StepRunCopy.documentID(fromURL: url) {
                environment.navigation.openDocument(id: documentID)
                return true
            }
            return openWebURL(url, openURL: openURL)
        case .openApproval:
            environment.navigation.sheet = .activity
            return true
        case .openURL(let raw):
            return openWebURL(raw, openURL: openURL)
        case .openBrowser, .showQuestion, .markStepDone, .showArtifacts, .resume, .none:
            return false
        }
    }

    static func open(
        _ artifact: StepRunView.Artifact,
        environment: AppEnvironment,
        openURL: OpenURLAction
    ) async -> Bool {
        switch artifact.kind {
        case .draft:
            guard let id = artifact.referenceID else { return false }
            return await open(.openDraft(id: id, accountID: artifact.accountID), environment: environment, openURL: openURL)
        case .document:
            return await open(.openDocument(id: artifact.referenceID, url: artifact.url), environment: environment, openURL: openURL)
        case .approval:
            return await open(.openApproval(id: artifact.referenceID), environment: environment, openURL: openURL)
        case .event:
            guard let accountID = artifact.accountID, let eventID = artifact.referenceID else {
                return openWebURL(artifact.url, openURL: openURL)
            }
            environment.navigation.openEvent(
                accountID: accountID,
                eventID: eventID,
                calendarID: nil,
                preview: nil,
                preservingCurrentRoot: true
            )
            return true
        case .page, .card, .unknown:
            return openWebURL(artifact.url, openURL: openURL)
        }
    }

    private static func openWebURL(_ raw: String?, openURL: OpenURLAction) -> Bool {
        guard let raw, let url = URL(string: raw),
              ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { return false }
        openURL(url)
        return true
    }
}
