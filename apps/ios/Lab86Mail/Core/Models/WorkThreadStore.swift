import Foundation
import Observation

// The runs of one Work, as the thread shows them: the newest 30 from
// `GET /api/albatross/work/[workId]/runs`, the run actions, and the answer to
// a run's question. Optimistic writes settle on the next read. Nothing here
// is cached to disk: a run is a live server row.

@MainActor
@Observable
final class WorkThreadStore {
    /// How an answer went.
    enum AnswerOutcome: Equatable, Sendable {
        case sent
        /// The server refused fields: the messages by field id.
        case fieldErrors([String: String])
        case failed(String)
    }

    let workID: String
    private(set) var runs: [ThreadRunView] = []
    private(set) var loaded = false
    private(set) var loadError: String?
    /// True while an action is in flight. The blocks disable their buttons.
    private(set) var busy = false
    /// The last action that failed, shown under the block until the next action.
    private(set) var notice: String?
    private var revision = 0

    init(workID: String) {
        self.workID = workID
    }

    var runsPath: String { "/api/albatross/work/\(workID)/runs" }
    var runPath: String { "/api/albatross/work/\(workID)/run" }

    static func answerPath(questionID: String) -> String {
        "/api/albatross/work/questions/\(questionID)/answer"
    }

    /// The run that works now, if any.
    var openRun: ThreadRunView? {
        runs.last { $0.run.state.isOpen }
    }

    /// The newest run.
    var newestRun: ThreadRunView? { runs.last }

    /// The newest question that still waits for an answer.
    var pendingQuestion: ThreadQuestion? {
        for view in runs.reversed() {
            if let question = view.pendingQuestion { return question }
        }
        return nil
    }

    func run(id: String) -> ThreadRunView? {
        runs.first { $0.id == id }
    }

    func clearNotice() {
        notice = nil
    }

    /// Reads the runs. An older read that lands after a newer one is dropped.
    func load(_ transport: any BackendExchanging) async {
        revision += 1
        let requestRevision = revision
        do {
            let exchange = try await transport.exchange(method: "GET", path: runsPath, body: nil)
            guard revision == requestRevision, !Task.isCancelled else { return }
            guard exchange.isSuccess, let body = exchange.body else {
                loaded = true
                loadError = exchange.errorMessage
                return
            }
            runs = ThreadRunView.list(from: body)
            loaded = true
            loadError = nil
        } catch {
            guard revision == requestRevision, !Task.isCancelled else { return }
            loaded = true
            loadError = error.localizedDescription
        }
    }

    /// "Handle it". The queued run appears at once; the next read settles it.
    /// A `note` goes to the new run first ("Send again" with no run open).
    func start(stepKey: String, stepTitle: String, note: String? = nil, transport: any BackendExchanging) async -> String? {
        var body: [String: JSONValue] = ["action": .string("start"), "stepKey": .string(stepKey)]
        if let note = note?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank {
            body["note"] = .string(String(note.prefix(2_000)))
        }
        guard let result = await action(body, transport: transport) else {
            return nil
        }
        guard let runID = result["runId"]?.stringValue?.nilIfBlank else {
            notice = "The run did not start. Try again."
            return nil
        }
        if run(id: runID) == nil {
            runs.append(ThreadRunView(run: StepRunView.queued(id: runID, workID: workID, stepKey: stepKey, stepTitle: stepTitle)))
        }
        await load(transport)
        return runID
    }

    /// "Stop" on an open run, and "Take over" on the page: the server gives
    /// the page to the user.
    func stop(_ view: ThreadRunView, transport: any BackendExchanging) async -> Bool {
        guard await action(["action": .string("cancel"), "runId": .string(view.id)], transport: transport) != nil else {
            return false
        }
        replace(view.id, with: view.run.with(state: .cancelled))
        await load(transport)
        return true
    }

    /// "Continue", "I paid", "I signed in". The server starts a new run that
    /// continues this one and returns its id.
    func resume(_ view: ThreadRunView, note: String? = nil, transport: any BackendExchanging) async -> String? {
        var body: [String: JSONValue] = ["action": .string("resume"), "runId": .string(view.id)]
        if let note = note?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank {
            body["note"] = .string(String(note.prefix(2_000)))
        }
        guard let result = await action(body, transport: transport) else { return nil }
        await load(transport)
        return result["runId"]?.stringValue?.nilIfBlank ?? view.id
    }

    /// "Dismiss" on a handoff. The step is eligible again.
    func dismiss(_ view: ThreadRunView, transport: any BackendExchanging) async -> Bool {
        guard await action(["action": .string("dismiss"), "runId": .string(view.id)], transport: transport) != nil else {
            return false
        }
        replace(view.id, with: view.run.with(state: .closed))
        await load(transport)
        return true
    }

    /// A note to a run that works now. The run reads it between its steps.
    /// `noteID` is the id of the thread message that carries the note, so
    /// the run view's `notes` give the message its receipt.
    func steer(_ view: ThreadRunView, note: String, noteID: String? = nil, transport: any BackendExchanging) async -> Bool {
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        var body: [String: JSONValue] = [
            "action": .string("steer"),
            "runId": .string(view.id),
            "note": .string(String(trimmed.prefix(2_000))),
        ]
        if let noteID { body["noteId"] = .string(noteID) }
        return await action(body, transport: transport) != nil
    }

    /// Answers a run's question with the form. The server resumes the run.
    func answer(question: ThreadQuestion, form: FormAnswer, transport: any BackendExchanging) async -> AnswerOutcome {
        busy = true
        notice = nil
        defer { busy = false }
        let body: JSONValue = .object([
            "form": form.json,
            "timezone": .string(TimeZone.current.identifier),
        ])
        do {
            let exchange = try await transport.exchange(method: "POST", path: Self.answerPath(questionID: question.id), body: body)
            if exchange.isSuccess {
                await load(transport)
                return .sent
            }
            if let errors = exchange.body?["errors"]?.objectValue, !errors.isEmpty {
                var byField: [String: String] = [:]
                for (field, message) in errors {
                    if let text = message.stringValue?.nilIfBlank { byField[field] = text }
                }
                if !byField.isEmpty { return .fieldErrors(byField) }
            }
            return .failed(exchange.errorMessage)
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    // MARK: - Private

    private func action(_ body: [String: JSONValue], transport: any BackendExchanging) async -> JSONValue? {
        busy = true
        notice = nil
        defer { busy = false }
        do {
            let exchange = try await transport.exchange(method: "POST", path: runPath, body: .object(body))
            guard exchange.isSuccess else {
                notice = exchange.errorMessage
                return nil
            }
            return exchange.body ?? .object([:])
        } catch {
            notice = error.localizedDescription
            return nil
        }
    }

    private func replace(_ id: String, with run: StepRunView) {
        guard let index = runs.firstIndex(where: { $0.id == id }) else { return }
        runs[index] = ThreadRunView(run: run, question: runs[index].question, notes: runs[index].notes)
    }
}
