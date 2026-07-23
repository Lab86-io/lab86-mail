import Foundation
import MobileAPI

protocol MobileCommandSubmitting: Sendable {
    func submit(_ snapshot: PendingCommandSnapshot) async throws -> OutboxCommandReceipt
}

enum MobileV1ClientError: LocalizedError, Sendable, Equatable {
    case server(status: Int, code: String, message: String, retryable: Bool)
    case undocumented(status: Int)
    case invalidSyncPayload

    var errorDescription: String? {
        switch self {
        case .server(_, _, let message, _): message
        case .undocumented(let status): "The server returned an unsupported response (\(status))."
        case .invalidSyncPayload: "The server returned sync data for the wrong domain."
        }
    }
}

actor MobileV1Client: MobileCommandSubmitting, MobileBootstrapFetching, MobileSyncFetching {
    private let client: Client

    init(
        baseURL: URL,
        session: URLSession = .shared,
        tokenProvider: @escaping MobileAPITokenProvider
    ) {
        client = MobileAPIClientFactory.make(
            serverURL: baseURL,
            session: session,
            tokenProvider: tokenProvider
        )
    }

    func submit(_ snapshot: PendingCommandSnapshot) async throws -> OutboxCommandReceipt {
        let output = try await client.postMobileCommand(
            body: .json(Self.generatedCommand(from: snapshot))
        )
        switch output {
        case .ok(let response):
            return Self.receipt(from: try response.body.json)
        case .badRequest(let response):
            throw Self.error(from: try response.body.json, status: 400)
        case .unauthorized(let response):
            throw Self.error(from: try response.body.json, status: 401)
        case .conflict(let response):
            throw Self.error(from: try response.body.json, status: 409)
        case .tooManyRequests(let response):
            throw Self.error(from: try response.body.json, status: 429)
        case .internalServerError(let response):
            throw Self.error(from: try response.body.json, status: 500)
        case .undocumented(let status, _):
            throw MobileV1ClientError.undocumented(status: status)
        }
    }

    func fetchBootstrap() async throws -> MobileBootstrapSnapshot {
        let output = try await client.getMobileBootstrap(.init())
        switch output {
        case .ok(let response):
            return Self.bootstrap(from: try response.body.json)
        case .badRequest(let response):
            throw Self.error(from: try response.body.json, status: 400)
        case .unauthorized(let response):
            throw Self.error(from: try response.body.json, status: 401)
        case .conflict(let response):
            throw Self.error(from: try response.body.json, status: 409)
        case .tooManyRequests(let response):
            throw Self.error(from: try response.body.json, status: 429)
        case .internalServerError(let response):
            throw Self.error(from: try response.body.json, status: 500)
        case .undocumented(let status, _):
            throw MobileV1ClientError.undocumented(status: status)
        }
    }

    func fetchSync(domain: MobileDomain, cursor: String?, limit: Int = 200) async throws -> MobileSyncPage {
        let output = try await client.getMobileSync(
            .init(
                query: .init(
                    domain: Self.generatedDomain(domain),
                    cursor: cursor,
                    limit: min(max(limit, 1), 500)
                )
            )
        )
        switch output {
        case .ok(let response):
            return try Self.syncPage(
                from: response.body.json,
                requestedDomain: domain
            )
        case .badRequest(let response):
            throw Self.error(from: try response.body.json, status: 400)
        case .unauthorized(let response):
            throw Self.error(from: try response.body.json, status: 401)
        case .conflict(let response):
            throw Self.error(from: try response.body.json, status: 409)
        case .tooManyRequests(let response):
            throw Self.error(from: try response.body.json, status: 429)
        case .internalServerError(let response):
            throw Self.error(from: try response.body.json, status: 500)
        case .undocumented(let status, _):
            throw MobileV1ClientError.undocumented(status: status)
        }
    }

    private static func bootstrap(
        from value: Components.Schemas.MobileBootstrap
    ) -> MobileBootstrapSnapshot {
        MobileBootstrapSnapshot(
            user: MobileBootstrapUser(
                id: value.user.id,
                email: value.user.email,
                name: value.user.name,
                imageURL: value.user.imageURL.flatMap(URL.init(string:))
            ),
            accounts: value.accounts.map(account),
            featureFlags: value.featureFlags.additionalProperties,
            notificationSettings: MobileNotificationSettings(
                nativePushEnabled: value.notificationSettings.nativePushEnabled,
                newMailPushEnabled: value.notificationSettings.newMailPushEnabled,
                eventSuggestionPushEnabled: value.notificationSettings.eventSuggestionPushEnabled,
                eveningCheckinEnabled: value.notificationSettings.eveningCheckinEnabled
            ),
            cursors: [
                .accounts: value.cursors.accounts,
                .mail: value.cursors.mail,
                .calendar: value.cursors.calendar,
                .tasks: value.cursors.tasks,
                .today: value.cursors.today,
                .work: value.cursors.work,
                .assistant: value.cursors.assistant,
                .activity: value.cursors.activity,
            ],
            serverTime: value.serverTime
        )
    }

    private static func account(
        from value: Components.Schemas.MobileBootstrap.AccountsPayloadPayload
    ) -> MobileAccount {
        MobileAccount(
            id: value.id,
            email: value.email,
            provider: provider(value.provider),
            status: connectionStatus(value.status),
            displayName: value.displayName,
            scopes: value.scopes,
            capabilities: ProviderCapabilities(
                mail: value.capabilities.mail,
                calendar: value.capabilities.calendar,
                contacts: value.capabilities.contacts,
                folders: value.capabilities.folders,
                labels: value.capabilities.labels,
                drafts: value.capabilities.drafts,
                scheduledSend: value.capabilities.scheduledSend,
                push: value.capabilities.push,
                search: value.capabilities.search,
                unsupportedReason: value.capabilities.unsupportedReason
            ),
            sync: MobileAccountSyncState(
                status: syncStatus(value.sync.status),
                corpusReady: value.sync.corpusReady,
                itemsSynced: value.sync.itemsSynced,
                lastSyncedAt: value.sync.lastSyncedAt.map(providerDate),
                error: value.sync.error
            )
        )
    }

    static func syncPage(
        from value: Components.Schemas.SyncEnvelope,
        requestedDomain: MobileDomain
    ) throws -> MobileSyncPage {
        let changes = try value.items.map(syncChange)
        guard changes.allSatisfy({ $0.domain == requestedDomain }) else {
            throw MobileV1ClientError.invalidSyncPayload
        }
        return MobileSyncPage(
            domain: requestedDomain,
            changes: changes,
            deletedIDs: value.deletedIDs,
            cursor: value.cursor,
            serverRevision: value.serverRevision,
            hasMore: value.hasMore
        )
    }

    private static func syncChange(
        from value: Components.Schemas.SyncChange
    ) throws -> MobileSyncChange {
        switch value {
        case .thread(let change):
            return .mailThread(
                MailThreadSyncPatch(
                    entityID: change.entityID,
                    revision: change.revision,
                    accountID: change.payload.accountID,
                    archived: change.payload.archived,
                    trashed: change.payload.trashed,
                    unread: change.payload.unread
                )
            )
        case .message(let change):
            return .mailMessage(
                MailMessageSyncPatch(
                    entityID: change.entityID,
                    revision: change.revision,
                    accountID: change.payload.accountID,
                    unread: change.payload.unread,
                    starred: change.payload.starred
                )
            )
        case .event(let change):
            return .calendarEvent(
                CalendarEventSyncReference(
                    entityID: change.entityID,
                    revision: change.revision,
                    accountID: change.payload.accountID,
                    eventID: change.payload.eventID
                )
            )
        case .task(let change):
            return .task(
                TaskSyncPatch(
                    entityID: change.entityID,
                    revision: change.revision,
                    cardID: change.payload.cardID,
                    title: change.payload.title,
                    completed: change.payload.completed
                )
            )
        case .work(let change):
            return .work(
                WorkSyncReference(
                    entityID: change.entityID,
                    revision: change.revision,
                    captureID: change.payload.captureID,
                    workIDs: change.payload.workIDs,
                    fallback: change.payload.fallback
                )
            )
        case .approval(let change):
            if let requested = change.payload.value1 {
                return .approval(
                    ApprovalSyncPatch(
                        entityID: change.entityID,
                        revision: change.revision,
                        approvalID: requested.approvalID,
                        state: .requested(commandKind: requested.commandKind)
                    )
                )
            }
            if let resolved = change.payload.value2,
               let status = ApprovalResolution(rawValue: resolved.status.rawValue) {
                return .approval(
                    ApprovalSyncPatch(
                        entityID: change.entityID,
                        revision: change.revision,
                        approvalID: resolved.approvalID,
                        state: .resolved(status: status)
                    )
                )
            }
            throw MobileV1ClientError.invalidSyncPayload
        case .operation(let change):
            guard let domain = MobileDomain(rawValue: change.domain.rawValue) else {
                throw MobileV1ClientError.invalidSyncPayload
            }
            return .operation(
                OperationSyncPatch(
                    domain: domain,
                    entityID: change.entityID,
                    revision: change.revision,
                    operationID: change.payload.operationID,
                    undone: change.payload.undone
                )
            )
        }
    }

    private static func generatedDomain(
        _ domain: MobileDomain
    ) -> Operations.GetMobileSync.Input.Query.DomainPayload {
        switch domain {
        case .accounts: .accounts
        case .mail: .mail
        case .calendar: .calendar
        case .tasks: .tasks
        case .today: .today
        case .work: .work
        case .assistant: .assistant
        case .activity: .activity
        }
    }

    private static func provider(
        _ value: Components.Schemas.MobileBootstrap.AccountsPayloadPayload.ProviderPayload
    ) -> ProviderKind {
        switch value {
        case .google: .google
        case .microsoft: .microsoft
        case .icloud: .icloud
        case .imap: .imap
        }
    }

    private static func connectionStatus(
        _ value: Components.Schemas.MobileBootstrap.AccountsPayloadPayload.StatusPayload
    ) -> ProviderConnectionStatus {
        switch value {
        case .connected: .connected
        case .disconnected: .disconnected
        case .error: .error
        }
    }

    private static func syncStatus(
        _ value: Components.Schemas.MobileBootstrap.AccountsPayloadPayload.SyncPayload.StatusPayload
    ) -> AccountSyncStatus {
        switch value {
        case .idle: .idle
        case .backfilling: .backfilling
        case .syncing: .syncing
        case .ready: .ready
        case .error: .error
        }
    }

    private static func providerDate(_ timestamp: Int) -> Date {
        let seconds = timestamp > 10_000_000_000 ? Double(timestamp) / 1_000 : Double(timestamp)
        return Date(timeIntervalSince1970: seconds)
    }

    private static func receipt(from value: Components.Schemas.CommandReceipt) -> OutboxCommandReceipt {
        OutboxCommandReceipt(
            commandID: value.commandID,
            status: status(from: value.status),
            entityRevision: value.entityRevision,
            operationID: value.operationID,
            approvalID: value.approvalID,
            undoExpiresAt: value.undoExpiresAt,
            errorCode: value.recoverableError?.code,
            errorMessage: value.recoverableError?.message,
            retryable: value.recoverableError?.retryable ?? false
        )
    }

    private static func status(
        from value: Components.Schemas.CommandReceipt.StatusPayload
    ) -> OutboxCommandStatus {
        switch value {
        case .queued: .queued
        case .applied: .applied
        case .needsApproval: .needsApproval
        case .conflicted: .conflicted
        case .failed: .failed
        }
    }

    private static func error(
        from envelope: Components.Schemas.MobileErrorEnvelope,
        status: Int
    ) -> MobileV1ClientError {
        .server(
            status: status,
            code: envelope.error.code,
            message: envelope.error.message,
            retryable: envelope.error.retryable
        )
    }

    private static func generatedCommand(
        from snapshot: PendingCommandSnapshot
    ) -> Components.Schemas.MobileCommand {
        switch snapshot.command {
        case .mailArchive(let payload):
            .mail_archive(
                .init(
                    idempotencyKey: snapshot.idempotencyKey,
                    baseRevision: snapshot.baseRevision,
                    clientCreatedAt: snapshot.clientCreatedAt,
                    kind: .mail_archive,
                    payload: .init(accountID: payload.accountID, threadID: payload.threadID)
                )
            )
        case .mailTrash(let payload):
            .mail_trash(
                .init(
                    idempotencyKey: snapshot.idempotencyKey,
                    baseRevision: snapshot.baseRevision,
                    clientCreatedAt: snapshot.clientCreatedAt,
                    kind: .mail_trash,
                    payload: .init(accountID: payload.accountID, threadID: payload.threadID)
                )
            )
        case .mailMarkRead(let payload):
            .mail_markRead(
                .init(
                    idempotencyKey: snapshot.idempotencyKey,
                    baseRevision: snapshot.baseRevision,
                    clientCreatedAt: snapshot.clientCreatedAt,
                    kind: .mail_markRead,
                    payload: .init(accountID: payload.accountID, threadID: payload.threadID)
                )
            )
        case .mailMarkUnread(let payload):
            .mail_markUnread(
                .init(
                    idempotencyKey: snapshot.idempotencyKey,
                    baseRevision: snapshot.baseRevision,
                    clientCreatedAt: snapshot.clientCreatedAt,
                    kind: .mail_markUnread,
                    payload: .init(accountID: payload.accountID, messageID: payload.messageID)
                )
            )
        case .mailStar(let payload):
            .mail_star(
                .init(
                    idempotencyKey: snapshot.idempotencyKey,
                    baseRevision: snapshot.baseRevision,
                    clientCreatedAt: snapshot.clientCreatedAt,
                    kind: .mail_star,
                    payload: .init(accountID: payload.accountID, messageID: payload.messageID)
                )
            )
        case .mailUnstar(let payload):
            .mail_unstar(
                .init(
                    idempotencyKey: snapshot.idempotencyKey,
                    baseRevision: snapshot.baseRevision,
                    clientCreatedAt: snapshot.clientCreatedAt,
                    kind: .mail_unstar,
                    payload: .init(accountID: payload.accountID, messageID: payload.messageID)
                )
            )
        case .calendarCreate(let payload):
            .calendar_create(
                .init(
                    idempotencyKey: snapshot.idempotencyKey,
                    baseRevision: snapshot.baseRevision,
                    clientCreatedAt: snapshot.clientCreatedAt,
                    kind: .calendar_create,
                    payload: .init(
                        accountID: payload.accountID,
                        calendarID: payload.calendarID,
                        title: payload.title,
                        startAt: payload.startAt,
                        endAt: payload.endAt,
                        allDay: payload.allDay,
                        description: payload.description,
                        location: payload.location,
                        attendees: payload.attendees.map {
                            .init(email: $0.email, name: $0.name)
                        },
                        recurrence: payload.recurrence,
                        busy: payload.busy
                    )
                )
            )
        case .taskCreate(let payload):
            .task_create(
                .init(
                    idempotencyKey: snapshot.idempotencyKey,
                    baseRevision: snapshot.baseRevision,
                    clientCreatedAt: snapshot.clientCreatedAt,
                    kind: .task_create,
                    payload: .init(
                        boardID: payload.boardID,
                        column: payload.column,
                        title: payload.title,
                        description: payload.description,
                        priority: taskPriority(payload.priority),
                        dueAt: payload.dueAt
                    )
                )
            )
        case .taskSetCompleted(let payload):
            .task_setCompleted(
                .init(
                    idempotencyKey: snapshot.idempotencyKey,
                    baseRevision: snapshot.baseRevision,
                    clientCreatedAt: snapshot.clientCreatedAt,
                    kind: .task_setCompleted,
                    payload: .init(cardID: payload.cardID, completed: payload.completed)
                )
            )
        case .workCapture(let payload):
            .work_capture(
                .init(
                    idempotencyKey: snapshot.idempotencyKey,
                    baseRevision: snapshot.baseRevision,
                    clientCreatedAt: snapshot.clientCreatedAt,
                    kind: .work_capture,
                    payload: .init(
                        rawText: payload.rawText,
                        transcript: payload.transcript,
                        source: workCaptureSource(payload.source),
                        areaID: payload.areaID
                    )
                )
            )
        case .approvalApprove(let payload):
            .approval_approve(
                .init(
                    idempotencyKey: snapshot.idempotencyKey,
                    baseRevision: snapshot.baseRevision,
                    clientCreatedAt: snapshot.clientCreatedAt,
                    kind: .approval_approve,
                    payload: .init(approvalID: payload.approvalID)
                )
            )
        case .approvalReject(let payload):
            .approval_reject(
                .init(
                    idempotencyKey: snapshot.idempotencyKey,
                    baseRevision: snapshot.baseRevision,
                    clientCreatedAt: snapshot.clientCreatedAt,
                    kind: .approval_reject,
                    payload: .init(approvalID: payload.approvalID, reason: payload.reason)
                )
            )
        }
    }

    private static func taskPriority(
        _ priority: TaskPriority?
    ) -> Components.Schemas.TaskCreateCommand.PayloadPayload.PriorityPayload? {
        switch priority {
        case .low: .low
        case .medium: .medium
        case .high: .high
        case nil: nil
        }
    }

    private static func workCaptureSource(
        _ source: WorkCaptureSource
    ) -> Components.Schemas.WorkCaptureCommand.PayloadPayload.SourcePayload {
        switch source {
        case .text: .text
        case .voice: .voice
        case .chat: .chat
        }
    }
}
