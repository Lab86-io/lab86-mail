import SwiftUI

// The pure rules behind the run surfaces: what the primary button of a
// handoff does, the words the Brief and the thread share, the shared browser
// bar, the log rows, and the open helpers. Views stay thin and these rules
// stay testable. The web pins the same rules in its thread components.

/// What the primary button of a handoff does on this client. The contract's
/// next-action table, as a value the views switch on.
enum StepRunNextBehaviour: Equatable, Sendable {
    case openDraft(id: String, accountID: String?)
    case openDocument(id: String?, url: String?)
    case openApproval(id: String?)
    /// `sign_in` and `finish_on_page`: the page, then the done label.
    case openBrowser
    /// The Work question with its form; the answer resumes the run.
    case showQuestion(id: String?)
    /// `do_offline`: the usual step check.
    case markStepDone
    case openURL(String)
    /// `review` with no url: the artifacts are the result.
    case showArtifacts
    /// `continue`: send resume.
    case resume
    /// `allow_secure`: the allow card with its three answers (V6).
    case allowSecure(SecureAllowRequest)
    case none

    static func from(_ next: StepRunView.Next?) -> StepRunNextBehaviour {
        guard let next else { return .none }
        let target = next.target
        switch next.kind {
        case .allowSecure:
            // Without `allow` there is nothing to ask: no "Open" from the
            // target url, which points at the site.
            guard let allow = next.allow else { return .none }
            return .allowSecure(allow)
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

    /// The block draws a primary button for these. A question shows its
    /// form instead, an allow draws its own card, and the artifacts already
    /// list themselves.
    var showsPrimaryButton: Bool {
        switch self {
        case .showQuestion, .showArtifacts, .allowSecure, .none: false
        default: true
        }
    }

    /// The done label ("I paid", "Continue") is a second button after the
    /// user did their part on a page.
    static func showsContinue(_ next: StepRunView.Next?) -> Bool {
        switch next?.kind {
        case .signIn, .finishOnPage: true
        default: false
        }
    }
}

/// The words the Brief and the thread share. The run block's own words are
/// in `RunBlockCopy`; these delegate to them so the two never drift.
enum StepRunCopy {
    /// The headline of a run: "Your turn", "Stopped", "Did not finish".
    static func headline(_ run: StepRunView) -> String {
        RunBlockCopy.headline(run)
    }

    static func limitLine(_ stoppedBy: StepRunView.StoppedBy?) -> String? {
        RunBlockCopy.limitLine(stoppedBy)
    }

    /// The one line under an open run: the newest log line, or the state.
    static func progressLine(_ run: StepRunView) -> String {
        RunBlockCopy.progressLine(run)
    }

    /// "In progress: {step}".
    static func workingLine(_ run: StepRunView) -> String {
        "In progress: \(run.stepTitle)"
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

/// The status bar of the page while a run owns or hands over it: who has
/// it, and which one control the bar offers.
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
            statusLine = followed ? "The page is closed." : "Opening the shared browser…"
        }
    }
}

/// The live lines of a run, oldest first, each with its time.
struct StepRunLogView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let lines: [StepRunView.LogLine]
    var limit: Int?

    private var shown: [StepRunView.LogLine] {
        guard let limit, lines.count > limit else { return lines }
        return Array(lines.suffix(limit))
    }

    /// A note the run read from the user ("Read your note: …") shows in the
    /// primary colour, so it stands out from the run's own lines.
    private static func isNote(_ line: StepRunView.LogLine) -> Bool {
        line.text.hasPrefix("Read your note")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(shown.enumerated()), id: \.offset) { _, line in
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 2) {
                        lineText(line)
                        timeText(line)
                    }
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        timeText(line)
                            .frame(width: 56, alignment: .leading)
                        lineText(line)
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func timeText(_ line: StepRunView.LogLine) -> some View {
        Text(line.at.map { $0.formatted(date: .omitted, time: .shortened) } ?? "")
            .font(.caption.monospacedDigit())
            .foregroundStyle(.tertiary)
    }

    private func lineText(_ line: StepRunView.LogLine) -> some View {
        Text(line.text)
            .font(.caption)
            .foregroundStyle(Self.isNote(line) ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// What a handoff's primary button opens on this client. Shared by the
/// thread and the Brief's "Ready for you" list, so one tap means the same
/// thing on both.
@MainActor
enum StepRunActions {
    /// Returns false when this surface cannot do it here; the caller then
    /// opens the thread, where the page and the form live.
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
        case .openBrowser, .showQuestion, .markStepDone, .showArtifacts, .resume, .allowSecure, .none:
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
