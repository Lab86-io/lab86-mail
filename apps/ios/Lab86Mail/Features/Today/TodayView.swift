import SwiftUI

struct TodayView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    @State private var showsHistory = false
    @State private var artifactReview: ArtifactReviewRequest?
    @State private var isRegenerating = false
    @State private var showsInlineDate = false

    private var store: ProductStore { environment.store }

    private var dateline: String {
        Date.now.formatted(.dateTime.weekday(.wide).month(.wide).day())
    }

    // The single source of truth for "this report renders the native v2
    // document" — the toolbar dateline and artifactBody must agree, or the
    // date shows twice / the crossfade never fires.
    static func rendersNativeDocument(_ report: DailyReportModel) -> Bool {
        report.document != nil && report.artifactSource == "document-v2"
    }

    /// How tall Today's own dateline masthead stands: the accent rule, the
    /// serif date, and the day-shape line under it.
    static let mastheadHeight: CGFloat = 132

    // Whether the masthead's dateline has scrolled far enough off screen that
    // the navigation bar should carry the date instead. It measures Today's own
    // masthead now, not the brief's — the brief no longer brings one.
    static func mastheadScrolledPast(offset: CGFloat, containerWidth _: CGFloat = 0) -> Bool {
        offset > mastheadHeight - 56
    }

    var body: some View {
        Group {
            todayBody
        }
        .navigationTitle("")
        .toolbar {
            // The dateline lives in the masthead. It crossfades into the bar
            // only once the masthead has scrolled away, so it never reads twice.
            ToolbarItem(placement: .principal) {
                Text(dateline)
                    .font(.headline)
                    .opacity(showsInlineDate ? 1 : 0)
                    .animation(.easeInOut(duration: 0.15), value: showsInlineDate)
                    .accessibilityHidden(!showsInlineDate)
            }
            ToolbarItem(placement: .primaryAction) {
                regenerateButton
            }
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

    /// Today is one page read in layers down one scroll.
    ///
    /// The live layer comes first and is read from live work, approvals and
    /// calendar rows, so the top of the page can never be stale. The brief's
    /// synthesis follows underneath it, stamped with when it was written.
    ///
    /// It used to be two whole surfaces: when a brief existed the live day
    /// vanished behind it, and a three-week-old edition could present itself as
    /// the current one. The web merged them; this is the same page.
    private var todayBody: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                todayMasthead
                liveLayer
                briefLayer
                    .padding(.bottom, 32)
            }
        }
        .onScrollGeometryChange(for: Bool.self) { geometry in
            Self.mastheadScrolledPast(
                offset: geometry.contentOffset.y + geometry.contentInsets.top,
                containerWidth: geometry.containerSize.width
            )
        } action: { _, crossed in
            showsInlineDate = crossed
        }
        .refreshable { await store.refreshToday() }
        .overlay {
            if store.isLoading && store.dailyReport == nil && store.events.isEmpty && store.approvals.isEmpty {
                ProgressView("Putting your day together…")
            }
        }
    }

    /// The editorial dateline: an accent rule, the year set small in mono, the
    /// date in serif, and one sentence about the shape of the day.
    private var todayMasthead: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Rectangle()
                    .fill(Color.accentColor)
                    .frame(width: 22, height: 1)
                Text(Date.now.formatted(.dateTime.year()))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
            Text(dateline)
                .font(.system(.largeTitle, design: .serif).weight(.semibold))
                .lineLimit(2)
                .minimumScaleFactor(0.7)
            Text(dayShape)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.top, 4)
        .padding(.bottom, 18)
        .overlay(alignment: .bottom) { Divider() }
    }

    /// What actually needs the user: approvals waiting, plus every Albatross the
    /// Albatrosses page would file under "Needs you". Counting approvals alone
    /// let the masthead say "Nothing needs you today" while that page showed a
    /// needs-you group.
    private var needsYouCount: Int {
        store.approvals.count + store.allWork.filter(\.needsYou).count
    }

    /// What Albatross is carrying on its own. The sentence says "Albatross is
    /// carrying N things", which describes Albatrosses, not board cards.
    private var carryingCount: Int {
        store.allWork.filter { !$0.isClosed && !$0.needsYou }.count
    }

    private var dayShape: String {
        TodayComposition.dayShapeLine(
            needsYouCount: needsYouCount,
            eventCount: store.todaysEvents.count,
            capacity: .normal,
            carryingCount: carryingCount
        )
    }

    /// The short list of Albatrosses that cannot move without the user, ordered
    /// by how much is waiting on them.
    private var needsYouWork: [WorkListItem] {
        store.allWork.filter(\.needsYou).sorted { $0.openQuestions > $1.openQuestions }
    }

    /// Always current, because it is read rather than written.
    @ViewBuilder private var liveLayer: some View {
        if !store.approvals.isEmpty || !needsYouWork.isEmpty {
            todaySection("Needs you", note: "Albatross cannot move these without you.") {
                VStack(spacing: 0) {
                    ForEach(needsYouWork.prefix(3)) { item in
                        Button {
                            environment.navigation.openWork(id: item.id, title: item.displayTitle)
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(item.displayTitle)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(.primary)
                                Text(item.standingLine)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 10)
                        }
                        .buttonStyle(.plain)
                        Divider()
                    }
                    ForEach(store.approvals.prefix(3)) { approval in
                        Button {
                            environment.navigation.sheet = .activity
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(approval.title)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(.primary)
                                Text(approval.detail)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 10)
                        }
                        .buttonStyle(.plain)
                        if approval.id != store.approvals.prefix(3).last?.id { Divider() }
                    }
                }
                .padding(.horizontal, 14)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color(.secondarySystemGroupedBackground))
                )
            }
        }

        // The day drawn to scale rather than listed. Where the open air is
        // decides what can move today, and a list never says it.
        todaySection("Your day", note: "Solid is booked. Dashed is open air.") {
            if store.todaysEvents.isEmpty {
                scheduleEmptyState
            } else {
                DayRibbonView(events: store.todaysEvents, now: Date()) { event in
                    environment.navigation.openEvent(event)
                }
            }
        }

        let moving = store.allWork.filter { !$0.isClosed && !$0.needsYou }
        if !moving.isEmpty {
            todaySection("Could move today", note: "Albatross is carrying these.") {
                VStack(spacing: 0) {
                    ForEach(moving.prefix(6)) { item in
                        Button {
                            environment.navigation.openWork(id: item.id, title: item.displayTitle)
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(item.displayTitle)
                                    .font(.subheadline)
                                    .foregroundStyle(.primary)
                                Text(item.standingLine)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 8)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }

        let openTasks = store.tasks.filter { !$0.completed }
        if !openTasks.isEmpty {
            todaySection("Tasks", note: "From your boards.") {
                VStack(spacing: 0) {
                    ForEach(openTasks.prefix(8)) { task in
                        TaskRow(task: task)
                            .padding(.vertical, 4)
                    }
                }
            }
        }

        if !store.areas.isEmpty {
            todaySection("In motion", note: "Areas Albatross is carrying.") {
                VStack(spacing: 0) {
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
    }

    /// A section rule in the editorial voice: a hairline, a serif heading, a
    /// quiet note, and a rule running out to the margin.
    @ViewBuilder
    private func todaySection<Content: View>(
        _ title: String,
        note: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Rectangle()
                    .fill(Color.secondary.opacity(0.45))
                    .frame(width: 18, height: 1)
                Text(title).font(.system(.subheadline, design: .serif).weight(.semibold))
                Text(note).font(.caption2).foregroundStyle(.tertiary)
                Spacer(minLength: 0)
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
    }

    // Regenerate is busy — progress shown, button disabled — while a rebuild
    // is in flight locally or the server still reports the edition generating.
    static func regenerateInFlight(isRegenerating: Bool, report: DailyReportModel?) -> Bool {
        isRegenerating || report?.isGenerating == true
    }

    // Regenerate lives in the top bar beside History — never inside the brief
    // document. It shows progress while an edition is being rebuilt and stays
    // tappable again after a failure (generateBrief surfaces its own error
    // state through the store).
    private var regenerateButton: some View {
        let busy = Self.regenerateInFlight(isRegenerating: isRegenerating, report: store.dailyReport)
        return Button {
            isRegenerating = true
            Task {
                await store.generateBrief()
                isRegenerating = false
            }
        } label: {
            if busy {
                ProgressView()
            } else {
                Label("Regenerate brief", systemImage: "arrow.clockwise")
            }
        }
        .disabled(busy)
    }

    /// The synthesis layer. It is generated, so it says when it was written and
    /// says it louder when it describes an older day. A missing brief thins the
    /// page; it never replaces the live day above it.
    @ViewBuilder private var briefLayer: some View {
        let report = store.dailyReport
        let standing = TodayComposition.briefStandingLine(generatedAt: report?.generatedAt, now: Date())
        let stale = TodayComposition.briefIsStale(generatedAt: report?.generatedAt, now: Date())
        let busy = Self.regenerateInFlight(isRegenerating: isRegenerating, report: report)

        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Rectangle()
                    .fill(Color.secondary.opacity(0.45))
                    .frame(width: 18, height: 1)
                Text("The brief").font(.system(.subheadline, design: .serif).weight(.semibold))
                Text(standing)
                    .font(.caption2)
                    .foregroundStyle(stale ? Color.orange : Color.secondary)
                Spacer(minLength: 0)
                Button {
                    isRegenerating = true
                    Task {
                        await store.generateBrief()
                        isRegenerating = false
                    }
                } label: {
                    Text(busy ? "Writing…" : (report == nil ? "Write today\u{2019}s brief" : "Write it again"))
                        .font(.caption)
                }
                .disabled(busy)
            }
            .padding(.horizontal, 20)

            briefContent(report)
        }
        .padding(.top, 20)
    }

    @ViewBuilder
    private func briefContent(_ report: DailyReportModel?) -> some View {
        if let report, report.hasArtifact {
            if let document = report.document, Self.rendersNativeDocument(report) {
                // Today has already given the date, so the brief brings no
                // masthead of its own into the same scroll.
                DailyBriefLede(text: document.summary)
                BriefDocumentView(
                    document: document,
                    isComposing: report.artifactStatus == "composing",
                    onReview: { artifactReview = $0 }
                )
                DailyBriefFooter(report: report)
            } else {
                DailyBriefView(
                    report: report,
                    lastRefresh: store.lastRefresh,
                    isOffline: store.briefError != nil,
                    onAction: handleBriefAction
                )
            }
        } else if let report, report.isGenerating {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Putting today\u{2019}s brief together…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                if let progress = report.progress, progress.total > 0 {
                    ProgressView(value: progress.fraction)
                }
            }
            .padding(.horizontal, 20)
        } else if let report {
            VStack(alignment: .leading, spacing: 8) {
                if let text = report.legacyText {
                    Text(text).font(.body).textSelection(.enabled)
                }
                briefCountSummary(report.sectionCounts)
            }
            .padding(.horizontal, 20)
        } else if let error = store.briefError {
            VStack(alignment: .leading, spacing: 8) {
                Label("Couldn\u{2019}t load today\u{2019}s brief", systemImage: "exclamationmark.triangle")
                    .font(.subheadline.weight(.medium))
                Text(error).font(.caption).foregroundStyle(.secondary)
                Button("Try Again") { Task { await store.refreshBrief() } }
                    .buttonStyle(.bordered)
            }
            .padding(.horizontal, 20)
        } else {
            Text("Albatross writes this each morning from your mail and calendar. There is no edition for today yet.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 20)
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
        if let intent = TodayBriefNavigationIntent.resolve(action: action, payload: payload) {
            switch intent {
            case .work(let workID, let areaID, let title):
                if let areaID {
                    environment.navigation.openArea(id: areaID, name: nil)
                }
                environment.navigation.openWork(id: workID, title: title)
            case .primaryView(let view):
                environment.navigation.openPrimaryView(view)
            case .externalURL(let url):
                openURL(url)
            }
            return
        }

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

enum TodayBriefNavigationIntent: Equatable {
    case work(workID: String, areaID: String?, title: String?)
    case primaryView(String)
    case externalURL(URL)

    static func resolve(action: String, payload: BriefActionPayload) -> Self? {
        switch action {
        case "open_work":
            guard let workID = payload.workID else { return nil }
            return .work(workID: workID, areaID: payload.areaID, title: payload.title)
        case "open_view":
            guard let view = payload.view else { return nil }
            return .primaryView(view)
        case "open_url":
            guard let rawURL = payload.url,
                  let url = URL(string: rawURL),
                  url.scheme?.lowercased() == "https",
                  url.host != nil
            else {
                return nil
            }
            return .externalURL(url)
        default:
            return nil
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
