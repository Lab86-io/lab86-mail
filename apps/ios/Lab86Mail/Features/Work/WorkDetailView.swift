import SwiftUI

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

// A durable Work item rendered as a document: desired outcome and plan context
// first, followed by the same sandboxed plan artifact used by the desktop Work
// surface. The server remains the single owner of Work and its plan provenance.
struct WorkDetailView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    let route: WorkRoute

    @State private var detail: WorkDetail?
    @State private var loadError: String?
    @State private var isLoading = false
    @State private var artifactHeight: CGFloat = 360
    @State private var artifactNonce = UUID().uuidString
    @State private var isMutating = false
    @State private var showsArchiveConfirmation = false
    @State private var artifactReview: ArtifactReviewRequest?

    var body: some View {
        Group {
            if let detail {
                loadedBody(detail)
            } else if let loadError {
                errorState(loadError)
            } else {
                ProgressView("Loading Work…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle("Work")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Discuss Work", systemImage: "bubble.left.and.bubble.right") {
                        environment.startAssistantChat(
                            scope: AssistantChatScope(kind: .work, contextID: route.workID, label: route.title)
                        )
                    }
                    Button("Continue Planning", systemImage: "arrow.forward.circle") {
                        Task {
                            isMutating = true
                            _ = await environment.store.advanceWork(route.workID)
                            await load(initial: false)
                            isMutating = false
                        }
                    }
                    if detail?.work.workState == "paused" {
                        Button("Resume", systemImage: "play") {
                            Task { await changeState("active") }
                        }
                    } else {
                        Button("Pause", systemImage: "pause") {
                            Task { await changeState("paused") }
                        }
                    }
                    Button("Mark Complete", systemImage: "checkmark.circle") {
                        Task { await changeState("done") }
                    }
                    Divider()
                    Button("Archive", systemImage: "archivebox", role: .destructive) {
                        showsArchiveConfirmation = true
                    }
                } label: {
                    Label("Work actions", systemImage: "ellipsis.circle")
                }
                .disabled(isMutating)
            }
        }
        .task(id: route.id) { await load(initial: true) }
        .confirmationDialog(
            "Archive this Work?",
            isPresented: $showsArchiveConfirmation,
            titleVisibility: .visible
        ) {
            Button("Archive Work", role: .destructive) {
                Task {
                    await changeState("archived")
                    environment.navigation.workRoute = nil
                }
            }
        } message: {
            Text("Archived Work leaves active Areas but remains in durable history.")
        }
        .sheet(item: $artifactReview) { request in
            ArtifactActionReviewSheet(request: request) {
                await load(initial: false)
            }
        }
    }

    private func loadedBody(_ detail: WorkDetail) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let loadError {
                    Label("Showing the last saved Work. \(loadError)", systemImage: "wifi.slash")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                workLead(detail)

                TimelineView(.periodic(from: .now, by: 30)) { context in
                    if let move = passedWorkExecutionMove(detail, at: context.date) {
                        bareSection {
                            MissedMoveRecoveryView(move: move) {
                                Task { await load(initial: false) }
                            }
                        }
                    }
                }

                if let step = detail.execution.currentStep {
                    currentStepSection(step, execution: detail.execution)
                }

                if let question = detail.questions.first(where: { $0.status == "pending" }) {
                    documentSection("Needs you") {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(question.prompt)
                                .font(.body.weight(.medium))
                            if let reason = question.reason {
                                Text(reason)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                            Button("Answer in chat") {
                                environment.startAssistantChat(
                                    scope: AssistantChatScope(
                                        kind: .work,
                                        contextID: route.workID,
                                        label: detail.plan?.outcome ?? detail.work.title ?? route.title
                                    )
                                )
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    }
                }

                // The contract sits above everything Albatross made, because it
                // is the thing that decides whether any of it counts as done.
                if let contract = detail.contract {
                    bareSection {
                        OutcomeContractView(
                            contract: contract,
                            canClose: detail.proofStanding.isConfirmed
                        )
                    }
                }

                if !detail.evidence.isEmpty {
                    bareSection {
                        ProofTimelineView(
                            evidence: detail.evidence,
                            standing: detail.proofStanding
                        )
                    }
                }

                if let project = detail.project {
                    documentSection("Project") {
                        VStack(alignment: .leading, spacing: 5) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(project.title)
                                    .font(.headline)
                                Spacer()
                                Text(project.status.replacingOccurrences(of: "_", with: " ").capitalized)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            if let outcome = project.outcome {
                                Text(outcome)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                if !detail.execution.guideSteps.isEmpty {
                    documentSection("The plan") {
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
                                        if let detail = step.detail {
                                            Text(detail)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
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
                }

                if let plan = detail.plan,
                   let document = plan.document,
                   plan.artifactSource == "document-v2" {
                    BriefDocumentView(
                        document: document,
                        isComposing: false,
                        onReview: { artifactReview = $0 }
                    )
                    .padding(.vertical, 20)
                    .overlay(alignment: .top) { Divider() }
                } else if let plan = detail.plan, let html = plan.artifactHTML {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(plan.artifactTitle ?? "Brief")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 20)

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
                    }
                    .padding(.vertical, 20)
                    .overlay(alignment: .top) { Divider() }
                }

                if let plan = detail.plan, (!plan.assumptions.isEmpty || !plan.sources.isEmpty) {
                    documentSection("Context") {
                        VStack(alignment: .leading, spacing: 16) {
                            if !plan.assumptions.isEmpty {
                                VStack(alignment: .leading, spacing: 7) {
                                    Text("Assumptions").font(.subheadline.weight(.semibold))
                                    ForEach(plan.assumptions, id: \.self) { assumption in
                                        Label(assumption, systemImage: "circle.fill")
                                            .labelStyle(AssumptionLabelStyle())
                                            .font(.subheadline)
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

                if let error = detail.work.planError {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .padding(20)
                }
            }
            .padding(.bottom, 32)
        }
        .refreshable { await load(initial: false) }
    }

    private func workLead(_ detail: WorkDetail) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("Desired outcome")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Text(detail.work.stateLabel)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            }

            Text(detail.plan?.outcome ?? detail.work.title)
                .font(.largeTitle.bold())
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
        }
        .padding(.horizontal, 20)
        .padding(.top, 20)
        .padding(.bottom, 24)
        .accessibilityElement(children: .contain)
    }

    private func currentStepSection(
        _ step: WorkDetail.ExecutionStep,
        execution: WorkDetail.Execution
    ) -> some View {
        documentSection("Do this next") {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(step.title)
                        .font(.title3.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail = step.detail {
                        Text(detail)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text(execution.remainingSteps == 1
                        ? "This is the last planned step."
                        : "\(execution.remainingSteps) of \(execution.totalSteps) planned steps remain.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let rawURL = step.url, let url = URL(string: rawURL) {
                    Button("Open the relevant site") { openURL(url) }
                        .buttonStyle(.bordered)
                        .frame(minHeight: 44)
                }

                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) { currentStepActions(step) }
                    VStack(alignment: .leading, spacing: 10) { currentStepActions(step) }
                }
            }
        }
    }

    @ViewBuilder
    private func currentStepActions(_ step: WorkDetail.ExecutionStep) -> some View {
        Button(isMutating ? "Updating…" : "Mark this step done") {
            Task { await completeCurrentStep(step) }
        }
        .buttonStyle(.borderedProminent)
        .disabled(isMutating)
        .frame(minHeight: 44)

        Button("Discuss this") {
            environment.startAssistantChat(
                scope: AssistantChatScope(kind: .work, contextID: route.workID, label: route.title)
            )
        }
        .buttonStyle(.bordered)
        .frame(minHeight: 44)
    }

    private func documentSection<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            // Sentence case, not small caps. A shouted micro-label is decoration.
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

    /// A section whose content already carries its own heading.
    private func bareSection<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .padding(.horizontal, 20)
            .padding(.vertical, 18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .top) { Divider() }
    }

    private func errorState(_ message: String) -> some View {
        ContentUnavailableView {
            Label("Couldn’t load this Work", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Try Again") { Task { await load(initial: false) } }
                .buttonStyle(.borderedProminent)
            Button("Back to Area") { environment.navigation.workRoute = nil }
        }
    }

    private func load(initial: Bool) async {
        if initial, detail == nil, let cached = environment.store.cachedWorkDetail(route.workID) {
            detail = cached
        }
        if detail == nil { isLoading = true }
        defer { isLoading = false }
        do {
            detail = try await environment.store.loadWorkDetail(route.workID)
            loadError = nil
        } catch {
            if detail == nil { loadError = error.localizedDescription }
            else { loadError = error.localizedDescription }
        }
    }

    private func handleArtifactAction(_ action: String, _ payload: BriefActionPayload) {
        switch action {
        case "open_thread":
            if let account = payload.account, let threadID = payload.threadID {
                environment.navigation.openThread(
                    accountID: account,
                    threadID: threadID,
                    preservingCurrentRoot: true
                )
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
            artifactReview = ArtifactReviewRequest(
                action: action,
                payload: payload,
                source: detail?.work.title ?? route.title ?? "Work"
            )
        }
    }

    private func changeState(_ state: String) async {
        isMutating = true
        defer { isMutating = false }
        if await environment.store.updateWorkState(route.workID, state: state) {
            await load(initial: false)
        }
    }

    private func completeCurrentStep(_ step: WorkDetail.ExecutionStep) async {
        isMutating = true
        defer { isMutating = false }
        if await environment.store.completeWorkStep(route.workID, stepKey: step.id) {
            await load(initial: false)
        }
    }
}

private struct AssumptionLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            configuration.icon
                .font(.system(size: 5))
                .foregroundStyle(.tertiary)
            configuration.title
        }
    }
}
