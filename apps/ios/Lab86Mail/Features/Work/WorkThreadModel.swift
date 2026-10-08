import Foundation
import Observation
import SwiftUI

// The Albatross thread of one Work (docs/albatross-thread.md): the canonical
// chat session, the runs, and the Work detail, merged into one timeline. The
// screen owns one model for each route; the model owns the chat model, the
// run store, the reads, and the actions. The Mac mounts the same model.

/// One item of the merged timeline.
enum ThreadItem: Identifiable, Equatable {
    /// What Albatross understood: the outcome and the plan. Always first.
    case outcome
    /// "From an earlier chat", above the messages without a time.
    case earlierDivider
    case message(AssistantChatMessage)
    case run(ThreadRunView, continues: Bool)

    var id: String {
        switch self {
        case .outcome: "outcome"
        case .earlierDivider: "earlier"
        case .message(let message): "message:\(message.id)"
        case .run(let view, _): "run:\(view.id)"
        }
    }
}

@MainActor
@Observable
final class WorkThreadModel {
    /// How the answer of one question goes.
    struct QuestionState: Equatable, Sendable {
        var isSending = false
        var fieldErrors: [String: String] = [:]
        var error: String? = nil
    }

    static let pollInterval: Duration = .seconds(3)

    let workID: String
    let chat: AssistantChatModel
    let store: WorkThreadStore
    private let transport: any BackendExchanging
    private let productStore: ProductStore

    private(set) var detail: WorkDetail?
    private(set) var detailError: String?
    private(set) var questionStates: [String: QuestionState] = [:]
    /// The run whose page the sheet shows. Nil when the page is closed.
    var pageRun: ThreadRunView?
    /// The run the user started here: its page opens by itself once it has
    /// a session (decision 13).
    private var autoOpenRunID: String?
    private var autoOpened: Set<String> = []
    /// The owner's handlers for the run blocks, set by the screen.
    var actions = RunBlockActions()
    /// The identity check of this thread (an allow). The screen mounts its sheet.
    let identity = IdentityCheckPresenter()
    private let secureDetails: SecureDetailsStore
    private let webBaseURL: URL?
    /// How each run's allow goes on this device, by run id.
    private(set) var allowStates: [String: SecureAllowState] = [:]
    /// The runs whose sign-in handoff the user answered with a saved sign-in (V13).
    private(set) var savedSignInRuns: Set<String> = []
    /// The live thread list: the reply that runs on the server, and the rows
    /// the banner reads.
    private let threads: ThreadsStore
    /// The steer notes this device could not post, by message id (T7).
    private(set) var failedNoteIDs: Set<String> = []
    /// The notes sent again (T9). The first bubble loses its "Send again".
    private(set) var resentNoteIDs: Set<String> = []
    /// The run "Stop and redirect" stopped (T8). The next send continues it
    /// with the note.
    private(set) var redirectArmed: ThreadRunView?
    /// True once this model saw a reply run on the server; the thread reads
    /// the saved reply when it ends.
    private var awaitedServerReply = false
    /// The document open in the thread (docs/albatross-document-handoff.md,
    /// D5), or nil. The chat sends it with every turn while it is open.
    private(set) var document: DocumentTarget?
    /// Grows when a chat turn edited the open document: the editor loads
    /// the saved document again.
    private(set) var documentReloadToken = 0
    /// True while "Mark step done" is on its way to the server.
    private(set) var isMarkingDone = false
    /// The last "Mark step done" that failed, under the block until the next one.
    private(set) var stepNotice: String?
    /// A run reads at most this many notes (docs/albatross-thread.md).
    static let noteCap = 10

    init(workID: String, title: String?, environment: AppEnvironment) {
        self.workID = workID
        transport = environment.backend
        productStore = environment.store
        secureDetails = environment.secureDetails
        threads = environment.threads
        webBaseURL = environment.configuration.apiBaseURL
        store = WorkThreadStore(workID: workID)
        let sessionStore = environment.sessionStore
        chat = AssistantChatModel(
            backend: environment.backend,
            baseURL: environment.configuration.apiBaseURL,
            scope: AssistantChatScope(kind: .work, contextID: workID, label: title),
            sessionID: WorkThreadSession.id(for: workID),
            draftStore: environment.assistantDrafts,
            ownerIDProvider: { sessionStore.ownerID }
        )
        detail = environment.store.cachedWorkDetail(workID)
    }

    // MARK: - Derived

    var threadState: ThreadState {
        ThreadState.resolve(detail: detail, runs: store.runs)
    }

    var planLine: String {
        threadState.planLine(stepNumber: ThreadPlanPosition.stepNumber(detail), total: ThreadPlanPosition.total(detail))
    }

    var title: String {
        detail?.plan?.outcome ?? detail?.work.title ?? chat.scope.label ?? "Albatross"
    }

    var openRun: ThreadRunView? { store.openRun }

    var pendingQuestion: ThreadQuestion? { store.pendingQuestion }

    var currentStep: WorkDetail.ExecutionStep? { detail?.execution.currentStep }

    func step(for run: StepRunView) -> WorkDetail.ExecutionStep? {
        detail?.execution.guideSteps.first { $0.id == run.stepKey }
    }

    func questionState(for view: ThreadRunView) -> QuestionState {
        guard let id = view.question?.id else { return QuestionState() }
        return questionStates[id] ?? QuestionState()
    }

    func allowState(for view: ThreadRunView) -> SecureAllowState {
        allowStates[view.id] ?? .idle
    }

    func signInSaved(for view: ThreadRunView) -> Bool {
        savedSignInRuns.contains(view.id)
    }

    /// The newest allow that still waits for an answer, on this device and
    /// on the server.
    var pendingAllow: ThreadRunView? {
        store.runs.last { view in
            guard view.run.isHandoff, let next = view.run.next, next.kind == .allowSecure,
                  next.allow != nil, next.allowAnswer == nil else { return false }
            if case .answered = allowStates[view.id] ?? .idle { return false }
            return true
        }
    }

    /// True when the session's first factor is under 10 minutes old.
    var identityWindowOpen: Bool { ClerkIdentity.windowIsOpen() }

    /// A reply runs on the server, not on this device (T5).
    var replyInProgress: Bool {
        !chat.isStreaming && threads.row(for: workID)?.status == .answering
    }

    var noteCapReached: Bool {
        (openRun?.notes.count ?? 0) >= Self.noteCap
    }

    /// The composer placeholder by route and state (decision 11, T7, T8).
    var composerPlaceholder: String {
        if redirectArmed != nil { return RunBlockCopy.redirectPlaceholder }
        if document != nil { return DocumentHandoffCopy.placeholder }
        switch chat.route {
        case .run:
            return ThreadState.running.composerPlaceholder
        case .ask where replyInProgress:
            return RunBlockCopy.replyInProgressPlaceholder
        case .ask where openRun != nil:
            return RunBlockCopy.askWhileRunPlaceholder
        case .ask, .hold:
            return threadState.composerPlaceholder
        }
    }

    /// "To the run · Step 2, Renew online" above the field while the route
    /// is Run (lead decision 5).
    var runRouteLine: String? {
        guard chat.route == .run, let view = redirectArmed ?? openRun else { return nil }
        let number = detail?.execution.guideSteps.firstIndex { $0.id == view.run.stepKey }.map { $0 + 1 }
        return RunBlockCopy.runRouteLine(stepNumber: number, title: view.run.stepTitle)
    }

    /// The composer holds an Ask while a reply runs on the server. A run
    /// note still goes.
    var sendsAreHeld: Bool {
        replyInProgress && chat.route != .run && redirectArmed == nil
    }

    /// The Run route exists while a run is open and under its note cap, or
    /// while a redirect waits for its note.
    func syncRunRoute() {
        chat.setRunRouteAvailable(redirectArmed != nil || (openRun != nil && !noteCapReached))
    }

    /// The Work page on the web (`?work=<id>`), for "Open on the web".
    var webURL: URL? {
        guard let webBaseURL, var components = URLComponents(url: webBaseURL, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/"
        components.queryItems = [URLQueryItem(name: "work", value: workID)]
        return components.url
    }

    /// The merged timeline: the outcome block, then the messages and the
    /// runs in time order, with one divider above the messages that have
    /// no time (an earlier chat).
    var items: [ThreadItem] {
        let merged = ThreadTimeline.merge(
            messages: chat.messages,
            runs: store.runs,
            createdAt: { $0.createdAtMilliseconds },
            startedRunIDs: { $0.startedRunIDs }
        )
        var items: [ThreadItem] = [.outcome]
        var dividerPlaced = false
        for entry in merged {
            switch entry {
            case .message(let message, let at):
                if at == nil, !dividerPlaced {
                    items.append(.earlierDivider)
                    dividerPlaced = true
                }
                items.append(.message(message))
            case .run(let view, let continues):
                items.append(.run(view, continues: continues))
            }
        }
        return items
    }

    /// The last item, where the composer sits.
    var newestItemID: String? { items.last?.id }

    // MARK: - Reads

    /// The three reads on open, in parallel: the chat session, the runs,
    /// and the Work detail.
    func open(intent: WorkRoute.Intent?) async {
        async let session: Void = chat.restoreWorkThread(workID: workID)
        async let runs: Void = store.load(transport)
        async let work: Void = loadDetail()
        _ = await (session, runs, work)
        applyAutoOpen()
        syncRunRoute()
        if intent == .openPage, pageRun == nil, let candidate = store.runs.last(where: { Self.hasPage($0.run) }) {
            pageRun = candidate
        }
    }

    func refresh() async {
        async let runs: Void = store.load(transport)
        async let work: Void = loadDetail()
        _ = await (runs, work)
        syncPageRun()
        applyAutoOpen()
        syncRunRoute()
    }

    /// While a reply runs on the server (T5), the thread waits for the
    /// threads poll to say it ended, then reads the saved reply once.
    func followServerReply() async {
        while !Task.isCancelled {
            if replyInProgress {
                awaitedServerReply = true
            } else if awaitedServerReply {
                awaitedServerReply = false
                await chat.restoreWorkThread(workID: workID)
                await store.load(transport)
                syncRunRoute()
            }
            do { try await Task.sleep(for: Self.pollInterval) } catch { return }
        }
    }

    func loadDetail() async {
        do {
            detail = try await productStore.loadWorkDetail(workID)
            detailError = nil
        } catch {
            if detail == nil { detailError = error.localizedDescription }
        }
    }

    /// While a run is open, or a chat turn may start one, read the runs
    /// every few seconds. The task ends when nothing is open.
    func followOpenRun() async {
        while !Task.isCancelled {
            guard store.openRun != nil || chat.isStreaming else { return }
            do { try await Task.sleep(for: Self.pollInterval) } catch { return }
            guard !Task.isCancelled else { return }
            await store.load(transport)
            syncPageRun()
            applyAutoOpen()
            syncRunRoute()
            if store.openRun == nil, !chat.isStreaming {
                await loadDetail()
                return
            }
        }
    }

    /// A run with a page opens its page when the user started it here.
    private func applyAutoOpen() {
        guard let autoOpenRunID, !autoOpened.contains(autoOpenRunID),
              let view = store.run(id: autoOpenRunID), view.run.browserSessionID != nil else { return }
        autoOpened.insert(autoOpenRunID)
        self.autoOpenRunID = nil
        if pageRun == nil { pageRun = view }
    }

    /// The page sheet follows the run chain: after "Continue" the new run
    /// takes the page.
    private func syncPageRun() {
        guard let current = pageRun else { return }
        if let open = store.openRun, open.id != current.id, open.run.parentRunID == current.id || open.run.stepKey == current.run.stepKey {
            pageRun = open
        } else if let same = store.run(id: current.id) {
            pageRun = same
        }
    }

    static func hasPage(_ run: StepRunView) -> Bool {
        if run.state.isOpen { return run.browserSessionID != nil }
        return StepRunNextBehaviour.from(run.next) == .openBrowser
    }

    // MARK: - Actions

    /// "Handle it": the run route directly, no model turn (decision 1).
    func handle(step: WorkDetail.ExecutionStep) async {
        guard let runID = await store.start(stepKey: step.id, stepTitle: step.title, transport: transport) else { return }
        autoOpenRunID = runID
        await loadDetail()
    }

    func stop(_ view: ThreadRunView) async {
        _ = await store.stop(view, transport: transport)
        syncRunRoute()
        await loadDetail()
    }

    /// "Continue" on a handoff. Returns false when the server refused it, so
    /// the page bar can leave its "checking" state.
    @discardableResult
    func resume(_ view: ThreadRunView, note: String? = nil) async -> Bool {
        let runID = await store.resume(view, note: note, transport: transport)
        syncPageRun()
        return runID != nil
    }

    /// A chat turn ended. It may have started a run that the last poll did not
    /// see (the poll task restarts when the turn ends and stops at once when no
    /// run is open), so read the runs once now.
    func turnDidEnd() async {
        // The reply wrote to the open document: the editor loads it again.
        if document != nil, let reply = chat.messages.last(where: { $0.role == .assistant }),
           DocumentHandoff.turnEditedDocument(reply) {
            documentReloadToken += 1
        }
        await store.load(transport)
        syncPageRun()
        applyAutoOpen()
        syncRunRoute()
    }

    // MARK: - Mark step done and document mode

    /// "Mark step done" on a run block (docs/albatross-document-handoff.md,
    /// D2, D3): the step is checked with the user's word, and Albatross
    /// starts on the next step it can do. The thread then shows that run.
    @discardableResult
    func markStepDone(_ view: ThreadRunView) async -> Bool {
        guard !isMarkingDone else { return false }
        isMarkingDone = true
        stepNotice = nil
        defer { isMarkingDone = false }
        let previous = detail
        if let previous { detail = previous.completing(stepID: view.run.stepKey) }
        guard let result = await productStore.completeWorkStepAndContinue(workID, stepKey: view.run.stepKey) else {
            detail = previous
            stepNotice = DocumentHandoffCopy.failed
            return false
        }
        if let runID = result.nextRunID { autoOpenRunID = runID }
        await refresh()
        return true
    }

    /// Opens a document inside the thread (D5). The chat carries it from now on.
    func openDocument(_ target: DocumentTarget) {
        document = target
        chat.documentAttachment = target.attachment
    }

    /// "Close" or "Back to thread": the document leaves, the thread stays.
    func closeDocument() {
        document = nil
        chat.documentAttachment = nil
    }

    /// The open handoff the document belongs to, or nil for an older artifact.
    var documentHandoff: ThreadRunView? {
        guard let document else { return nil }
        return DocumentHandoff.run(for: store.runs, target: document)
    }

    /// The "Your part" text, or nil for no card.
    var documentYourPart: String? {
        DocumentHandoff.detail(of: documentHandoff)
    }

    /// "Done, continue": marks the handoff's step done, then closes document
    /// mode. With no handoff the document only closes.
    @discardableResult
    func finishDocument() async -> Bool {
        if let handoff = documentHandoff {
            guard await markStepDone(handoff) else { return false }
        }
        closeDocument()
        return true
    }

    // MARK: - Notes to the run

    /// A note to the run that works (T7): straight to the run, no chat
    /// turn. The bubble appears at once; the receipt follows the run's notes.
    func steer(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard let run = openRun else {
            chat.send(trimmed, attachments: [])
            return
        }
        let noteID = ThreadNoteID.make()
        chat.appendSteerMessage(trimmed, id: noteID, runID: run.id, redirect: false)
        let sent = await store.steer(run, note: trimmed, noteID: noteID, transport: transport)
        if !sent { failedNoteIDs.insert(noteID) }
        await store.load(transport)
        syncRunRoute()
    }

    /// The receipt under a note bubble, or nil for a message that is not a note.
    func receipt(for message: AssistantChatMessage) -> NoteReceipt? {
        guard let steer = message.steer else { return nil }
        return NoteReceiptPresentation.receipt(
            noteID: message.id,
            runID: steer.runID,
            redirect: steer.redirect,
            text: message.text,
            failed: failedNoteIDs.contains(message.id),
            runs: store.runs
        )
    }

    /// "Send again" shows once for each note.
    func canSendAgain(_ message: AssistantChatMessage) -> Bool {
        message.steer != nil && !resentNoteIDs.contains(message.id)
    }

    /// "Send again" under a note the run never read, or never got (T9): the
    /// open run, else the step starts again with the note first. The button
    /// hides while the send runs, and comes back when a restart fails.
    func sendAgain(_ message: AssistantChatMessage) async {
        guard let steer = message.steer, !resentNoteIDs.contains(message.id) else { return }
        let text = message.text
        resentNoteIDs.insert(message.id)
        if let open = openRun {
            failedNoteIDs.remove(message.id)
            let noteID = ThreadNoteID.make()
            chat.appendSteerMessage(text, id: noteID, runID: open.id, redirect: false)
            let sent = await store.steer(open, note: text, noteID: noteID, transport: transport)
            if !sent { failedNoteIDs.insert(noteID) }
        } else if let view = store.run(id: steer.runID) {
            var restarted = false
            // A handoff that a run already continued starts the step again
            // instead: a second continuation would split its receipt.
            if view.run.isHandoff, !hasContinuation(view) {
                // The new run continues `view`, so the note keeps `view`'s id:
                // its receipt reads from the run whose parent that is.
                if await store.resume(view, note: text, transport: transport) != nil {
                    chat.appendSteerMessage(text, id: ThreadNoteID.make(), runID: view.id, redirect: true)
                    restarted = true
                }
            } else if let runID = await store.start(
                stepKey: view.run.stepKey, stepTitle: view.run.stepTitle, note: text, transport: transport
            ) {
                chat.appendSteerMessage(text, id: ThreadNoteID.make(), runID: runID, redirect: true)
                restarted = true
            }
            if restarted {
                failedNoteIDs.remove(message.id)
            } else {
                resentNoteIDs.remove(message.id)
            }
        } else {
            resentNoteIDs.remove(message.id)
        }
        await store.load(transport)
        syncRunRoute()
        await loadDetail()
    }

    // MARK: - Stop and redirect

    /// "Stop and redirect" (T8, lead decision 6): the run stops at once and
    /// the composer waits for the note. The next send continues the run
    /// with it.
    func armRedirect(_ view: ThreadRunView) async {
        // A stop that failed leaves the run working, so there is nothing to
        // redirect; the store's notice says why.
        guard await store.stop(view, transport: transport) else { return }
        redirectArmed = store.run(id: view.id) ?? view
        chat.presetRoute(.run)
        syncRunRoute()
        await loadDetail()
    }

    /// "Cancel" on the strip. The run stays stopped; its block offers "Continue".
    func disarmRedirect() {
        redirectArmed = nil
        chat.clearRoute()
        syncRunRoute()
    }

    /// True while the armed note goes to the server, so a second send waits.
    private var redirectSending = false

    /// Continues the stopped run with the note. False when the run did not
    /// continue: the strip stays armed and the caller puts the text back.
    /// The note keeps the stopped run's id (`metadata.steer.runId`), as on
    /// web; the new run is the one whose parent it is.
    @discardableResult
    func sendRedirect(_ text: String) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !redirectSending, let view = redirectArmed else { return false }
        redirectSending = true
        defer { redirectSending = false }
        guard await store.resume(view, note: trimmed, transport: transport) != nil else { return false }
        redirectArmed = nil
        chat.appendSteerMessage(trimmed, id: ThreadNoteID.make(), runID: view.id, redirect: true)
        chat.clearRoute()
        syncPageRun()
        syncRunRoute()
        await loadDetail()
        return true
    }

    /// Command-Return belongs to the newest run only, and only while no form
    /// waits: an old block must never start a paid run.
    func ownsWaitingShortcut(_ view: ThreadRunView) -> Bool {
        store.newestRun?.id == view.id && pendingQuestion == nil
    }

    /// A run whose continuation is in the list offers no "Continue" of its own.
    func hasContinuation(_ view: ThreadRunView) -> Bool {
        store.runs.contains { $0.run.parentRunID == view.id }
    }

    func dismiss(_ view: ThreadRunView) async {
        _ = await store.dismiss(view, transport: transport)
        if pageRun?.id == view.id { pageRun = nil }
        await loadDetail()
    }

    func tryAgain(_ view: ThreadRunView) async {
        guard let runID = await store.start(stepKey: view.run.stepKey, stepTitle: view.run.stepTitle, transport: transport) else { return }
        autoOpenRunID = runID
    }

    /// The form answer of a run's question. The server resumes the run.
    func answer(_ question: ThreadQuestion, form: FormAnswer) async {
        questionStates[question.id] = QuestionState(isSending: true)
        let outcome = await store.answer(question: question, form: form, transport: transport)
        switch outcome {
        case .sent:
            questionStates[question.id] = QuestionState()
            await loadDetail()
        case .fieldErrors(let errors):
            questionStates[question.id] = QuestionState(isSending: false, fieldErrors: errors, error: nil)
        case .failed(let message):
            questionStates[question.id] = QuestionState(isSending: false, fieldErrors: [:], error: message)
        }
    }

    /// The answer to an allow (V6). "Allow once" and "Always on {site}" go
    /// through the identity check: the window first, then the request, then
    /// one retry after a 403. "Do not allow" goes at once.
    func allow(_ view: ThreadRunView, request: SecureAllowRequest, scope: SecureAllowScope) async {
        let runID = view.id
        allowStates[runID] = .sending(scope)
        let outcome: IdentityGuard.Outcome
        if scope == .deny {
            do {
                try await secureDetails.allow(runID: runID, itemID: request.itemID, site: request.site, scope: .deny, transport: transport)
                outcome = .done
            } catch let error as SecureSaveError {
                outcome = .error(error)
            } catch {
                outcome = .error(.other(error.localizedDescription))
            }
        } else {
            let reason = scope == .once
                ? IdentityCheckCopy.allowOnceReason(itemLabel: request.itemLabel, host: request.host)
                : IdentityCheckCopy.allowAlwaysReason(itemLabel: request.itemLabel, site: request.site, host: request.host)
            outcome = await IdentityGuard.run(
                reason: reason,
                presenter: identity,
                windowOpen: { ClerkIdentity.windowIsOpen() }
            ) {
                try await secureDetails.allow(runID: runID, itemID: request.itemID, site: request.site, scope: scope, transport: transport)
            }
        }
        switch outcome {
        case .done:
            allowStates[runID] = .answered(scope)
            await refresh()
        case .cancelled:
            allowStates[runID] = .cancelled
        case .checkFailed(let message):
            allowStates[runID] = .checkFailed(message)
        case .error(let error):
            if case .closed = error {
                // Another device answered first: the next read shows its answer.
                allowStates[runID] = .idle
                await refresh()
            } else {
                allowStates[runID] = .error(error.line)
            }
        }
    }

    /// The user saved a sign-in from this handoff (V13): the block reads
    /// "Saved. Press Continue, and Albatross signs in."
    func markSignInSaved(_ view: ThreadRunView) {
        savedSignInRuns.insert(view.id)
    }

    /// The usual step check ("Mark this step done" on an offline handoff).
    func completeStep(_ step: WorkDetail.ExecutionStep) async {
        let previous = detail
        if let previous { detail = previous.completing(stepID: step.id) }
        if await productStore.completeWorkStep(workID, stepKey: step.id, note: nil) {
            detail = productStore.cachedWorkDetail(workID) ?? detail
        } else {
            detail = previous
        }
    }

    func setWorkState(_ state: String) async -> Bool {
        let ok = await productStore.updateWorkState(workID, state: state)
        if ok { await loadDetail() }
        return ok
    }

    func setHorizon(_ horizon: WorkHorizon?) {
        detail = detail?.withHorizon(horizon)
    }

    func setShape(_ shape: WorkShape) {
        detail = detail?.withShape(shape)
    }

    /// A user message. It goes to the Albatross chat agent with the Work
    /// attached; the agent passes it to a working run as a steer note.
    func send(_ text: String, attachments: [ComposeAttachment]) {
        chat.send(text, attachments: attachments)
    }
}

// MARK: - Environment

private struct WorkThreadModelKey: EnvironmentKey {
    static let defaultValue: WorkThreadModel? = nil
}

extension EnvironmentValues {
    /// The thread a chat message renders inside, when it renders inside one.
    /// The work-log row draws a started run's block from it.
    var workThread: WorkThreadModel? {
        get { self[WorkThreadModelKey.self] }
        set { self[WorkThreadModelKey.self] = newValue }
    }
}
