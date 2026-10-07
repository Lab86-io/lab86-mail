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

    init(workID: String, title: String?, environment: AppEnvironment) {
        self.workID = workID
        transport = environment.backend
        productStore = environment.store
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
        await store.load(transport)
        syncPageRun()
        applyAutoOpen()
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
