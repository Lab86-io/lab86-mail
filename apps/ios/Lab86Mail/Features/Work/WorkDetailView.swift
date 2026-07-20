import SwiftUI

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
                Button {
                    environment.navigation.sheet = .assistant
                } label: {
                    Label("Discuss Work", systemImage: "bubble.left.and.bubble.right")
                }
            }
        }
        .task(id: route.id) { await load(initial: true) }
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
                            Button("Review and answer") {
                                environment.navigation.sheet = .activity
                            }
                            .buttonStyle(.borderedProminent)
                        }
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

                if let plan = detail.plan, !plan.actions.isEmpty {
                    documentSection("What Albatross created") {
                        VStack(spacing: 0) {
                            ForEach(plan.actions) { action in
                                HStack(alignment: .top, spacing: 12) {
                                    Image(systemName: plan.appliedStepKeys.contains(action.id)
                                        ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(plan.appliedStepKeys.contains(action.id) ? .green : .secondary)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(action.title)
                                        if let detail = action.detail {
                                            Text(detail)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer(minLength: 4)
                                    Text(action.kind.replacingOccurrences(of: "_", with: " ").capitalized)
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                }
                                .padding(.vertical, 10)
                                .accessibilityElement(children: .combine)
                                Divider()
                            }
                        }
                    }
                }

                if let plan = detail.plan, let html = plan.artifactHTML {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(plan.artifactTitle ?? "Brief")
                            .font(.caption.weight(.semibold))
                            .textCase(.uppercase)
                            .tracking(1.2)
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
                    .textCase(.uppercase)
                    .tracking(1.2)
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

    private func documentSection<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.caption.weight(.semibold))
                .textCase(.uppercase)
                .tracking(1.2)
                .foregroundStyle(.secondary)
            content()
        }
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
            environment.navigation.sheet = .activity
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
