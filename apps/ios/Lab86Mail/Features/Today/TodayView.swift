import SwiftUI

struct TodayView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var narrative = NarrativeBriefStore()
    @State private var emptyEditionDate = Date.now
    @State private var showsHistory = false
    @State private var historyLoading = false
    @State private var historyError: String?
    @State private var artifactReview: ArtifactReviewRequest?
    @State private var isRegenerating = false
    // What the user last asked the brief to do, so "Try again" repeats it.
    @State private var lastBriefRequest: BriefRequest = .read
    @State private var showsInlineDate = false
    @State private var showsBriefSettings = false

    private var store: ProductStore { environment.store }

    /// The brief reads were a plain load, or a request to write the edition.
    enum BriefRequest: Equatable {
        case read
        case write
    }

    /// The reading column under the plate: 680 pt of text and the 20 pt
    /// margins on each side (D23).
    static let readingWidth: CGFloat = 720

    /// Room under the last row so the floating "+" never covers it (D24).
    static let bottomReserve: CGFloat = 88

    /// On a regular-width iPad the floating "+" sits over the trailing end of
    /// the rows. The column leaves it that room (56 pt button, 20 pt margin).
    static func trailingReserve(regularWidth: Bool) -> CGFloat {
        regularWidth ? 76 : 0
    }

    private var dateline: String {
        Self.editionDate(report: store.dailyReport, now: emptyEditionDate)
            .formatted(.dateTime.weekday(.wide).month(.wide).day())
    }

    static func editionDate(report: DailyReportModel?, now: Date) -> Date { report?.generatedAt ?? now }

    // The single source of truth for "this report renders the native v2
    // document" — the toolbar dateline and artifactBody must agree, or the
    // date shows twice / the crossfade never fires.
    static func rendersNativeDocument(_ report: DailyReportModel) -> Bool {
        report.document != nil && report.artifactSource == "document-v2"
    }

    // Whether the masthead's dateline has scrolled far enough off screen that
    // the navigation bar should carry the date instead. The plate is a
    // fixed-aspect image, so its height follows the container width.
    static func mastheadScrolledPast(offset: CGFloat, containerWidth: CGFloat) -> Bool {
        offset > DailyBriefMasthead.height(forWidth: containerWidth) - 56
    }

    // The narrative poll runs while the scene is active or inactive (Control
    // Center, Face ID). It stops, and the account clears, only in the
    // background. The key changes with the edition, so a new edition starts a
    // fresh poll and the store clears the old account itself (B5).
    static func narrativePollKey(report: DailyReportModel?, scenePhase: ScenePhase) -> String {
        "\(report?.generatedAt.timeIntervalSince1970 ?? 0):\(clearsNarrative(in: scenePhase) ? "background" : "foreground")"
    }

    static func clearsNarrative(in scenePhase: ScenePhase) -> Bool {
        scenePhase == .background
    }

    // While the shown edition is still being written, Today re-reads it every
    // five seconds so the progress note and the finished letter arrive
    // without a pull (B1). The poll stops in the background and once the
    // edition is done.
    static let briefPollInterval: Duration = .seconds(5)

    static func pollsBrief(report: DailyReportModel?, scenePhase: ScenePhase) -> Bool {
        report?.isGenerating == true && scenePhase != .background
    }

    static func briefPollKey(report: DailyReportModel?, scenePhase: ScenePhase) -> String {
        "\(report?.id ?? "none"):\(pollsBrief(report: report, scenePhase: scenePhase))"
    }

    // A failed history read with nothing to show is the sheet's error. When
    // past briefs from an earlier read are still there, the sheet shows them.
    static func historyFailure(reportCount: Int, loadError: String?) -> String? {
        reportCount == 0 ? loadError : nil
    }

    var body: some View {
        todayBody
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // The dateline lives in the masthead. It crossfades into the bar
            // only once the masthead has scrolled away, so it never reads twice.
            #if os(macOS)
            // AppKit draws an empty capsule for a principal item even at
            // opacity zero; mount the item only when it has something to say.
            if showsInlineDate {
                ToolbarItem(placement: .principal) {
                    Text(dateline)
                        .font(.headline)
                }
            }
            #else
            ToolbarItem(placement: .principal) {
                Text(dateline)
                    .font(.headline)
                    .opacity(showsInlineDate ? 1 : 0)
                    .animation(.easeInOut(duration: 0.15), value: showsInlineDate)
                    .accessibilityHidden(!showsInlineDate)
            }
            #endif
            ToolbarItem(placement: .primaryAction) {
                regenerateButton
            }
            // Secondary actions share the system overflow menu, so the bar
            // carries one ellipsis, never two side by side (D20).
            ToolbarItem(placement: .secondaryAction) {
                Button("Past briefs", systemImage: "clock") { openHistory() }
            }
            ToolbarItem(placement: .secondaryAction) {
                Button("Delivery and schedule", systemImage: "calendar.badge.clock") { showsBriefSettings = true }
            }
        }
        .sheet(isPresented: $showsBriefSettings) {
            NavigationStack {
                BriefSettingsView()
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { showsBriefSettings = false }
                        }
                    }
            }
            #if os(macOS)
            .macFormSheet()
            #endif
        }
        .task { await environment.trust.refreshPlan() }
        .sheet(isPresented: $showsHistory) {
            DailyReportHistorySheet(
                reports: store.dailyReportHistory,
                isLoading: historyLoading,
                error: historyError,
                onRetry: { await loadHistory() },
                onSelect: { report in await openPastBrief(report) }
            )
        }
        .sheet(item: $artifactReview) { request in
            // The sheet closes first; only the brief re-reads, in the
            // background (B7).
            ArtifactActionReviewSheet(request: request) {
                await store.refreshBrief()
            }
        }
        .shellToolbar()
        .task(id: Self.narrativePollKey(report: store.dailyReport, scenePhase: scenePhase)) {
            if Self.clearsNarrative(in: scenePhase) { narrative.clear(); return }
            emptyEditionDate = .now
            while !Task.isCancelled {
                await reloadNarrative()
                do { try await Task.sleep(for: .seconds(narrative.running ? 8 : 60)) } catch { return }
            }
        }
        .task(id: Self.briefPollKey(report: store.dailyReport, scenePhase: scenePhase)) {
            guard Self.pollsBrief(report: store.dailyReport, scenePhase: scenePhase) else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: Self.briefPollInterval) } catch { return }
                await store.refreshBrief()
            }
        }
        // A `brief_ready` notification names its edition. Open that one, not
        // the latest. The request is read once.
        .task(id: environment.navigation.pendingBriefEditionID) {
            // Read the id without clearing it: clearing changes this task's
            // key and cancels the request. The request is cleared after it
            // settles, which re-runs the task once with a nil id (a no-op).
            guard let editionID = environment.navigation.pendingBriefEditionID else { return }
            await store.selectDailyReport(id: editionID)
            // A newer request may have replaced this one while the edition
            // loaded. Only the request this task served is cleared.
            guard !Task.isCancelled, environment.navigation.pendingBriefEditionID == editionID else { return }
            _ = environment.navigation.consumeBriefEdition()
        }
    }

    private func reloadNarrative() async {
        let date = Self.editionDate(report: store.dailyReport, now: emptyEditionDate)
        let backend = environment.backend
        await narrative.load(.brief(date)) { try await backend.get(path: $0) }
    }

    private func regenerateBrief() async {
        lastBriefRequest = .write
        let backend = environment.backend
        await narrative.requestRefresh {
            try await backend.post(path: "/api/narrative", body: .object(["action": .string("refresh")]))
        }
        await store.generateBrief()
        await reloadNarrative()
    }

    private func startRegenerate() {
        isRegenerating = true
        Task {
            await regenerateBrief()
            isRegenerating = false
        }
    }

    // "Try again" repeats what failed: the write, or the plain read.
    private func retryBrief() async {
        switch lastBriefRequest {
        case .write:
            isRegenerating = true
            await regenerateBrief()
            isRegenerating = false
        case .read:
            await store.refreshBrief()
        }
    }

    private func openHistory() {
        showsHistory = true
        Task { await loadHistory() }
    }

    private func loadHistory() async {
        historyLoading = true
        historyError = nil
        await store.loadDailyReportHistory()
        historyLoading = false
        historyError = Self.historyFailure(reportCount: store.dailyReportHistory.count, loadError: store.historyError)
    }

    // Opens one past edition. Nil when it opened; else the reason it did not,
    // which the sheet shows in place (it stays open).
    private func openPastBrief(_ report: DailyReportModel) async -> String? {
        await store.selectDailyReport(id: report.id)
        if store.dailyReport?.id == report.id {
            showsHistory = false
            return nil
        }
        return store.briefError ?? "This brief did not open."
    }

    /// On compact Apple platforms, Today is one page read in layers down one
    /// scroll. The Mac branch below restores the written Brief as the page.
    ///
    /// The live layer comes first and is read from live work, approvals and
    /// calendar rows, so the top of the page can never be stale. The brief's
    /// synthesis follows underneath it, stamped with when it was written.
    ///
    /// It used to be two whole surfaces: when a brief existed the live day
    /// vanished behind it, and a three-week-old edition could present itself as
    /// the current one. The web merged them; this is the same page.
    @ViewBuilder
    private var todayBody: some View {
        #if os(macOS)
        // Restore the desktop Today surface to its strongest identity: when a
        // written edition exists, the brief is the page. Live operational
        // modules remain the useful fallback while an edition is unavailable.
        if let report = store.dailyReport, report.hasArtifact {
            macBriefBody(report)
        } else {
            layeredTodayBody
        }
        #else
        layeredTodayBody
        #endif
    }

    private var trailingReserve: CGFloat {
        #if os(iOS)
        Self.trailingReserve(regularWidth: horizontalSizeClass == .regular)
        #else
        0
        #endif
    }

    /// The compact-client composition remains one continuous page of live day
    /// context followed by its synthesis. macOS only uses this as the fallback
    /// until a complete Brief artifact is available.
    private var layeredTodayBody: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                // The plate. The day's art, its dateline and its edition title,
                // carried by the day itself rather than by the brief — so it is
                // right on a morning when nothing has been written yet, and
                // there is only ever one of it on the page.
                DailyBriefMasthead(
                    generatedAt: Self.editionDate(report: store.dailyReport, now: emptyEditionDate),
                    art: store.dailyReport?.art,
                    kind: store.dailyReport?.kind
                )
                sourceStrip
                    .modifier(TodayColumn(trailingReserve: trailingReserve))
                todayDeck
                    .modifier(TodayColumn(trailingReserve: trailingReserve))
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    liveLayer(now: context.date)
                }
                .modifier(TodayColumn(trailingReserve: trailingReserve))
                briefLayer
                    .padding(.bottom, 32)
                    .modifier(TodayColumn(trailingReserve: trailingReserve))
            }
        }
        .contentMargins(.bottom, Self.bottomReserve, for: .scrollContent)
        .onScrollGeometryChange(for: Bool.self) { geometry in
            Self.mastheadScrolledPast(
                offset: geometry.contentOffset.y + geometry.contentInsets.top,
                containerWidth: geometry.containerSize.width
            )
        } action: { _, crossed in
            showsInlineDate = crossed
        }
        .refreshable {
            await store.refreshToday()
            await store.refreshExecution()
            await reloadNarrative()
            await environment.refreshTodayWidget()
        }
        .task(id: "today-execution-poll") {
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(300))
                } catch {
                    return
                }
                await store.refreshExecution()
            }
        }
    }

    #if os(macOS)
    /// The editorial Brief experience the desktop had before Today became a
    /// dashboard. It deliberately reuses the same masthead, lede, document,
    /// footer, review flow, and legacy HTML renderer rather than creating a
    /// second interpretation of report data.
    private func macBriefBody(_ report: DailyReportModel) -> some View {
        ScrollView {
            if let document = report.document, Self.rendersNativeDocument(report) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    DailyBriefMasthead(generatedAt: report.generatedAt, art: report.art, kind: report.kind)
                    sourceStrip
                    if BriefOwnerMounts.mountsReadyForYou(hasReport: true, showsLatest: store.showsLatestDailyReport) {
                        ReadyForYouSection()
                    }
                    if BriefOwnerMounts.mountsNarrative(document) {
                        narrativeView
                    }
                    if BriefOwnerMounts.mountsLede(document, narrativeLoaded: narrative.entry != nil) {
                        DailyBriefLede(text: document.summary)
                    }
                    BriefDocumentView(
                        document: document,
                        isComposing: report.artifactStatus == "composing",
                        surface: .daily,
                        reportID: report.id,
                        hideInactive: store.showsLatestDailyReport,
                        liveSections: BriefOwnerMounts.liveSections(
                            showsLatest: store.showsLatestDailyReport,
                            narrative: narrative,
                            backend: environment.backend
                        ),
                        onReview: { artifactReview = $0 }
                    )
                    if BriefOwnerMounts.mountsPreparedWork(
                        document,
                        hasArtifact: report.hasArtifact,
                        showsLatest: store.showsLatestDailyReport
                    ) {
                        PreparedWorkSection()
                    }
                    BriefMailBacklog(items: report.overflow) { item in
                        environment.navigation.openThread(accountID: item.accountID, threadID: item.threadID)
                    }
                    DailyBriefFooter(report: report)
                        .padding(.bottom, 32)
                }
                .frame(maxWidth: 920)
                .frame(maxWidth: .infinity)
            } else {
                LazyVStack(alignment: .leading, spacing: 0) {
                    // An older HTML edition draws its own masthead, so the
                    // source line, the Reconnect rows, and the trial note
                    // lead the page (round 2).
                    sourceStrip
                    narrativeView
                    DailyBriefView(
                        report: report,
                        lastRefresh: store.lastRefresh,
                        isOffline: store.briefError != nil,
                        onAction: handleBriefAction
                    )
                }
                .frame(maxWidth: 920)
                .frame(maxWidth: .infinity)
                .padding(.bottom, 32)
            }
        }
        .background(environment.theme.paperColor)
        // Both native and legacy editions carry a masthead, so the shared
        // scroller must hand its dateline to the toolbar for either renderer.
        .onScrollGeometryChange(for: Bool.self) { geometry in
            Self.mastheadScrolledPast(
                offset: geometry.contentOffset.y + geometry.contentInsets.top,
                containerWidth: min(geometry.containerSize.width, 920)
            )
        } action: { _, crossed in
            showsInlineDate = crossed
        }
        .refreshable {
            await store.refreshToday()
            await reloadNarrative()
        }
    }
    #endif

    /// The source health line, the edition notes, and the trial note, under
    /// the plate (round 2).
    private var sourceStrip: some View {
        BriefSourceStrip(
            health: store.briefSources,
            notes: BriefEditionNotes.notes(for: store.dailyReport),
            trialNote: environment.trust.plan?.trialNote
        )
    }

    private var narrativeView: some View {
        NarrativeBriefView(memory: narrative, backend: environment.backend) {
            await reloadNarrative()
        }
    }

    /// The deck under the plate: one sentence about the shape of the day. The
    /// plate already carries the date, so this never repeats it.
    private var todayDeck: some View {
        Text(dayShape)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 2)
            .padding(.bottom, 18)
            .overlay(alignment: .bottom) { Divider() }
    }

    /// What needs the user today: approvals waiting, plus every Albatross
    /// that cannot move without them. The deck counts them. The page no longer
    /// lists them; that list is the Work page.
    private var needsYouCount: Int {
        store.approvals.count + store.workExecution.needsYou.count
    }

    private var dayShape: String {
        TodayComposition.dayShapeLine(
            needsYouCount: needsYouCount,
            eventCount: store.todaysEvents.count,
            capacity: .normal
        )
    }

    /// The conversations the letter below already lists, as "account:thread"
    /// keys. Only a native edition can be read this way; an HTML edition
    /// keeps the live section whole.
    private var letterThreadKeys: Set<String> {
        guard let report = store.dailyReport, report.hasArtifact,
              let document = report.document, Self.rendersNativeDocument(report) else { return [] }
        return TodayComposition.letterThreadKeys(in: document)
    }

    /// Mail that matters, from the brief's own attention index, without the
    /// conversations the letter already shows on this page (D19). At most four.
    private var importantMail: [ImportantMailItem] {
        TodayComposition.mailOutsideLetter(
            store.dailyReport?.importantMail ?? [],
            letterThreadKeys: letterThreadKeys
        )
    }

    /// Today is the day, the mail, and one move. Always current, because it
    /// is read rather than written. No albatross stack sits above the calendar.
    @ViewBuilder private func liveLayer(now: Date) -> some View {
        // The day drawn to scale rather than listed. Where the open air is
        // decides what can move today, and a list never says it.
        todaySection("Your day", note: "Solid is booked. Dashed is open air.") {
            scheduleBody(now: now)
        }

        if !importantMail.isEmpty {
            // The rows say why each one matters; the rule needs no hint.
            todaySection("Mail that matters") {
                MailThatMattersSection(items: importantMail) { item in
                    environment.navigation.openThread(accountID: item.accountID, threadID: item.threadID)
                }
            }
        }

        if let move = TodayComposition.nextMove(from: store.workExecution.currentMove, now: now) {
            todaySection("Next move", note: "One step, booked for today.") {
                NextMoveLine(move: move) {
                    environment.navigation.openWork(id: move.workID, title: move.workTitle)
                }
            }
        }
    }

    // Three states, never a spinner over an empty line (B4): loading rows
    // until the first calendar read ends, the failure with a retry, else the
    // ribbon. An empty day still draws the ribbon: open air is the point.
    @ViewBuilder private func scheduleBody(now: Date) -> some View {
        if let error = store.calendarError, !store.calendarDidLoad {
            TodayProblemLine(message: "Your calendar did not load.", detail: error) {
                await store.refreshToday()
            }
        } else if !store.calendarDidLoad {
            BriefPlaceholderBars()
                .padding(.vertical, 8)
        } else {
            DayRibbonView(
                events: store.todaysEvents,
                now: now,
                height: store.todaysEvents.isEmpty ? 180 : 300
            ) { event in
                environment.navigation.openEvent(event)
            }
        }
    }

    /// A section in the editorial voice: the shared rule, the heading in the
    /// display face, a quiet note, then the content.
    @ViewBuilder
    private func todaySection<Content: View>(
        _ title: String,
        note: String? = nil,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            BriefSectionRule(title: title, note: note)
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
            startRegenerate()
        } label: {
            if busy {
                ProgressView()
            } else {
                Label("Write the brief again", systemImage: "arrow.clockwise")
            }
        }
        .disabled(busy)
    }

    /// The synthesis layer. It is generated, so it says when it was written and
    /// says it louder when it describes an older day. A missing brief thins the
    /// page; it never replaces the live day above it.
    @ViewBuilder private var briefLayer: some View {
        let report = store.dailyReport
        let busy = Self.regenerateInFlight(isRegenerating: isRegenerating, report: report)

        VStack(alignment: .leading, spacing: 12) {
            briefRule(report: report, busy: busy)
                .padding(.horizontal, 20)
            // A failed read or write says so in every state, not only when
            // no edition shows (B6).
            if let error = store.briefError, !busy {
                TodayProblemLine(
                    message: lastBriefRequest == .write ? "The brief was not written." : "The brief did not load.",
                    detail: error
                ) {
                    await retryBrief()
                }
                .padding(.horizontal, 20)
            }
            briefContent(report)
        }
        .padding(.top, 20)
    }

    private func briefRule(report: DailyReportModel?, busy: Bool) -> some View {
        let standing = Self.briefStanding(report: report, briefDidLoad: store.briefDidLoad, now: Date())
        let stale = TodayComposition.briefIsStale(generatedAt: report?.generatedAt, now: Date())
        return BriefSectionRule(
            title: report?.isWeeklyReview == true ? "The weekly review" : "The brief",
            note: standing,
            noteVoice: .narration,
            noteWarns: stale,
            action: BriefSectionRule.Action(
                title: busy ? "Writing" : (report == nil ? "Write today\u{2019}s brief" : "Write it again"),
                isDisabled: busy,
                run: startRegenerate
            )
        )
    }

    // Before the first brief read ends the rule does not claim "not written
    // yet"; it says the read is in progress (B4).
    static func briefStanding(report: DailyReportModel?, briefDidLoad: Bool, now: Date) -> String {
        if report == nil, !briefDidLoad { return "Reading today\u{2019}s edition" }
        return TodayComposition.briefStandingLine(generatedAt: report?.generatedAt, now: now)
    }

    @ViewBuilder
    private func briefContent(_ report: DailyReportModel?) -> some View {
        // The step runner's handoffs come first, before the editorial body.
        if BriefOwnerMounts.mountsReadyForYou(hasReport: report != nil, showsLatest: store.showsLatestDailyReport) {
            ReadyForYouSection()
        }
        // An editorial edition places the narrative in its own body.
        if BriefOwnerMounts.mountsNarrative(
            report.flatMap { Self.rendersNativeDocument($0) ? $0.document : nil }
        ) {
            narrativeView
        }
        if let report, report.hasArtifact {
            briefArtifact(report)
        } else if let report, report.isGenerating {
            briefWritingLine(report)
        } else if let report {
            VStack(alignment: .leading, spacing: 8) {
                if let text = report.legacyText {
                    Text(text).font(.body).textSelection(.enabled)
                }
                briefCountSummary(report.sectionCounts)
            }
            .padding(.horizontal, 20)
        } else if !store.briefDidLoad {
            // Loading rows until the first read ends; never "no edition yet"
            // under a spinner (B4).
            BriefPlaceholderBars()
                .padding(.horizontal, 20)
                .padding(.top, 8)
        } else if store.briefError == nil {
            Text("No edition for today yet. Albatross writes one each morning from your mail and calendar.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 20)
        }
    }

    @ViewBuilder
    private func briefArtifact(_ report: DailyReportModel) -> some View {
        if let document = report.document, Self.rendersNativeDocument(report) {
            // Today has already given the date, so the brief brings no
            // masthead of its own into the same scroll.
            if BriefOwnerMounts.mountsLede(document, narrativeLoaded: narrative.entry != nil) {
                DailyBriefLede(text: document.summary)
            }
            BriefDocumentView(
                document: document,
                isComposing: report.artifactStatus == "composing",
                surface: .daily,
                reportID: report.id,
                hideInactive: store.showsLatestDailyReport,
                liveSections: BriefOwnerMounts.liveSections(
                    showsLatest: store.showsLatestDailyReport,
                    narrative: narrative,
                    backend: environment.backend
                ),
                onReview: { artifactReview = $0 }
            )
            if BriefOwnerMounts.mountsPreparedWork(
                document,
                hasArtifact: report.hasArtifact,
                showsLatest: store.showsLatestDailyReport
            ) {
                PreparedWorkSection()
            }
            BriefMailBacklog(items: report.overflow) { item in
                environment.navigation.openThread(accountID: item.accountID, threadID: item.threadID)
            }
            DailyBriefFooter(report: report)
        } else {
            DailyBriefView(
                report: report,
                lastRefresh: store.lastRefresh,
                isOffline: store.briefError != nil,
                onAction: handleBriefAction
            )
        }
    }

    private func briefWritingLine(_ report: DailyReportModel) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Writing today\u{2019}s brief")
                    .font(environment.theme.displayType.displayItalicFont(size: 15))
                    .foregroundStyle(.secondary)
            }
            if let progress = report.progress, progress.total > 0 {
                ProgressView(value: progress.fraction)
            }
        }
        .padding(.horizontal, 20)
    }

    // A single reflowing summary line — wraps at any Dynamic Type size without
    // clipping, unlike a fixed row of chips.
    @ViewBuilder private func briefCountSummary(_ counts: DailyReportModel.SectionCounts) -> some View {
        let line = Self.countSummaryLine(counts)
        if !line.isEmpty {
            Text(line)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    static func countSummaryLine(_ counts: DailyReportModel.SectionCounts) -> String {
        let parts: [String] = [
            counts.replyOwed > 0 ? "\(counts.replyOwed) reply owed" : nil,
            counts.followUpOwed > 0 ? "\(counts.followUpOwed) follow-up" : nil,
            counts.timeSensitive > 0 ? "\(counts.timeSensitive) time-sensitive" : nil,
            counts.tracked > 0 ? "\(counts.tracked) tracked" : nil,
            counts.tasks > 0 ? "\(counts.tasks) tasks" : nil,
            counts.calendar > 0 ? "\(counts.calendar) events" : nil,
        ].compactMap { $0 }
        return parts.joined(separator: ", ")
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
                source: store.dailyReport?.title ?? "Today\u{2019}s brief"
            )
        }
    }
}

/// The reading column under the plate: a maximum width, centered on wide
/// screens, with room on the trailing side for the floating "+" where it
/// overlaps the rows.
private struct TodayColumn: ViewModifier {
    let trailingReserve: CGFloat

    func body(content: Content) -> some View {
        content
            .frame(maxWidth: TodayView.readingWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.trailing, trailingReserve)
    }
}

/// A failed read on Today: what went wrong, the detail, and one text button
/// that repeats the read. Never an icon, never a spinner that stays.
struct TodayProblemLine: View {
    let message: String
    var detail: String? = nil
    var retryTitle = "Try again"
    let retry: () async -> Void

    @State private var isRetrying = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(message)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.primary)
            if let detail, !detail.isEmpty {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button(retryTitle) {
                isRetrying = true
                Task {
                    await retry()
                    isRetrying = false
                }
            }
            .buttonStyle(.plain)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.tint)
            .disabled(isRetrying)
            .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
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

// The past briefs. Three states while the list loads, fails, or is empty, and
// a row that shows its own progress while that edition opens. A failed open
// keeps the sheet and says why.
private struct DailyReportHistorySheet: View {
    @Environment(\.dismiss) private var dismiss
    let reports: [DailyReportModel]
    let isLoading: Bool
    let error: String?
    let onRetry: () async -> Void
    let onSelect: (DailyReportModel) async -> String?

    @State private var openingID: String?
    @State private var openError: String?

    var body: some View {
        NavigationStack {
            List {
                if isLoading, reports.isEmpty {
                    ForEach(0..<3, id: \.self) { _ in
                        BriefPlaceholderBars()
                            .padding(.vertical, 6)
                    }
                } else if let error {
                    TodayProblemLine(message: "Past briefs did not load.", detail: error, retry: onRetry)
                        .padding(.vertical, 6)
                } else if reports.isEmpty {
                    Text("No past briefs yet.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(reports, id: \.id) { report in
                        row(report)
                    }
                    if let openError {
                        Text(openError)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Past briefs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }

    private func row(_ report: DailyReportModel) -> some View {
        Button {
            openingID = report.id
            openError = nil
            Task {
                openError = await onSelect(report)
                openingID = nil
            }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(report.title)
                        .foregroundStyle(.primary)
                    Text(report.generatedAt.formatted(date: .complete, time: .shortened))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if openingID == report.id {
                    ProgressView()
                        .controlSize(.small)
                }
            }
            .contentShape(.rect)
        }
        .disabled(openingID != nil)
    }
}

struct EventRow: View {
    let event: CalendarEventSummary

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            // The time column is as wide as the widest time, not a constant.
            ZStack(alignment: .leading) {
                Text("12:00 PM")
                    .font(.caption.monospacedDigit())
                    .hidden()
                Text(event.allDay ? "All day" : event.start.formatted(.dateTime.hour().minute()))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .fixedSize(horizontal: true, vertical: false)
            VStack(alignment: .leading, spacing: 3) {
                Text(event.title)
                if let location = event.location {
                    Text(location)
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

/// At most four rows: the sender in the display face, the subject, and one
/// line on why it matters. Hairline dividers, no card. Tap opens the thread.
struct MailThatMattersSection: View {
    @Environment(AppEnvironment.self) private var environment
    let items: [ImportantMailItem]
    let onOpen: (ImportantMailItem) -> Void

    var body: some View {
        VStack(spacing: 0) {
            ForEach(items) { item in
                Button {
                    onOpen(item)
                } label: {
                    HStack(alignment: .top, spacing: 12) {
                        InitialsAvatar(name: item.sender, seed: item.sender, size: 32)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.sender)
                                .font(environment.theme.displayType.displayFont(size: 15))
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                            Text(item.subject)
                                .font(.body)
                                .foregroundStyle(.primary)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                            if let reason = item.reason {
                                Text(reason)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                                    .multilineTextAlignment(.leading)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 10)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Self.accessibilityLabel(item))
                .accessibilityAddTraits(.isButton)
                if item.id != items.last?.id {
                    Divider()
                }
            }
        }
    }

    static func accessibilityLabel(_ item: ImportantMailItem) -> String {
        var parts = ["From \(item.sender)", item.subject]
        if let reason = item.reason { parts.append(reason) }
        return parts.joined(separator: ", ")
    }
}

/// One line: a 2 pt accent bar, the step title, the time. Tap opens the Work.
struct NextMoveLine: View {
    @Environment(AppEnvironment.self) private var environment
    let move: TodayComposition.NextMove
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(alignment: .top, spacing: 12) {
                RoundedRectangle(cornerRadius: 1, style: .continuous)
                    .fill(environment.theme.accentColor)
                    .frame(width: 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(move.stepTitle)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.leading)
                    Text(TodayComposition.nextMoveSourceLine(move))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .fixedSize(horizontal: false, vertical: true)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Next move, \(move.stepTitle), \(move.time), \(move.workTitle)")
        .accessibilityAddTraits(.isButton)
    }
}
