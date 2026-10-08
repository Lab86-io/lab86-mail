import SwiftUI
import UniformTypeIdentifiers

// The Albatross thread on the phone (docs/albatross-thread.md): one
// conversation per Work. The navigation bar carries the title and the plan
// line; the list is the outcome block, the messages, and the run blocks in
// time order; the composer is the chat composer. The plan, the details, and
// the page are sheets. The Mac mounts the same model and blocks in its own
// screen.
struct WorkThreadView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let route: WorkRoute
    /// False on iPad, where the list column beside the thread shows the change.
    var showsAttentionBanner = true
    /// False inside document mode, where this thread is the chat beside the
    /// document and must not open a second document.
    var presentsDocument = true

    @State private var model: WorkThreadModel?
    /// The rows of the "needs you" banner at the top. Empty when hidden.
    @State private var banner: [ThreadRow] = []
    @State private var bannerTask: Task<Void, Never>?
    @State private var draft = ""
    @State private var pendingFiles: [ComposeAttachment] = []
    @State private var showsFileImporter = false
    @State private var showsPlan = false
    @State private var showsDetails = false
    @State private var showsHorizonSheet = false
    @State private var showsArchiveConfirmation = false
    @State private var signInOffer: SignInSaveOffer?
    @State private var atBottom = true
    @State private var announced: String?
    @FocusState private var composerFocused: Bool

    static let earlierDivider = "From an earlier chat"
    static let splitPrompt = "Split this into: "
    /// The banner leaves by itself after this long.
    static let bannerDuration: Duration = .seconds(10)

    // The body is three layers, so the type checker reads each chain on its
    // own: the loaded thread and its tasks, the refresh triggers, then the
    // thread-list hooks (docs/albatross-threads.md) and the file importer.
    var body: some View {
        refreshed
            .onChange(of: draft) { _, next in
                environment.composerDrafts.set(next, files: pendingFiles, for: route.workID)
            }
            .onChange(of: pendingFiles.count) { _, _ in
                environment.composerDrafts.set(draft, files: pendingFiles, for: route.workID)
            }
            // The thread is on screen: new activity is seen at once (T2).
            .onChange(of: environment.threads.row(for: route.workID)?.unread) { _, unread in
                guard unread == true else { return }
                Task { await environment.threads.markSeen(workID: route.workID, transport: environment.backend) }
            }
            // Another Albatross needs the user while this one is open (T4).
            .onChange(of: environment.threads.attention?.id) { _, _ in
                guard showsAttentionBanner, let attention = environment.threads.attention else { return }
                let rows = attention.rows.filter { $0.workID != route.workID }
                guard !rows.isEmpty else { return }
                showBanner(rows)
            }
            .onAppear { environment.threads.beginFollowing(environment.backend) }
            .onDisappear { environment.threads.endFollowing() }
            .fileImporter(isPresented: $showsFileImporter, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                guard case .success(let urls) = result else { return }
                AssistantComposerFiles.importing(urls, into: &pendingFiles)
            }
    }

    /// The thread, its title, and the tasks that load and follow it.
    private var loaded: some View {
        Group {
            if let model {
                content(model)
            } else {
                ProgressView("Loading…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(environment.theme.paperColor)
        // The principal item shows the title; this one names the back button
        // of a deeper push and the window on the Mac.
        .navigationTitle(model?.title ?? route.title ?? "Albatross")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: route.id) {
            // The three newest threads stay warm (T4): a return is instant,
            // and the draft comes back with the thread.
            let model = environment.threadModels.model(for: route.workID, title: route.title, environment: environment)
            self.model = model
            model.actions = actions(for: model)
            draft = environment.composerDrafts.draft(for: route.workID)
            pendingFiles = environment.composerDrafts.files(for: route.workID)
            await model.open(intent: route.intent)
            await environment.threads.markSeen(workID: route.workID, transport: environment.backend)
        }
        .task(id: followKey) {
            guard let model else { return }
            await model.followOpenRun()
        }
        // A reply that runs on the server (T5): wait for it, then read it.
        .task(id: model?.workID) {
            guard let model else { return }
            await model.followServerReply()
        }
    }

    /// The loaded thread with the events that refresh it.
    private var refreshed: some View {
        loaded
            // A turn that ends may have started a run the poll did not see yet.
            .onChange(of: model?.chat.isStreaming ?? false) { wasStreaming, isStreaming in
                guard wasStreaming, !isStreaming, let model else { return }
                Task { await model.turnDidEnd() }
            }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active, let model else { return }
                Task { await model.refresh() }
            }
            .onChange(of: environment.navigation.workRefreshToken) { _, _ in
                guard let model else { return }
                Task { await model.refresh() }
            }
            .onChange(of: environment.navigation.workRoute?.intent) { _, intent in
                applyIntent(intent)
            }
            .documentMode(model, route: route, enabled: presentsDocument)
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
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
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
            .onChange(of: model.threadState) { previous, next in
                announce(previous: previous, next: next, model: model)
            }
            .overlay(alignment: .bottomTrailing) {
                if let pill = ThreadJumpPill.text(
                    atBottom: atBottom,
                    pendingFormOffscreen: (model.pendingQuestion != nil || model.pendingAllow != nil) && !atBottom
                ) {
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
            .safeAreaInset(edge: .top, spacing: 0) {
                if !banner.isEmpty {
                    NeedsYouBanner(
                        rows: banner,
                        onOpen: { row in openFromBanner(row) },
                        onDismiss: { hideBanner() }
                    )
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                }
            }
            .environment(\.workThread, model)
            .toolbar { toolbar(model) }
            .sheet(isPresented: $showsPlan) {
                if let detail = model.detail {
                    PlanSheet(
                        detail: detail,
                        runs: model.store.runs,
                        threadState: model.threadState,
                        busy: model.store.busy,
                        onHandle: { step in Task { await model.handle(step: step) } },
                        onSelect: { step in
                            if let target = model.store.runs.last(where: { $0.run.stepKey == step.id }) {
                                proxy.scrollTo("run:\(target.id)", anchor: .top)
                            } else {
                                proxy.scrollTo(ThreadItem.outcome.id, anchor: .top)
                            }
                        },
                        onOpenSite: { openURL($0) }
                    )
                }
            }
            .sheet(isPresented: $showsDetails) {
                if let detail = model.detail {
                    DetailsSheet(
                        detail: detail,
                        runs: model.store.runs,
                        onReload: { await model.refresh() },
                        onArtifact: { artifact in Task { await openArtifact(artifact, model: model) } }
                    )
                }
            }
            .sheet(item: Binding(get: { model.pageRun }, set: { model.pageRun = $0 })) { run in
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
                #if os(macOS)
                .macSheet(.liveBrowser)
                #endif
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
            // "Save a sign-in" on a sign-in handoff (V13): the add sheet with
            // the site filled in. A save marks the run, so its block reads
            // "Saved. Press Continue, and Albatross signs in."
            .sheet(item: $signInOffer) { offer in
                SecureItemEditorView(target: .newSignIn(site: offer.site, label: nil), siteSource: .run) { item in
                    if item != nil { model.markSignInSaved(offer.run) }
                }
            }
            .identityCheckSheet(model.identity)
        }
    }

    @ViewBuilder private func itemView(_ item: ThreadItem, model: WorkThreadModel) -> some View {
        switch item {
        case .outcome:
            OutcomeBlockView(
                detail: model.detail,
                routeTitle: route.title,
                threadState: model.threadState,
                runs: model.store.runs,
                busy: model.store.busy || model.isMarkingDone,
                onHandle: { step in Task { await model.handle(step: step) } },
                onOpenPlan: { showsPlan = true },
                onOpenDetails: { showsDetails = true }
            )
            .padding(.bottom, 4)
        case .earlierDivider:
            HStack(spacing: 10) {
                Rectangle().fill(environment.theme.hairlineColor).frame(height: 1)
                Text(Self.earlierDivider)
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
                busy: model.store.busy || model.isMarkingDone,
                pageShown: model.pageRun?.id == view.id,
                questionState: model.questionState(for: view),
                allowState: model.allowState(for: view),
                signInSaved: model.signInSaved(for: view),
                identityWindowOpen: model.identityWindowOpen,
                actions: model.actions
            )
        }
    }

    /// The hold receipts and the chat errors, under the newest item.
    @ViewBuilder private func chatFooter(_ model: WorkThreadModel) -> some View {
        // A reply runs on the server (T5): one quiet row until it lands.
        if model.replyInProgress {
            HStack(spacing: 8) {
                RevealDot()
                Text(RunBlockCopy.replyInProgress)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
        }
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
        if let notice = model.stepNotice {
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

    // MARK: - The navigation bar

    @ToolbarContentBuilder private func toolbar(_ model: WorkThreadModel) -> some ToolbarContent {
        ToolbarItem(placement: .principal) {
            Button {
                showsPlan = model.detail != nil
            } label: {
                VStack(spacing: 1) {
                    if !dynamicTypeSize.isAccessibilitySize {
                        Text(model.title)
                            .font(.headline)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Text(model.planLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .frame(maxWidth: 260)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(model.title). \(model.planLine).")
            .accessibilityHint("Opens the plan")
        }
        ToolbarItem(placement: .primaryAction) {
            Menu {
                Button("Details") { showsDetails = true }
                Button("Split…") {
                    draft = Self.splitPrompt
                    composerFocused = true
                }
                if model.detail?.work.workState == "paused" {
                    Button("Pick it up") { Task { _ = await model.setWorkState("active") } }
                } else {
                    Button("Put it down") { Task { _ = await model.setWorkState("paused") } }
                }
                Button("Set horizon…") { showsHorizonSheet = true }
                Button("Mark done") { Task { _ = await model.setWorkState("done") } }
                Divider()
                Button("Archive…", role: .destructive) { showsArchiveConfirmation = true }
            } label: {
                Label("More", systemImage: "ellipsis.circle")
            }
            .disabled(model.store.busy)
        }
    }

    // MARK: - The composer

    private func composer(_ model: WorkThreadModel) -> some View {
        AssistantComposer(
            model: model.chat,
            draft: $draft,
            pendingFiles: $pendingFiles,
            focus: $composerFocused,
            placeholder: model.composerPlaceholder,
            hidesContextChip: true,
            routeLine: model.runRouteLine,
            armed: model.redirectArmed == nil ? nil : ComposerArmedNotice(
                text: RunBlockCopy.redirectStripLine(hasFiles: !pendingFiles.isEmpty),
                onCancel: { model.disarmRedirect() }
            ),
            // A redirect note is text only: an attached file holds the send.
            sendDisabled: model.sendsAreHeld || (model.redirectArmed != nil && !pendingFiles.isEmpty),
            onSubmit: { submitDraft(model) },
            onAttach: { showsFileImporter = true }
        )
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

    /// Return follows the chip. Run sends to the run that works. Ask sends
    /// to Albatross. Hold makes new Work and produces no reply.
    private func submitDraft(_ model: WorkThreadModel) {
        guard canSend, !model.chat.isStreaming, !model.chat.isHolding, !model.sendsAreHeld else { return }
        // "Stop and redirect" waits for this message: the stopped run goes
        // on with it (T8).
        if model.redirectArmed != nil {
            // A run takes text only; the file and the text stay in the field.
            guard pendingFiles.isEmpty else { return }
            let text = draft
            clearDraft()
            Task {
                // The run did not continue: the text comes back to the field.
                let continued = await model.sendRedirect(text)
                if !continued, draft.isEmpty { draft = text }
            }
            return
        }
        // A note to the run that works, straight to the run (T7).
        if model.chat.route == .run, pendingFiles.isEmpty {
            let text = draft
            clearDraft()
            Task { await model.steer(text) }
            return
        }
        if model.chat.route == .hold, pendingFiles.isEmpty {
            let text = draft
            clearDraft()
            Task { await model.chat.hold(text) }
            return
        }
        model.send(draft, attachments: pendingFiles)
        clearDraft()
        model.chat.clearRoute()
    }

    private func clearDraft() {
        draft = ""
        pendingFiles = []
        environment.composerDrafts.clear(for: route.workID)
    }

    // MARK: - The banner

    private func showBanner(_ rows: [ThreadRow]) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) { banner = rows }
        PlatformAccessibility.announce(NeedsYouBannerCopy.announcement(rows))
        bannerTask?.cancel()
        bannerTask = Task {
            do { try await Task.sleep(for: Self.bannerDuration) } catch { return }
            hideBanner()
        }
    }

    private func hideBanner() {
        bannerTask?.cancel()
        bannerTask = nil
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { banner = [] }
    }

    /// "Open" goes to that thread. "Show" goes back to the list on "Needs you".
    private func openFromBanner(_ row: ThreadRow?) {
        hideBanner()
        if let row {
            environment.navigation.openWork(id: row.workID, title: row.title)
        } else {
            environment.navigation.pendingWorkFilter = .needsYou
            environment.navigation.workRoute = nil
        }
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
        actions.markDone = { view in Task { await model.markStepDone(view) } }
        actions.artifact = { artifact in Task { await openArtifact(artifact, model: model) } }
        actions.showPage = { view in model.pageRun = view }
        actions.hidePage = { view in if model.pageRun?.id == view.id { model.pageRun = nil } }
        actions.answer = { question, answer, _ in Task { await model.answer(question, form: answer) } }
        actions.allow = { view, request, scope in Task { await model.allow(view, request: request, scope: scope) } }
        actions.openWeb = { _ in if let url = model.webURL { openURL(url) } }
        actions.saveSignIn = { view, offer in signInOffer = SignInSaveOffer(run: view, site: offer.site) }
        // The run stops at once; the composer waits for the note (T8).
        actions.redirect = { view in
            Task {
                await model.armRedirect(view)
                composerFocused = true
            }
        }
        return actions
    }

    /// The primary button of a handoff, as the contract's next-action table
    /// says. The page and the step check live here; the rest is shared with
    /// the Brief list.
    private func performNext(_ behaviour: StepRunNextBehaviour, view: ThreadRunView, model: WorkThreadModel) async {
        switch behaviour {
        case .openBrowser:
            model.pageRun = view
        case .markStepDone:
            // The user's word checks the step, and Albatross continues (D3).
            await model.markStepDone(view)
        case .resume:
            await model.resume(view)
        case .showQuestion, .showArtifacts, .allowSecure, .none:
            break
        case .openDocument(let id, let url):
            // The document opens inside the thread, not in Files (D5).
            if let target = DocumentTarget.of(url: url, id: id) {
                await openDocument(target, model: model)
            } else {
                _ = await StepRunActions.open(behaviour, environment: environment, openURL: openURL)
            }
        case .openDraft, .openApproval, .openURL:
            _ = await StepRunActions.open(behaviour, environment: environment, openURL: openURL)
        }
    }

    private func openArtifact(_ artifact: StepRunView.Artifact, model: WorkThreadModel) async {
        if artifact.kind == .document, let target = DocumentTarget.of(url: artifact.url, id: artifact.referenceID) {
            await openDocument(target, model: model)
            return
        }
        _ = await StepRunActions.open(artifact, environment: environment, openURL: openURL)
    }

    /// Document mode (docs/albatross-document-handoff.md, D5). A sheet that
    /// is up (Details, the plan) closes first, so the cover can present.
    private func openDocument(_ target: DocumentTarget, model: WorkThreadModel) async {
        if showsDetails || showsPlan {
            showsDetails = false
            showsPlan = false
            try? await Task.sleep(for: .milliseconds(400))
        }
        model.openDocument(target)
    }

    private func applyIntent(_ intent: WorkRoute.Intent?) {
        guard let model, let intent else { return }
        switch intent {
        case .openPage:
            if let candidate = model.store.runs.last(where: { WorkThreadModel.hasPage($0.run) }) {
                model.pageRun = candidate
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
        case .needsAnswer:
            let allowTitle = model.pendingAllow?.run.next?.allow.map(SecureAllowCopy.title)
            line = "Albatross asks: \(model.pendingQuestion?.resolvedForm.title ?? allowTitle ?? "one question")."
        case .readyForYou: line = "Ready for you: \(model.store.newestRun?.run.summary ?? model.currentStep?.title ?? "the step")."
        case .done: line = "Done."
        case .planning, .ready, .putDown: line = nil
        }
        guard let line, line != announced else { return }
        announced = line
        PlatformAccessibility.announce(line)
    }
}

// MARK: - Document mode

private extension View {
    /// The document open in the thread, as a full-screen cover on iOS
    /// (docs/albatross-document-handoff.md, D5). The Mac has its own layout.
    func documentMode(_ model: WorkThreadModel?, route: WorkRoute, enabled: Bool) -> some View {
        #if os(iOS)
        fullScreenCover(item: Binding(
            get: { enabled ? model?.document : nil },
            set: { if $0 == nil { model?.closeDocument() } }
        )) { target in
            if let model {
                DocumentModeView(route: route, model: model, target: target)
            }
        }
        #else
        self
        #endif
    }
}
