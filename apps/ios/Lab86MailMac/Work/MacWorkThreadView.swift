import AppKit
import SwiftUI
import UniformTypeIdentifiers

// The Albatross thread on the Mac (docs/albatross-thread.md): one
// conversation per Work in the detail column, the plan line in the toolbar,
// and one trailing pane for the page or the details. The model, the blocks,
// the forms, and the composer are the shared ones; this screen adds the
// window: the pane, the toolbar, the keyboard, and the source list that
// gives way when the pane needs the room. Design note:
// docs/research/albatross-thread-macos-design-2026-10-07.md.
struct MacWorkThreadView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let route: WorkRoute

    @State private var model: WorkThreadModel?
    @State private var draft = ""
    @State private var pendingFiles: [ComposeAttachment] = []
    @State private var showsFileImporter = false
    @State private var showsPlan = false
    @State private var showsDetailsPopover = false
    @State private var showsHorizonSheet = false
    @State private var showsArchiveConfirmation = false
    @State private var atBottom = true
    @State private var announced: String?
    @FocusState private var composerFocused: Bool

    // The pane and the window. The rules read the window, not the column:
    // the column shrinks when the pane opens.
    @State private var paneMode: MacThreadPaneMode = .none
    @State private var pendingPane: MacThreadPaneMode?
    @State private var windowSize: CGSize = .zero
    @State private var hostWindow: NSWindow?
    @State private var collapsedSidebar = false

    // The page: its session, and the sheet of a narrow window.
    @State private var follower = PageSessionFollower()
    @State private var tookOver = false
    @State private var checking = false
    @State private var acting = false
    @State private var pageSheetRun: ThreadRunView?

    var body: some View {
        Group {
            if let model {
                content(model)
            } else {
                ProgressView("Loading…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(environment.theme.paperColor)
        .background(MacWindowReader { window in
            hostWindow = window
            windowSize = window?.frame.size ?? .zero
        })
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didResizeNotification)) { notification in
            guard let hostWindow, (notification.object as? NSWindow) === hostWindow else { return }
            windowSize = hostWindow.frame.size
        }
        .navigationTitle(model?.title ?? route.title ?? "Albatross")
        .task(id: route.id) {
            let model = WorkThreadModel(workID: route.workID, title: route.title, environment: environment)
            self.model = model
            model.actions = actions(for: model)
            await model.open(intent: route.intent)
            // Focus goes to the composer unless a form waits (section 2.8).
            if model.pendingQuestion == nil { composerFocused = true }
        }
        .task(id: followKey) {
            guard let model else { return }
            await model.followOpenRun()
        }
        // A turn that ends may have started a run the poll did not see yet.
        .onChange(of: model?.chat.isStreaming ?? false) { wasStreaming, isStreaming in
            guard wasStreaming, !isStreaming, let model else { return }
            Task { await model.turnDidEnd() }
        }
        .task(id: model?.pageRun?.id) {
            checking = false
            tookOver = false
            follower = PageSessionFollower()
            guard let model, model.pageRun != nil else { return }
            await follower.follow(workID: route.workID, environment: environment)
        }
        .onChange(of: model?.pageRun?.id) { _, next in
            guard let model else { return }
            pageDidChange(hasPage: next != nil, model: model)
        }
        .onChange(of: windowSize.width) { _, _ in roomDidChange() }
        .onChange(of: MacRequests.shared.sidebarShown) { _, _ in roomDidChange() }
        .onChange(of: MacRequests.shared.threadPaneToken) { _, _ in
            guard let model else { return }
            request(MacRequests.shared.threadPaneTarget, model: model)
        }
        .onChange(of: MacRequests.shared.focusComposerToken) { _, _ in
            composerFocused = true
        }
        .onChange(of: MacRequests.shared.openHorizonToken) { _, _ in
            showsHorizonSheet = true
        }
        .onChange(of: paneMode, initial: true) { _, mode in
            MacRequests.shared.threadPaneMode = mode
        }
        .onDisappear {
            MacRequests.shared.threadPaneMode = .none
            restoreSidebar()
        }
        .onChange(of: environment.navigation.workRefreshToken) { _, _ in
            guard let model else { return }
            Task { await model.refresh() }
        }
        .onChange(of: environment.navigation.workRoute?.intent) { _, intent in
            applyIntent(intent)
        }
        .onChange(of: model?.threadState) { previous, next in
            guard let model, let previous, let next else { return }
            announce(previous: previous, next: next, model: model)
        }
        .fileImporter(isPresented: $showsFileImporter, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            AssistantComposerFiles.importing(urls, into: &pendingFiles)
        }
    }

    /// The poll task restarts when a run opens or closes, or a turn streams.
    private var followKey: String {
        guard let model else { return "none" }
        return "\(model.openRun?.id ?? "none")-\(model.chat.isStreaming)"
    }

    // MARK: - Content

    private func content(_ model: WorkThreadModel) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    ForEach(model.items) { item in
                        itemView(item, model: model)
                            .id(item.id)
                    }
                    chatFooter(model)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 16)
                // The transcript keeps a reading measure; the column may be wider.
                .frame(maxWidth: MacThreadLayout.readingMeasure + 40)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 80
            } action: { _, isAtBottom in
                atBottom = isAtBottom
            }
            .onChange(of: model.items.count) { _, _ in
                guard atBottom, let last = model.newestItemID else { return }
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
                    proxy.scrollTo(last, anchor: .bottom)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if let pill = ThreadJumpPill.text(atBottom: atBottom, pendingFormOffscreen: model.pendingQuestion != nil && !atBottom) {
                    Button(pill) {
                        guard let last = model.newestItemID else { return }
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) {
                            proxy.scrollTo(last, anchor: .bottom)
                        }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .padding(.trailing, 20)
                    .padding(.bottom, 12)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if model.chat.holdCards.isEmpty {
                    composer(model)
                } else {
                    holdLanding(model)
                }
            }
            .environment(\.workThread, model)
            .toolbar { toolbar(model, proxy: proxy) }
            .inspector(isPresented: paneShown(model)) {
                MacThreadPane(
                    mode: paneMode,
                    detail: model.detail,
                    runs: model.store.runs,
                    pageRun: model.pageRun,
                    session: follower.session,
                    followed: follower.followed,
                    tookOver: tookOver,
                    checking: checking,
                    busy: acting || model.store.busy,
                    onTakeOver: { Task { await takeOver(model) } },
                    onDone: { Task { await done(model) } },
                    onEnlarge: { pageSheetRun = model.pageRun },
                    onClose: { apply(.none, model: model) },
                    onReload: { await model.refresh() },
                    onArtifact: { artifact in Task { await openArtifact(artifact, model: model) } }
                )
                .inspectorColumnWidth(
                    min: MacThreadLayout.paneMinWidth,
                    ideal: paneWidth,
                    max: MacThreadLayout.paneMaxWidth
                )
            }
            .sheet(item: $pageSheetRun) { run in
                PageSheet(
                    workID: route.workID,
                    run: run,
                    busy: model.store.busy,
                    onTakeOver: { view in
                        await model.stop(view)
                        return model.store.notice == nil
                    },
                    onDone: { view in await model.resume(view) }
                )
                // A web view has no size of its own; the sheet names one that
                // fits the window.
                .macSheet(.liveBrowser(fitting: windowSize))
            }
            .sheet(isPresented: $showsHorizonSheet) {
                HorizonSheet(title: model.title, initial: model.detail?.work.horizon) { horizon in
                    let ok = await WorkHorizonWriter.set(horizon, for: route.workID, environment: environment)
                    if ok {
                        model.setHorizon(horizon)
                        if horizon?.isDormant(at: .now) == true { environment.navigation.workRoute = nil }
                    }
                    return ok
                }
            }
            .confirmationDialog("Archive this Albatross?", isPresented: $showsArchiveConfirmation, titleVisibility: .visible) {
                Button("Archive", role: .destructive) {
                    Task {
                        if await model.setWorkState("archived") { environment.navigation.workRoute = nil }
                    }
                }
            } message: {
                Text("An archived Albatross leaves its Area. It stays in history.")
            }
        }
    }

    @ViewBuilder private func itemView(_ item: ThreadItem, model: WorkThreadModel) -> some View {
        switch item {
        case .outcome:
            OutcomeBlockView(
                detail: model.detail,
                routeTitle: route.title,
                threadState: model.threadState,
                busy: model.store.busy,
                onHandle: { step in Task { await model.handle(step: step) } },
                onOpenPlan: { showsPlan = true },
                onOpenDetails: { request(.details, model: model) }
            )
            .padding(.bottom, 4)
        case .earlierDivider:
            HStack(spacing: 10) {
                Rectangle().fill(environment.theme.hairlineColor).frame(height: 1)
                Text(WorkThreadView.earlierDivider)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize()
                Rectangle().fill(environment.theme.hairlineColor).frame(height: 1)
            }
            .accessibilityElement(children: .combine)
        case .message(let message):
            AssistantMessageRow(model: model.chat, message: message)
        case .run(let view, let continues):
            RunBlockView(
                view: view,
                step: model.step(for: view.run),
                continues: continues,
                ownsWaitingShortcut: model.ownsWaitingShortcut(view),
                hasContinuation: model.hasContinuation(view),
                busy: model.store.busy,
                pageShown: pageShown(view, model: model),
                questionState: model.questionState(for: view),
                actions: model.actions
            )
        }
    }

    /// The hold receipts and the chat errors, under the newest item.
    @ViewBuilder private func chatFooter(_ model: WorkThreadModel) -> some View {
        ForEach(model.chat.receipts) { receipt in
            HoldReceiptRow(
                model: receipt,
                isUndoing: model.chat.isUndoingHold,
                onOpen: { environment.navigation.openWork(id: receipt.id, title: receipt.title) },
                onUndo: model.chat.canUndoHold(receipt) ? { undoHold(receipt, model: model) } : nil
            )
        }
        if let holdError = model.chat.holdError {
            Text(holdError).font(.footnote).foregroundStyle(.red)
        }
        if let notice = model.store.notice {
            Text(notice).font(.footnote).foregroundStyle(.red)
        }
        if let error = model.detailError, model.detail == nil {
            Text(error).font(.footnote).foregroundStyle(.red)
        }
        if model.chat.errorMessage != nil || model.chat.canContinue {
            VStack(alignment: .leading, spacing: 8) {
                if let error = model.chat.errorMessage {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
                HStack {
                    if model.chat.canRetry {
                        Button("Retry", action: model.chat.retryLastTurn).buttonStyle(.bordered)
                    }
                    if model.chat.canContinue {
                        Button("Continue", action: model.chat.continueResponse).buttonStyle(.bordered)
                    }
                }
            }
        }
    }

    // MARK: - The toolbar

    @ToolbarContentBuilder private func toolbar(_ model: WorkThreadModel, proxy: ScrollViewProxy) -> some ToolbarContent {
        MacThreadToolbar(
            planLine: model.planLine,
            planAvailable: model.detail != nil,
            showsPlan: $showsPlan,
            paneMode: paneMode,
            pageAvailable: pageCandidate(model) != nil,
            pageDot: pageDot(model),
            showsDetailsPopover: $showsDetailsPopover,
            busy: model.store.busy,
            isPaused: model.detail?.work.workState == "paused",
            onTogglePage: { request(.page, model: model) },
            onToggleDetails: { request(.details, model: model) },
            onSplit: {
                draft = WorkThreadView.splitPrompt
                composerFocused = true
            },
            onPutDown: { Task { _ = await model.setWorkState("paused") } },
            onPickUp: { Task { _ = await model.setWorkState("active") } },
            onHorizon: { showsHorizonSheet = true },
            onMarkDone: { Task { _ = await model.setWorkState("done") } },
            onArchive: { showsArchiveConfirmation = true },
            planPopover: { planPopover(model, proxy: proxy) },
            detailsPopover: { detailsPopover(model) }
        )
    }

    /// The plan at a glance (S3): the shared list in a popover under the
    /// plan line. A click on a step scrolls the thread to its newest run.
    @ViewBuilder private func planPopover(_ model: WorkThreadModel, proxy: ScrollViewProxy) -> some View {
        if let detail = model.detail {
            PlanListView(
                detail: detail,
                runs: model.store.runs,
                threadState: model.threadState,
                busy: model.store.busy,
                onHandle: { step in
                    showsPlan = false
                    Task { await model.handle(step: step) }
                },
                onSelect: { step in
                    showsPlan = false
                    scroll(to: step, model: model, proxy: proxy)
                },
                onOpenSite: { openURL($0) }
            )
            .frame(width: MacThreadLayout.popoverWidth)
        } else {
            Text(OutcomeBlockView.planningLine)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(20)
                .frame(width: MacThreadLayout.popoverWidth)
        }
    }

    /// The details of a narrow window: the shared body in a popover.
    @ViewBuilder private func detailsPopover(_ model: WorkThreadModel) -> some View {
        if let detail = model.detail {
            ScrollView {
                WorkDetailsBody(
                    detail: detail,
                    runs: model.store.runs,
                    onReload: { await model.refresh() },
                    onArtifact: { artifact in Task { await openArtifact(artifact, model: model) } }
                )
            }
            .frame(width: MacThreadLayout.popoverWidth, height: MacThreadLayout.popoverMaxHeight)
        } else {
            Text(MacThreadPaneCopy.noDetails)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(20)
                .frame(width: MacThreadLayout.popoverWidth)
        }
    }

    private func scroll(to step: WorkDetail.ExecutionStep, model: WorkThreadModel, proxy: ScrollViewProxy) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) {
            if let target = model.store.runs.last(where: { $0.run.stepKey == step.id }) {
                proxy.scrollTo("run:\(target.id)", anchor: .top)
            } else {
                proxy.scrollTo(ThreadItem.outcome.id, anchor: .top)
            }
        }
    }

    // MARK: - The pane

    private var room: MacThreadLayout.Room {
        MacThreadLayout.room(windowWidth: windowSize.width, sidebarShown: MacRequests.shared.sidebarShown)
    }

    private var paneWidth: CGFloat {
        MacThreadLayout.paneWidth(
            for: MacThreadLayout.detailWidth(windowWidth: windowSize.width, sidebarShown: MacRequests.shared.sidebarShown)
        )
    }

    private func paneShown(_ model: WorkThreadModel) -> Binding<Bool> {
        Binding(
            get: { paneMode != .none },
            set: { shown in if !shown { apply(.none, model: model) } }
        )
    }

    /// The run whose page the pane shows: the one on screen, else the newest
    /// run with a page.
    private func pageCandidate(_ model: WorkThreadModel) -> ThreadRunView? {
        model.pageRun ?? model.store.runs.last(where: { WorkThreadModel.hasPage($0.run) })
    }

    private func pageShown(_ view: ThreadRunView, model: WorkThreadModel) -> Bool {
        model.pageRun?.id == view.id && (paneMode == .page || pageSheetRun != nil)
    }

    /// The dot at the page glyph: a live page that is not on screen.
    private func pageDot(_ model: WorkThreadModel) -> Color? {
        guard model.pageRun != nil, paneMode != .page, pageSheetRun == nil else { return nil }
        return follower.session?.agentHasPage == true ? environment.theme.accent2Color : environment.theme.accentColor
    }

    /// A toolbar toggle or a View menu item. The same pane again closes it.
    private func request(_ target: MacThreadPaneMode, model: WorkThreadModel) {
        guard target != .none else { return }
        if paneMode == target {
            apply(.none, model: model)
            return
        }
        switch target {
        case .page:
            if pageSheetRun != nil {
                pageSheetRun = nil
                model.pageRun = nil
                return
            }
            guard pageCandidate(model) != nil else { return }
        case .details:
            if showsDetailsPopover {
                showsDetailsPopover = false
                return
            }
        case .none:
            return
        }
        pendingPane = target
        settle(model: model)
    }

    /// The page row, or a page handoff's primary button (decision 13).
    private func showPage(_ view: ThreadRunView, model: WorkThreadModel) {
        let changed = model.pageRun?.id != view.id
        model.pageRun = view
        // A new page opens through the change handler. The same page again
        // (the pane closed by hand, or the details on top) needs the request.
        if !changed {
            pendingPane = .page
            settle(model: model)
        }
    }

    /// A page appeared or went away (the model's auto-open, a handoff, a
    /// continuation, or "Hide the page").
    private func pageDidChange(hasPage: Bool, model: WorkThreadModel) {
        if hasPage {
            pendingPane = .page
            settle(model: model)
        } else {
            pageSheetRun = nil
            if paneMode == .page { apply(.none, model: model) }
        }
    }

    /// The window changed size, or the source list came or went.
    private func roomDidChange() {
        guard let model, windowSize.width > 0 else { return }
        if paneMode != .none, room != .pane {
            apply(.none, model: model)
        }
        settle(model: model)
    }

    /// Settles a pane request against the room the window has now: the
    /// pane, the source list first, or the narrow surfaces.
    private func settle(model: WorkThreadModel) {
        guard let target = pendingPane, windowSize.width > 0 else { return }
        switch room {
        case .pane:
            pendingPane = nil
            apply(target, model: model)
        case .collapseSidebarFirst:
            collapseSidebar()
        case .none:
            pendingPane = nil
            switch target {
            case .page:
                if model.pageRun == nil { model.pageRun = pageCandidate(model) }
                pageSheetRun = model.pageRun
            case .details:
                showsDetailsPopover = true
            case .none:
                break
            }
        }
    }

    private func apply(_ next: MacThreadPaneMode, model: WorkThreadModel) {
        if next == .page, model.pageRun == nil {
            model.pageRun = pageCandidate(model)
        }
        if next == .none {
            if paneMode == .page { model.pageRun = nil }
            restoreSidebar()
        }
        guard next != paneMode else { return }
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) {
            paneMode = next
        }
    }

    private func collapseSidebar() {
        guard MacRequests.shared.sidebarShown, !collapsedSidebar else { return }
        collapsedSidebar = true
        MacRequests.shared.requestSidebar(visible: false)
    }

    private func restoreSidebar() {
        guard collapsedSidebar else { return }
        collapsedSidebar = false
        MacRequests.shared.requestSidebar(visible: true)
    }

    // MARK: - The page

    private func takeOver(_ model: WorkThreadModel) async {
        guard let run = model.pageRun else { return }
        acting = true
        defer { acting = false }
        await model.stop(run)
        if model.store.notice == nil { tookOver = true }
    }

    private func done(_ model: WorkThreadModel) async {
        guard let run = model.pageRun else { return }
        acting = true
        checking = true
        defer { acting = false }
        // A refused "Continue" leaves the run id as it was: clear "checking" here.
        if !(await model.resume(run)) { checking = false }
        tookOver = false
    }

    // MARK: - The composer

    private func composer(_ model: WorkThreadModel) -> some View {
        AssistantComposer(
            model: model.chat,
            draft: $draft,
            pendingFiles: $pendingFiles,
            focus: $composerFocused,
            placeholder: model.threadState.composerPlaceholder,
            hidesContextChip: true,
            onSubmit: { submitDraft(model) },
            onAttach: { showsFileImporter = true }
        )
        .frame(maxWidth: MacThreadLayout.readingMeasure + 40)
        .frame(maxWidth: .infinity)
    }

    /// The cards stand where the composer was, then travel to the Work rail.
    private func holdLanding(_ model: WorkThreadModel) -> some View {
        VStack(spacing: 6) {
            ForEach(Array(model.chat.holdCards.enumerated()), id: \.element.id) { index, card in
                HoldCard(model: card, phase: model.chat.holdPhase, isWorking: model.chat.isHolding)
                    .animation(
                        .easeIn(duration: HoldPhase.travelDuration).delay(Double(index) * 0.06),
                        value: model.chat.holdPhase
                    )
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    private var canSend: Bool {
        (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingFiles.isEmpty)
            && model?.chat.isUploading == false
    }

    /// Return follows the chip. Ask sends to Albatross. Hold makes new Work
    /// and produces no reply.
    private func submitDraft(_ model: WorkThreadModel) {
        guard canSend, !model.chat.isStreaming, !model.chat.isHolding else { return }
        if model.chat.route == .hold, pendingFiles.isEmpty {
            let text = draft
            draft = ""
            Task { await model.chat.hold(text) }
            return
        }
        model.send(draft, attachments: pendingFiles)
        draft = ""
        pendingFiles = []
        model.chat.clearRoute()
    }

    private func undoHold(_ receipt: HoldCardModel, model: WorkThreadModel) {
        Task {
            guard let text = await model.chat.undoHold(receipt) else { return }
            draft = HoldUndo.restoredDraft(current: draft, held: text)
            model.chat.presetRoute(.ask)
            composerFocused = true
        }
    }

    // MARK: - Run actions

    private func actions(for model: WorkThreadModel) -> RunBlockActions {
        var actions = RunBlockActions()
        actions.stop = { view in Task { await model.stop(view) } }
        actions.resume = { view in Task { await model.resume(view) } }
        actions.dismiss = { view in Task { await model.dismiss(view) } }
        actions.tryAgain = { view in Task { await model.tryAgain(view) } }
        actions.primary = { view, behaviour in Task { await performNext(behaviour, view: view, model: model) } }
        actions.artifact = { artifact in Task { await openArtifact(artifact, model: model) } }
        actions.showPage = { view in showPage(view, model: model) }
        actions.hidePage = { view in if model.pageRun?.id == view.id { model.pageRun = nil } }
        actions.answer = { question, answer, _ in Task { await model.answer(question, form: answer) } }
        return actions
    }

    /// The primary button of a handoff, as the contract's next-action table
    /// says. The page and the step check live here; the rest is shared with
    /// the Brief list.
    private func performNext(_ behaviour: StepRunNextBehaviour, view: ThreadRunView, model: WorkThreadModel) async {
        switch behaviour {
        case .openBrowser:
            showPage(view, model: model)
        case .markStepDone:
            if let step = model.step(for: view.run) { await model.completeStep(step) }
        case .resume:
            await model.resume(view)
        case .showQuestion, .showArtifacts, .none:
            break
        case .openDraft, .openDocument, .openApproval, .openURL:
            _ = await StepRunActions.open(behaviour, environment: environment, openURL: openURL)
        }
    }

    private func openArtifact(_ artifact: StepRunView.Artifact, model: WorkThreadModel) async {
        _ = await StepRunActions.open(artifact, environment: environment, openURL: openURL)
    }

    private func applyIntent(_ intent: WorkRoute.Intent?) {
        guard let model, let intent else { return }
        switch intent {
        case .openPage:
            if let candidate = model.store.runs.last(where: { WorkThreadModel.hasPage($0.run) }) {
                showPage(candidate, model: model)
            }
        case .focusComposer:
            composerFocused = true
        }
    }

    /// One announcement for each state change, never for each log line.
    private func announce(previous: ThreadState, next: ThreadState, model: WorkThreadModel) {
        guard previous != next else { return }
        let line: String?
        switch next {
        case .running: line = "Albatross started on \(model.currentStep?.title ?? "the step")."
        case .yourTurn: line = "Your turn: \(model.store.newestRun?.run.next?.detail ?? model.currentStep?.title ?? "the step")."
        case .needsAnswer: line = "Albatross asks: \(model.pendingQuestion?.resolvedForm.title ?? "one question")."
        case .readyForYou: line = "Ready for you: \(model.store.newestRun?.run.summary ?? model.currentStep?.title ?? "the step")."
        case .done: line = "Done."
        case .planning, .ready, .putDown: line = nil
        }
        guard let line, line != announced else { return }
        announced = line
        PlatformAccessibility.announce(line)
    }
}

/// Hands the hosting window to the thread, so the pane rules can read the
/// window size. The column is the wrong measure: it shrinks when the pane
/// opens.
private struct MacWindowReader: NSViewRepresentable {
    let onWindow: @MainActor (NSWindow?) -> Void

    func makeNSView(context: Context) -> MacWindowProbe {
        let probe = MacWindowProbe()
        probe.onWindow = onWindow
        return probe
    }

    func updateNSView(_ nsView: MacWindowProbe, context: Context) {
        nsView.onWindow = onWindow
    }
}

final class MacWindowProbe: NSView {
    var onWindow: (@MainActor (NSWindow?) -> Void)?

    // A background view: it draws nothing and takes no clicks.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let onWindow else { return }
        let window = self.window
        // After the layout pass, so the state change lands on the next frame.
        Task { @MainActor in
            onWindow(window)
        }
    }
}
