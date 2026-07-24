import SwiftUI

struct TodayView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    @State private var showsHistory = false
    @State private var artifactReview: ArtifactReviewRequest?

    private var store: ProductStore { environment.store }

    var body: some View {
        Group {
            if let report = store.dailyReport, report.hasArtifact {
                artifactBody(report)
            } else {
                fallbackBody
            }
        }
        .navigationTitle(Date.now.formatted(.dateTime.weekday(.wide).month(.wide).day()))
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task {
                        await store.loadDailyReportHistory()
                        showsHistory = true
                    }
                } label: {
                    Label("Report history", systemImage: "clock.arrow.circlepath")
                }
            }
        }
        .sheet(isPresented: $showsHistory) {
            DailyReportHistorySheet(reports: store.dailyReportHistory) { report in
                await store.selectDailyReport(id: report.id)
                showsHistory = false
            }
        }
        .sheet(item: $artifactReview) { request in
            ArtifactActionReviewSheet(request: request) {
                await store.refreshToday()
            }
        }
        .shellToolbar()
    }

    // v2 editions render as native SwiftUI. Historical editions keep the
    // sandboxed HTML path so saved report history remains readable.
    @ViewBuilder
    private func artifactBody(_ report: DailyReportModel) -> some View {
        if let document = report.document, report.artifactSource == "document-v2" {
            ScrollView {
                BriefDocumentView(
                    document: document,
                    isComposing: report.artifactStatus == "composing",
                    onReview: { artifactReview = $0 },
                    onRegenerate: { Task { await store.generateBrief() } }
                )
                .padding(.bottom, 24)
            }
            .refreshable { await store.refreshToday() }
        } else {
            ScrollView {
                DailyBriefView(
                    report: report,
                    lastRefresh: store.lastRefresh,
                    isOffline: store.briefError != nil,
                    onAction: handleBriefAction,
                    onRegenerate: { Task { await store.generateBrief() } }
                )
                .padding(.bottom, 24)
            }
            .refreshable { await store.refreshToday() }
        }
    }

    // Fallback when no artifact exists yet (no edition, still generating, or a
    // local load error): a useful native structured day rather than a blank
    // screen. The day's real context stays present regardless of the brief.
    private var fallbackBody: some View {
        List {
            briefStatusSection

            if !store.approvals.isEmpty {
                Section("Needs your call") {
                    ForEach(store.approvals.prefix(3)) { approval in
                        Button {
                            environment.navigation.sheet = .activity
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(approval.title).foregroundStyle(.primary)
                                Text(approval.detail)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                    }
                }
            }

            Section("Schedule") {
                let today = store.todaysEvents
                if today.isEmpty {
                    scheduleEmptyState
                } else {
                    ForEach(today) { event in
                        Button { environment.navigation.openEvent(event) } label: {
                            EventRow(event: event)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            Section("Tasks") {
                let open = store.tasks.filter { !$0.completed }
                if open.isEmpty {
                    ContentUnavailableView("No open tasks", systemImage: "checkmark.circle")
                } else {
                    ForEach(open.prefix(8)) { task in
                        TaskRow(task: task)
                    }
                }
            }

            if !store.areas.isEmpty {
                Section("In motion") {
                    ForEach(store.areas.prefix(5)) { area in
                        Button {
                            environment.navigation.openArea(id: area.id, name: area.name)
                        } label: {
                            AreaMotionRow(area: area)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .refreshable { await store.refreshToday() }
        .overlay {
            if store.isLoading && store.dailyReport == nil && store.events.isEmpty && store.approvals.isEmpty {
                ProgressView("Putting your day together…")
            }
        }
    }

    @ViewBuilder private var briefStatusSection: some View {
        Section("Brief") {
            if let report = store.dailyReport {
                // A report exists but has no self-contained artifact — show its
                // structured summary rather than a blank brief.
                VStack(alignment: .leading, spacing: 8) {
                    if report.isGenerating {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Putting today’s brief together…")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        if let progress = report.progress, progress.total > 0 {
                            ProgressView(value: progress.fraction)
                        }
                    }
                    if let text = report.legacyText {
                        Text(text)
                            .font(.body)
                            .textSelection(.enabled)
                    }
                    briefCountSummary(report.sectionCounts)
                }
                .padding(.vertical, 2)
            } else if let error = store.briefError {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Couldn’t load today’s brief", systemImage: "exclamationmark.triangle")
                        .font(.subheadline.weight(.medium))
                    Text(error).font(.caption).foregroundStyle(.secondary)
                    Button("Try Again") { Task { await store.refreshBrief() } }
                        .buttonStyle(.bordered)
                }
                .padding(.vertical, 2)
            } else if store.isLoading {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Loading your brief…").foregroundStyle(.secondary)
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("No brief for today yet.")
                        .font(.subheadline)
                    Text("Generate a Daily Report from your recent mail, calendar, and tasks.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Generate today’s brief") { Task { await store.generateBrief() } }
                        .buttonStyle(.borderedProminent)
                }
                .padding(.vertical, 2)
            }
        }
    }

    // A single reflowing summary line — wraps at any Dynamic Type size without
    // clipping, unlike a fixed row of chips.
    @ViewBuilder private func briefCountSummary(_ counts: DailyReportModel.SectionCounts) -> some View {
        let parts: [String] = [
            counts.replyOwed > 0 ? "\(counts.replyOwed) reply owed" : nil,
            counts.followUpOwed > 0 ? "\(counts.followUpOwed) follow-up" : nil,
            counts.timeSensitive > 0 ? "\(counts.timeSensitive) time-sensitive" : nil,
            counts.tracked > 0 ? "\(counts.tracked) tracked" : nil,
            counts.tasks > 0 ? "\(counts.tasks) tasks" : nil,
            counts.calendar > 0 ? "\(counts.calendar) events" : nil,
        ].compactMap { $0 }
        if !parts.isEmpty {
            Text(parts.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder private var scheduleEmptyState: some View {
        if store.calendarError != nil && !store.calendarDidLoad {
            Label("Couldn’t load your calendar", systemImage: "calendar.badge.exclamationmark")
                .foregroundStyle(.secondary)
        } else {
            ContentUnavailableView("Nothing scheduled today", systemImage: "calendar.badge.checkmark")
        }
    }

    private func handleBriefAction(_ action: String, _ payload: BriefActionPayload) {
        switch action {
        case "open_thread":
            if let account = payload.account, let thread = payload.threadID {
                environment.navigation.openThread(accountID: account, threadID: thread)
            }
        case "open_event":
            if let account = payload.account, let event = payload.eventID {
                let preview = store.events.first { $0.id == event && $0.accountID == account }
                environment.navigation.openEvent(
                    accountID: account,
                    eventID: event,
                    calendarID: preview?.calendarID ?? payload.calendarID,
                    preview: preview
                )
            }
        case "open_area":
            if let areaID = payload.areaID {
                let name = store.areas.first { $0.id == areaID }?.name
                environment.navigation.openArea(id: areaID, name: name)
            }
        case "open_work":
            if let workID = payload.workID {
                if let areaID = payload.areaID {
                    environment.navigation.openArea(id: areaID, name: nil)
                }
                environment.navigation.openWork(id: workID, title: payload.title)
            }
        case "open_view":
            if let view = payload.view { environment.navigation.openPrimaryView(view) }
        case "open_url":
            if let rawURL = payload.url,
               let url = URL(string: rawURL),
               url.scheme == "https"
            {
                openURL(url)
            }
        case "draft_reply":
            if let account = payload.account, let threadID = payload.threadID {
                environment.navigation.pendingCompose = ComposePrefill(
                    recipient: "",
                    cc: "",
                    bcc: "",
                    subject: payload.subject ?? "",
                    body: payload.body ?? "",
                    mode: "reply",
                    accountID: account,
                    threadID: threadID,
                    messageID: nil,
                    replyAll: false,
                    attachmentsKey: nil,
                    draftID: nil
                )
                environment.navigation.sheet = .compose
            }
        default:
            // Protected/mutating artifact actions (dismiss_task, toggle_task,
            // resolve_thread, dismiss_thread, …) are never executed from the
            // untrusted artifact. They route to the existing review surface.
            artifactReview = ArtifactReviewRequest(
                action: action,
                payload: payload,
                source: store.dailyReport?.title ?? "Daily Report"
            )
        }
    }
}

private struct DailyReportHistorySheet: View {
    @Environment(\.dismiss) private var dismiss
    let reports: [DailyReportModel]
    let onSelect: (DailyReportModel) async -> Void

    var body: some View {
        NavigationStack {
            List(reports, id: \.id) { report in
                Button {
                    Task { await onSelect(report) }
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(report.title)
                            .foregroundStyle(.primary)
                        Text(report.generatedAt.formatted(date: .complete, time: .shortened))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .overlay {
                if reports.isEmpty {
                    ContentUnavailableView("No saved reports", systemImage: "doc.text.magnifyingglass")
                }
            }
            .navigationTitle("Daily Report History")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }
}

struct EventRow: View {
    let event: CalendarEventSummary

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(event.allDay ? "All day" : event.start.formatted(.dateTime.hour().minute()))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 64, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                Text(event.title)
                if let location = event.location {
                    Label(location, systemImage: "location")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.forward")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .contentShape(.rect)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.accessibilityLabel(event))
        .accessibilityAddTraits(.isButton)
    }

    static func accessibilityLabel(_ event: CalendarEventSummary) -> String {
        var parts = [event.title]
        parts.append(event.allDay ? "all day" : event.start.formatted(date: .omitted, time: .shortened))
        if let location = event.location { parts.append("at \(location)") }
        return parts.joined(separator: ", ")
    }
}

struct TaskRow: View {
    let task: TaskSummary

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Image(systemName: task.completed ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(task.completed ? .secondary : .primary)
            VStack(alignment: .leading, spacing: 3) {
                Text(task.title).strikethrough(task.completed)
                HStack {
                    Text(task.column)
                    if let due = task.due { Text(due, format: .dateTime.month().day().hour().minute()) }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct AreaMotionRow: View {
    let area: AreaSummary

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(area.name)
                Text(area.overview?.statusLine ?? area.kind.capitalized)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            if area.overview?.needsAttention == true {
                Circle().fill(.orange).frame(width: 7, height: 7).accessibilityHidden(true)
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
