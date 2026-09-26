import Combine
import ConvexMobile
import Foundation
import Observation
import SwiftUI

struct AreaRefreshState: Equatable, Sendable {
    enum Phase: String, Sendable {
        case queued
        case running
        case done
        case error
    }

    let phase: Phase
    let progress: String?
    let error: String?
}

private struct AreaIndexStatusPayload: Decodable, Sendable {
    struct Run: Decodable, Sendable {
        let runId: String
        let areaId: String?
        let status: String
        let scanned: Double?
        let matched: Double?
        let error: String?
    }

    let latestRun: Run?
}

@MainActor
@Observable
final class ProductStore {
    private struct PendingMailCommand {
        let command: DurableMobileCommand
        let rollBack: @MainActor () -> Void
    }

    // One mail list action and the row it came from, when there is one.
    private struct MailAction {
        let command: DurableMobileCommand
        let thread: MailThreadSummary?
    }

    private struct MailStateOverride {
        var unread: Bool? = nil
        var starred: Bool? = nil

        var isEmpty: Bool { unread == nil && starred == nil }
    }

    private let tools: any ToolInvoking
    private let backend: BackendClient
    private let cache: ProductCache
    private let spotlight: any MailSpotlightIndexing
    private let convex: ConvexClientWithAuth<String>?
    // Typed v1 paged mail reads; nil keeps the legacy per-account tool path.
    private let mailPages: (any MailPageFetching)?
    // The durable path for mail list actions (NAT-10). Nil where nothing acts
    // on mail (previews and some tests); an action there reports an error.
    private let mailCommands: (any MailCommandQueueing)?
    // Mail list actions not settled yet, by idempotency key, with what
    // undoes their change on screen after a final failure.
    private var pendingMailCommands: [String: PendingMailCommand] = [:]
    // What puts each confirmed change of the current undo notice back on
    // screen, by operation id (round 2, FEATURES item 10).
    private var mailUndoRollBacks: [String: @MainActor () -> Void] = [:]
    private var undoNoticeExpiry: Task<Void, Never>?
    /// How long an undo notice stays. Activity keeps the Undo after that.
    var undoNoticeLifetime: Duration = .seconds(10)
    private var cacheOwner: String?
    private var liveMailTask: Task<Void, Never>?
    private var mailStateOverrides: [String: MailStateOverride] = [:]
    private var suppressedMailThreads: Set<String> = []
    // Snoozed threads stay hidden until their time. The server archives them
    // and brings them back, so they may show again after that (MUT-1).
    private var snoozedMailThreads: [String: Date] = [:]
    private var areaBriefMonitoringTasks: [String: Task<Void, Never>] = [:]

    var accounts: [AccountSummary] = []
    // Mailboxes whose sign-in ended. Not mail scopes until they reconnect.
    var reconnectAccounts: [AccountSummary] = []
    var threads: [MailThreadSummary] = []
    // Cursor state for the typed unified-inbox pages. hasMoreMail drives the
    // list's load-more row; the cursor is a lastDate watermark from the server.
    private(set) var hasMoreMail = false
    private(set) var isLoadingMoreMail = false
    private var mailNextCursor: String?
    // One cursor per server-paged scope (a category, a label, or one
    // account). Pages merge into `threads`, so every mutation path keeps
    // working; the view filters by scope. A refresh clears them.
    private var mailScopeCursors: [MailListScope: MailScopeCursor] = [:]
    private var loadingMailScopes: Set<MailListScope> = []
    private(set) var mailScopeGeneration = 0
    // Enabled custom labels the user shows in the sidebar (NAT-4).
    var mailLabels: [MailLabelSummary] = []
    // The Snoozed mailbox: active snoozes from `list_snoozed`, newest first.
    var snoozedThreads: [MailSnoozedThread] = []
    var isLoadingSnoozed = false
    var snoozedDidLoad = false
    var snoozedError: String?
    var searchedThreads: [MailThreadSummary] = []
    var completedMailSearchQuery: String?
    var isSearchingMail = false
    var events: [CalendarEventSummary] = []
    var calendarChoices: [CalendarChoice] = []
    var calendarUnauthorizedAccountIDs: Set<String> = []
    var dueCalendarTasks: [TaskSummary] = []
    var tasks: [TaskSummary] = []
    // Ordered column names of the active board, for grouping and move targets.
    var taskColumns: [String] = []
    // All of the user's boards (owned + shared) and the one the Tasks surface
    // is currently showing; nil = the default Personal board.
    var taskBoards: [TaskBoardSummary] = []
    var activeBoardID: String? = UserDefaults.standard.string(forKey: "albatross.tasks.active-board")
    var taskColumnRows: [TaskColumnSummary] = []
    var taskBoardMembers: [TaskBoardMember] = []
    var taskBoardRole = "viewer"
    var taskPublicToken: String?
    var projects: [ProjectSummary] = []
    // Project panes keyed by project id — linked tasks, loading, error, and
    // freshness — so the project surface reads store state instead of holding
    // a one-shot view-local snapshot that drifts after task mutations.
    var projectPanes: [String: ProjectPaneState] = [:]
    var areas: [AreaSummary] = []
    var approvals: [ApprovalSummary] = []
    var pendingQuestions: [PendingWorkQuestionSummary] = []
    var suggestions: [SuggestionSummary] = []
    var checkin: CheckinSummary?
    // Typed edition owns html/status/progress/sections; `dailyBrief` stays only
    // as the legacy migration/fallback string.
    var dailyReport: DailyReportModel?
    var dailyReportHistory: [DailyReportModel] = []
    // The id of the newest edition the server returned. Set on every
    // `get_latest_daily_report`; `selectDailyReport` leaves it alone.
    var latestDailyReportID: String?
    // The sources behind the shown edition, with their last sync and any
    // that must reconnect (round 2, FEATURES item 18). The last good read
    // stays when a refresh fails.
    var briefSources: BriefSourceHealth?

    // True while the shown edition is the newest one (or no newer edition is
    // known yet). Inactive-row hiding stays on in that state and turns off
    // while browsing history, the same as the web's `hideInactive`.
    var showsLatestDailyReport: Bool {
        DailyReportSelection.isLatest(shownID: dailyReport?.id, latestID: latestDailyReportID)
    }
    var dailyBrief: String?
    var isLoading = false
    var errorMessage: String?
    var mailErrorMessage: String?
    // Domain-local surfaces so a calendar or brief failure never blanks healthy
    // Mail or raises the app-wide alert.
    var calendarError: String?
    var isSyncingCalendar = false
    var calendarDidLoad = false
    // Calendar sync kicks: the phase and freshness the Calendar view shows,
    // the follow task that waits for a server copy, and the client creation
    // time of each event that still waits for its server copy.
    var calendarSync = CalendarSyncState()
    private var calendarSyncFollowTask: Task<Void, Never>?
    private(set) var pendingCalendarEventCreations: [String: Date] = [:]
    var briefError: String?
    var taskError: String?
    var isLoadingTasks = false
    var tasksDidLoad = false
    // Work is its own data owner too: a failed `area_list` keeps the last-good
    // (cached) areas readable, records the message only in `workError`, and never
    // blanks Mail or raises the app-wide alert. `workDidLoad` distinguishes a
    // genuine empty result from "haven't successfully loaded yet".
    var workError: String?
    var isLoadingWork = false
    var workDidLoad = false
    var lastRefresh: Date?
    var undoNotice: UndoableOperationNotice?
    var areaRefreshStates: [String: AreaRefreshState] = [:]
    // Immediate/offline read cache of opened area homes, keyed by area id. Never
    // a substitute for the authoritative server read — only what was last seen.
    private(set) var areaDetails: [String: AreaDetail] = [:]
    private(set) var workDetails: [String: WorkDetail] = [:]
    /// Every Albatross the user is carrying. This is what the Albatrosses page
    /// shows; areas are how they are filed, not what they are.
    private(set) var allWork: [WorkListItem] = []
    private(set) var workExecution = WorkExecutionSnapshot(json: nil)
    /// The "Later" shelf: dormant Work in wake order. The server sends it on
    /// `work_list`; the store recomputes it from `allWork` after a local
    /// horizon write and on a cache restore, so there is one rule on both sides.
    private(set) var laterWork: [WorkListItem] = []
    private var mailSearchGeneration = 0
    private var projectPaneLoadGeneration: [String: Int] = [:]
    private var projectPaneSessionGeneration = 0
    private var workProjectionGeneration = 0
    private var workProjectionLoads = 0
    private var accountSessionGeneration = 0

    init(
        tools: any ToolInvoking,
        backend: BackendClient,
        convex: ConvexClientWithAuth<String>? = nil,
        cache: ProductCache = .shared,
        spotlight: any MailSpotlightIndexing = MailSpotlightIndexer.shared,
        mailPages: (any MailPageFetching)? = nil,
        mailCommands: (any MailCommandQueueing)? = nil
    ) {
        self.tools = tools
        self.backend = backend
        self.convex = convex
        self.cache = cache
        self.spotlight = spotlight
        self.mailPages = mailPages
        self.mailCommands = mailCommands
    }

    func bootstrap(cacheOwner: String? = nil) async {
        guard !isLoading else { return }
        if let cacheOwner, self.cacheOwner != cacheOwner {
            self.cacheOwner = cacheOwner
            await restoreCache(owner: cacheOwner)
        }
        isLoading = true
        defer {
            isLoading = false
            lastRefresh = .now
        }
        errorMessage = nil
        await refreshMail()
        await refreshToday()
        await refreshWork()
        await persistCache()
        startLiveMail()
    }

    func refreshMail() async {
        mailErrorMessage = nil
        do {
            let result = try await tools.invoke("list_accounts")
            let listed = (result["accounts"]?.arrayValue ?? []).compactMap(AccountSummary.init)
            // A mailbox that needs to reconnect is not a mail account until
            // it does; it is listed apart so Mail can say so.
            let refreshedAccounts = listed.filter { !$0.needsReconnect }
            accounts = refreshedAccounts
            reconnectAccounts = listed.filter(\.needsReconnect)
            await refreshMailLabels()
            // Typed paged path: one unified corpus page with a real cursor,
            // instead of 200 threads per account replayed on every refresh.
            // An empty first page on a corpus that is still backfilling falls
            // through to the legacy per-account read so the inbox never blanks.
            if let mailPages {
                do {
                    let page = try await mailPages.fetchMailThreads(
                        accountID: nil,
                        category: nil,
                        cursor: nil,
                        limit: 100
                    )
                    if !page.items.isEmpty || refreshedAccounts.isEmpty {
                        threads = page.items.compactMap(applyPendingMailState).sorted { $0.date > $1.date }
                        mailNextCursor = page.nextCursor
                        hasMoreMail = page.hasMore
                        resetMailScopes()
                        await persistCache()
                        await syncMailIndex()
                        return
                    }
                } catch {
                    // The legacy path below remains the fallback contract.
                }
            }
            var allThreads: [MailThreadSummary] = []
            var firstFailure: Error?
            for account in refreshedAccounts where !account.id.isEmpty {
                do {
                    let rows = try await tools.invoke(
                        "list_account_threads",
                        arguments: ["account": .string(account.id), "limit": .number(200)]
                    )
                    allThreads += (rows["threads"]?.arrayValue ?? []).compactMap {
                        MailThreadSummary(json: $0, accountID: account.id)
                    }
                } catch {
                    firstFailure = firstFailure ?? error
                    // A single disconnected provider must not blank every other
                    // mailbox—or discard the last useful snapshot for this one.
                    allThreads += threads.filter { $0.accountID == account.id }
                }
            }
            threads = allThreads.compactMap(applyPendingMailState).sorted { $0.date > $1.date }
            mailNextCursor = nil
            hasMoreMail = false
            resetMailScopes()
            await persistCache()
            await syncMailIndex()
            if let firstFailure { recordMail(firstFailure) }
        } catch {
            recordMail(error)
        }
    }

    // Appends the next unified page beneath what is already shown. Existing
    // rows win a collision so optimistic state and live updates are kept.
    func loadMoreMail() async {
        guard let mailPages, hasMoreMail, !isLoadingMoreMail, let cursor = mailNextCursor else { return }
        isLoadingMoreMail = true
        defer { isLoadingMoreMail = false }
        do {
            let page = try await mailPages.fetchMailThreads(
                accountID: nil,
                category: nil,
                cursor: cursor,
                limit: 100
            )
            mergeMailPage(page.items)
            mailNextCursor = page.nextCursor
            hasMoreMail = page.hasMore
            await persistCache()
        } catch {
            recordMail(error)
        }
    }

    func hasMoreMail(in scope: MailListScope) -> Bool {
        scope.isUnified ? hasMoreMail : (mailScopeCursors[scope]?.hasMore ?? false)
    }

    func isLoadingMail(in scope: MailListScope) -> Bool {
        scope.isUnified ? isLoadingMoreMail : loadingMailScopes.contains(scope)
    }

    /// Changes each time a scope's cursor moves, so a load-more row that
    /// stays on screen asks again.
    func mailCursorToken(in scope: MailListScope) -> String {
        let cursor = scope.isUnified ? mailNextCursor : mailScopeCursors[scope]?.cursor
        return "\(scope.key)|\(cursor ?? "start")|\(mailScopeGeneration)"
    }

    /// Loads the first server page of a category, label, or account scope
    /// (NAT-2). The unified scope is the inbox itself and needs nothing.
    func loadMailScope(_ scope: MailListScope) async {
        guard !scope.isUnified, mailScopeCursors[scope] == nil else { return }
        await fetchMailScopePage(scope, cursor: nil)
    }

    func loadMoreMail(in scope: MailListScope) async {
        if scope.isUnified {
            await loadMoreMail()
            return
        }
        guard let state = mailScopeCursors[scope] else {
            await loadMailScope(scope)
            return
        }
        guard state.hasMore, let cursor = state.cursor else { return }
        await fetchMailScopePage(scope, cursor: cursor)
    }

    private func fetchMailScopePage(_ scope: MailListScope, cursor: String?) async {
        guard let mailPages, !loadingMailScopes.contains(scope) else { return }
        loadingMailScopes.insert(scope)
        defer { loadingMailScopes.remove(scope) }
        let generation = mailScopeGeneration
        do {
            let page = try await mailPages.fetchMailThreads(
                accountID: scope.accountID,
                category: scope.category,
                cursor: cursor,
                limit: 100
            )
            // A refresh replaced the list while this page loaded.
            guard generation == mailScopeGeneration else { return }
            mergeMailPage(page.items)
            mailScopeCursors[scope] = MailScopeCursor(cursor: page.nextCursor, hasMore: page.hasMore)
            await persistCache()
        } catch {
            recordMail(error)
        }
    }

    // The list was replaced, so scope pages merged into it are gone. Every
    // scope pages again from its first page; a page still in flight is
    // dropped by the generation check.
    private func resetMailScopes() {
        mailScopeCursors = [:]
        mailScopeGeneration += 1
    }

    private func mergeMailPage(_ items: [MailThreadSummary]) {
        let existing = Set(threads.map(mailKey))
        let fresh = items
            .filter { !existing.contains(mailKey($0)) }
            .compactMap(applyPendingMailState)
        guard !fresh.isEmpty else { return }
        threads = (threads + fresh).sorted { $0.date > $1.date }
    }

    func refreshMailLabels() async {
        guard let result = try? await tools.invoke("list_smart_labels", arguments: [:]) else { return }
        mailLabels = MailLabelSummary.sidebarLabels(from: result)
    }

    func searchMail(_ rawQuery: String) async {
        let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        mailSearchGeneration += 1
        let generation = mailSearchGeneration

        guard !query.isEmpty else {
            searchedThreads = []
            completedMailSearchQuery = nil
            isSearchingMail = false
            return
        }

        isSearchingMail = true
        defer {
            if generation == mailSearchGeneration { isSearchingMail = false }
        }

        do {
            let result = try await tools.invoke(
                "corpus_search",
                arguments: [
                    "query": .string(query),
                    "includeConnectedTools": .bool(false),
                    "max": .number(50),
                ]
            )
            guard generation == mailSearchGeneration, !Task.isCancelled else { return }
            let items = result["items"]?.arrayValue ?? []
            searchedThreads = items.compactMap { item in
                guard item["source"]?.stringValue != "mcp" else { return nil }
                return MailThreadSummary(json: item).flatMap(applyPendingMailState)
            }
            completedMailSearchQuery = query
        } catch is CancellationError {
            return
        } catch {
            guard generation == mailSearchGeneration else { return }
            recordMail(error)
        }
    }

    func refreshToday() async {
        // Calendar is one data owner: Today filters this window to the current
        // local day; the Calendar tab shows the full upcoming window.
        await refreshCalendar()

        do {
            isLoadingTasks = true
            defer { isLoadingTasks = false }
            var boardArguments: [String: JSONValue] = [:]
            if let activeBoardID { boardArguments["boardId"] = .string(activeBoardID) }
            let result = try await tools.invoke("tasks_get_board", arguments: boardArguments)
            let board = result["board"]
            var columnNames: [String: String] = [:]
            var orderedColumns: [String] = []
            for row in board?["columns"]?.arrayValue ?? [] {
                if let id = row["columnId"]?.stringValue, let name = row["name"]?.stringValue {
                    columnNames[id] = name
                    orderedColumns.append(name)
                }
            }
            taskColumns = orderedColumns
            taskColumnRows = (board?["columns"]?.arrayValue ?? []).compactMap(TaskColumnSummary.init)
            taskBoardMembers = (board?["members"]?.arrayValue ?? []).compactMap(TaskBoardMember.init)
            taskBoardRole = board?["role"]?.stringValue ?? "viewer"
            taskPublicToken = Self.nonBlank(board?["publicToken"]?.stringValue)
            tasks = (board?["cards"]?.arrayValue ?? []).compactMap { card in
                TaskSummary(json: card, column: columnNames[card["columnId"]?.stringValue ?? ""] ?? "Tasks")
            }.sorted {
                if $0.column != $1.column { return $0.column < $1.column }
                return $0.order < $1.order
            }
            tasksDidLoad = true
            taskError = nil
        } catch {
            taskError = error.localizedDescription
            record(error)
        }

        do {
            let result = try await tools.invoke(
                "albatross_list_approval_queue",
                arguments: ["status": .string("pending"), "limit": .number(50)]
            )
            approvals = (result["approvals"]?.arrayValue ?? []).compactMap(ApprovalSummary.init)
        } catch { record(error) }

        do {
            let result = try await backend.post(path: "/api/mobile/activity", body: .object([:]))
            suggestions = (result["suggestions"]?.arrayValue ?? []).compactMap(SuggestionSummary.init)
            checkin = result["checkin"].flatMap(CheckinSummary.init)
            pendingQuestions = (result["questions"]?.arrayValue ?? []).compactMap(PendingWorkQuestionSummary.init)
        } catch { record(error) }

        await refreshBrief()
        await persistCache()
    }

    // Calendar-specific loader. `sync: false` (bootstrap) lists the cached/current
    // upcoming window; `sync: true` (explicit pull-to-refresh) triggers one
    // `calendar_sync_now` first. All failure stays calendar-local: a query error
    // keeps the last good agenda visible and never blanks Mail or raises the
    // app-wide alert. Invalid required dates reject their event rather than
    // becoming 1970, and that rejection surfaces as a local decode note.
    func refreshCalendar(sync: Bool = false) async {
        isSyncingCalendar = true
        defer { isSyncingCalendar = false }
        var syncFailure: String?
        if sync {
            do {
                _ = try await tools.invoke("calendar_sync_now")
            } catch {
                syncFailure = error.localizedDescription
            }
        }
        let calendar = Calendar.autoupdatingCurrent
        // A wide window so week/month/year views have real data: from the
        // start of last month through four months out.
        let monthStart = calendar.dateInterval(of: .month, for: .now)?.start ?? calendar.startOfDay(for: .now)
        let start = calendar.date(byAdding: .month, value: -1, to: monthStart) ?? monthStart
        let end = calendar.date(byAdding: .month, value: 4, to: monthStart) ?? start.addingTimeInterval(120 * 86_400)
        let iso = ISO8601DateFormatter()
        do {
            let result = try await tools.invoke(
                "calendar_list_events",
                arguments: [
                    "fromIso": .string(iso.string(from: start)),
                    "toIso": .string(iso.string(from: end)),
                    "limit": .number(500),
                ]
            )
            let rows = result["events"]?.arrayValue ?? []
            let decoded = rows.compactMap(CalendarEventSummary.init).sorted { $0.start < $1.start }
            events = decoded
            do {
                let dueResult = try await tools.invoke(
                    "tasks_due_cards",
                    arguments: [
                        "startAt": .number(start.timeIntervalSince1970 * 1_000),
                        "endAt": .number(end.timeIntervalSince1970 * 1_000),
                    ]
                )
                dueCalendarTasks = (dueResult["cards"]?.arrayValue ?? []).compactMap { value in
                    TaskSummary(json: value)
                }
            } catch {
                taskError = error.localizedDescription
            }
            calendarDidLoad = true
            if let syncFailure {
                calendarError = syncFailure
            } else if decoded.count < rows.count {
                calendarError = "Some events couldn’t be read and were skipped."
            } else {
                calendarError = nil
            }
            await persistCache()
        } catch {
            calendarError = error.localizedDescription
        }
    }

    // MARK: - Calendar sync kicks

    // One user-triggered resync through `POST /api/calendar/resync`. The
    // server debounces `view_open` and rate limits `pull` and `manual_http`.
    // When the server starts a sync, this call follows the sync states until
    // the server copy lands, then reads the mirror. A `pull` therefore holds
    // the refresh spinner until the calendar is current.
    func resyncCalendar(reason: CalendarResyncReason, accountID: String? = nil) async {
        let request = CalendarResyncRequest(accountID: accountID, reason: reason)
        do {
            let json = try await backend.post(path: CalendarResyncRequest.path, body: request.body)
            guard let response = CalendarResyncResponse(json: json) else { throw BackendError.invalidResponse }
            if let lastSyncedAt = response.lastSyncedAt { calendarSync.lastSyncedAt = lastSyncedAt }
            calendarSync.failureMessage = nil
            guard response.started else {
                // A fresh calendar shows no line. The mirror read is still
                // cheap, and a pull expects the list to move.
                if reason != .viewOpen { await refreshCalendar(sync: false) }
                if calendarSync.phase == .failed { calendarSync.phase = .idle }
                return
            }
            // One follow loop at a time. A background follow from a mutation
            // yields to the explicit one.
            calendarSyncFollowTask?.cancel()
            calendarSyncFollowTask = nil
            await followCalendarSync(since: response.lastSyncedAt)
        } catch {
            // 429 and every other failure read the same on the surface. The
            // subtitle tells the user what to do next.
            calendarSyncFollowTask?.cancel()
            calendarSyncFollowTask = nil
            calendarSync.phase = .failed
            calendarSync.failureMessage = CalendarSyncState.failureCopy
        }
    }

    // A mirror write shows the local copy at once. The server kicks a forced
    // sync after the write. This records the event so the surface can draw
    // the dashed border, then follows the sync in the background.
    func noteCalendarMutation(eventID: String?, at date: Date = .now) {
        if let eventID = eventID?.nilIfBlank {
            pendingCalendarEventCreations[eventID] = date
        }
        calendarSyncFollowTask?.cancel()
        // The server copy lands with a sync that completes after the write.
        calendarSyncFollowTask = Task { [weak self] in
            await self?.followCalendarSync(since: date)
        }
    }

    // The dashed-border rule for one event on the screen.
    func isPendingServerCopy(_ event: CalendarEventSummary, now: Date = .now) -> Bool {
        guard let createdAt = pendingCalendarEventCreations[event.id] else { return false }
        return CalendarPendingEvents.isPending(
            createdAt: createdAt,
            lastSyncedAt: calendarSync.lastSyncedAt(forAccount: event.accountID),
            now: now
        )
    }

    // Reads the per-account sync states once. `calendar_list_calendars` is
    // the one authenticated read that returns them.
    func readCalendarSyncStates() async throws -> [CalendarSyncStateRow] {
        let result = try await tools.invoke("calendar_list_calendars")
        return (result["syncStates"]?.arrayValue ?? []).compactMap(CalendarSyncStateRow.init)
    }

    // Polls the sync states while a sync runs. Stops on a newer completed
    // sync, on an error row, or after the deadline. A deadline is not a
    // failure: the line fades, and the subtitle keeps the last known time.
    private func followCalendarSync(
        since: Date?,
        interval: Duration = .seconds(1),
        deadline: Duration = .seconds(60)
    ) async {
        calendarSync.phase = .running
        calendarSync.failureMessage = nil
        let startedAt = ContinuousClock.now
        while !Task.isCancelled {
            let rows = (try? await readCalendarSyncStates()) ?? []
            if !rows.isEmpty { calendarSync.rows = rows }
            switch CalendarSyncFollow.outcome(rows: rows, since: since) {
            case .done(let lastSyncedAt):
                calendarSync.lastSyncedAt = lastSyncedAt ?? calendarSync.lastSyncedAt
                await refreshCalendar(sync: false)
                guard !Task.isCancelled else { return }
                pruneSettledCalendarEvents()
                calendarSync.phase = .done
                calendarSync.completionToken += 1
                PlatformAccessibility.announce("Calendar updated")
                return
            case .failed:
                calendarSync.phase = .failed
                calendarSync.failureMessage = CalendarSyncState.failureCopy
                return
            case .waiting:
                break
            }
            if ContinuousClock.now - startedAt >= deadline {
                await refreshCalendar(sync: false)
                if calendarSync.phase == .running { calendarSync.phase = .idle }
                return
            }
            try? await Task.sleep(for: interval)
        }
    }

    private func pruneSettledCalendarEvents() {
        let now = Date.now
        pendingCalendarEventCreations = pendingCalendarEventCreations.filter { eventID, createdAt in
            let accountID = events.first(where: { $0.id == eventID })?.accountID
            let lastSyncedAt = accountID.map { calendarSync.lastSyncedAt(forAccount: $0) } ?? calendarSync.lastSyncedAt
            return CalendarPendingEvents.isPending(createdAt: createdAt, lastSyncedAt: lastSyncedAt, now: now)
        }
    }

    // Today's local day, from the same event owner the Calendar tab uses.
    var todaysEvents: [CalendarEventSummary] {
        let calendar = Calendar.autoupdatingCurrent
        let start = calendar.startOfDay(for: .now)
        let end = calendar.date(byAdding: .day, value: 1, to: start) ?? start.addingTimeInterval(86_400)
        // Half-open overlap includes events spanning the entire day and excludes
        // an event whose exclusive end is exactly midnight at the day's start.
        return events.filter { $0.start < end && $0.end > start }
    }

    func refreshBrief() async {
        briefError = nil
        do {
            let result = try await tools.invoke("get_latest_daily_report")
            let report = DailyReportModel(json: result["report"])
            dailyReport = report
            latestDailyReportID = report?.id
            dailyBrief = report?.legacyText ?? Self.briefText(from: result["report"])
            await persistCache()
        } catch {
            briefError = error.localizedDescription
        }
        await refreshBriefSources()
    }

    /// Reads the source health line for the shown edition. A failure keeps
    /// the last good line; the masthead never blanks on a slow read.
    func refreshBriefSources() async {
        do {
            briefSources = try await BriefSettingsClient(tools: tools).sources(reportID: dailyReport?.id)
        } catch {
            // The line is a read-only aid. The brief itself reports errors.
        }
    }

    func loadDailyReportHistory() async {
        do {
            let result = try await tools.invoke(
                "list_daily_reports",
                // The sheet shows only titles and dates; a tap loads the full
                // edition. Full rows here cost about 20 MB.
                arguments: ["limit": .number(30), "summaryOnly": .bool(true)]
            )
            dailyReportHistory = (result["reports"]?.arrayValue ?? []).compactMap(DailyReportModel.init)
        } catch {
            briefError = error.localizedDescription
        }
    }

    func selectDailyReport(id: String) async {
        if dailyReport?.id == id { return }
        do {
            let result = try await tools.invoke("get_daily_report", arguments: ["id": .string(id)])
            guard let report = DailyReportModel(json: result["report"]) else {
                throw BackendError.invalidResponse
            }
            dailyReport = report
        } catch {
            briefError = error.localizedDescription
        }
    }

    // Empty-state action: start a background generation and pick up the partial
    // edition. The tool returns immediately; the partial streams in via the same
    // get_latest_daily_report contract.
    func generateBrief() async {
        briefError = nil
        do {
            _ = try await tools.invoke("generate_daily_report", arguments: ["kind": .string("manual")])
            await refreshBrief()
        } catch {
            briefError = error.localizedDescription
        }
    }

    // MARK: - Task mutations (default board, optimistic with refresh-on-error)

    func setTaskCompleted(_ task: TaskSummary, completed: Bool) async {
        if let index = tasks.firstIndex(where: { $0.id == task.id }) {
            tasks[index] = task.with(completed: completed)
        }
        do {
            _ = try await tools.invoke(
                "tasks_update_card",
                arguments: ["cardId": .string(task.id), "completed": .bool(completed)]
            )
            await refreshTasks()
            await refreshProjectPanes(containing: task.id)
        } catch {
            errorMessage = error.localizedDescription
            await refreshTasks()
        }
    }

    func createTask(
        title: String,
        column: String?,
        due: Date?,
        details: String? = nil,
        priority: String? = nil
    ) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        var arguments: [String: JSONValue] = ["title": .string(trimmed)]
        if let activeBoardID { arguments["boardId"] = .string(activeBoardID) }
        if let column { arguments["column"] = .string(column) }
        if let due { arguments["dueIso"] = .string(due.formatted(.iso8601)) }
        if let details, !details.isEmpty { arguments["description"] = .string(details) }
        if let priority, !priority.isEmpty { arguments["priority"] = .string(priority) }
        do {
            _ = try await tools.invoke("tasks_create_card", arguments: arguments)
            await refreshTasks()
            await refreshProjectPanes(containing: nil)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func autofillTask(rough: String) async -> TaskDraftSuggestion? {
        do {
            let result = try await backend.post(
                path: "/api/tasks/autofill",
                body: .object(["rough": .string(rough)])
            )
            return TaskDraftSuggestion(json: result["draft"])
        } catch {
            taskError = error.localizedDescription
            return nil
        }
    }

    func moveTask(_ task: TaskSummary, to column: String) async {
        guard column != task.column else { return }
        if let index = tasks.firstIndex(where: { $0.id == task.id }) {
            tasks[index] = task.with(
                column: column,
                completed: column.lowercased() == "done" ? true : task.completed
            )
        }
        do {
            _ = try await tools.invoke(
                "tasks_move_card",
                arguments: ["cardId": .string(task.id), "column": .string(column)]
            )
            await refreshTasks()
            await refreshProjectPanes(containing: task.id)
        } catch {
            errorMessage = error.localizedDescription
            await refreshTasks()
        }
    }

    func updateTaskDetails(
        _ task: TaskSummary,
        title: String,
        details: String,
        priority: String?,
        due: Date?,
        completed: Bool,
        labels: [String]? = nil,
        assignees: [String]? = nil,
        weight: Int?? = nil
    ) async -> Bool {
        var arguments: [String: JSONValue] = [
            "cardId": .string(task.id),
            "title": .string(title),
            "description": .string(details),
            "completed": .bool(completed),
            "dueIso": due.map { .string($0.formatted(.iso8601)) } ?? .null,
        ]
        if let priority { arguments["priority"] = .string(priority) }
        if let labels { arguments["labels"] = .array(labels.map(JSONValue.string)) }
        if let assignees { arguments["assignees"] = .array(assignees.map(JSONValue.string)) }
        if let weight {
            arguments["weight"] = weight.map { .number(Double($0)) } ?? .null
        }
        do {
            _ = try await tools.invoke("tasks_update_card", arguments: arguments)
            await refreshTasks()
            await refreshProjectPanes(containing: task.id)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func addTaskComment(_ task: TaskSummary, body: String) async -> Bool {
        do {
            _ = try await tools.invoke(
                "tasks_add_comment",
                arguments: ["cardId": .string(task.id), "body": .string(body)]
            )
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func deleteTask(_ task: TaskSummary) async {
        tasks.removeAll { $0.id == task.id }
        do {
            _ = try await tools.invoke(
                "tasks_delete_card",
                arguments: ["cardId": .string(task.id)]
            )
            await refreshProjectPanes(containing: task.id)
        } catch {
            errorMessage = error.localizedDescription
            await refreshTasks()
        }
    }

    func setTaskDue(_ task: TaskSummary, due: Date?) async {
        if let index = tasks.firstIndex(where: { $0.id == task.id }) {
            tasks[index] = task.with(due: .some(due))
        }
        do {
            _ = try await tools.invoke(
                "tasks_update_card",
                arguments: [
                    "cardId": .string(task.id),
                    "dueIso": due.map { .string($0.formatted(.iso8601)) } ?? .null,
                ]
            )
            await refreshTasks()
            await refreshProjectPanes(containing: task.id)
        } catch {
            errorMessage = error.localizedDescription
            await refreshTasks()
        }
    }

    func switchBoard(to boardID: String?) async {
        activeBoardID = boardID
        if let boardID {
            UserDefaults.standard.set(boardID, forKey: "albatross.tasks.active-board")
        } else {
            UserDefaults.standard.removeObject(forKey: "albatross.tasks.active-board")
        }
        await refreshTasks()
    }

    func createBoard(title: String) async -> Bool {
        do {
            let result = try await tools.invoke(
                "tasks_create_board",
                arguments: ["title": .string(title.trimmingCharacters(in: .whitespacesAndNewlines))]
            )
            await refreshBoardsAndProjects()
            if let boardID = result["boardId"]?.stringValue {
                await switchBoard(to: boardID)
            }
            return true
        } catch {
            taskError = error.localizedDescription
            return false
        }
    }

    func renameActiveBoard(title: String) async -> Bool {
        guard let activeBoardID else { return false }
        do {
            _ = try await tools.invoke(
                "tasks_rename_board",
                arguments: [
                    "boardId": .string(activeBoardID),
                    "title": .string(title.trimmingCharacters(in: .whitespacesAndNewlines)),
                ]
            )
            await refreshBoardsAndProjects()
            return true
        } catch {
            taskError = error.localizedDescription
            return false
        }
    }

    func deleteActiveBoard() async -> Bool {
        guard let activeBoardID else { return false }
        do {
            _ = try await tools.invoke("tasks_delete_board", arguments: ["boardId": .string(activeBoardID)])
            await switchBoard(to: nil)
            await refreshBoardsAndProjects()
            return true
        } catch {
            taskError = error.localizedDescription
            return false
        }
    }

    func createColumn(name: String) async -> Bool {
        var arguments: [String: JSONValue] = [
            "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines))
        ]
        if let activeBoardID { arguments["boardId"] = .string(activeBoardID) }
        do {
            _ = try await tools.invoke("tasks_create_column", arguments: arguments)
            await refreshTasks()
            return true
        } catch {
            taskError = error.localizedDescription
            return false
        }
    }

    func renameColumn(_ column: TaskColumnSummary, name: String) async -> Bool {
        var arguments: [String: JSONValue] = [
            "column": .string(column.name),
            "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
        ]
        if let activeBoardID { arguments["boardId"] = .string(activeBoardID) }
        do {
            _ = try await tools.invoke("tasks_rename_column", arguments: arguments)
            await refreshTasks()
            return true
        } catch {
            taskError = error.localizedDescription
            return false
        }
    }

    func deleteColumn(_ column: TaskColumnSummary) async -> Bool {
        var arguments: [String: JSONValue] = ["column": .string(column.name)]
        if let activeBoardID { arguments["boardId"] = .string(activeBoardID) }
        do {
            _ = try await tools.invoke("tasks_delete_column", arguments: arguments)
            await refreshTasks()
            return true
        } catch {
            taskError = error.localizedDescription
            return false
        }
    }

    func reorderColumns(from offsets: IndexSet, to destination: Int) async {
        var reordered = taskColumnRows
        reordered.move(fromOffsets: offsets, toOffset: destination)
        taskColumnRows = reordered.enumerated().map { index, column in
            TaskColumnSummary(id: column.id, name: column.name, order: Double((index + 1) * 1_000))
        }
        taskColumns = taskColumnRows.map(\.name)
        do {
            for column in taskColumnRows {
                var arguments: [String: JSONValue] = [
                    "column": .string(column.name),
                    "order": .number(column.order),
                ]
                if let activeBoardID { arguments["boardId"] = .string(activeBoardID) }
                _ = try await tools.invoke("tasks_reorder_column", arguments: arguments)
            }
            await refreshTasks()
        } catch {
            taskError = error.localizedDescription
            await refreshTasks()
        }
    }

    func reorderTasks(in column: String, from offsets: IndexSet, to destination: Int) async {
        var ordered = tasks.filter { $0.column == column }.sorted { $0.order < $1.order }
        let movedIDs = offsets.compactMap { ordered.indices.contains($0) ? ordered[$0].id : nil }
        ordered.move(fromOffsets: offsets, toOffset: destination)
        guard let movedID = movedIDs.first, let index = ordered.firstIndex(where: { $0.id == movedID }) else { return }
        let before = index > 0 ? ordered[index - 1].order : nil
        let after = index + 1 < ordered.count ? ordered[index + 1].order : nil
        guard let task = ordered.first(where: { $0.id == movedID }) else { return }
        var arguments: [String: JSONValue] = ["cardId": .string(task.id), "column": .string(column)]
        if let before { arguments["beforeOrder"] = .number(before) }
        if let after { arguments["afterOrder"] = .number(after) }
        do {
            _ = try await tools.invoke("tasks_move_card", arguments: arguments)
            await refreshTasks()
            await refreshProjectPanes(containing: task.id)
        } catch {
            // Rollback via server refresh, THEN surface the error —
            // refreshTasks' success path clears taskError.
            await refreshTasks()
            taskError = error.localizedDescription
        }
    }

    func reorderTask(id: String, to column: String, before destinationID: String?) async {
        guard let task = tasks.first(where: { $0.id == id }) else { return }
        let destinationCards = tasks
            .filter { $0.column == column && $0.id != id }
            .sorted { $0.order < $1.order }
        let destinationIndex = destinationID
            .flatMap { destinationID in destinationCards.firstIndex { $0.id == destinationID } }
            ?? destinationCards.endIndex
        let beforeOrder = destinationIndex > destinationCards.startIndex
            ? destinationCards[destinationIndex - 1].order
            : nil
        let afterOrder = destinationIndex < destinationCards.endIndex
            ? destinationCards[destinationIndex].order
            : nil

        var arguments: [String: JSONValue] = [
            "cardId": .string(task.id),
            "column": .string(column),
        ]
        if let beforeOrder { arguments["beforeOrder"] = .number(beforeOrder) }
        if let afterOrder { arguments["afterOrder"] = .number(afterOrder) }

        let optimisticOrder: Double
        if let beforeOrder, let afterOrder {
            optimisticOrder = (beforeOrder + afterOrder) / 2
        } else if let beforeOrder {
            optimisticOrder = beforeOrder + 1_000
        } else if let afterOrder {
            optimisticOrder = afterOrder / 2
        } else {
            optimisticOrder = 1_000
        }
        if let index = tasks.firstIndex(where: { $0.id == id }) {
            tasks[index] = task.with(
                column: column,
                completed: column.lowercased() == "done",
                order: optimisticOrder
            )
        }

        do {
            _ = try await tools.invoke("tasks_move_card", arguments: arguments)
            await refreshTasks()
            await refreshProjectPanes(containing: task.id)
        } catch {
            // Rollback via server refresh, THEN surface the error —
            // refreshTasks' success path clears taskError.
            await refreshTasks()
            taskError = error.localizedDescription
        }
    }

    func loadTask(_ task: TaskSummary) async -> TaskSummary {
        do {
            let result = try await tools.invoke("tasks_get_card", arguments: ["cardId": .string(task.id)])
            return result["card"].flatMap { TaskSummary(json: $0, column: task.column) } ?? task
        } catch {
            taskError = error.localizedDescription
            return task
        }
    }

    func tasksForThread(_ threadID: String) async -> [TaskSummary] {
        do {
            let result = try await tools.invoke(
                "tasks_for_thread",
                arguments: ["threadId": .string(threadID)]
            )
            return (result["cards"]?.arrayValue ?? []).compactMap { value in
                TaskSummary(json: value)
            }
        } catch {
            taskError = error.localizedDescription
            return []
        }
    }

    func tasksForCalendarEvent(eventID: String, masterEventID: String?) async -> [TaskSummary] {
        var arguments: [String: JSONValue] = ["eventId": .string(eventID)]
        if let masterEventID { arguments["masterEventId"] = .string(masterEventID) }
        do {
            let result = try await tools.invoke("tasks_for_calendar_event", arguments: arguments)
            return (result["cards"]?.arrayValue ?? []).compactMap { value in
                TaskSummary(json: value)
            }
        } catch {
            taskError = error.localizedDescription
            return []
        }
    }

    func attachLink(to task: TaskSummary, name: String?, url: String) async -> Bool {
        var arguments: [String: JSONValue] = ["cardId": .string(task.id), "url": .string(url)]
        if let name, !name.isEmpty { arguments["name"] = .string(name) }
        do {
            _ = try await tools.invoke("tasks_attach_link", arguments: arguments)
            await refreshTasks()
            return true
        } catch {
            taskError = error.localizedDescription
            return false
        }
    }

    func attachFile(to task: TaskSummary, attachment: ComposeAttachment) async -> Bool {
        do {
            let result = try await backend.postMultipart(
                path: "/api/agent/uploads",
                fields: [:],
                files: [
                    MultipartFile(
                        fieldName: "files",
                        filename: attachment.filename,
                        contentType: attachment.contentType,
                        data: attachment.data
                    )
                ]
            )
            guard let uploadID = result["uploads"]?.arrayValue?.first?["uploadId"]?.stringValue else {
                throw BackendError.invalidResponse
            }
            _ = try await tools.invoke(
                "tasks_attach_file",
                arguments: [
                    "cardId": .string(task.id),
                    "name": .string(attachment.filename),
                    "chatUploadId": .string(uploadID),
                ]
            )
            await refreshTasks()
            return true
        } catch {
            taskError = error.localizedDescription
            return false
        }
    }

    func setBoardPublicLink(enabled: Bool) async -> Bool {
        guard let activeBoardID else { return false }
        do {
            let result = try await tools.invoke(
                "tasks_set_public_link",
                arguments: ["boardId": .string(activeBoardID), "enabled": .bool(enabled)]
            )
            taskPublicToken = Self.nonBlank(result["publicToken"]?.stringValue)
            await refreshBoardsAndProjects()
            return true
        } catch {
            taskError = error.localizedDescription
            return false
        }
    }

    func inviteBoardMember(email: String, role: String) async -> Bool {
        guard let activeBoardID else { return false }
        do {
            _ = try await tools.invoke(
                "tasks_invite_member",
                arguments: [
                    "boardId": .string(activeBoardID),
                    "email": .string(email),
                    "role": .string(role),
                ]
            )
            await refreshTasks()
            return true
        } catch {
            taskError = error.localizedDescription
            return false
        }
    }

    func removeBoardMember(_ member: TaskBoardMember) async -> Bool {
        guard let activeBoardID else { return false }
        do {
            _ = try await tools.invoke(
                "tasks_remove_member",
                arguments: ["boardId": .string(activeBoardID), "memberId": .string(member.id)]
            )
            await refreshTasks()
            return true
        } catch {
            taskError = error.localizedDescription
            return false
        }
    }

    func projectTasks(projectID: String) async -> [TaskSummary] {
        do {
            let result = try await tools.invoke(
                "albatross_get_project_pane",
                arguments: ["projectId": .string(projectID)]
            )
            return (result["pane"]?["tasks"]?.arrayValue ?? []).compactMap { row in
                guard let card = row["card"] else { return nil }
                return TaskSummary(json: card, column: card["columnName"]?.stringValue ?? "Tasks")
            }
        } catch {
            taskError = error.localizedDescription
            return []
        }
    }

    // Loads (or reloads) one project's pane into the store. `force` bypasses
    // the freshness check; plain calls are cheap no-ops while a pane is
    // already loaded or loading.
    func loadProjectPane(projectID: String, force: Bool = false) async {
        let sessionGeneration = projectPaneSessionGeneration
        if !force, let pane = projectPanes[projectID], pane.isLoading || pane.lastRefreshed != nil {
            return
        }
        var pane = projectPanes[projectID] ?? ProjectPaneState()
        pane.isLoading = true
        pane.error = nil
        projectPanes[projectID] = pane
        let generation = (projectPaneLoadGeneration[projectID] ?? 0) + 1
        projectPaneLoadGeneration[projectID] = generation
        do {
            let result = try await tools.invoke(
                "albatross_get_project_pane",
                arguments: ["projectId": .string(projectID)]
            )
            let linked = (result["pane"]?["tasks"]?.arrayValue ?? []).compactMap { row -> TaskSummary? in
                guard let card = row["card"] else { return nil }
                return TaskSummary(json: card, column: card["columnName"]?.stringValue ?? "Tasks")
            }
            guard projectPaneSessionGeneration == sessionGeneration,
                  projectPaneLoadGeneration[projectID] == generation
            else { return }
            projectPanes[projectID] = ProjectPaneState(
                tasks: linked,
                isLoading: false,
                error: nil,
                lastRefreshed: .now
            )
        } catch {
            guard projectPaneSessionGeneration == sessionGeneration,
                  projectPaneLoadGeneration[projectID] == generation
            else { return }
            pane.isLoading = false
            pane.error = error.localizedDescription
            projectPanes[projectID] = pane
        }
    }

    // Task mutations funnel through here: every loaded pane that links the
    // mutated task refreshes from the server, so project surfaces stay honest
    // while the task card itself keeps a single identity — a project pane is
    // links over board tasks, never a second task record. Pass nil to refresh
    // every loaded pane (e.g. after a task was created or hard-deleted, when
    // membership can appear/disappear without the old pane knowing).
    func refreshProjectPanes(containing taskID: String?) async {
        let affected = projectPanes.filter { _, pane in
            taskID == nil || pane.tasks.contains { $0.id == taskID }
        }.map(\.key)
        for projectID in affected {
            await loadProjectPane(projectID: projectID, force: true)
        }
    }

    func updateProject(_ project: ProjectSummary, status: String) async -> Bool {
        do {
            let result = try await tools.invoke(
                "albatross_update_project",
                arguments: ["projectId": .string(project.id), "status": .string(status)]
            )
            captureUndoNotice(result, summary: "Changed project to \(status)")
            let list = try await tools.invoke(
                "albatross_list_projects",
                arguments: ["limit": .number(100)]
            )
            projects = (list["projects"]?.arrayValue ?? []).compactMap(ProjectSummary.init)
            return true
        } catch {
            taskError = error.localizedDescription
            return false
        }
    }

    func refreshBoardsAndProjects() async {
        isLoadingTasks = true
        defer { isLoadingTasks = false }
        do {
            let result = try await tools.invoke("tasks_list_boards")
            taskBoards = (result["boards"]?.arrayValue ?? []).compactMap(TaskBoardSummary.init)
            if activeBoardID == nil || !taskBoards.contains(where: { $0.id == activeBoardID }) {
                activeBoardID = TaskBoardSummary.defaultBoardID(in: taskBoards)
                if let activeBoardID {
                    UserDefaults.standard.set(activeBoardID, forKey: "albatross.tasks.active-board")
                }
            }
        } catch {
            taskError = error.localizedDescription
        }
        do {
            let result = try await tools.invoke(
                "albatross_list_projects",
                arguments: ["status": .string("active"), "limit": .number(100)]
            )
            projects = (result["projects"]?.arrayValue ?? []).compactMap(ProjectSummary.init)
        } catch {
            taskError = error.localizedDescription
        }
        await refreshTasks()
    }

    // Board-only reload — cheaper than refreshToday after a card mutation.
    private func refreshTasks() async {
        isLoadingTasks = true
        defer { isLoadingTasks = false }
        do {
            var arguments: [String: JSONValue] = [:]
            if let activeBoardID { arguments["boardId"] = .string(activeBoardID) }
            let result = try await tools.invoke("tasks_get_board", arguments: arguments)
            let board = result["board"]
            var columnNames: [String: String] = [:]
            var orderedColumns: [String] = []
            for row in board?["columns"]?.arrayValue ?? [] {
                if let id = row["columnId"]?.stringValue, let name = row["name"]?.stringValue {
                    columnNames[id] = name
                    orderedColumns.append(name)
                }
            }
            taskColumns = orderedColumns
            taskColumnRows = (board?["columns"]?.arrayValue ?? []).compactMap(TaskColumnSummary.init)
            taskBoardMembers = (board?["members"]?.arrayValue ?? []).compactMap(TaskBoardMember.init)
            taskBoardRole = board?["role"]?.stringValue ?? "viewer"
            taskPublicToken = Self.nonBlank(board?["publicToken"]?.stringValue)
            tasks = (board?["cards"]?.arrayValue ?? []).compactMap { card in
                TaskSummary(json: card, column: columnNames[card["columnId"]?.stringValue ?? ""] ?? "Tasks")
            }.sorted {
                if $0.column != $1.column { return $0.column < $1.column }
                return $0.order < $1.order
            }
            tasksDidLoad = true
            taskError = nil
            await persistCache()
        } catch {
            // A failed reload keeps the optimistic state; the next refreshToday settles it.
            taskError = error.localizedDescription
        }
    }

    func refreshWork() async {
        let sessionGeneration = accountSessionGeneration
        do {
            let result = try await tools.invoke("area_list", arguments: ["status": .string("active")])
            guard sessionGeneration == accountSessionGeneration else { return }
            areas = (result["areas"]?.arrayValue ?? []).compactMap(AreaSummary.init)
            // The Albatrosses page lists work, not areas. A failure here keeps
            // the last-good list rather than blanking the page — but it must not
            // report an empty list as "you are carrying nothing", so with no
            // cache to fall back on the failure is recorded.
            do {
                try await loadWorkProjection(sessionGeneration: sessionGeneration)
            } catch {
                guard sessionGeneration == accountSessionGeneration else { return }
                if allWork.isEmpty { throw error }
                workError = error.localizedDescription
                workDidLoad = true
            }
            guard sessionGeneration == accountSessionGeneration else { return }
            await persistCache()
        } catch {
            guard sessionGeneration == accountSessionGeneration else { return }
            // Keep the last-good cached areas visible and record the failure only
            // on the Work surface. A Work failure must never blank Mail or raise
            // the app-wide `errorMessage`.
            workError = error.localizedDescription
        }
    }

    /// Refresh the server-owned current move without reloading the Area rail.
    /// Today polls this lightly so a block that just passed can enter recovery
    /// without waiting for an app relaunch.
    func refreshExecution() async {
        let sessionGeneration = accountSessionGeneration
        do {
            try await loadWorkProjection(sessionGeneration: sessionGeneration)
            guard sessionGeneration == accountSessionGeneration else { return }
            await persistCache()
        } catch {
            guard sessionGeneration == accountSessionGeneration else { return }
            workError = error.localizedDescription
        }
    }

    private func loadWorkProjection(sessionGeneration: Int) async throws {
        workProjectionGeneration += 1
        let generation = workProjectionGeneration
        workProjectionLoads += 1
        isLoadingWork = true
        defer {
            if sessionGeneration == accountSessionGeneration {
                workProjectionLoads = max(0, workProjectionLoads - 1)
                isLoadingWork = workProjectionLoads > 0
            }
        }

        let listed: JSONValue
        do {
            listed = try await tools.invoke("work_list", arguments: [:])
        } catch {
            // A newer request owns the visible state and its own error. An
            // older request finishing late must not overwrite either one.
            guard generation == workProjectionGeneration,
                  sessionGeneration == accountSessionGeneration else { return }
            throw error
        }
        guard generation == workProjectionGeneration,
              sessionGeneration == accountSessionGeneration else { return }
        allWork = (listed["work"]?.arrayValue ?? []).compactMap(WorkListItem.init)
        workExecution = WorkExecutionSnapshot(json: listed["execution"])
        if let later = listed["later"]?.arrayValue {
            laterWork = later.compactMap(WorkListItem.init)
        } else {
            laterWork = WorkGrouping.split(allWork, now: .now).later
        }
        workDidLoad = true
        workError = nil
    }

    /// Apply a horizon locally before the server confirms it. The row moves
    /// between the open groups and the "Later" shelf at once; the next
    /// `refreshWork` settles it against the server.
    func applyWorkHorizon(_ workID: String, horizon: WorkHorizon?) {
        allWork = allWork.map { $0.id == workID ? $0.withHorizon(horizon) : $0 }
        laterWork = WorkGrouping.split(allWork, now: .now).later
        if let detail = workDetails[workID] {
            workDetails[workID] = detail.withHorizon(horizon)
        }
    }

    // MARK: - Shape writes
    //
    // Each shape command is applied locally first. The row and the cached
    // detail change at once; the next `work_home` read settles them.

    func applyWorkShape(_ workID: String, shape: WorkShape) {
        allWork = allWork.map { $0.id == workID ? $0.withShape(shape) : $0 }
        if let detail = workDetails[workID] {
            workDetails[workID] = detail.withShape(shape)
        }
    }

    func applyWorkListItems(_ workID: String, items: [WorkListEntry]) {
        allWork = allWork.map { $0.id == workID ? $0.withListItems(items) : $0 }
        if let detail = workDetails[workID] {
            workDetails[workID] = detail.withListItems(items)
        }
    }

    func applyWorkMilestones(_ workID: String, milestones: [WorkMilestone]) {
        allWork = allWork.map { $0.id == workID ? $0.withMilestones(milestones) : $0 }
        if let detail = workDetails[workID] {
            workDetails[workID] = detail.withMilestones(milestones)
        }
    }

    func applyWorkMetricEntry(_ workID: String, entry: WorkMetricEntry, now: Date = .now) {
        if let detail = workDetails[workID] {
            let next = detail.appendingMetricEntry(entry, now: now)
            workDetails[workID] = next
            allWork = allWork.map { $0.id == workID ? $0.withMetricSummary(next.metricSummary) : $0 }
        }
    }

    /// Replace the milestone set. There is no durable command for this: the
    /// Mac and the phone call the same mutation the web calls. Ids are kept
    /// when they are sent, so a rename never reopens a done milestone.
    func setWorkMilestones(_ workID: String, milestones: [WorkMilestone]) async -> Bool {
        guard let convex else {
            workError = "Live connection unavailable — try again shortly."
            return false
        }
        let previous = workDetails[workID]?.work.milestones
        applyWorkMilestones(workID, milestones: milestones)
        nonisolated(unsafe) let client = convex
        do {
            let rows: [ConvexEncodable?] = milestones.map { milestone in
                var row: [String: ConvexEncodable?] = ["title": milestone.title]
                if !milestone.id.hasPrefix("local-") { row["id"] = milestone.id }
                return row
            }
            try await client.mutation(
                "albatrossWorkV2:setMilestones",
                with: ["workId": workID, "milestones": rows]
            )
            _ = try? await loadWorkDetail(workID)
            return true
        } catch {
            if let previous { applyWorkMilestones(workID, milestones: previous) }
            workError = error.localizedDescription
            return false
        }
    }

    /// Refresh one cached detail after a shape command. A failure keeps the
    /// optimistic state; the next open settles it.
    func settleWorkDetail(_ workID: String) async {
        _ = try? await loadWorkDetail(workID)
    }

    func answerWorkQuestion(_ question: WorkDetail.Question, answer: String, optionID: String?) async -> Bool {
        var body: [String: JSONValue] = [
            "answer": .string(answer),
            "timezone": .string(TimeZone.current.identifier),
        ]
        if let optionID { body["answeredOptionId"] = .string(optionID) }
        do {
            _ = try await backend.post(
                path: "/api/albatross/work/questions/\(question.id)/answer",
                body: .object(body)
            )
            await refreshWork()
            return true
        } catch {
            workError = error.localizedDescription
            return false
        }
    }

    func advanceWork(_ workID: String) async -> Bool {
        do {
            _ = try await backend.post(
                path: "/api/albatross/work/\(workID)/advance",
                body: .object(["timezone": .string(TimeZone.current.identifier)])
            )
            await refreshWork()
            return true
        } catch {
            workError = error.localizedDescription
            return false
        }
    }

    func completeWorkStep(_ workID: String, stepKey: String?, note: String? = nil) async -> Bool {
        var body: [String: JSONValue] = ["timezone": .string(TimeZone.current.identifier)]
        if let stepKey { body["stepKey"] = .string(stepKey) }
        if let note = note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty {
            body["note"] = .string(String(note.prefix(2_000)))
        }
        let previous = workDetails[workID]
        let optimistic = stepKey.flatMap { previous?.completing(stepID: $0) }
        if let optimistic { workDetails[workID] = optimistic }
        do {
            _ = try await backend.post(
                path: "/api/albatross/work/\(workID)/step",
                body: .object(body)
            )
            // The authoritative write has returned. Refresh projections in the
            // background without evicting the last-good detail or keeping the
            // completion button blocked on another network round trip.
            Task { [weak self] in
                guard let self else { return }
                await self.refreshWork()
                _ = try? await self.loadWorkDetail(workID)
            }
            return true
        } catch {
            if workDetails[workID] == optimistic {
                if let previous { workDetails[workID] = previous }
                else { workDetails.removeValue(forKey: workID) }
            }
            workError = error.localizedDescription
            return false
        }
    }

    /// Returns the request-scoped failure message, or nil when recovery was accepted.
    func recoverWork(_ move: WorkExecutionMove, recovery: String) async -> String? {
        var body: [String: JSONValue] = [
            "recovery": .string(recovery),
            "reasonKind": .string("other"),
            "timezone": .string(TimeZone.current.identifier),
        ]
        if let stepKey = move.stepKey { body["stepKey"] = .string(stepKey) }
        if let plannedAt = move.scheduledStartAt {
            body["plannedAt"] = .number(plannedAt.timeIntervalSince1970 * 1_000)
        }
        do {
            _ = try await backend.post(
                path: "/api/albatross/work/\(move.workID)/recover",
                body: .object(body)
            )
            workDetails.removeValue(forKey: move.workID)
            await refreshWork()
            return nil
        } catch {
            let message = error.localizedDescription
            return message
        }
    }

    struct WorkBrowserSession: Sendable {
        let sessionID: String
        let liveViewURL: String
        let replayURL: String
    }

    /// Open one shared browser for a guided step. The live view is
    /// interactive: the user acts inside it, and secrets go to the site only.
    func startWorkSession(_ workID: String, stepKey: String) async -> WorkBrowserSession? {
        do {
            let result = try await backend.post(
                path: "/api/albatross/work/\(workID)/session",
                body: .object(["action": .string("start"), "stepKey": .string(stepKey)])
            )
            guard let sessionID = result["sessionId"]?.stringValue,
                  let liveViewURL = result["liveViewUrl"]?.stringValue else {
                workError = "The shared browser could not open."
                return nil
            }
            return WorkBrowserSession(
                sessionID: sessionID,
                liveViewURL: liveViewURL,
                replayURL: result["replayUrl"]?.stringValue ?? ""
            )
        } catch {
            workError = error.localizedDescription
            return nil
        }
    }

    /// Ask the server to read the page and judge the step's doneWhen. A
    /// satisfied verdict completes the step server-side with the session
    /// bound as observed evidence.
    func verifyWorkSession(
        _ workID: String,
        sessionID: String,
        stepKey: String
    ) async -> (satisfied: Bool, reason: String)? {
        do {
            let result = try await backend.post(
                path: "/api/albatross/work/\(workID)/session",
                body: .object([
                    "action": .string("verify"),
                    "sessionId": .string(sessionID),
                    "stepKey": .string(stepKey),
                ])
            )
            let satisfied = result["satisfied"]?.boolValue ?? false
            if satisfied {
                if let optimistic = workDetails[workID]?.completing(stepID: stepKey) {
                    workDetails[workID] = optimistic
                }
                Task { [weak self] in
                    guard let self else { return }
                    await self.refreshWork()
                    _ = try? await self.loadWorkDetail(workID)
                }
            }
            return (satisfied, result["reason"]?.stringValue ?? "")
        } catch {
            workError = error.localizedDescription
            return nil
        }
    }

    func endWorkSession(_ workID: String, sessionID: String) async {
        _ = try? await backend.post(
            path: "/api/albatross/work/\(workID)/session",
            body: .object(["action": .string("end"), "sessionId": .string(sessionID)])
        )
    }

    func proofMatches(
        subject: String,
        snippet: String,
        messageID: String?,
        accountID: String? = nil,
        providerThreadID: String? = nil
    ) async -> [WorkProofCandidate] {
        do {
            var body: [String: JSONValue] = [
                "subject": .string(subject),
                "snippet": .string(String(snippet.prefix(2_000))),
            ]
            // The thread identity lets the server block marketing and code
            // mail by class before any candidate is even ranked.
            if let accountID { body["accountId"] = .string(accountID) }
            if let providerThreadID { body["providerThreadId"] = .string(providerThreadID) }
            let result = try await backend.post(
                path: "/api/albatross/proof-matches",
                body: .object(body)
            )
            return (result["candidates"]?.arrayValue ?? []).compactMap {
                WorkProofCandidate(
                    json: $0,
                    matchedMessageID: messageID,
                    matchedContent: String(snippet.prefix(2_000))
                )
            }
        } catch {
            // Proof suggestions are opportunistic. Mail remains fully readable
            // when matching is unavailable, so this does not raise a global error.
            return []
        }
    }

    /// "Not related" on a mail proof offer. The server keeps each Work and
    /// thread pair, and the proof matches leave them out on every device
    /// after that. True when the server saved them.
    @discardableResult
    func dismissProofOffer(accountID: String, threadID: String, workIDs: [String]) async -> Bool {
        guard let body = ProofDismissalRequest.body(accountID: accountID, threadID: threadID, workIDs: workIDs) else {
            return true
        }
        do {
            let result = try await backend.post(path: ProofDismissalRequest.path, body: body)
            return result["ok"]?.boolValue == true
        } catch {
            // The offer stays hidden in this view; it can come back later.
            return false
        }
    }

    func attachMailProof(
        _ candidate: WorkProofCandidate,
        route: ThreadRoute,
        subject: String,
        snippet: String
    ) async -> Bool {
        var body: [String: JSONValue] = [
            "claim": .string(candidate.proofWhat ?? "Something about \(candidate.workTitle) happened."),
            "title": .string(subject),
            "summary": .string(String((candidate.matchedContent ?? snippet).prefix(2_000))),
            "sourceKind": .string("mail_thread"),
            "sourceId": .string(route.threadID),
            "accountId": .string(route.accountID),
            "timezone": .string(TimeZone.current.identifier),
        ]
        if let proofID = candidate.proofID { body["proofId"] = .string(proofID) }
        do {
            _ = try await backend.post(
                path: "/api/albatross/work/\(candidate.workID)/proof",
                body: .object(body)
            )
            workDetails.removeValue(forKey: candidate.workID)
            await refreshWork()
            return true
        } catch {
            workError = error.localizedDescription
            return false
        }
    }

    func updateWorkState(_ workID: String, state: String) async -> Bool {
        do {
            _ = try await backend.post(
                path: "/api/albatross/work/\(workID)/state",
                body: .object(["state": .string(state)])
            )
            workDetails.removeValue(forKey: workID)
            await refreshWork()
            return true
        } catch {
            workError = error.localizedDescription
            return false
        }
    }

    func cachedAreaDetail(_ areaID: String) -> AreaDetail? { areaDetails[areaID] }

    func cachedWorkDetail(_ workID: String) -> WorkDetail? { workDetails[workID] }

    // Authoritative single-area read via the read-only `area_home` tool. A missing
    // or archived area throws from the server ('Area not found.'); the caller shows
    // an unavailable state and a route back to all areas rather than inventing data.
    @discardableResult
    func loadAreaDetail(_ areaID: String) async throws -> AreaDetail {
        let result = try await tools.invoke("area_home", arguments: ["areaId": .string(areaID)])
        guard let home = result["home"], home.objectValue != nil else {
            throw BackendError.server(status: 404, message: "This area is unavailable.")
        }
        let detail = AreaDetail(json: home)
        guard !detail.identity.id.isEmpty else {
            throw BackendError.server(status: 404, message: "This area is unavailable.")
        }
        areaDetails[areaID] = detail
        await persistCache()
        return detail
    }

    @discardableResult
    func loadWorkDetail(_ workID: String) async throws -> WorkDetail {
        let result = try await tools.invoke("work_home", arguments: ["workId": .string(workID)])
        guard let value = result["detail"], let detail = WorkDetail(json: value) else {
            throw BackendError.server(status: 404, message: "This Work is unavailable.")
        }
        workDetails[workID] = detail
        await persistCache()
        return detail
    }

    // Full event read for EventDetailView. Requires a calendar id (present on
    // Calendar-tab events); rows without one show summary-only detail instead.
    func loadEventDetail(accountID: String, eventID: String, calendarID: String) async throws -> CalendarEventDetail {
        let result = try await tools.invoke(
            "calendar_event_detail",
            arguments: [
                "account": .string(accountID),
                "eventId": .string(eventID),
                "calendarId": .string(calendarID),
            ]
        )
        guard let event = result["event"], event.objectValue != nil else {
            throw BackendError.server(status: 404, message: "This event is unavailable.")
        }
        return CalendarEventDetail(json: event)
    }

    func loadThread(_ route: ThreadRoute) async throws -> MailThreadDetail {
        let result = try await tools.invoke(
            "get_thread",
            arguments: ["account": .string(route.accountID), "threadId": .string(route.threadID)]
        )
        return MailThreadDetail(json: result)
    }

    // MARK: - Mail list actions (NAT-10)

    // Each action goes through the command outbox, so it survives going
    // offline and a relaunch. The change shows at once; a final failure
    // rolls it back and says why.

    func archive(_ thread: MailThreadSummary) async {
        await dispatchMail([MailAction(command: .mailArchive(Self.target(thread)), thread: thread)])
    }

    func trash(_ thread: MailThreadSummary) async {
        await dispatchMail([MailAction(command: .mailTrash(Self.target(thread)), thread: thread)])
    }

    func restore(_ thread: MailThreadSummary) async {
        await dispatchMail([MailAction(command: .mailRestore(Self.target(thread)), thread: thread)])
    }

    func bulkArchive(_ selected: [MailThreadSummary]) async {
        await dispatchMail(selected.map { MailAction(command: .mailArchive(Self.target($0)), thread: $0) })
    }

    func bulkTrash(_ selected: [MailThreadSummary]) async {
        await dispatchMail(selected.map { MailAction(command: .mailTrash(Self.target($0)), thread: $0) })
    }

    func bulkRestore(_ selected: [MailThreadSummary]) async {
        await dispatchMail(selected.map { MailAction(command: .mailRestore(Self.target($0)), thread: $0) })
    }

    func markRead(_ thread: MailThreadSummary) async {
        await dispatchMail([MailAction(command: .mailMarkRead(Self.target(thread)), thread: thread)])
    }

    // The server marks the newest message of the thread unread.
    func markUnread(_ thread: MailThreadSummary) async {
        await dispatchMail([MailAction(command: .mailMarkUnread(Self.messageTarget(thread)), thread: thread)])
    }

    // The server stars or unstars the newest message of the thread.
    func setStarred(_ starred: Bool, thread: MailThreadSummary) async {
        let target = Self.messageTarget(thread)
        await dispatchMail([MailAction(command: starred ? .mailStar(target) : .mailUnstar(target), thread: thread)])
    }

    // Snooze archives the thread now; the server brings it back at `until`.
    func snooze(_ thread: MailThreadSummary, until: Date) async {
        let payload = MailSnoozeCommandPayload(accountID: thread.accountID, threadID: thread.id, untilAt: until)
        await dispatchMail([MailAction(command: .mailSnooze(payload), thread: thread)])
    }

    // Brings a snoozed thread back to the inbox now.
    func unsnooze(_ snoozed: MailSnoozedThread) async {
        let payload = MailUnsnoozeCommandPayload(
            accountID: snoozed.accountID,
            threadID: snoozed.threadID,
            messageID: snoozed.messageID
        )
        await dispatchMail([MailAction(command: .mailUnsnooze(payload), thread: snoozed.summary)])
    }

    func performMailNotificationAction(action: String, accountID: String, threadID: String) async {
        let target = MailThreadCommandTarget(accountID: accountID, threadID: threadID)
        switch action {
        case "mark_read": await dispatchMail([MailAction(command: .mailMarkRead(target), thread: nil)])
        case "archive": await dispatchMail([MailAction(command: .mailArchive(target), thread: nil)])
        default: return
        }
    }

    /// Loads the Snoozed mailbox. A thread whose wake the outbox has not
    /// settled stays off the list.
    func refreshSnoozed() async {
        isLoadingSnoozed = true
        defer { isLoadingSnoozed = false }
        do {
            let result = try await tools.invoke("list_snoozed", arguments: ["limit": .number(200)])
            let waking = Set(pendingMailCommands.values.compactMap { pending -> String? in
                guard case .mailUnsnooze(let payload) = pending.command else { return nil }
                return mailKey(accountID: payload.accountID, threadID: payload.threadID)
            })
            snoozedThreads = (result["snoozed"]?.arrayValue ?? [])
                .compactMap(MailSnoozedThread.init(json:))
                .filter { !waking.contains($0.threadKey) }
            snoozedDidLoad = true
            snoozedError = nil
        } catch {
            snoozedError = error.localizedDescription
        }
    }

    /// Brings the lists in line with the outbox. A confirmed action keeps
    /// its change. A final failure rolls its change back and says why. An
    /// action that still waits keeps its change, also after a relaunch.
    func reconcileMailCommands(_ commands: [PendingCommandSnapshot]) async {
        var changed = false
        var failures: [PendingMailCommand] = []
        var undoable: [(operationID: String, pending: PendingMailCommand)] = []
        for command in commands {
            let key = command.idempotencyKey
            switch MailCommandPhase(command) {
            case .waiting:
                guard pendingMailCommands[key] == nil else { continue }
                // The app relaunched while this action waited: show it again.
                pendingMailCommands[key] = PendingMailCommand(
                    command: command.command,
                    rollBack: applyMailChange(command.command, thread: nil)
                )
                changed = true
            case .confirmed:
                guard let pending = pendingMailCommands.removeValue(forKey: key) else { continue }
                // A change the server recorded gets an Undo.
                if let operationID = command.operationID?.nilIfBlank {
                    undoable.append((operationID, pending))
                }
                changed = true
            case .failed(let message):
                guard let pending = pendingMailCommands.removeValue(forKey: key) else { continue }
                failures.append(pending)
                if mailErrorMessage == nil { mailErrorMessage = message }
                changed = true
            }
        }
        // Newest first, so two changes to one thread undo in the right order.
        for failure in failures.reversed() { failure.rollBack() }
        if !undoable.isEmpty {
            mailUndoRollBacks = Dictionary(
                undoable.map { ($0.operationID, $0.pending.rollBack) },
                uniquingKeysWith: { first, _ in first }
            )
            let operationIDs = undoable.map(\.operationID)
            showUndoNotice(UndoableOperationNotice(
                id: operationIDs[0],
                summary: MailUndoCopy.summary(for: undoable.map(\.pending.command)),
                operationIDs: operationIDs,
                kind: .mail
            ))
        }
        guard changed else { return }
        await persistCache()
        await syncMailIndex()
    }

    private func dispatchMail(_ actions: [MailAction]) async {
        guard let mailCommands else {
            recordMail(BackendError.configuration)
            return
        }
        var sent = false
        for action in actions {
            let key = MailCommandKey.make()
            let rollBack = applyMailChange(action.command, thread: action.thread)
            // Tracked before the first await, so a drain that runs meanwhile
            // does not apply the same change a second time.
            pendingMailCommands[key] = PendingMailCommand(command: action.command, rollBack: rollBack)
            do {
                try await mailCommands.enqueue(action.command, idempotencyKey: key)
                sent = true
            } catch {
                pendingMailCommands.removeValue(forKey: key)
                rollBack()
                recordMail(error)
            }
        }
        guard sent else { return }
        await reconcileMailCommands(await mailCommands.flush())
    }

    /// Shows one mail action at once and returns what undoes it.
    private func applyMailChange(
        _ command: DurableMobileCommand,
        thread: MailThreadSummary?
    ) -> @MainActor () -> Void {
        switch command {
        case .mailArchive(let target), .mailTrash(let target):
            return hideThread(accountID: target.accountID, threadID: target.threadID, snoozedUntil: nil)
        case .mailSnooze(let payload):
            return hideThread(accountID: payload.accountID, threadID: payload.threadID, snoozedUntil: payload.untilAt)
        case .mailRestore(let target):
            return showThread(accountID: target.accountID, threadID: target.threadID, summary: thread)
        case .mailUnsnooze(let payload):
            return wakeThread(accountID: payload.accountID, threadID: payload.threadID, summary: thread)
        case .mailMarkRead(let target):
            return setMailFlags(accountID: target.accountID, threadID: target.threadID, unread: false, current: thread)
        case .mailMarkUnread(let target):
            return setMailFlags(accountID: target.accountID, threadID: target.threadID, unread: true, current: thread)
        case .mailStar(let target):
            return setMailFlags(accountID: target.accountID, threadID: target.threadID, starred: true, current: thread)
        case .mailUnstar(let target):
            return setMailFlags(accountID: target.accountID, threadID: target.threadID, starred: false, current: thread)
        default:
            return {}
        }
    }

    // Archive, trash, and snooze take the thread off every list.
    private func hideThread(accountID: String, threadID: String, snoozedUntil: Date?) -> @MainActor () -> Void {
        let key = mailKey(accountID: accountID, threadID: threadID)
        let wasSuppressed = suppressedMailThreads.contains(key)
        let previousSnooze = snoozedMailThreads[key]
        if let snoozedUntil {
            snoozedMailThreads[key] = snoozedUntil
        } else {
            suppressedMailThreads.insert(key)
        }
        let removed = removeThreadOptimistically(accountID: accountID, threadID: threadID)
        return { [weak self] in
            guard let self else { return }
            if snoozedUntil != nil {
                self.snoozedMailThreads[key] = previousSnooze
            } else if !wasSuppressed {
                self.suppressedMailThreads.remove(key)
            }
            self.restoreThread(removed)
        }
    }

    // Restore puts the thread back in the inbox.
    private func showThread(accountID: String, threadID: String, summary: MailThreadSummary?) -> @MainActor () -> Void {
        let key = mailKey(accountID: accountID, threadID: threadID)
        let wasSuppressed = suppressedMailThreads.remove(key) != nil
        let inserted = insertThread(summary, key: key)
        return { [weak self] in
            guard let self else { return }
            if wasSuppressed { self.suppressedMailThreads.insert(key) }
            if inserted { self.threads.removeAll { self.mailKey($0) == key } }
        }
    }

    // Unsnooze takes the thread off the Snoozed list and puts it back in the inbox.
    private func wakeThread(accountID: String, threadID: String, summary: MailThreadSummary?) -> @MainActor () -> Void {
        let key = mailKey(accountID: accountID, threadID: threadID)
        let previousSnooze = snoozedMailThreads.removeValue(forKey: key)
        let index = snoozedThreads.firstIndex { $0.threadKey == key }
        let row = index.map { snoozedThreads.remove(at: $0) }
        let inserted = insertThread(summary, key: key)
        return { [weak self] in
            guard let self else { return }
            if let previousSnooze { self.snoozedMailThreads[key] = previousSnooze }
            if let row, let index, !self.snoozedThreads.contains(where: { $0.threadKey == key }) {
                self.snoozedThreads.insert(row, at: min(index, self.snoozedThreads.endIndex))
            }
            if inserted { self.threads.removeAll { self.mailKey($0) == key } }
        }
    }

    // Read and star state show at once. The override keeps the change while
    // a server copy still has the old state.
    private func setMailFlags(
        accountID: String,
        threadID: String,
        unread: Bool? = nil,
        starred: Bool? = nil,
        current thread: MailThreadSummary?
    ) -> @MainActor () -> Void {
        let key = mailKey(accountID: accountID, threadID: threadID)
        let current = thread
            ?? threads.first(where: { mailKey($0) == key })
            ?? searchedThreads.first(where: { mailKey($0) == key })
        let previousUnread = unread.map { current?.unread ?? !$0 }
        let previousStarred = starred.map { current?.starred ?? !$0 }
        var override = mailStateOverrides[key] ?? MailStateOverride()
        let previousUnreadOverride = override.unread
        let previousStarredOverride = override.starred
        if let unread { override.unread = unread }
        if let starred { override.starred = starred }
        mailStateOverrides[key] = override
        if let unread { setUnread(unread, accountID: accountID, threadID: threadID) }
        if let starred { setStarredLocally(starred, accountID: accountID, threadID: threadID) }
        return { [weak self] in
            guard let self else { return }
            // Only the field this action set goes back; another action may
            // own the other one.
            var restored = self.mailStateOverrides[key] ?? MailStateOverride()
            if unread != nil { restored.unread = previousUnreadOverride }
            if starred != nil { restored.starred = previousStarredOverride }
            self.mailStateOverrides[key] = restored.isEmpty ? nil : restored
            if let previousUnread { self.setUnread(previousUnread, accountID: accountID, threadID: threadID) }
            if let previousStarred { self.setStarredLocally(previousStarred, accountID: accountID, threadID: threadID) }
        }
    }

    // Adds a thread the list does not show yet, in date order. True when it did.
    private func insertThread(_ summary: MailThreadSummary?, key: String) -> Bool {
        guard let summary, !threads.contains(where: { mailKey($0) == key }) else { return false }
        threads = (threads + [summary]).sorted { $0.date > $1.date }
        return true
    }

    private static func target(_ thread: MailThreadSummary) -> MailThreadCommandTarget {
        MailThreadCommandTarget(accountID: thread.accountID, threadID: thread.id)
    }

    private static func messageTarget(_ thread: MailThreadSummary) -> MailThreadMessageCommandTarget {
        MailThreadMessageCommandTarget(accountID: thread.accountID, threadID: thread.id)
    }

    func bulkTriage(_ selected: [MailThreadSummary]) async -> [BulkTriageVerdict] {
        guard !selected.isEmpty else { return [] }
        do {
            let items = selected.prefix(40).map { thread in
                JSONValue.object([
                    "id": .string(mailKey(thread)),
                    "from": .string(thread.sender),
                    "subject": .string(thread.subject),
                    "snippet": .string(thread.snippet),
                ])
            }
            let result = try await tools.invoke(
                "bulk_triage",
                arguments: ["items": .array(Array(items))]
            )
            return (result["verdicts"]?.arrayValue ?? []).compactMap(BulkTriageVerdict.init)
        } catch {
            recordMail(error)
            return []
        }
    }

    func correctCategory(_ thread: MailThreadSummary, to correction: MailCategoryCorrection) async -> Bool {
        do {
            let result = try await tools.invoke(
                "apply_smart_correction",
                arguments: correction.arguments(accountID: thread.accountID, threadID: thread.id)
            )
            captureUndoNotice(result, summary: "Smart rule saved", kind: .mail)
            await refreshMail()
            return true
        } catch {
            recordMail(error)
            return false
        }
    }

    func sendMail(accountID: String, to: String, subject: String, body: String) async throws {
        _ = try await tools.invoke(
            "send_message",
            arguments: [
                "account": .string(accountID),
                "to": .string(to),
                "subject": .string(subject),
                "body": .string(body),
            ]
        )
    }

    func downloadAttachment(
        accountID: String,
        messageID: String,
        attachment: MailAttachment
    ) async throws -> URL {
        let pathCharacters = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        guard let messageComponent = messageID.addingPercentEncoding(withAllowedCharacters: pathCharacters),
              let attachmentComponent = attachment.id.addingPercentEncoding(withAllowedCharacters: pathCharacters) else {
            throw BackendError.invalidResponse
        }
        var components = URLComponents()
        components.percentEncodedPath = "/api/attachments/\(messageComponent)/\(attachmentComponent)"
        components.queryItems = [
            URLQueryItem(name: "account", value: accountID),
            URLQueryItem(name: "name", value: attachment.filename),
            URLQueryItem(name: "mime", value: attachment.mimeType),
            URLQueryItem(name: "preview", value: "1"),
        ]
        guard let path = components.string else { throw BackendError.invalidResponse }
        let download = try await backend.download(path: path)
        return try await Task.detached {
            let stagedDirectory = download.url.deletingLastPathComponent()
            defer { try? FileManager.default.removeItem(at: stagedDirectory) }
            let safeName = URL(fileURLWithPath: attachment.filename.replacingOccurrences(of: "\\", with: "/"))
                .lastPathComponent
                .replacingOccurrences(of: ":", with: "-")
            let directory = FileManager.default.temporaryDirectory
                .appending(path: "AlbatrossAttachmentPreviews", directoryHint: .isDirectory)
                .appending(path: UUID().uuidString, directoryHint: .isDirectory)
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.complete]
            )
            let finalName = safeName
                .trimmingCharacters(in: .whitespacesAndNewlines.union(.controlCharacters))
                .replacingOccurrences(of: #"^\.+"#, with: "", options: .regularExpression)
            let url = directory.appending(path: finalName.isEmpty ? "Attachment" : finalName)
            try FileManager.default.moveItem(at: download.url, to: url)
            try FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.complete],
                ofItemAtPath: url.path
            )
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var mutableURL = url
            try mutableURL.setResourceValues(values)
            return mutableURL
        }.value
    }

    func reply(accountID: String, threadID: String, messageID: String, body: String) async throws {
        _ = try await tools.invoke(
            "reply",
            arguments: [
                "account": .string(accountID),
                "threadId": .string(threadID),
                "messageId": .string(messageID),
                "body": .string(body),
            ]
        )
    }

    func replyAll(accountID: String, threadID: String?, messageID: String, body: String) async throws {
        var arguments: [String: JSONValue] = [
            "account": .string(accountID),
            "messageId": .string(messageID),
            "body": .string(body),
        ]
        if let threadID { arguments["threadId"] = .string(threadID) }
        _ = try await tools.invoke("reply_all", arguments: arguments)
    }

    func forward(accountID: String, messageID: String, to: String, subject: String, body: String) async throws {
        _ = try await tools.invoke(
            "forward",
            arguments: [
                "account": .string(accountID),
                "messageId": .string(messageID),
                "to": .string(to),
                "subject": .string(subject),
                "body": .string(body),
            ]
        )
    }

    func sendCompose(
        mode: String,
        accountID: String,
        threadID: String?,
        messageID: String?,
        to: String,
        cc: String,
        bcc: String,
        subject: String,
        body: String,
        attachments: [ComposeAttachment],
        sendAt: Date? = nil,
        undoSeconds: Int = 0
    ) async throws -> ComposeSubmission {
        var fields = [
            "mode": mode,
            "account": accountID,
            "to": to,
            "cc": cc,
            "bcc": bcc,
            "subject": subject,
            "body": body,
        ]
        if let threadID { fields["threadId"] = threadID }
        if let messageID { fields["messageId"] = messageID }
        if let sendAt { fields["sendAt"] = String(Int(sendAt.timeIntervalSince1970 * 1_000)) }
        if sendAt == nil, undoSeconds > 0 {
            fields["undoSeconds"] = String(min(max(undoSeconds, 0), 300))
        }
        let result = try await backend.postMultipart(
            path: "/api/compose",
            fields: fields,
            files: attachments.map(\.multipart)
        )
        // Only an explicit `sent` object counts as sent. A 2xx envelope
        // without one is unconfirmed: the caller keeps the draft and never
        // retries on its own.
        let submission = ComposeSubmission.parse(
            result,
            accountID: accountID,
            threadID: threadID,
            undoSeconds: undoSeconds
        )
        if case .sent = submission {
            await refreshMail()
        }
        return submission
    }

    func saveDraft(
        id: String?,
        accountID: String,
        threadID: String?,
        messageID: String?,
        to: String,
        cc: String,
        bcc: String,
        subject: String,
        body: String,
        scheduledFor: Date?
    ) async throws -> String {
        if let id {
            var patch: [String: JSONValue] = [
                "to": .string(to),
                "cc": .string(cc),
                "bcc": .string(bcc),
                "subject": .string(subject),
                "body": .string(body),
            ]
            if let scheduledFor {
                patch["scheduledFor"] = .number(scheduledFor.timeIntervalSince1970 * 1_000)
            }
            _ = try await tools.invoke(
                "update_draft",
                arguments: ["id": .string(id), "patch": .object(patch)]
            )
            return id
        }

        var arguments: [String: JSONValue] = [
            "account": .string(accountID),
            "to": .string(to),
            "cc": .string(cc),
            "bcc": .string(bcc),
            "subject": .string(subject),
            "body": .string(body),
        ]
        if let threadID { arguments["threadId"] = .string(threadID) }
        if let messageID { arguments["inReplyToMessageId"] = .string(messageID) }
        if let scheduledFor {
            arguments["scheduledFor"] = .number(scheduledFor.timeIntervalSince1970 * 1_000)
        }
        let result = try await tools.invoke("save_draft", arguments: arguments)
        guard let savedID = result["draft"]?["_id"]?.stringValue
            ?? result["draft"]?["id"]?.stringValue else {
            throw BackendError.invalidResponse
        }
        return savedID
    }

    func deleteDraft(id: String) async throws {
        _ = try await tools.invoke("delete_draft", arguments: ["id": .string(id)])
    }

    func draftCompose(
        accountID: String,
        threadID: String?,
        to: String,
        subject: String,
        currentBody: String
    ) async throws -> String {
        if let threadID, !threadID.isEmpty {
            let result = try await tools.invoke(
                "draft_reply",
                arguments: [
                    "account": .string(accountID),
                    "threadId": .string(threadID),
                    "instructions": currentBody.isEmpty ? .string("Draft a concise response.") : .string(currentBody),
                ]
            )
            guard let draft = result["draft"]?.stringValue, !draft.isEmpty else {
                throw BackendError.invalidResponse
            }
            return draft
        }
        let result = try await backend.post(
            path: "/api/compose/draft",
            body: .object([
                "account": .string(accountID),
                "to": .string(to),
                "subject": .string(subject),
                "instructions": .string(currentBody),
            ])
        )
        guard let draft = result["draft"]?.stringValue, !draft.isEmpty else {
            throw BackendError.invalidResponse
        }
        return draft
    }

    func createEvent(accountID: String, title: String, start: Date, end: Date, sourceThread: ThreadRoute?) async throws {
        let iso = ISO8601DateFormatter()
        var arguments: [String: JSONValue] = [
            "account": .string(accountID),
            "title": .string(title),
            "startIso": .string(iso.string(from: start)),
            "endIso": .string(iso.string(from: end)),
            "allDay": .bool(false),
            "attendees": .array([]),
            "busy": .bool(true),
        ]
        if let sourceThread {
            arguments["description"] = .string("Created from Lab86 Mail thread \(sourceThread.threadID)")
        }
        let result = try await tools.invoke("calendar_create_event", arguments: arguments)
        captureUndoNotice(result, summary: "Created “\(title)”")
        await refreshToday()
        noteCalendarMutation(eventID: result["eventId"]?.stringValue)
    }

    func createEvent(
        accountID: String,
        calendarID: String?,
        title: String,
        start: Date,
        end: Date,
        allDay: Bool,
        location: String?,
        description: String?,
        attendeeEmails: [String] = [],
        recurrence: [String]? = nil
    ) async throws {
        // All-day events travel as date-only strings with an exclusive end;
        // `end` is the editor's inclusive last day (CAL-4).
        var arguments = EventWriteFields.timeArguments(start: start, end: end, allDay: allDay)
        arguments.merge([
            "account": .string(accountID),
            "title": .string(title),
            "attendees": .array(
                attendeeEmails.map { .object(["email": .string($0)]) }
            ),
            "busy": .bool(true),
        ]) { _, new in new }
        if let calendarID, !calendarID.isEmpty { arguments["calendarId"] = .string(calendarID) }
        if let location, !location.isEmpty { arguments["location"] = .string(location) }
        if let description, !description.isEmpty { arguments["description"] = .string(description) }
        if let recurrence { arguments["recurrence"] = .array(recurrence.map(JSONValue.string)) }
        let result = try await tools.invoke("calendar_create_event", arguments: arguments)
        captureUndoNotice(result, summary: "Created “\(title)”")
        await refreshCalendar(sync: false)
        noteCalendarMutation(eventID: result["eventId"]?.stringValue)
    }

    func updateEvent(
        accountID: String,
        calendarID: String,
        eventID: String,
        title: String?,
        start: Date?,
        end: Date?,
        allDay: Bool?,
        location: String?,
        description: String?,
        attendeeEmails: [String]?,
        recurrence: [String]?
    ) async throws {
        let iso = ISO8601DateFormatter()
        var arguments: [String: JSONValue] = [
            "account": .string(accountID),
            "calendarId": .string(calendarID),
            "eventId": .string(eventID),
        ]
        if let title { arguments["title"] = .string(title) }
        if let start { arguments["startIso"] = .string(iso.string(from: start)) }
        if let end { arguments["endIso"] = .string(iso.string(from: end)) }
        if let allDay { arguments["allDay"] = .bool(allDay) }
        if let location { arguments["location"] = .string(location) }
        if let description { arguments["description"] = .string(description) }
        if let attendeeEmails {
            arguments["attendees"] = .array(
                attendeeEmails.map { .object(["email": .string($0)]) }
            )
        }
        if let recurrence { arguments["recurrence"] = .array(recurrence.map(JSONValue.string)) }
        let result = try await tools.invoke("calendar_update_event", arguments: arguments)
        captureUndoNotice(result, summary: "Updated calendar event")
        await refreshCalendar(sync: false)
        noteCalendarMutation(eventID: nil)
    }

    /// Sends only the given changes, keyed as `calendar_update_event` reads
    /// them (CAL-2).
    func updateEvent(
        accountID: String,
        calendarID: String,
        eventID: String,
        changes: [String: JSONValue]
    ) async throws {
        var arguments = changes
        arguments["account"] = .string(accountID)
        arguments["calendarId"] = .string(calendarID)
        arguments["eventId"] = .string(eventID)
        let result = try await tools.invoke("calendar_update_event", arguments: arguments)
        captureUndoNotice(result, summary: "Updated calendar event")
        await refreshCalendar(sync: false)
        noteCalendarMutation(eventID: nil)
    }

    func rescheduleEvent(_ event: CalendarEventSummary, start: Date, end: Date) async {
        guard let calendarID = event.calendarID else {
            calendarError = "This event cannot be moved until its calendar finishes syncing."
            return
        }
        do {
            try await updateEvent(
                accountID: event.accountID,
                calendarID: calendarID,
                eventID: event.id,
                title: nil,
                start: start,
                end: end,
                allDay: event.allDay,
                location: nil,
                description: nil,
                attendeeEmails: nil,
                recurrence: nil
            )
        } catch {
            calendarError = error.localizedDescription
        }
    }

    func deleteEvent(
        accountID: String,
        calendarID: String,
        eventID: String,
        deleteSeries: Bool = false
    ) async throws {
        let result = try await tools.invoke(
            "calendar_delete_event",
            arguments: [
                "account": .string(accountID),
                "calendarId": .string(calendarID),
                "eventId": .string(eventID),
                "deleteSeries": .bool(deleteSeries),
            ]
        )
        captureUndoNotice(result, summary: "Deleted calendar event")
        // Deleted events fade at once.
        withAnimation(.easeInOut(duration: 0.18)) {
            events.removeAll { $0.id == eventID && $0.accountID == accountID }
        }
        pendingCalendarEventCreations.removeValue(forKey: eventID)
        await refreshCalendar(sync: false)
        noteCalendarMutation(eventID: nil)
    }

    func refreshCalendarChoices() async {
        do {
            let result = try await tools.invoke("calendar_list_calendars")
            calendarChoices = (result["calendars"]?.arrayValue ?? []).compactMap(CalendarChoice.init)
            calendarUnauthorizedAccountIDs = Set(
                (result["syncStates"]?.arrayValue ?? []).compactMap { state in
                    state["status"]?.stringValue == "unauthorized"
                        ? state["accountId"]?.stringValue
                        : nil
                }
            )
        } catch {
            calendarError = error.localizedDescription
        }
    }

    /// Takes back every operation of the shown notice, newest first. "Undone"
    /// reads only after the server confirms each inverse ran.
    func undoLatestOperation() async {
        guard let notice = undoNotice else { return }
        undoNoticeExpiry?.cancel()
        undoNoticeExpiry = nil
        do {
            for operationID in notice.operationIDs.reversed() {
                _ = try await tools.invoke(
                    "undo_operation",
                    arguments: ["operationId": .string(operationID)]
                )
            }
            if undoNotice?.id == notice.id { undoNotice = nil }
            switch notice.kind {
            case .mail:
                // The rows come back at once; the server copy follows.
                for operationID in notice.operationIDs.reversed() {
                    mailUndoRollBacks.removeValue(forKey: operationID)?()
                }
                PlatformAccessibility.announce("Undone")
                await refreshMail()
            case .general:
                await refreshToday()
                await refreshWork()
            }
        } catch {
            if undoNotice?.id == notice.id { undoNotice = nil }
            switch notice.kind {
            case .mail: recordMail(error)
            case .general: errorMessage = error.localizedDescription
            }
        }
    }

    /// Shows an undo notice and takes it down after `undoNoticeLifetime`,
    /// unless a newer notice replaced it first.
    func showUndoNotice(_ notice: UndoableOperationNotice) {
        undoNotice = notice
        undoNoticeExpiry?.cancel()
        let lifetime = undoNoticeLifetime
        undoNoticeExpiry = Task { [weak self] in
            try? await Task.sleep(for: lifetime)
            guard !Task.isCancelled, let self, self.undoNotice?.id == notice.id else { return }
            self.undoNotice = nil
        }
    }

    /// A mail change a tool recorded outside the list actions, such as a
    /// block: one notice whose Undo takes back every operation.
    func noteMailOperations(_ operationIDs: [String?], summary: String) {
        let ids = operationIDs.compactMap { $0?.nilIfBlank }
        guard let first = ids.first else { return }
        mailUndoRollBacks = [:]
        showUndoNotice(UndoableOperationNotice(id: first, summary: summary, operationIDs: ids, kind: .mail))
    }

    func dismissUndoNotice() {
        undoNoticeExpiry?.cancel()
        undoNoticeExpiry = nil
        undoNotice = nil
    }

    private func captureUndoNotice(
        _ result: JSONValue,
        summary: String,
        kind: UndoableOperationNotice.Kind = .general
    ) {
        if let operationID = result["operationId"]?.stringValue, !operationID.isEmpty {
            if kind == .mail { mailUndoRollBacks = [:] }
            showUndoNotice(UndoableOperationNotice(id: operationID, summary: summary, kind: kind))
        }
    }

    func rsvpEvent(accountID: String, calendarID: String, eventID: String, status: String) async throws {
        _ = try await tools.invoke(
            "calendar_rsvp_event",
            arguments: [
                "account": .string(accountID),
                "calendarId": .string(calendarID),
                "eventId": .string(eventID),
                "status": .string(status),
            ]
        )
        await refreshCalendar(sync: false)
    }

    // Queue a living-brief regeneration and follow the authoritative Convex
    // job row. There is no fixed delay or optimistic "finished" state.
    func queueAreaBriefRefresh(areaID: String) async -> Bool {
        guard let convex else {
            errorMessage = "Live connection unavailable — try again shortly."
            return false
        }
        // The Convex client manages its own internal synchronization; the
        // Sendable annotation just hasn't caught up in the SDK.
        nonisolated(unsafe) let client = convex
        do {
            areaRefreshStates[areaID] = AreaRefreshState(
                phase: .queued,
                progress: "Queued",
                error: nil
            )
            try await client.mutation("albatross:reindexMyAreas", with: ["areaId": areaID])
            areaBriefMonitoringTasks[areaID]?.cancel()
            areaBriefMonitoringTasks[areaID] = Task { [weak self] in
                do {
                    let updates = client.subscribe(
                        to: "albatross:areaIndexStatus",
                        with: [:],
                        yielding: AreaIndexStatusPayload.self
                    ).values
                    for try await payload in updates {
                        guard !Task.isCancelled else { return }
                        guard let run = payload.latestRun, run.areaId == areaID else { continue }
                        let phase = AreaRefreshState.Phase(rawValue: run.status) ?? .running
                        let count = Int(run.scanned ?? run.matched ?? 0)
                        self?.areaRefreshStates[areaID] = AreaRefreshState(
                            phase: phase,
                            progress: phase == .running ? "Refreshing · \(count.formatted()) checked" : phase.rawValue.capitalized,
                            error: run.error
                        )
                        if phase == .done {
                            _ = try? await self?.loadAreaDetail(areaID)
                            return
                        }
                        if phase == .error { return }
                    }
                } catch is CancellationError {
                    return
                } catch {
                    self?.areaRefreshStates[areaID] = AreaRefreshState(
                        phase: .error,
                        progress: nil,
                        error: error.localizedDescription
                    )
                }
            }
            return true
        } catch {
            areaRefreshStates[areaID] = AreaRefreshState(
                phase: .error,
                progress: nil,
                error: error.localizedDescription
            )
            errorMessage = error.localizedDescription
            return false
        }
    }

    // Set an area's custom picture — same Convex mutation the desktop area
    // editor uses (URL-based; there is no upload flow for area imagery).
    func setAreaImage(areaID: String, imageURL: String) async -> Bool {
        guard let convex else {
            errorMessage = "Live connection unavailable — try again shortly."
            return false
        }
        nonisolated(unsafe) let client = convex
        do {
            try await client.mutation(
                "albatross:updateArea",
                with: ["areaId": areaID, "imageUrl": imageURL]
            )
            _ = try? await loadAreaDetail(areaID)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func uploadAreaImage(areaID: String, attachment: ComposeAttachment) async -> Bool {
        guard let convex else {
            errorMessage = "Live connection unavailable — try again shortly."
            return false
        }
        do {
            let uploaded = try await backend.postMultipart(
                path: "/api/agent/uploads",
                fields: [:],
                files: [
                    MultipartFile(
                        fieldName: "files",
                        filename: attachment.filename,
                        contentType: attachment.contentType,
                        data: attachment.data
                    ),
                ]
            )
            guard let uploadID = uploaded["uploads"]?.arrayValue?.first?["uploadId"]?.stringValue else {
                throw BackendError.invalidResponse
            }
            nonisolated(unsafe) let client = convex
            try await client.mutation(
                "albatross:setAreaImage",
                with: ["areaId": areaID, "uploadId": uploadID]
            )
            _ = try? await loadAreaDetail(areaID)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func updateArea(
        areaID: String,
        name: String,
        kind: String,
        primaryDomain: String,
        imageURL: String
    ) async -> Bool {
        do {
            _ = try await backend.post(
                path: "/api/albatross/areas",
                body: .object([
                    "action": .string("update_area"),
                    "areaId": .string(areaID),
                    "name": .string(name),
                    "kind": .string(kind),
                    "primaryDomain": .string(primaryDomain),
                    "imageUrl": .string(imageURL),
                ])
            )
            _ = try? await loadAreaDetail(areaID)
            await refreshWork()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Creates an Area (or revives an archived one with the same name) and
    /// returns its id. Shared by the iOS sidebar and the Mac source list
    /// (NAT-9).
    @discardableResult
    func createArea(name: String) async -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        do {
            let result = try await backend.post(
                path: "/api/albatross/areas",
                body: .object([
                    "action": .string("create_area"),
                    "name": .string(String(trimmed.prefix(120))),
                ])
            )
            guard let areaID = result["areaId"]?.stringValue?.nilIfBlank else {
                throw BackendError.server(
                    status: 500,
                    message: result["error"]?.stringValue ?? "The area could not be created."
                )
            }
            await refreshWork()
            return areaID
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func archiveArea(areaID: String) async -> Bool {
        do {
            _ = try await backend.post(
                path: "/api/albatross/areas",
                body: .object([
                    "action": .string("archive_area"),
                    "areaId": .string(areaID),
                ])
            )
            areaDetails.removeValue(forKey: areaID)
            await refreshWork()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func mutateAreaMail(
        _ rows: [AreaDetail.MailRow],
        action: String,
        category: String? = nil
    ) async -> Bool {
        do {
            for row in rows {
                let toolName: String
                var arguments: [String: JSONValue] = [
                    "account": .string(row.accountID),
                    "threadId": .string(row.threadID),
                ]
                switch action {
                case "archive":
                    toolName = "archive_thread"
                case "trash":
                    toolName = "trash_thread"
                case "remove_area":
                    guard let linkID = row.linkID else {
                        throw BackendError.invalidResponse
                    }
                    toolName = "area_artifact_set_status"
                    arguments = [
                        "linkId": .string(linkID),
                        "status": .string("rejected"),
                        "reason": .string("Removed from the Area by the user on iOS."),
                    ]
                default:
                    toolName = "apply_smart_correction"
                    arguments["action"] = .string("move_to")
                    arguments["scope"] = .string("thread")
                    arguments["category"] = .string(category ?? "main")
                }
                _ = try await tools.invoke(toolName, arguments: arguments)
            }
            return true
        } catch {
            recordMail(error)
            return false
        }
    }

    // Verify or retire a candidate fact from an Area's Context section.
    func setAreaFactStatus(areaID: String, factID: String, status: String) async {
        do {
            _ = try await tools.invoke(
                "area_fact_set_status",
                arguments: ["factId": .string(factID), "status": .string(status)]
            )
            _ = try? await loadAreaDetail(areaID)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func analyzeCapture(_ text: String) async throws -> [CaptureSuggestion] {
        let response = try await backend.post(
            path: "/api/albatross/capture/analyze",
            body: .object(["rawText": .string(text)])
        )
        guard response["ok"]?.boolValue == true else {
            throw BackendError.server(
                status: 500,
                message: response["error"]?.stringValue ?? "Capture analysis failed."
            )
        }
        return (response["work"]?.arrayValue ?? []).compactMap(CaptureSuggestion.init)
    }

    func capture(
        _ text: String,
        reviewedItems: [CaptureSuggestion]? = nil,
        transcript: String? = nil,
        location: (latitude: Double, longitude: Double)? = nil
    ) async throws -> String? {
        var body: [String: JSONValue] = [
            "rawText": .string(text),
            "source": .string(transcript == nil ? "text" : "voice"),
            "timezone": .string(TimeZone.current.identifier),
        ]
        if let transcript { body["transcript"] = .string(transcript) }
        if let reviewedItems {
            body["reviewedItems"] = .array(
                reviewedItems.map {
                    .object(["title": .string($0.title), "rawText": .string($0.rawText)])
                }
            )
        }
        let response = try await backend.post(
            path: "/api/albatross/capture",
            body: .object(body)
        )
        guard response["ok"]?.boolValue == true else {
            throw BackendError.server(status: 500, message: response["error"]?.stringValue ?? "Capture failed.")
        }
        // Capture only records the intent; planning starts on an explicit
        // advance (the same call the desktop workbench makes). Kick each
        // captured Work forward so a phone capture doesn't sit unplanned.
        let workIDs = (response["workIds"]?.arrayValue ?? []).compactMap(\.stringValue)
        var planningFailures = 0
        for workID in workIDs {
            var advanceBody: [String: JSONValue] = [
                "timezone": .string(TimeZone.current.identifier),
            ]
            if let location {
                advanceBody["geo"] = .object([
                    "latitude": .number(location.latitude),
                    "longitude": .number(location.longitude),
                ])
            }
            do {
                _ = try await backend.post(
                    path: "/api/albatross/work/\(workID)/advance",
                    body: .object(advanceBody)
                )
            } catch {
                planningFailures += 1
            }
        }
        await refreshWork()
        if planningFailures > 0 {
            return "Work was saved, but planning could not start for \(planningFailures) item\(planningFailures == 1 ? "" : "s"). Open Work and try Continue."
        }
        return nil
    }

    func approve(_ approval: ApprovalSummary) async {
        do {
            _ = try await tools.invoke(
                "albatross_approve_action",
                arguments: ["approvalId": .string(approval.id)]
            )
            await refreshToday()
        } catch { record(error) }
    }

    func reject(_ approval: ApprovalSummary, reason: String = "Dismissed on iPhone") async {
        do {
            _ = try await tools.invoke(
                "albatross_reject_action",
                arguments: ["approvalId": .string(approval.id), "reason": .string(reason)]
            )
            await refreshToday()
        } catch { record(error) }
    }

    func actOnSuggestion(id: String, action: String) async {
        do {
            let result = try await backend.post(
                path: "/api/suggestions/act",
                body: .object([
                    "suggestionId": .string(id),
                    "action": .string(action),
                ])
            )
            guard result["ok"]?.boolValue == true else {
                throw BackendError.server(status: 500, message: result["error"]?.stringValue ?? "Suggestion failed.")
            }
            suggestions.removeAll { $0.id == id }
            await persistCache()
            if action == "accept" { await refreshToday() }
        } catch { record(error) }
    }

    func answerCheckin(
        promptKind: String,
        responseText: String,
        completed: [CheckinCandidateSummary]
    ) async throws {
        guard let checkin else { return }
        let completedJSON = completed.map { candidate in
            JSONValue.object([
                "kind": .string(candidate.kind),
                "id": .string(candidate.sourceID),
            ])
        }
        let response = try await backend.post(
            path: "/api/albatross/checkin/\(checkin.id)/answer",
            body: .object([
                "promptKind": .string(promptKind),
                "responseText": .string(responseText),
                "completed": .array(completedJSON),
                "timezone": .string(TimeZone.current.identifier),
            ])
        )
        try applyCheckinAnswerResponse(response)
        await persistCache()
        await refreshToday()
    }

    /// The API acknowledges the durable write, not the slower background work.
    func applyCheckinAnswerResponse(_ response: JSONValue) throws {
        guard response["ok"]?.boolValue == true else {
            throw BackendError.server(status: 500, message: response["error"]?.stringValue ?? "Check-in failed.")
        }
        if response["status"]?.stringValue == "answered" {
            self.checkin = nil
        }
    }

    func clearError() { errorMessage = nil }
    func clearMailError() { mailErrorMessage = nil }

    func clearForSignOut() async {
        // Invalidate every suspended account-owned request before the first await.
        accountSessionGeneration += 1
        workProjectionGeneration += 1
        liveMailTask?.cancel()
        liveMailTask = nil
        for task in areaBriefMonitoringTasks.values { task.cancel() }
        areaBriefMonitoringTasks = [:]
        areaRefreshStates = [:]
        if let cacheOwner {
            await spotlight.remove(owner: cacheOwner)
            try? await cache.remove(owner: cacheOwner)
        }
        cacheOwner = nil
        accounts = []
        reconnectAccounts = []
        threads = []
        resetMailScopes()
        mailLabels = []
        searchedThreads = []
        completedMailSearchQuery = nil
        isSearchingMail = false
        mailSearchGeneration += 1
        projectPaneSessionGeneration += 1
        projectPanes = [:]
        projectPaneLoadGeneration = [:]
        events = []
        calendarChoices = []
        calendarUnauthorizedAccountIDs = []
        dueCalendarTasks = []
        tasks = []
        areas = []
        approvals = []
        suggestions = []
        checkin = nil
        dailyBrief = nil
        dailyReport = nil
        latestDailyReportID = nil
        briefSources = nil
        areaDetails = [:]
        workDetails = [:]
        allWork = []
        laterWork = []
        workExecution = WorkExecutionSnapshot(json: nil)
        errorMessage = nil
        mailErrorMessage = nil
        calendarError = nil
        isSyncingCalendar = false
        calendarDidLoad = false
        calendarSyncFollowTask?.cancel()
        calendarSyncFollowTask = nil
        calendarSync = CalendarSyncState()
        pendingCalendarEventCreations = [:]
        briefError = nil
        workError = nil
        workProjectionLoads = 0
        isLoadingWork = false
        workDidLoad = false
        tasksDidLoad = false
        taskError = nil
        isLoadingTasks = false
        mailStateOverrides = [:]
        suppressedMailThreads = []
        snoozedMailThreads = [:]
        pendingMailCommands = [:]
        snoozedThreads = []
        isLoadingSnoozed = false
        snoozedDidLoad = false
        snoozedError = nil
        lastRefresh = nil
        dismissUndoNotice()
        mailUndoRollBacks = [:]
    }

    private func record(_ error: Error) {
        if errorMessage == nil { errorMessage = error.localizedDescription }
    }

    private func recordMail(_ error: Error) {
        if let backendError = error as? BackendError,
           case .unauthorized = backendError {
            // Authentication is an app-wide boundary failure. Keep it out of
            // the Mail-specific presenter so bootstrap cannot try to display
            // both alerts for the same rejected Clerk session.
            record(error)
            return
        }
        if mailErrorMessage == nil { mailErrorMessage = error.localizedDescription }
    }

    private static func nonBlank(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func startLiveMail() {
        guard liveMailTask == nil, let convex else { return }
        liveMailTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let updates = convex.subscribe(
                        to: "liveMail:listThreads",
                        with: ["limit": 200.0],
                        yielding: LiveMailThreadsPayload.self
                    ).values
                    for try await payload in updates {
                        guard !Task.isCancelled else { return }
                        await self?.applyLiveMail(payload)
                    }
                } catch is CancellationError {
                    return
                } catch {
                    // Convex owns reconnection once subscribed. If auth rotated
                    // before subscription began, retry without disrupting cached mail.
                    try? await Task.sleep(for: .seconds(2))
                }
            }
        }
    }

    func applyLiveMail(_ payload: LiveMailThreadsPayload) async {
        let live = payload.items.map(\.summary).compactMap(applyPendingMailState)
        // An empty live window says nothing about mail that was paged in
        // beneath it; replacing the list here would blank the inbox on one
        // empty tick while the cursor still described a partially paged list.
        guard !live.isEmpty else { return }
        // The live query owns its recency window; threads paged in beneath it
        // must survive each tick or Load More would visibly undo itself.
        let liveKeys = Set(live.map(mailKey))
        let oldestLive = live.map(\.date).min() ?? .distantPast
        let pagedTail = threads.filter { !liveKeys.contains(mailKey($0)) && $0.date < oldestLive }
        threads = (live + pagedTail).sorted { $0.date > $1.date }
        await persistCache()
        await syncMailIndex()
    }

    private func mailKey(_ thread: MailThreadSummary) -> String {
        mailKey(accountID: thread.accountID, threadID: thread.id)
    }

    private func mailKey(accountID: String, threadID: String) -> String {
        "\(accountID):\(threadID)"
    }

    // True while a pending archive, trash, or snooze keeps the thread off the lists.
    private func isHiddenByMailAction(_ thread: MailThreadSummary) -> Bool {
        let key = mailKey(thread)
        if suppressedMailThreads.contains(key) { return true }
        if let until = snoozedMailThreads[key] { return until > Date.now }
        return false
    }

    private func applyPendingMailState(_ incoming: MailThreadSummary) -> MailThreadSummary? {
        let key = mailKey(incoming)
        guard !suppressedMailThreads.contains(key) else { return nil }
        if let until = snoozedMailThreads[key] {
            if until > Date.now { return nil }
            snoozedMailThreads.removeValue(forKey: key)
        }
        guard var override = mailStateOverrides[key] else { return incoming }
        var result = incoming
        if let unread = override.unread {
            if result.unread == unread { override.unread = nil }
            else { result.unread = unread }
        }
        if let starred = override.starred {
            if result.starred == starred { override.starred = nil }
            else { result.starred = starred }
        }
        if override.isEmpty { mailStateOverrides.removeValue(forKey: key) }
        else { mailStateOverrides[key] = override }
        return result
    }

    private func setUnread(_ unread: Bool, accountID: String, threadID: String) {
        if let index = threads.firstIndex(where: { $0.id == threadID && $0.accountID == accountID }) {
            threads[index].unread = unread
        }
        if let index = searchedThreads.firstIndex(where: { $0.id == threadID && $0.accountID == accountID }) {
            searchedThreads[index].unread = unread
        }
    }

    private func setStarredLocally(_ starred: Bool, accountID: String, threadID: String) {
        if let index = threads.firstIndex(where: { $0.id == threadID && $0.accountID == accountID }) {
            threads[index].starred = starred
        }
        if let index = searchedThreads.firstIndex(where: { $0.id == threadID && $0.accountID == accountID }) {
            searchedThreads[index].starred = starred
        }
    }

    private func removeThreadOptimistically(
        accountID: String,
        threadID: String
    ) -> (inbox: (index: Int, thread: MailThreadSummary)?, search: (index: Int, thread: MailThreadSummary)?) {
        var inbox: (index: Int, thread: MailThreadSummary)?
        var search: (index: Int, thread: MailThreadSummary)?
        if let index = threads.firstIndex(where: { $0.id == threadID && $0.accountID == accountID }) {
            inbox = (index, threads.remove(at: index))
        }
        if let index = searchedThreads.firstIndex(where: { $0.id == threadID && $0.accountID == accountID }) {
            search = (index, searchedThreads.remove(at: index))
        }
        return (inbox, search)
    }

    private func restoreThread(
        _ removed: (inbox: (index: Int, thread: MailThreadSummary)?, search: (index: Int, thread: MailThreadSummary)?)
    ) {
        if let inbox = removed.inbox,
           !threads.contains(where: { $0.id == inbox.thread.id && $0.accountID == inbox.thread.accountID }) {
            threads.insert(inbox.thread, at: min(inbox.index, threads.endIndex))
        }
        if let search = removed.search,
           !searchedThreads.contains(where: { $0.id == search.thread.id && $0.accountID == search.thread.accountID }) {
            searchedThreads.insert(search.thread, at: min(search.index, searchedThreads.endIndex))
        }
    }

    private func restoreCache(owner: String) async {
        guard let snapshot = try? await cache.load(owner: owner) else { return }
        accounts = snapshot.accounts
        // A mail action still in the outbox keeps its thread off the list.
        threads = snapshot.threads.filter { !isHiddenByMailAction($0) }
        events = snapshot.events
        tasks = snapshot.tasks
        areas = snapshot.areas
        approvals = snapshot.approvals
        suggestions = snapshot.suggestions
        checkin = snapshot.checkin
        dailyBrief = snapshot.dailyBrief
        dailyReport = snapshot.dailyReport
        areaDetails = snapshot.areaDetails ?? [:]
        workDetails = snapshot.workDetails ?? [:]
        allWork = snapshot.allWork ?? []
        laterWork = WorkGrouping.split(allWork, now: .now).later
        workExecution = snapshot.workExecution ?? WorkExecutionSnapshot(json: nil)
        // A nonempty cached Area list is immediately useful: treat it as last-good
        // so Work shows the list (not a loading/empty state) before the first
        // server refresh completes.
        if !areas.isEmpty { workDidLoad = true }
        if !tasks.isEmpty { tasksDidLoad = true }
        lastRefresh = snapshot.savedAt
        await syncMailIndex()
    }

    private func syncMailIndex() async {
        guard let cacheOwner else { return }
        await spotlight.replace(owner: cacheOwner, accounts: accounts, threads: threads)
    }

    private func persistCache() async {
        guard let cacheOwner else { return }
        let snapshot = ProductSnapshot(
            accounts: accounts,
            threads: threads,
            events: events,
            tasks: tasks,
            areas: areas,
            approvals: approvals,
            suggestions: suggestions,
            checkin: checkin,
            dailyBrief: dailyBrief,
            dailyReport: dailyReport,
            areaDetails: areaDetails,
            workDetails: workDetails,
            allWork: allWork,
            workExecution: workExecution,
            savedAt: .now
        )
        try? await cache.save(snapshot, owner: cacheOwner)
    }

    private static func briefText(from report: JSONValue?) -> String? {
        guard let report else { return nil }
        return report["summary"]?.stringValue
            ?? report["title"]?.stringValue
            ?? report["sections"]?["summary"]?.stringValue
            ?? report["sections"]?["overview"]?.stringValue
    }
}


// The body of `POST /api/albatross/proof-matches/dismissals`: one pair for
// each Work the offer showed, at most one batch.
enum ProofDismissalRequest {
    static let path = "/api/albatross/proof-matches/dismissals"
    static let batchLimit = 100

    static func body(accountID: String, threadID: String, workIDs: [String]) -> JSONValue? {
        guard let account = accountID.nilIfBlank, let thread = threadID.nilIfBlank else { return nil }
        var seen = Set<String>()
        let ids = workIDs.compactMap(\.nilIfBlank).filter { seen.insert($0).inserted }.prefix(batchLimit)
        guard !ids.isEmpty else { return nil }
        return .object([
            "dismissals": .array(ids.map { workID in
                JSONValue.object([
                    "accountId": .string(account),
                    "providerThreadId": .string(thread),
                    "workId": .string(workID),
                ])
            }),
        ])
    }
}

// Pure rule for the "latest edition" state (brief round 2026-09-22). No
// known latest id means the app has not asked yet; the shown edition then
// counts as latest so inactive hiding stays on.
enum DailyReportSelection {
    static func isLatest(shownID: String?, latestID: String?) -> Bool {
        guard let latestID else { return true }
        guard let shownID else { return true }
        return shownID == latestID
    }
}
