import Kingfisher
import SwiftUI

// One area's home, brief-first, backed by the read-only `area_home` server tool.
// Leads with the durable living brief, then the real linked sections the server
// contract provides. Loads by stable id; a missing/archived area is unavailable
// with a route back, never invented data.
struct AreaDetailView: View {
    private enum AreaSurface: String, CaseIterable, Identifiable {
        case brief
        case inbox

        var id: String { rawValue }
        var title: String {
            switch self {
            case .brief: "Brief"
            case .inbox: "Inbox"
            }
        }
    }

    @Environment(AppEnvironment.self) private var environment
    let route: AreaRoute

    @State private var detail: AreaDetail?
    @State private var isLoading = false
    @State private var loadError: String?
    @State private var isUnavailable = false
    @State private var surface: AreaSurface = .brief
    @State private var briefQueued = false
    @State private var showsImagePrompt = false
    @State private var imageURLDraft = ""

    var body: some View {
        @Bindable var navigation = environment.navigation
        Group {
            if isUnavailable {
                unavailableState
            } else if let detail {
                loadedBody(detail)
            } else if let loadError {
                errorState(loadError)
            } else {
                ProgressView("Loading \(route.name ?? "area")…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationDestination(item: $navigation.workRoute) { route in
            WorkDetailView(route: route)
        }
        .navigationDestination(item: $navigation.eventRoute) { route in
            EventDetailView(route: route)
        }
        .navigationDestination(item: $navigation.threadRoute) { route in
            ThreadView(
                route: route,
                summary: environment.store.threads.first {
                    $0.id == route.threadID && $0.accountID == route.accountID
                }
            )
        }
        .navigationTitle(detail?.identity.name ?? route.name ?? "Area")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Reload") {
                        Task { await load(initial: false) }
                    }
                    Button(briefQueued ? "Brief refresh queued…" : "Refresh brief") {
                        Task { await refreshBrief() }
                    }
                    .disabled(briefQueued)
                    Button("Set picture") {
                        imageURLDraft = detail?.identity.imageURL ?? ""
                        showsImagePrompt = true
                    }
                } label: {
                    Label("Area actions", systemImage: "arrow.clockwise")
                }
                .disabled(isLoading)
            }
        }
        .alert("Area picture", isPresented: $showsImagePrompt) {
            TextField("Image address (https://…)", text: $imageURLDraft)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Save") {
                let url = imageURLDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                Task {
                    if await environment.store.setAreaImage(areaID: route.areaID, imageURL: url) {
                        await load(initial: false)
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Shown as this area’s brief masthead here and its icon on desktop. Paste an image address; leave empty to remove.")
        }
        .task(id: route.id) { await load(initial: true) }
    }

    // Queue the living-brief regeneration (same mutation as desktop), then
    // re-read the area home once the worker has had a chance to write.
    private func refreshBrief() async {
        guard await environment.store.queueAreaBriefRefresh(areaID: route.areaID) else { return }
        briefQueued = true
        try? await Task.sleep(for: .seconds(12))
        await load(initial: false)
        briefQueued = false
    }

    // MARK: - Loaded

    private func loadedBody(_ detail: AreaDetail) -> some View {
        Group {
            switch surface {
            case .brief:
                briefSurface(detail)
            case .inbox:
                inboxSurface(detail)
            }
        }
        // The switcher lives in the bar itself; with the bar background hidden
        // on the brief, the controls float as glass over the document.
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("Area view", selection: $surface) {
                    ForEach(AreaSurface.allCases) { choice in
                        Text(choice.title).tag(choice)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 170)
            }
        }
        .toolbarBackgroundVisibility(
            surface == .brief ? .hidden : .automatic,
            for: .navigationBar
        )
    }

    // The area's mail as a first-class inbox list — same rows the brief's Mail
    // section samples, but as the whole surface.
    private func inboxSurface(_ detail: AreaDetail) -> some View {
        List {
            if detail.mail.isEmpty {
                ContentUnavailableView(
                    "No mail filed here yet",
                    systemImage: "tray",
                    description: Text("The classifier files this area’s conversations as it learns your context.")
                )
            } else {
                ForEach(detail.mail) { row in
                    Button {
                        environment.navigation.openThread(
                            accountID: row.accountID,
                            threadID: row.threadID,
                            preservingCurrentRoot: true
                        )
                    } label: {
                        AreaMailRowView(row: row)
                    }
                    .buttonStyle(.plain)
                }
                if detail.counts.mail > detail.mail.count {
                    Text("Showing the \(detail.mail.count) most relevant of \(detail.counts.mail) conversations.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .listRowSeparator(.hidden)
                }
            }
        }
        .listStyle(.plain)
        .refreshable { await load(initial: false) }
    }

    private func briefSurface(_ detail: AreaDetail) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
            if let loadError {
                Label("Showing your last saved view. \(loadError)", systemImage: "wifi.slash")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            AreaBriefLead(detail: detail)

            if !detail.hasAnyLinkedContent {
                AreaDocumentSection(title: "In this Area") {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Nothing here yet.").font(.body.weight(.medium))
                        Text("Albatross files Work, mail, events, and tasks here as it learns your context.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            } else {
                needsYouSection(detail)
                projectsSection(detail)
                workSection(detail)
                eventsSection(detail)
                mailSection(detail)
                tasksSection(detail)
                placesSection(detail)
                contextSection(detail)
            }
            }
            .padding(.bottom, 32)
        }
        .refreshable { await load(initial: false) }
    }

    @ViewBuilder private func needsYouSection(_ detail: AreaDetail) -> some View {
        let overdue = detail.tasks.filter { !$0.completed && ($0.due.map { $0 < .now } ?? false) }
        if !detail.candidateFacts.isEmpty || !overdue.isEmpty {
            AreaDocumentSection(title: "Needs you") {
                VStack(spacing: 0) {
                    ForEach(overdue) { task in
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(task.title)
                                if let due = task.due {
                                    Text("Overdue · \(due.formatted(date: .abbreviated, time: .omitted))")
                                        .font(.caption)
                                        .foregroundStyle(.red)
                                }
                            }
                        } icon: {
                            Circle().fill(.red).frame(width: 8, height: 8)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 10)
                        Divider()
                    }
                    if !detail.candidateFacts.isEmpty {
                        Text("\(detail.candidateFacts.count) suggested context fact\(detail.candidateFacts.count == 1 ? "" : "s") to review in Context below.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 10)
                    }
                }
            }
        }
    }

    @ViewBuilder private func projectsSection(_ detail: AreaDetail) -> some View {
        if !detail.projects.isEmpty {
            AreaDocumentSection(title: "Projects") {
                VStack(spacing: 0) {
                    ForEach(detail.projects) { project in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(project.title).font(.headline)
                            if let outcome = project.outcome {
                                Text(outcome).font(.subheadline).foregroundStyle(.secondary)
                            }
                            if project.taskCount > 0 {
                                HStack(spacing: 8) {
                                    ProgressView(
                                        value: Double(project.completedTaskCount),
                                        total: Double(project.taskCount)
                                    )
                                    Text("\(project.completedTaskCount)/\(project.taskCount)")
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .padding(.vertical, 11)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityElement(children: .combine)
                        Divider()
                    }
                }
            }
        }
    }

    @ViewBuilder private func workSection(_ detail: AreaDetail) -> some View {
        let work = detail.work ?? []
        if !work.isEmpty || !detail.plans.isEmpty {
            AreaDocumentSection(title: "Work") {
                VStack(spacing: 0) {
                    if !work.isEmpty {
                        ForEach(work) { item in
                            Button {
                                environment.navigation.openWork(id: item.id, title: item.title)
                            } label: {
                                HStack(alignment: .firstTextBaseline, spacing: 12) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(item.title)
                                            .font(.headline)
                                            .foregroundStyle(.primary)
                                        Text(item.stateLabel)
                                            .font(.subheadline)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer(minLength: 4)
                                    Image(systemName: "chevron.forward")
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)
                                }
                                .padding(.vertical, 12)
                                .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(item.title), \(item.stateLabel)")
                            Divider()
                        }
                    } else {
                        ForEach(detail.plans) { plan in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(plan.title).font(.headline)
                                Text(planStatus(plan))
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 11)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityElement(children: .combine)
                            Divider()
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private func eventsSection(_ detail: AreaDetail) -> some View {
        if !detail.events.isEmpty {
            AreaDocumentSection(title: "Events") {
                VStack(spacing: 0) {
                    ForEach(detail.events) { event in
                        Button {
                            environment.navigation.openEvent(event.summary, preservingCurrentRoot: true)
                        } label: {
                            EventRow(event: event.summary)
                                .padding(.vertical, 11)
                        }
                        .buttonStyle(.plain)
                        Divider()
                    }
                }
            }
        }
    }

    @ViewBuilder private func mailSection(_ detail: AreaDetail) -> some View {
        if !detail.mail.isEmpty {
            AreaDocumentSection(title: "Mail") {
                VStack(spacing: 0) {
                    ForEach(detail.mail) { row in
                        Button {
                            environment.navigation.openThread(
                                accountID: row.accountID,
                                threadID: row.threadID,
                                preservingCurrentRoot: true
                            )
                        } label: {
                            AreaMailRowView(row: row)
                                .padding(.vertical, 11)
                        }
                        .buttonStyle(.plain)
                        Divider()
                    }
                }
            }
        }
    }

    @ViewBuilder private func tasksSection(_ detail: AreaDetail) -> some View {
        if !detail.tasks.isEmpty {
            AreaDocumentSection(title: "Tasks") {
                VStack(spacing: 0) {
                    ForEach(detail.tasks) { task in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Image(systemName: task.completed ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(task.completed ? .secondary : .primary)
                            Text(task.title).strikethrough(task.completed)
                            Spacer(minLength: 4)
                            if task.linkStatus == "candidate" { SuggestedTag() }
                            if let due = task.due {
                                Text(due, format: .dateTime.month().day())
                                    .font(.caption)
                                    .foregroundStyle(task.due.map { $0 < .now } == true && !task.completed ? .red : .secondary)
                            }
                        }
                        .padding(.vertical, 11)
                        .accessibilityElement(children: .combine)
                        Divider()
                    }
                }
            }
        }
    }

    @ViewBuilder private func placesSection(_ detail: AreaDetail) -> some View {
        if !detail.places.isEmpty {
            AreaDocumentSection(title: "Places") {
                VStack(spacing: 0) {
                    ForEach(detail.places) { place in
                        placeRow(place)
                            .padding(.vertical, 11)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Divider()
                    }
                }
            }
        }
    }

    @ViewBuilder private func placeRow(_ place: AreaDetail.PlaceRow) -> some View {
        if let mapsURL = place.mapsURL, let url = URL(string: mapsURL) {
            Link(destination: url) {
                placeLabel(place)
            }
        } else {
            placeLabel(place)
        }
    }

    private func placeLabel(_ place: AreaDetail.PlaceRow) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(place.name).font(.subheadline)
            if let detail = place.detail {
                Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            if let address = place.address {
                Text(address).font(.caption).foregroundStyle(.tertiary).lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func contextSection(_ detail: AreaDetail) -> some View {
        if !detail.verifiedFacts.isEmpty || !detail.candidateFacts.isEmpty {
            AreaDocumentSection(title: "Context") {
                VStack(spacing: 0) {
                    ForEach(detail.candidateFacts) { fact in
                        VStack(alignment: .leading, spacing: 8) {
                            FactRow(fact: fact, suggested: true)
                            HStack(spacing: 10) {
                                Button("Verify") {
                                    Task { await reviewFact(fact, status: "verified") }
                                }
                                .buttonStyle(.borderedProminent)
                                .controlSize(.small)
                                Button("Not right") {
                                    Task { await reviewFact(fact, status: "rejected") }
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                            }
                        }
                        .padding(.vertical, 10)
                        Divider()
                    }
                    ForEach(detail.verifiedFacts) { fact in
                        FactRow(fact: fact, suggested: false).padding(.vertical, 10)
                        Divider()
                    }
                }
            }
        }
    }

    // MARK: - Non-loaded states

    private var unavailableState: some View {
        ContentUnavailableView {
            Label("This area is unavailable", systemImage: "square.stack.3d.up.slash")
        } description: {
            Text("It may have been archived or removed.")
        } actions: {
            Button("Back to areas") { environment.navigation.areaRoute = nil }
                .buttonStyle(.borderedProminent)
        }
    }

    private func errorState(_ message: String) -> some View {
        ContentUnavailableView {
            Label("Couldn’t load this area", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Try Again") { Task { await load(initial: false) } }
                .buttonStyle(.borderedProminent)
        }
    }

    // MARK: - Load

    private func reviewFact(_ fact: AreaDetail.Fact, status: String) async {
        await environment.store.setAreaFactStatus(areaID: route.areaID, factID: fact.id, status: status)
        detail = environment.store.cachedAreaDetail(route.areaID) ?? detail
    }

    private func load(initial: Bool) async {
        if initial, detail == nil, let cached = environment.store.cachedAreaDetail(route.areaID) {
            detail = cached
        }
        if detail == nil { isLoading = true }
        defer { isLoading = false }
        do {
            detail = try await environment.store.loadAreaDetail(route.areaID)
            loadError = nil
            isUnavailable = false
        } catch {
            let message = error.localizedDescription
            if detail == nil {
                if isAreaMissing(message) { isUnavailable = true } else { loadError = message }
            } else {
                // Keep the cached/last-good detail readable; note the failure.
                loadError = message
            }
        }
    }

    private func isAreaMissing(_ message: String) -> Bool {
        let lowered = message.lowercased()
        return lowered.contains("not found") || lowered.contains("unavailable") || lowered.contains("archived")
    }

    private func planStatus(_ plan: AreaDetail.PlanRow) -> String {
        if let outcome = plan.outcome { return outcome }
        if let summary = plan.summary { return summary }
        return plan.status.replacingOccurrences(of: "_", with: " ").capitalized
    }
}

private struct AreaBriefLead: View {
    @Environment(AppEnvironment.self) private var environment
    let detail: AreaDetail

    // The generated area brief presented as the document it is on desktop:
    // masthead (custom picture when set), display-face headline, the lede as
    // a standfirst, and the full summary as flowing body copy. Legacy editions
    // that stored complete HTML render verbatim, themed.
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let imageURL = detail.identity.imageURL, let url = URL(string: imageURL) {
                // Full-bleed masthead sliding under the glass toolbar.
                KFImage(url)
                    .placeholder { environment.theme.accent2Color.opacity(0.14) }
                    .fade(duration: 0.2)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                .frame(height: 280)
                .frame(maxWidth: .infinity)
                .clipped()
                .overlay(alignment: .bottom) {
                    LinearGradient(
                        colors: [.clear, Color(uiColor: .systemBackground).opacity(0.85)],
                        startPoint: .center,
                        endPoint: .bottom
                    )
                }
                .padding(.horizontal, -20)
                .padding(.top, -20)
                .accessibilityHidden(true)
            }

            HStack(alignment: .center, spacing: 10) {
                Text(detail.identity.name)
                    .font(environment.theme.displayType.displayFont(size: 34))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                if detail.identity.imageURL == nil {
                    AreaDetailMonogram(name: detail.identity.name, seed: detail.identity.id)
                }
            }

            if let html = detail.livingBrief?.artifactHtml {
                AreaBriefArtifact(html: html)
            } else {
                Text(leadText)
                    .font(environment.theme.displayType.displayFont(size: 19))
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }

            if detail.livingBrief?.artifactHtml == nil,
               let brief = detail.livingBrief, brief.isReady, !brief.summary.isEmpty {
                ForEach(Array(paragraphs(brief.summary).enumerated()), id: \.offset) { _, paragraph in
                    Text(paragraph)
                        .font(.body)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            } else if detail.livingBrief?.artifactHtml == nil,
                      let description = detail.identity.description {
                Text(description)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !propertyLine.isEmpty {
                Text(propertyLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 20)
        .padding(.bottom, 24)
        .accessibilityElement(children: .contain)
    }

    private func paragraphs(_ text: String) -> [String] {
        text.components(separatedBy: "\n\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private var leadText: String {
        if let brief = detail.livingBrief, brief.isReady, !brief.lede.isEmpty { return brief.lede }
        let needs = detail.candidateFacts.count
            + detail.tasks.filter { !$0.completed && ($0.due.map { $0 < .now } ?? false) }.count
        let upcoming = detail.events.filter { $0.end >= .now }.count
        if needs > 0 {
            return "\(detail.identity.name) has \(needs) thing\(needs == 1 ? "" : "s") that need you."
        }
        let workCount = detail.work?.filter { $0.workState != "done" && $0.workState != "archived" }.count ?? 0
        if upcoming > 0 || workCount > 0 || detail.counts.plans > 0 {
            let inMotion = workCount > 0 ? workCount : detail.counts.plans
            return "\(upcoming) upcoming, \(inMotion) in motion."
        }
        return "\(detail.identity.name) is quiet right now."
    }

    private var propertyLine: String {
        let upcoming = detail.events.filter { $0.end >= .now }.count
        let workCount = detail.work?.filter { $0.workState != "done" && $0.workState != "archived" }.count ?? 0
        let parts: [String] = [
            detail.counts.mail > 0 ? "\(detail.counts.mail) mail" : nil,
            upcoming > 0 ? "\(upcoming) upcoming" : nil,
            workCount > 0 ? "\(workCount) work" : nil,
            workCount == 0 && detail.counts.plans > 0 ? "\(detail.counts.plans) plans" : nil,
            detail.counts.projects > 0 ? "\(detail.counts.projects) projects" : nil,
            detail.counts.tasks > 0 ? "\(detail.counts.tasks) tasks" : nil,
        ].compactMap { $0 }
        return parts.joined(separator: " · ")
    }
}

private struct AreaDocumentSection<Content: View>: View {
    let title: String
    let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.caption.weight(.semibold))
                .textCase(.uppercase)
                .tracking(1.2)
                .foregroundStyle(.secondary)
            content
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { Divider() }
    }
}

// Legacy stored-HTML area briefs render in the same sandboxed, themed
// artifact webview the daily brief uses.
private struct AreaBriefArtifact: View {
    @Environment(AppEnvironment.self) private var environment
    let html: String

    @State private var height: CGFloat = 260
    @State private var nonce = UUID().uuidString

    var body: some View {
        BriefArtifactWebView(
            html: BriefArtifactDocument.make(
                from: html,
                nonce: nonce,
                themeCSS: environment.theme.briefThemeCSS
            ),
            contentHeight: $height,
            onAction: { _, _ in },
            onOpenURL: { _ in }
        )
        .frame(maxWidth: .infinity)
        .frame(height: height)
    }
}

private struct AreaMailRowView: View {
    let row: AreaDetail.MailRow

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(row.unread ? Color.accentColor : .clear)
                .frame(width: 7, height: 7)
                .padding(.top, 6)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(row.sender)
                        .fontWeight(row.unread ? .semibold : .regular)
                        .lineLimit(1)
                    if row.linkStatus == "candidate" { SuggestedTag() }
                    Spacer(minLength: 4)
                    Text(row.date, format: .dateTime.month().day())
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text(row.subject).font(.subheadline).lineLimit(1)
                if !row.snippet.isEmpty {
                    Text(row.snippet).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Image(systemName: "chevron.forward")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

private struct FactRow: View {
    let fact: AreaDetail.Fact
    let suggested: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(fact.kind.capitalized)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .frame(width: 68, alignment: .leading)
            Text(fact.value)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            if suggested { SuggestedTag() }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct SuggestedTag: View {
    var body: some View {
        Text("Suggested")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .overlay(Capsule().stroke(.quaternary))
            .accessibilityLabel("Suggested")
    }
}

private struct AreaDetailMonogram: View {
    let name: String
    let seed: String

    var body: some View {
        Circle()
            .fill(color.gradient)
            .frame(width: 36, height: 36)
            .overlay(
                Text(initials)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
            )
            .accessibilityHidden(true)
    }

    private var initials: String {
        let words = name.split(separator: " ").prefix(2)
        let letters = words.compactMap { $0.first }.map(String.init).joined()
        return letters.isEmpty ? "•" : letters.uppercased()
    }

    private var color: Color {
        AreaMonogramPalette.color(for: seed)
    }
}
