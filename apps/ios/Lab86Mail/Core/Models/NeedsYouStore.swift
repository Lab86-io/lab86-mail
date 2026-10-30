import Foundation
import Observation

// Needs you (docs/needs-you.md, phase 5): one read-through store for the
// page, the sidebar row, and the push routing. It reads the mobile v1
// routes with the app's own session and keeps nothing on disk except one
// Boolean for each owner: whether the feature is on, so the sidebar and a
// cold start from a push know the answer before the first read lands.
// The Mac target shares this store; its shell wires the same calls.

@MainActor
@Observable
final class NeedsYouStore {
    static let path = "/api/mobile/v1/needs-you"
    /// A read is good for this long; a forced read ignores it.
    static let cacheLife: TimeInterval = 30
    /// A user outside the flag reads again this often at most.
    static let idleRecheck: TimeInterval = 10 * 60

    /// The Undo offer after Done, Later, Not mine, an RSVP, or Send reply.
    struct UndoNotice: Identifiable, Hashable, Sendable {
        let obligationID: String
        /// The action word: "Done", "Later", "Not mine", "Reply sent".
        let word: String
        let asker: String
        /// The end of the window, in epoch milliseconds.
        let until: ObligationMillis

        var id: String { "\(obligationID):\(until)" }
        var summary: String { "\(word): \(asker)" }
    }

    private(set) var snapshot: NeedsYouSnapshot?
    private(set) var loaded = false
    private(set) var isLoading = false
    private(set) var loadError: String?
    private(set) var undo: UndoNotice?
    /// The item an action runs on now, so its buttons wait.
    private(set) var busyID: String?
    private(set) var actionError: String?
    private var loadedAt: Date?
    private var revision = 0
    private var ownerID: String?
    private var cachedEnabled = false
    private var undoTimer: Task<Void, Never>?
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    static func cacheKey(ownerID: String) -> String { "needsYou.enabled.\(ownerID)" }

    /// The server's answer, else the last answer for this owner.
    var isEnabled: Bool { snapshot?.enabled ?? cachedEnabled }
    var timezone: String? { snapshot?.timezone }
    var items: [ObligationView] { snapshot?.items ?? [] }

    /// The owner changed: the rows go, and the cached flag of the new owner
    /// is read so the sidebar row shows at once.
    func activate(ownerID: String?) {
        guard self.ownerID != ownerID else { return }
        clear()
        self.ownerID = ownerID
        if let ownerID {
            cachedEnabled = defaults.bool(forKey: Self.cacheKey(ownerID: ownerID))
        }
    }

    func clear() {
        revision += 1
        snapshot = nil
        loaded = false
        isLoading = false
        loadError = nil
        loadedAt = nil
        ownerID = nil
        cachedEnabled = false
        busyID = nil
        actionError = nil
        undoTimer?.cancel()
        undoTimer = nil
        undo = nil
    }

    // MARK: - Reads of the rows

    func item(id: String) -> ObligationView? {
        items.first { $0.id == id }
    }

    /// The item of one mail thread: an open one first, else the newest.
    func item(accountID: String, threadID: String) -> ObligationView? {
        let matches = items.filter { $0.accountID == accountID && $0.threadID == threadID }
        if let open = matches.first(where: { !$0.isClosed }) { return open }
        return matches.max { $0.updatedAt < $1.updatedAt }
    }

    /// The rows with expired codes settled for this moment.
    func settledItems(now: Date = .now) -> [ObligationView] {
        NeedsYouGrouping.settleExpiredCodes(items, now: NeedsYouClock.millis(now))
    }

    func groups(now: Date = .now, extras: [NeedsYouExtra] = []) -> [NeedsYouGroup] {
        NeedsYouGrouping.groups(
            items: settledItems(now: now),
            extras: extras,
            now: NeedsYouClock.millis(now),
            timezone: timezone
        )
    }

    func summary(now: Date = .now, extras: [NeedsYouExtra] = []) -> NeedsYouSummary {
        NeedsYouGrouping.summary(of: groups(now: now, extras: extras))
    }

    /// The Now count for the sidebar row.
    func nowCount(now: Date = .now) -> Int {
        summary(now: now).now
    }

    /// The next moment a code on the list expires, for the page's wake.
    func nextCodeExpiry(now: Date = .now) -> Date? {
        NeedsYouGrouping.nextCodeExpiry(items, now: NeedsYouClock.millis(now)).map(NeedsYouClock.date)
    }

    // MARK: - The read

    /// Reads the snapshot. A fresh read within `cacheLife` is kept unless
    /// `force` is true.
    func load(_ transport: any BackendExchanging, force: Bool = false, now: Date = .now) async {
        if !force, loaded, let loadedAt, now.timeIntervalSince(loadedAt) < Self.cacheLife { return }
        revision += 1
        let requestRevision = revision
        isLoading = true
        defer { if revision == requestRevision { isLoading = false } }
        do {
            let exchange = try await transport.exchange(method: "GET", path: Self.path, body: nil)
            guard revision == requestRevision, !Task.isCancelled else { return }
            guard exchange.isSuccess, let body = exchange.body, let snapshot = NeedsYouSnapshot(json: body) else {
                loadError = Self.serverMessage(exchange) ?? exchange.errorMessage
                return
            }
            apply(snapshot, now: now)
        } catch {
            guard revision == requestRevision else { return }
            loadError = error.localizedDescription
        }
    }

    /// The app came to the front: a flag user reads again; another user
    /// checks the flag again now and then.
    func refreshOnForeground(_ transport: any BackendExchanging, now: Date = .now) async {
        if isEnabled || !loaded {
            await load(transport, force: true, now: now)
            return
        }
        if let loadedAt, now.timeIntervalSince(loadedAt) < Self.idleRecheck { return }
        await load(transport, force: true, now: now)
    }

    /// A push arrived. The list reads again when the feature is on.
    func refreshAfterPush(_ transport: any BackendExchanging, now: Date = .now) async {
        guard isEnabled else { return }
        await load(transport, force: true, now: now)
    }

    /// One snapshot, as a read or a fixture gives it.
    func apply(_ snapshot: NeedsYouSnapshot, now: Date = .now) {
        self.snapshot = snapshot
        loaded = true
        loadError = nil
        loadedAt = now
        cachedEnabled = snapshot.enabled
        if let ownerID {
            defaults.set(snapshot.enabled, forKey: Self.cacheKey(ownerID: ownerID))
        }
    }

    // MARK: - Actions

    /// Done, Later, Not mine, or an RSVP. The row the server gives back
    /// replaces the old one; an undo window opens when the server offers one.
    @discardableResult
    func act(
        _ action: ObligationAction,
        on id: String,
        transport: any BackendExchanging,
        now: Date = .now
    ) async -> Bool {
        guard let result = await post(id: id, body: action.body, transport: transport),
              let outcome = ObligationActionResult(json: result) else { return false }
        replace(outcome.obligation)
        offerUndo(for: outcome, word: action.noticeWord, now: now)
        return true
    }

    /// Reverses the last close while its window is open.
    @discardableResult
    func undoLast(transport: any BackendExchanging, now: Date = .now) async -> Bool {
        guard let undo else { return false }
        guard NeedsYouClock.millis(now) <= undo.until else {
            dismissUndo()
            return false
        }
        guard let result = await post(id: undo.obligationID, body: ObligationAction.undo.body, transport: transport),
              let outcome = ObligationActionResult(json: result) else { return false }
        replace(outcome.obligation)
        dismissUndo()
        return true
    }

    func dismissUndo() {
        undoTimer?.cancel()
        undoTimer = nil
        undo = nil
    }

    /// The window closed: the offer goes.
    func expireUndo(now: Date = .now) {
        guard let undo, NeedsYouClock.millis(now) > undo.until else { return }
        dismissUndo()
    }

    /// The prepared reply of a mail `reply` obligation.
    func prepareDraft(id: String, transport: any BackendExchanging) async -> ObligationDraft? {
        guard let result = await post(id: id, suffix: "draft", body: .object([:]), transport: transport) else {
            return nil
        }
        guard let draft = ObligationDraft(json: result) else {
            actionError = "The server sent no draft."
            return nil
        }
        return draft
    }

    /// Sends the reply in the thread; the row closes as replied.
    @discardableResult
    func sendReply(id: String, body: String, transport: any BackendExchanging, now: Date = .now) async -> Bool {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            actionError = "Write the reply first."
            return false
        }
        guard let result = await post(id: id, suffix: "reply", body: .object(["body": .string(text)]), transport: transport),
              let outcome = ObligationActionResult(json: result) else { return false }
        replace(outcome.obligation)
        offerUndo(for: outcome, word: "Reply sent", now: now)
        return true
    }

    /// Starts a run on the item's Albatross, or a new Albatross from it.
    func startAlbatross(id: String, transport: any BackendExchanging) async -> ObligationAlbatrossResult? {
        guard let result = await post(id: id, suffix: "albatross", body: .object([:]), transport: transport),
              let outcome = ObligationAlbatrossResult(json: result) else { return nil }
        replace(outcome.obligation)
        return outcome
    }

    func clearActionError() {
        actionError = nil
    }

    // MARK: - Wiring

    /// `/api/mobile/v1/needs-you/<id>`, or `.../<id>/<suffix>`.
    static func actionPath(id: String, suffix: String? = nil) -> String {
        let base = "\(path)/\(id)"
        guard let suffix else { return base }
        return "\(base)/\(suffix)"
    }

    private func post(
        id: String,
        suffix: String? = nil,
        body: JSONValue,
        transport: any BackendExchanging
    ) async -> JSONValue? {
        let path = Self.actionPath(id: id, suffix: suffix)
        guard busyID == nil else { return nil }
        busyID = id
        defer { busyID = nil }
        actionError = nil
        do {
            let exchange = try await transport.exchange(method: "POST", path: path, body: body)
            guard exchange.isSuccess else {
                actionError = Self.errorMessage(for: exchange)
                return nil
            }
            guard let body = exchange.body else {
                actionError = "The server sent an empty answer."
                return nil
            }
            return body
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    /// The words of one failed action. A gone item says so; the rest use
    /// the server's line.
    static func errorMessage(for exchange: BackendExchange) -> String {
        switch exchange.status {
        case 404: "This item is no longer on your list."
        case 409: serverMessage(exchange) ?? "This item changed. Read it again."
        default: serverMessage(exchange) ?? exchange.errorMessage
        }
    }

    /// The server's line of a failed exchange. The mobile routes answer with
    /// the envelope `{ ok: false, requestID, error: { code, message,
    /// retryable } }`; an older route answers with `{ error: "..." }`.
    static func serverMessage(_ exchange: BackendExchange) -> String? {
        exchange.body?["error"]?["message"]?.stringValue?.nilIfBlank
            ?? exchange.body?["error"]?.stringValue?.nilIfBlank
    }

    private func replace(_ obligation: ObligationView) {
        guard var snapshot else { return }
        if let index = snapshot.items.firstIndex(where: { $0.id == obligation.id }) {
            snapshot.items[index] = obligation
        } else {
            snapshot.items.append(obligation)
        }
        self.snapshot = snapshot
    }

    private func offerUndo(for outcome: ObligationActionResult, word: String, now: Date) {
        guard let until = outcome.undoUntil else {
            dismissUndo()
            return
        }
        undoTimer?.cancel()
        undo = UndoNotice(obligationID: outcome.obligation.id, word: word, asker: outcome.obligation.asker, until: until)
        let wait = max(0, until - NeedsYouClock.millis(now))
        undoTimer = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(Int(wait) + 50))
            guard !Task.isCancelled else { return }
            self?.expireUndo()
        }
    }
}
