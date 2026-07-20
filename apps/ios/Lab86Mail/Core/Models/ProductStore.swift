import Combine
import ConvexMobile
import Foundation
import Observation

@MainActor
@Observable
final class ProductStore {
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
    private var cacheOwner: String?
    private var liveMailTask: Task<Void, Never>?
    private var mailStateOverrides: [String: MailStateOverride] = [:]
    private var suppressedMailThreads: Set<String> = []

    var accounts: [AccountSummary] = []
    var threads: [MailThreadSummary] = []
    var searchedThreads: [MailThreadSummary] = []
    var completedMailSearchQuery: String?
    var isSearchingMail = false
    var events: [CalendarEventSummary] = []
    var tasks: [TaskSummary] = []
    // Ordered column names of the active board, for grouping and move targets.
    var taskColumns: [String] = []
    // All of the user's boards (owned + shared) and the one the Tasks surface
    // is currently showing; nil = the default Personal board.
    var taskBoards: [TaskBoardSummary] = []
    var activeBoardID: String?
    var projects: [ProjectSummary] = []
    var areas: [AreaSummary] = []
    var approvals: [ApprovalSummary] = []
    var suggestions: [SuggestionSummary] = []
    var checkin: CheckinSummary?
    // Typed edition owns html/status/progress/sections; `dailyBrief` stays only
    // as the legacy migration/fallback string.
    var dailyReport: DailyReportModel?
    var dailyBrief: String?
    var isLoading = false
    var errorMessage: String?
    var mailErrorMessage: String?
    // Domain-local surfaces so a calendar or brief failure never blanks healthy
    // Mail or raises the app-wide alert.
    var calendarError: String?
    var isSyncingCalendar = false
    var calendarDidLoad = false
    var briefError: String?
    // Work is its own data owner too: a failed `area_list` keeps the last-good
    // (cached) areas readable, records the message only in `workError`, and never
    // blanks Mail or raises the app-wide alert. `workDidLoad` distinguishes a
    // genuine empty result from "haven't successfully loaded yet".
    var workError: String?
    var isLoadingWork = false
    var workDidLoad = false
    var lastRefresh: Date?
    // Immediate/offline read cache of opened area homes, keyed by area id. Never
    // a substitute for the authoritative server read — only what was last seen.
    private(set) var areaDetails: [String: AreaDetail] = [:]
    private(set) var workDetails: [String: WorkDetail] = [:]
    private var mailSearchGeneration = 0

    init(
        tools: any ToolInvoking,
        backend: BackendClient,
        convex: ConvexClientWithAuth<String>? = nil,
        cache: ProductCache = .shared,
        spotlight: any MailSpotlightIndexing = MailSpotlightIndexer.shared
    ) {
        self.tools = tools
        self.backend = backend
        self.convex = convex
        self.cache = cache
        self.spotlight = spotlight
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
            let refreshedAccounts = (result["accounts"]?.arrayValue ?? []).compactMap(AccountSummary.init)
            accounts = refreshedAccounts
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
            await persistCache()
            await syncMailIndex()
            if let firstFailure { recordMail(firstFailure) }
        } catch {
            recordMail(error)
        }
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
            tasks = (board?["cards"]?.arrayValue ?? []).compactMap { card in
                TaskSummary(json: card, column: columnNames[card["columnId"]?.stringValue ?? ""] ?? "Tasks")
            }.sorted {
                if $0.completed != $1.completed { return !$0.completed }
                return ($0.due ?? .distantFuture) < ($1.due ?? .distantFuture)
            }
        } catch { record(error) }

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
            dailyBrief = report?.legacyText ?? Self.briefText(from: result["report"])
            await persistCache()
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
        } catch {
            errorMessage = error.localizedDescription
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
        completed: Bool
    ) async -> Bool {
        var arguments: [String: JSONValue] = [
            "cardId": .string(task.id),
            "title": .string(title),
            "description": .string(details),
            "completed": .bool(completed),
            "dueIso": due.map { .string($0.formatted(.iso8601)) } ?? .null,
        ]
        if let priority { arguments["priority"] = .string(priority) }
        do {
            _ = try await tools.invoke("tasks_update_card", arguments: arguments)
            await refreshTasks()
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
        } catch {
            errorMessage = error.localizedDescription
            await refreshTasks()
        }
    }

    func switchBoard(to boardID: String?) async {
        activeBoardID = boardID
        await refreshTasks()
    }

    func refreshBoardsAndProjects() async {
        if let result = try? await tools.invoke("tasks_list_boards") {
            taskBoards = (result["boards"]?.arrayValue ?? []).compactMap(TaskBoardSummary.init)
        }
        if let result = try? await tools.invoke(
            "albatross_list_projects",
            arguments: ["status": .string("active"), "limit": .number(100)]
        ) {
            projects = (result["projects"]?.arrayValue ?? []).compactMap(ProjectSummary.init)
        }
    }

    // Board-only reload — cheaper than refreshToday after a card mutation.
    private func refreshTasks() async {
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
            tasks = (board?["cards"]?.arrayValue ?? []).compactMap { card in
                TaskSummary(json: card, column: columnNames[card["columnId"]?.stringValue ?? ""] ?? "Tasks")
            }.sorted {
                if $0.completed != $1.completed { return !$0.completed }
                return ($0.due ?? .distantFuture) < ($1.due ?? .distantFuture)
            }
            await persistCache()
        } catch {
            // A failed reload keeps the optimistic state; the next refreshToday settles it.
        }
    }

    func refreshWork() async {
        isLoadingWork = true
        defer { isLoadingWork = false }
        do {
            let result = try await tools.invoke("area_list", arguments: ["status": .string("active")])
            areas = (result["areas"]?.arrayValue ?? []).compactMap(AreaSummary.init)
            workDidLoad = true
            workError = nil
            await persistCache()
        } catch {
            // Keep the last-good cached areas visible and record the failure only
            // on the Work surface. A Work failure must never blank Mail or raise
            // the app-wide `errorMessage`.
            workError = error.localizedDescription
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

    func archive(_ thread: MailThreadSummary) async {
        suppressedMailThreads.insert(mailKey(thread))
        let removed = removeThreadOptimistically(thread)
        do {
            _ = try await tools.invoke(
                "archive_thread",
                arguments: ["account": .string(thread.accountID), "threadId": .string(thread.id)]
            )
            await persistCache()
            await syncMailIndex()
        } catch {
            suppressedMailThreads.remove(mailKey(thread))
            restoreThread(removed)
            recordMail(error)
        }
    }

    func markRead(_ thread: MailThreadSummary) async {
        setMailOverride(thread: thread, unread: false)
        let changed = setUnread(false, thread: thread)
        do {
            _ = try await tools.invoke(
                "mark_thread_read",
                arguments: ["account": .string(thread.accountID), "threadId": .string(thread.id)]
            )
            await persistCache()
        } catch {
            clearMailOverride(thread)
            if changed { _ = setUnread(thread.unread, thread: thread) }
            recordMail(error)
        }
    }

    func trash(_ thread: MailThreadSummary) async {
        suppressedMailThreads.insert(mailKey(thread))
        let removed = removeThreadOptimistically(thread)
        do {
            _ = try await tools.invoke(
                "trash_thread",
                arguments: ["account": .string(thread.accountID), "threadId": .string(thread.id)]
            )
            await persistCache()
            await syncMailIndex()
        } catch {
            suppressedMailThreads.remove(mailKey(thread))
            restoreThread(removed)
            recordMail(error)
        }
    }

    func markUnread(_ thread: MailThreadSummary) async {
        setMailOverride(thread: thread, unread: true)
        let changed = setUnread(true, thread: thread)
        do {
            let messageID = try await latestMessageID(accountID: thread.accountID, threadID: thread.id)
            _ = try await tools.invoke(
                "mark_unread",
                arguments: ["account": .string(thread.accountID), "messageId": .string(messageID)]
            )
            await persistCache()
        } catch {
            clearMailOverride(thread)
            if changed { _ = setUnread(thread.unread, thread: thread) }
            recordMail(error)
        }
    }

    func setStarred(_ starred: Bool, thread: MailThreadSummary) async {
        setMailOverride(thread: thread, starred: starred)
        let changed = setStarredLocally(starred, thread: thread)
        do {
            let messageID = try await latestMessageID(accountID: thread.accountID, threadID: thread.id)
            _ = try await tools.invoke(
                starred ? "star" : "unstar",
                arguments: ["account": .string(thread.accountID), "messageId": .string(messageID)]
            )
            await persistCache()
        } catch {
            clearMailOverride(thread)
            if changed { _ = setStarredLocally(thread.starred, thread: thread) }
            recordMail(error)
        }
    }

    func performMailNotificationAction(action: String, accountID: String, threadID: String) async {
        do {
            switch action {
            case "mark_read":
                _ = try await tools.invoke(
                    "mark_thread_read",
                    arguments: ["account": .string(accountID), "threadId": .string(threadID)]
                )
                if let index = threads.firstIndex(where: { $0.id == threadID && $0.accountID == accountID }) {
                    threads[index].unread = false
                }
            case "archive":
                _ = try await tools.invoke(
                    "archive_thread",
                    arguments: ["account": .string(accountID), "threadId": .string(threadID)]
                )
                threads.removeAll { $0.id == threadID && $0.accountID == accountID }
            default:
                return
            }
            await persistCache()
            if action == "archive" { await syncMailIndex() }
        } catch { recordMail(error) }
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
        sendAt: Date? = nil
    ) async throws {
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
        _ = try await backend.postMultipart(
            path: "/api/compose",
            fields: fields,
            files: attachments.map(\.multipart)
        )
        await refreshMail()
    }

    func deleteDraft(id: String) async throws {
        _ = try await tools.invoke("delete_draft", arguments: ["id": .string(id)])
    }

    private func latestMessageID(accountID: String, threadID: String) async throws -> String {
        let result = try await tools.invoke(
            "get_thread",
            arguments: ["account": .string(accountID), "threadId": .string(threadID)]
        )
        guard let message = result["messages"]?.arrayValue?.last,
              let messageID = message["providerMessageId"]?.stringValue
                ?? message["id"]?.stringValue
                ?? message["_id"]?.stringValue else {
            throw BackendError.server(status: 404, message: "The latest message could not be found.")
        }
        return messageID
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
        _ = try await tools.invoke("calendar_create_event", arguments: arguments)
        await refreshToday()
    }

    func createEvent(
        accountID: String,
        title: String,
        start: Date,
        end: Date,
        allDay: Bool,
        location: String?,
        description: String?
    ) async throws {
        let iso = ISO8601DateFormatter()
        var arguments: [String: JSONValue] = [
            "account": .string(accountID),
            "title": .string(title),
            "startIso": .string(iso.string(from: start)),
            "endIso": .string(iso.string(from: end)),
            "allDay": .bool(allDay),
            "attendees": .array([]),
            "busy": .bool(true),
        ]
        if let location, !location.isEmpty { arguments["location"] = .string(location) }
        if let description, !description.isEmpty { arguments["description"] = .string(description) }
        _ = try await tools.invoke("calendar_create_event", arguments: arguments)
        await refreshCalendar(sync: false)
    }

    func updateEvent(
        accountID: String,
        calendarID: String,
        eventID: String,
        title: String?,
        start: Date?,
        end: Date?,
        location: String?
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
        if let location { arguments["location"] = .string(location) }
        _ = try await tools.invoke("calendar_update_event", arguments: arguments)
        await refreshCalendar(sync: false)
    }

    func deleteEvent(accountID: String, calendarID: String, eventID: String) async throws {
        _ = try await tools.invoke(
            "calendar_delete_event",
            arguments: [
                "account": .string(accountID),
                "calendarId": .string(calendarID),
                "eventId": .string(eventID),
            ]
        )
        events.removeAll { $0.id == eventID && $0.accountID == accountID }
        await refreshCalendar(sync: false)
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

    // Snooze resurfaces the thread later via the MailOS/Snoozed label pipeline.
    func snooze(_ thread: MailThreadSummary, until: Date) async {
        do {
            let messageID = try await latestMessageID(accountID: thread.accountID, threadID: thread.id)
            _ = try await tools.invoke(
                "snooze_thread",
                arguments: [
                    "account": .string(thread.accountID),
                    "messageId": .string(messageID),
                    "threadId": .string(thread.id),
                    "untilTs": .number(until.timeIntervalSince1970 * 1_000),
                ]
            )
            suppressedMailThreads.insert(thread.id)
            threads.removeAll { $0.id == thread.id }
            searchedThreads.removeAll { $0.id == thread.id }
        } catch {
            mailErrorMessage = error.localizedDescription
        }
    }

    // Queue a living-brief regeneration for one area — the same Convex mutation
    // the desktop Refresh button uses. Regeneration is asynchronous server-side;
    // callers re-read area_home after a beat.
    func queueAreaBriefRefresh(areaID: String) async -> Bool {
        guard let convex else {
            errorMessage = "Live connection unavailable — try again shortly."
            return false
        }
        // The Convex client manages its own internal synchronization; the
        // Sendable annotation just hasn't caught up in the SDK.
        nonisolated(unsafe) let client = convex
        do {
            try await client.mutation("albatross:reindexMyAreas", with: ["areaId": areaID])
            return true
        } catch {
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

    func capture(_ text: String) async throws {
        let response = try await backend.post(
            path: "/api/albatross/capture",
            body: .object([
                "rawText": .string(text),
                "source": .string("text"),
                "timezone": .string(TimeZone.current.identifier),
            ])
        )
        guard response["ok"]?.boolValue == true else {
            throw BackendError.server(status: 500, message: response["error"]?.stringValue ?? "Capture failed.")
        }
        // Capture only records the intent; planning starts on an explicit
        // advance (the same call the desktop workbench makes). Kick each
        // captured Work forward so a phone capture doesn't sit unplanned.
        let workIDs = (response["workIds"]?.arrayValue ?? []).compactMap(\.stringValue)
        for workID in workIDs {
            Task { [backend] in
                _ = try? await backend.post(
                    path: "/api/albatross/work/\(workID)/advance",
                    body: .object([:])
                )
            }
        }
        await refreshWork()
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

    func answerCheckin(responseText: String, completed: [CheckinCandidateSummary]) async throws {
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
                "responseText": .string(responseText),
                "completed": .array(completedJSON),
            ])
        )
        guard response["ok"]?.boolValue == true else {
            throw BackendError.server(status: 500, message: response["error"]?.stringValue ?? "Check-in failed.")
        }
        self.checkin = nil
        await persistCache()
        await refreshToday()
    }

    func clearError() { errorMessage = nil }
    func clearMailError() { mailErrorMessage = nil }

    func clearForSignOut() async {
        liveMailTask?.cancel()
        liveMailTask = nil
        if let cacheOwner {
            await spotlight.remove(owner: cacheOwner)
            try? await cache.remove(owner: cacheOwner)
        }
        cacheOwner = nil
        accounts = []
        threads = []
        searchedThreads = []
        completedMailSearchQuery = nil
        isSearchingMail = false
        mailSearchGeneration += 1
        events = []
        tasks = []
        areas = []
        approvals = []
        suggestions = []
        checkin = nil
        dailyBrief = nil
        dailyReport = nil
        areaDetails = [:]
        workDetails = [:]
        errorMessage = nil
        mailErrorMessage = nil
        calendarError = nil
        isSyncingCalendar = false
        calendarDidLoad = false
        briefError = nil
        workError = nil
        isLoadingWork = false
        workDidLoad = false
        mailStateOverrides = [:]
        suppressedMailThreads = []
        lastRefresh = nil
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

    private func applyLiveMail(_ payload: LiveMailThreadsPayload) async {
        threads = payload.items.map(\.summary).compactMap(applyPendingMailState).sorted { $0.date > $1.date }
        await persistCache()
        await syncMailIndex()
    }

    private func mailKey(_ thread: MailThreadSummary) -> String {
        "\(thread.accountID):\(thread.id)"
    }

    private func clearMailOverride(_ thread: MailThreadSummary) {
        mailStateOverrides.removeValue(forKey: mailKey(thread))
    }

    private func setMailOverride(
        thread: MailThreadSummary,
        unread: Bool? = nil,
        starred: Bool? = nil
    ) {
        let key = mailKey(thread)
        var override = mailStateOverrides[key] ?? MailStateOverride()
        if let unread { override.unread = unread }
        if let starred { override.starred = starred }
        mailStateOverrides[key] = override
    }

    private func applyPendingMailState(_ incoming: MailThreadSummary) -> MailThreadSummary? {
        let key = mailKey(incoming)
        guard !suppressedMailThreads.contains(key) else { return nil }
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

    @discardableResult
    private func setUnread(_ unread: Bool, thread: MailThreadSummary) -> Bool {
        var changed = false
        if let index = threads.firstIndex(where: { $0.id == thread.id && $0.accountID == thread.accountID }) {
            threads[index].unread = unread
            changed = true
        }
        if let index = searchedThreads.firstIndex(where: { $0.id == thread.id && $0.accountID == thread.accountID }) {
            searchedThreads[index].unread = unread
            changed = true
        }
        return changed
    }

    @discardableResult
    private func setStarredLocally(_ starred: Bool, thread: MailThreadSummary) -> Bool {
        var changed = false
        if let index = threads.firstIndex(where: { $0.id == thread.id && $0.accountID == thread.accountID }) {
            threads[index].starred = starred
            changed = true
        }
        if let index = searchedThreads.firstIndex(where: { $0.id == thread.id && $0.accountID == thread.accountID }) {
            searchedThreads[index].starred = starred
            changed = true
        }
        return changed
    }

    private func removeThreadOptimistically(
        _ thread: MailThreadSummary
    ) -> (inbox: (index: Int, thread: MailThreadSummary)?, search: (index: Int, thread: MailThreadSummary)?) {
        var inbox: (index: Int, thread: MailThreadSummary)?
        var search: (index: Int, thread: MailThreadSummary)?
        if let index = threads.firstIndex(where: { $0.id == thread.id && $0.accountID == thread.accountID }) {
            inbox = (index, threads.remove(at: index))
        }
        if let index = searchedThreads.firstIndex(where: { $0.id == thread.id && $0.accountID == thread.accountID }) {
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
        threads = snapshot.threads
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
        // A nonempty cached Area list is immediately useful: treat it as last-good
        // so Work shows the list (not a loading/empty state) before the first
        // server refresh completes.
        if !areas.isEmpty { workDidLoad = true }
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
