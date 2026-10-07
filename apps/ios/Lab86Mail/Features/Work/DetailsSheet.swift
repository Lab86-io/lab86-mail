import SwiftUI

/// A scheduled step whose window has passed, for the missed-move recovery.
func passedWorkExecutionMove(_ detail: WorkDetail, at now: Date) -> WorkExecutionMove? {
    guard let step = detail.execution.currentStep,
          let end = detail.execution.scheduledEndAt,
          end <= now,
          !["done", "released", "archived"].contains(detail.work.workState)
    else { return nil }
    return WorkExecutionMove(
        workID: detail.work.id,
        workTitle: detail.plan?.outcome ?? detail.work.title,
        stepKey: step.id,
        stepTitle: step.title,
        detail: step.detail,
        url: step.url,
        phase: "missed",
        scheduledStartAt: detail.execution.scheduledStartAt,
        scheduledEndAt: end,
        remainingSteps: detail.execution.remainingSteps,
        totalSteps: detail.execution.totalSteps,
        areaName: nil
    )
}

// The details of an Albatross (docs/albatross-thread.md, S19 and decision
// 16): the outcome with its shape and horizon, the shape body of a list, a
// practice, or a project, the plan with proof, the files every run made, the
// proof, the commitments, and the plan document under "Read the plan". The
// sheet opens from the header menu. The Mac shows the same body in a pane.

struct WorkDetailsBody: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    let detail: WorkDetail
    let runs: [ThreadRunView]
    let onReload: () async -> Void
    let onArtifact: (StepRunView.Artifact) -> Void

    @State private var artifactHeight: CGFloat = 360
    @State private var artifactNonce = UUID().uuidString
    @State private var artifactReview: ArtifactReviewRequest?
    @State private var showsShapeSheet = false
    @State private var showsHorizonSheet = false
    @State private var showsPlanDocument = false

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            lead
            shapeBody
            TimelineView(.periodic(from: .now, by: 30)) { context in
                if let move = passedWorkExecutionMove(detail, at: context.date) {
                    bareSection {
                        MissedMoveRecoveryView(move: move) {
                            Task { await onReload() }
                        }
                    }
                }
            }
            if detail.work.resolvedShape.plans, !detail.execution.guideSteps.isEmpty {
                documentSection("Plan") { planRows }
            }
            files
            if !detail.evidence.isEmpty {
                bareSection {
                    ProofTimelineView(evidence: detail.evidence, standing: detail.proofStanding)
                }
            }
            if let contract = detail.contract {
                bareSection {
                    OutcomeContractView(contract: contract, canClose: detail.proofStanding.isConfirmed)
                }
            }
            if let project = detail.project {
                documentSection("Project") {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(project.title).font(.headline)
                            Spacer()
                            Text(project.status.replacingOccurrences(of: "_", with: " ").capitalized)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if let outcome = project.outcome {
                            Text(outcome).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            planDocument
            context
            if let error = detail.work.planError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .padding(20)
            }
        }
        .padding(.bottom, 32)
        .sheet(item: $artifactReview) { request in
            ArtifactActionReviewSheet(request: request) { await onReload() }
        }
        .sheet(isPresented: $showsShapeSheet) {
            ShapePickerSheet(current: detail.work.resolvedShape) { shape in
                let ok = await WorkShapeWriter.setShape(shape, for: detail.work.id, environment: environment)
                if ok { await onReload() }
                return ok
            }
        }
        .sheet(isPresented: $showsHorizonSheet) {
            HorizonSheet(title: detail.plan?.outcome ?? detail.work.title, initial: detail.work.horizon) { horizon in
                let ok = await WorkHorizonWriter.set(horizon, for: detail.work.id, environment: environment)
                if ok { await onReload() }
                return ok
            }
        }
    }

    // MARK: - Sections

    private var lead: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("Outcome")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    showsHorizonSheet = true
                } label: {
                    Text(detail.work.horizon?.line(at: .now) ?? detail.work.stateLabel)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(detail.work.horizon?.isDormant(at: .now) == true
                            ? environment.theme.accentColor : Color.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the horizon control")
            }
            Text(detail.plan?.outcome ?? detail.work.title)
                .font(.title2.bold())
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if let summary = detail.plan?.summary {
                Text(summary)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            } else if !detail.work.rawText.isEmpty, detail.work.rawText != detail.work.title {
                Text(detail.work.rawText)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button {
                showsShapeSheet = true
            } label: {
                Text(detail.work.resolvedShape.label)
                    .font(.subheadline)
                    .italic()
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Shape: \(detail.work.resolvedShape.label)")
            .accessibilityHint("Opens the shape picker")
        }
        .padding(.horizontal, 20)
        .padding(.top, 20)
        .padding(.bottom, 24)
        .accessibilityElement(children: .contain)
    }

    /// The body a shape owns. A list keeps items, a practice keeps a metric,
    /// a project keeps milestones.
    @ViewBuilder private var shapeBody: some View {
        switch detail.work.resolvedShape.detail {
        case .list:
            bareSection { ListBody(workID: detail.work.id, items: detail.work.listItems ?? []) }
        case .practice:
            bareSection {
                PracticeBody(workID: detail.work.id, metric: detail.work.metric, entries: detail.metricEntries)
            }
        case .milestones:
            bareSection {
                ProjectBody(
                    workID: detail.work.id,
                    milestones: detail.work.milestones ?? [],
                    evidence: detail.evidence,
                    lastUserTouchAt: detail.work.lastUserTouchAt,
                    updatedAt: detail.work.updatedAt
                )
            }
        case .guided, .decision, .monitor, .routine:
            EmptyView()
        }
    }

    private var planRows: some View {
        VStack(spacing: 0) {
            ForEach(Array(detail.execution.guideSteps.enumerated()), id: \.element.id) { offset, step in
                HStack(alignment: .top, spacing: 12) {
                    Text(step.done ? "Done" : "\(offset + 1)")
                        .font(.caption.monospacedDigit().weight(.medium))
                        .foregroundStyle(step.done ? Color.green : Color.secondary)
                        .frame(width: 38, alignment: .leading)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(step.title)
                            .strikethrough(step.done)
                        if let stepDetail = step.detail {
                            Text(stepDetail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if step.done, let verification = step.verificationLabel {
                            Text(verification)
                                .font(.caption2)
                                .foregroundStyle(
                                    step.verificationLevel == "reported"
                                        ? AnyShapeStyle(.tertiary)
                                        : AnyShapeStyle(Color.green)
                                )
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 10)
                .accessibilityElement(children: .combine)
                if offset < detail.execution.guideSteps.count - 1 { Divider() }
            }
        }
    }

    /// Every file the runs made, newest first, each with one verb.
    @ViewBuilder private var files: some View {
        let artifacts = Self.artifacts(of: runs)
        if !artifacts.isEmpty {
            documentSection("Files") {
                VStack(spacing: 0) {
                    ForEach(Array(artifacts.enumerated()), id: \.element.id) { offset, artifact in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(artifact.title)
                                    .font(.subheadline)
                                    .lineLimit(2)
                                Text(artifact.kind.label)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 8)
                            Button("Open") { onArtifact(artifact) }
                                .buttonStyle(.borderless)
                                .font(.subheadline.weight(.medium))
                        }
                        .padding(.vertical, 8)
                        if offset < artifacts.count - 1 { Divider() }
                    }
                }
            }
        }
    }

    /// The artifacts of every run, newest run first, one row for each file.
    static func artifacts(of runs: [ThreadRunView]) -> [StepRunView.Artifact] {
        var seen: Set<String> = []
        var rows: [StepRunView.Artifact] = []
        for view in runs.reversed() {
            for artifact in view.run.artifacts where seen.insert(artifact.id).inserted {
                rows.append(artifact)
            }
        }
        return rows
    }

    /// The plan document, collapsed under "Read the plan".
    @ViewBuilder private var planDocument: some View {
        if let plan = detail.plan, plan.document != nil || plan.artifactHTML != nil {
            documentSection("Plan document") {
                DisclosureGroup(isExpanded: $showsPlanDocument) {
                    if let document = plan.document, plan.artifactSource == "document-v2" {
                        BriefDocumentView(document: document, isComposing: false, onReview: { artifactReview = $0 })
                            .padding(.vertical, 12)
                    } else if let html = plan.artifactHTML {
                        BriefArtifactWebView(
                            html: BriefArtifactDocument.make(
                                from: html,
                                nonce: artifactNonce,
                                themeCSS: environment.theme.briefThemeCSS
                            ),
                            contentHeight: $artifactHeight,
                            onAction: handleArtifactAction,
                            onOpenURL: { openURL($0) }
                        )
                        .frame(maxWidth: .infinity)
                        .frame(height: artifactHeight)
                        .padding(.vertical, 12)
                    }
                } label: {
                    Text("Read the plan")
                        .font(.subheadline.weight(.medium))
                }
            }
        }
    }

    @ViewBuilder private var context: some View {
        if let plan = detail.plan, !plan.assumptions.isEmpty || !plan.sources.isEmpty {
            documentSection("Context") {
                VStack(alignment: .leading, spacing: 16) {
                    if !plan.assumptions.isEmpty {
                        VStack(alignment: .leading, spacing: 7) {
                            Text("Assumptions").font(.subheadline.weight(.semibold))
                            ForEach(plan.assumptions, id: \.self) { assumption in
                                Text(assumption).font(.subheadline)
                            }
                        }
                    }
                    if !plan.sources.isEmpty {
                        VStack(alignment: .leading, spacing: 7) {
                            Text("Sources").font(.subheadline.weight(.semibold))
                            ForEach(plan.sources) { source in
                                if let rawURL = source.url, let url = URL(string: rawURL) {
                                    Link(source.label ?? "\(source.kind) \(source.referenceID)", destination: url)
                                } else {
                                    Text(source.label ?? "\(source.kind) \(source.referenceID)")
                                        .font(.subheadline)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private func documentSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            content()
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { Divider() }
    }

    private func bareSection<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .padding(.horizontal, 20)
            .padding(.vertical, 18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .top) { Divider() }
    }

    private func handleArtifactAction(_ action: String, _ payload: BriefActionPayload) {
        switch action {
        case "open_thread":
            if let account = payload.account, let threadID = payload.threadID {
                environment.navigation.openThread(accountID: account, threadID: threadID, preservingCurrentRoot: true)
            }
        case "open_event":
            if let account = payload.account, let eventID = payload.eventID {
                let preview = environment.store.events.first { $0.id == eventID && $0.accountID == account }
                environment.navigation.openEvent(
                    accountID: account,
                    eventID: eventID,
                    calendarID: preview?.calendarID ?? payload.calendarID,
                    preview: preview,
                    preservingCurrentRoot: true
                )
            }
        case "open_area":
            if let areaID = payload.areaID {
                let name = environment.store.areas.first { $0.id == areaID }?.name
                environment.navigation.openArea(id: areaID, name: name)
            }
        case "open_view":
            if let view = payload.view { environment.navigation.openPrimaryView(view) }
        default:
            artifactReview = ArtifactReviewRequest(action: action, payload: payload, source: detail.work.title)
        }
    }
}

struct DetailsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let detail: WorkDetail
    let runs: [ThreadRunView]
    let onReload: () async -> Void
    let onArtifact: (StepRunView.Artifact) -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                WorkDetailsBody(detail: detail, runs: runs, onReload: onReload, onArtifact: onArtifact)
            }
            .navigationTitle("Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }
}
