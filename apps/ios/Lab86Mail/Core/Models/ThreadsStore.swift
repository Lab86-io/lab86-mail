import Foundation
import Observation

// The thread list of the signed-in user (docs/albatross-threads.md): the rows
// of `GET /api/albatross/threads`, the poll that keeps them live, the seen
// mark, and the actions a row offers from the list (Stop, Steer, Continue).
// Optimistic writes settle on the next read. Nothing here is cached to disk:
// a row is a live server row.

@MainActor
@Observable
final class ThreadsStore {
    static let path = "/api/albatross/threads"
    static let seenPath = "/api/albatross/threads/seen"
    static let agentStopPath = "/api/agent/stop"
    /// The cadence while the list is on screen and a row works.
    static let workingInterval: Duration = .seconds(5)
    /// The cadence otherwise.
    static let idleInterval: Duration = .seconds(30)
    /// After this many failed reads in a row, live rows read as stale.
    static let staleAfterFailedPolls = 2

    /// The rows that entered "Needs you" on one read, for the banner and the
    /// announcement. A new value for every read that has one.
    struct Attention: Equatable, Sendable {
        let id: Int
        let rows: [ThreadRow]
    }

    /// How a steer from the list went.
    enum SteerOutcome: Equatable, Sendable {
        case sent
        /// The server says the run is closed.
        case runEnded
        case failed(String)
    }

    private(set) var rows: [ThreadRow] = []
    private(set) var loaded = false
    private(set) var loadError: String?
    private(set) var failedPolls = 0
    private(set) var serverNow: Date?
    /// The last list action that failed, shown until the next action.
    private(set) var notice: String?
    private(set) var attention: Attention?
    /// True while the list is on screen. The list announces attention only
    /// then; a thread shows the banner instead.
    var listVisible = false
    private var revision = 0
    private var attentionCount = 0
    private var followTask: Task<Void, Never>?
    /// The screens that show the rows or a thread now. The first one starts
    /// the poll; the last one stops it.
    private(set) var viewers = 0

    var isStale: Bool { failedPolls >= Self.staleAfterFailedPolls }

    var hasWorkingRows: Bool { rows.contains { $0.working } }

    /// Every 5 s while a row works, else every 30 s (lead decision 9).
    var pollInterval: Duration {
        hasWorkingRows ? Self.workingInterval : Self.idleInterval
    }

    var isFollowing: Bool { followTask != nil }

    // MARK: - The poll

    /// A list or a thread came on screen. The first viewer starts the poll.
    func beginFollowing(_ transport: any BackendExchanging) {
        viewers += 1
        startFollowTask(transport)
    }

    /// A list or a thread left the screen. The last viewer stops the poll.
    func endFollowing() {
        viewers = max(0, viewers - 1)
        guard viewers == 0 else { return }
        followTask?.cancel()
        followTask = nil
    }

    /// The app left the foreground: the poll stops until it is back.
    func pauseFollowing() {
        followTask?.cancel()
        followTask = nil
    }

    /// The app is back in the foreground with a viewer on screen.
    func resumeFollowing(_ transport: any BackendExchanging) {
        guard viewers > 0 else { return }
        startFollowTask(transport)
    }

    private func startFollowTask(_ transport: any BackendExchanging) {
        guard followTask == nil else { return }
        followTask = Task { [weak self] in
            guard let self else { return }
            await self.follow(transport)
        }
    }

    /// The rows that wait on the user, for the count at the entrance.
    var needsYouCount: Int {
        rows.filter { $0.needsYou && !$0.closed }.count
    }

    func row(for workID: String) -> ThreadRow? {
        rows.first { $0.workID == workID }
    }

    func clearNotice() {
        notice = nil
    }

    /// Sign-out: the poll stops and no row of this user stays in memory.
    func clear() {
        followTask?.cancel()
        followTask = nil
        viewers = 0
        rows = []
        loaded = false
        loadError = nil
        failedPolls = 0
        serverNow = nil
        notice = nil
        attention = nil
        listVisible = false
        revision += 1
    }

    // MARK: - Reads

    /// Reads the rows. An older read that lands after a newer one is dropped.
    func load(_ transport: any BackendExchanging) async {
        revision += 1
        let requestRevision = revision
        do {
            let exchange = try await transport.exchange(method: "GET", path: Self.path, body: nil)
            guard revision == requestRevision, !Task.isCancelled else { return }
            guard exchange.isSuccess, let body = exchange.body else {
                loaded = true
                failedPolls += 1
                loadError = exchange.errorMessage
                return
            }
            apply(ThreadRow.list(from: body), now: ThreadRow.serverNow(from: body))
        } catch {
            guard revision == requestRevision, !Task.isCancelled else { return }
            loaded = true
            failedPolls += 1
            loadError = error.localizedDescription
        }
    }

    /// Reads until the task is cancelled, at the cadence of the moment.
    func follow(_ transport: any BackendExchanging) async {
        while !Task.isCancelled {
            await load(transport)
            do { try await Task.sleep(for: pollInterval) } catch { return }
        }
    }

    /// The new rows, and the ones that entered "Needs you" since the last
    /// read. The first read never raises attention: what already waited
    /// when the list opened is the list's job, not the banner's.
    func apply(_ next: [ThreadRow], now: Date?) {
        var previous: [String: ThreadRow] = [:]
        for row in rows { previous[row.workID] = row }
        let entered = next.filter { row in
            row.needsYou && row.unread && !row.closed && previous[row.workID]?.needsYou != true
        }
        rows = next
        serverNow = now
        loaded = true
        loadError = nil
        failedPolls = 0
        if !entered.isEmpty, !previous.isEmpty {
            attentionCount += 1
            attention = Attention(id: attentionCount, rows: entered)
        }
    }

    // MARK: - Seen

    /// The thread is on screen: the mark clears here at once and on the
    /// server, so every device agrees.
    func markSeen(workID: String, transport: any BackendExchanging) async {
        setUnread(false, workID: workID)
        _ = try? await transport.exchange(
            method: "POST",
            path: Self.seenPath,
            body: .object(["workId": .string(workID)])
        )
    }

    /// "Mark as unread" from the list.
    @discardableResult
    func markUnread(workID: String, transport: any BackendExchanging) async -> Bool {
        setUnread(true, workID: workID)
        let body: JSONValue = .object(["workId": .string(workID), "unread": .bool(true)])
        let exchange = try? await transport.exchange(method: "POST", path: Self.seenPath, body: body)
        guard let exchange, exchange.isSuccess else {
            setUnread(false, workID: workID)
            notice = ThreadsStoreCopy.unreadFailed
            return false
        }
        return true
    }

    private func setUnread(_ unread: Bool, workID: String) {
        rows = rows.map { $0.workID == workID ? $0.with(unread: unread) : $0 }
    }

    // MARK: - Actions from a row

    /// "Stop" on a row: the working run, else the reply that runs on the
    /// server. No confirm dialog; the row then offers "Continue".
    @discardableResult
    func stop(_ row: ThreadRow, transport: any BackendExchanging) async -> Bool {
        notice = nil
        if row.status == .answering {
            let body: JSONValue = .object(["sessionId": .string(WorkThreadSession.id(for: row.workID))])
            let exchange = try? await transport.exchange(method: "POST", path: Self.agentStopPath, body: body)
            guard let exchange, exchange.isSuccess else {
                notice = ThreadsStoreCopy.stopReplyFailed
                return false
            }
            replace(row.with(status: .idle, statusLabel: nil, preview: ThreadsStoreCopy.replyStopped))
            return true
        }
        guard let runID = row.workingRunID ?? row.latestRunID else { return false }
        let body: [String: JSONValue] = ["action": .string("cancel"), "runId": .string(runID)]
        guard await runAction(body, workID: row.workID, transport: transport) != nil else { return false }
        replace(row.with(status: .stopped, statusLabel: ThreadsStoreCopy.stoppedByYou, preview: row.stepTitle.map { "Next: \($0)" }))
        return true
    }

    /// "Steer" from a row: one note to the working run. With `redirect`, the
    /// run stops and starts again with the note, in one call.
    func steer(_ row: ThreadRow, note: String, redirect: Bool, transport: any BackendExchanging) async -> SteerOutcome {
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .failed(ThreadsStoreCopy.emptyNote) }
        guard let runID = row.workingRunID ?? row.latestRunID else { return .runEnded }
        var body: [String: JSONValue] = [
            "action": .string(redirect ? "redirect" : "steer"),
            "runId": .string(runID),
            "note": .string(String(trimmed.prefix(2_000))),
        ]
        if !redirect { body["noteId"] = .string(ThreadNoteID.make()) }
        do {
            let exchange = try await transport.exchange(
                method: "POST",
                path: Self.runPath(workID: row.workID),
                body: .object(body)
            )
            guard exchange.isSuccess else {
                if exchange.status == 409 || exchange.status == 410 { return .runEnded }
                return .failed(exchange.errorMessage)
            }
            if redirect {
                replace(row.with(status: .startsSoon, statusLabel: nil, preview: row.stepTitle))
            }
            return .sent
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    /// "Continue" on a stopped row: the newest run goes on.
    @discardableResult
    func continueRun(_ row: ThreadRow, transport: any BackendExchanging) async -> Bool {
        guard let runID = row.latestRunID else { return false }
        let body: [String: JSONValue] = ["action": .string("resume"), "runId": .string(runID)]
        guard await runAction(body, workID: row.workID, transport: transport) != nil else { return false }
        replace(row.with(status: .startsSoon, statusLabel: nil, preview: row.stepTitle))
        return true
    }

    static func runPath(workID: String) -> String {
        "/api/albatross/work/\(workID)/run"
    }

    // MARK: - Private

    private func runAction(_ body: [String: JSONValue], workID: String, transport: any BackendExchanging) async -> JSONValue? {
        notice = nil
        do {
            let exchange = try await transport.exchange(method: "POST", path: Self.runPath(workID: workID), body: .object(body))
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

    private func replace(_ row: ThreadRow) {
        rows = rows.map { $0.workID == row.workID ? row : $0 }
    }
}

/// The words of the store's optimistic rows and notices.
enum ThreadsStoreCopy {
    static let stoppedByYou = "Stopped by you"
    static let replyStopped = "Reply stopped by you."
    static let stopReplyFailed = "Could not stop the reply. Try again."
    static let unreadFailed = "Could not mark it unread. Try again."
    static let emptyNote = "Write what Albatross should change."
}
