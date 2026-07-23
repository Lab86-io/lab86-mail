import Foundation
import SwiftData

enum MobileCommandKind: String, Codable, CaseIterable, Sendable {
    case mailArchive = "mail.archive"
    case mailTrash = "mail.trash"
    case mailMarkRead = "mail.markRead"
    case mailMarkUnread = "mail.markUnread"
    case mailStar = "mail.star"
    case mailUnstar = "mail.unstar"
    case calendarCreate = "calendar.create"
    case taskCreate = "task.create"
    case taskSetCompleted = "task.setCompleted"
    case workCapture = "work.capture"
    case approvalApprove = "approval.approve"
    case approvalReject = "approval.reject"
}

struct MailThreadCommandTarget: Codable, Equatable, Sendable {
    let accountID: String
    let threadID: String
}

struct MailMessageCommandTarget: Codable, Equatable, Sendable {
    let accountID: String
    let messageID: String
}

struct CalendarCommandAttendee: Codable, Equatable, Sendable {
    let email: String
    let name: String?
}

struct CalendarCreateCommandPayload: Codable, Equatable, Sendable {
    let accountID: String
    let calendarID: String?
    let title: String
    let startAt: Date
    let endAt: Date
    let allDay: Bool
    let description: String?
    let location: String?
    let attendees: [CalendarCommandAttendee]
    let recurrence: [String]?
    let busy: Bool
}

enum TaskPriority: String, Codable, Equatable, Sendable {
    case low
    case medium
    case high
}

struct TaskCreateCommandPayload: Codable, Equatable, Sendable {
    let boardID: String?
    let column: String?
    let title: String
    let description: String?
    let priority: TaskPriority?
    let dueAt: Date?
}

struct TaskCompletionCommandPayload: Codable, Equatable, Sendable {
    let cardID: String
    let completed: Bool
}

enum WorkCaptureSource: String, Codable, Equatable, Sendable {
    case text
    case voice
    case chat
}

struct WorkCaptureCommandPayload: Codable, Equatable, Sendable {
    let rawText: String
    let transcript: String?
    let source: WorkCaptureSource
    let areaID: String?
}

struct ApprovalApproveCommandPayload: Codable, Equatable, Sendable {
    let approvalID: String
}

struct ApprovalRejectCommandPayload: Codable, Equatable, Sendable {
    let approvalID: String
    let reason: String?
}

enum DurableMobileCommand: Codable, Equatable, Sendable {
    case mailArchive(MailThreadCommandTarget)
    case mailTrash(MailThreadCommandTarget)
    case mailMarkRead(MailThreadCommandTarget)
    case mailMarkUnread(MailMessageCommandTarget)
    case mailStar(MailMessageCommandTarget)
    case mailUnstar(MailMessageCommandTarget)
    case calendarCreate(CalendarCreateCommandPayload)
    case taskCreate(TaskCreateCommandPayload)
    case taskSetCompleted(TaskCompletionCommandPayload)
    case workCapture(WorkCaptureCommandPayload)
    case approvalApprove(ApprovalApproveCommandPayload)
    case approvalReject(ApprovalRejectCommandPayload)

    var kind: MobileCommandKind {
        switch self {
        case .mailArchive: .mailArchive
        case .mailTrash: .mailTrash
        case .mailMarkRead: .mailMarkRead
        case .mailMarkUnread: .mailMarkUnread
        case .mailStar: .mailStar
        case .mailUnstar: .mailUnstar
        case .calendarCreate: .calendarCreate
        case .taskCreate: .taskCreate
        case .taskSetCompleted: .taskSetCompleted
        case .workCapture: .workCapture
        case .approvalApprove: .approvalApprove
        case .approvalReject: .approvalReject
        }
    }
}

enum OutboxCommandStatus: String, Codable, Sendable {
    case pending
    case submitting
    case queued
    case applied
    case needsApproval
    case conflicted
    case failed

    var isTerminal: Bool {
        switch self {
        case .applied, .needsApproval, .conflicted: true
        case .pending, .submitting, .queued, .failed: false
        }
    }
}

struct OutboxCommandReceipt: Equatable, Sendable {
    let commandID: String
    let status: OutboxCommandStatus
    let entityRevision: Int?
    let operationID: String?
    let approvalID: String?
    let undoExpiresAt: Date?
    let errorCode: String?
    let errorMessage: String?
    let retryable: Bool
}

struct PendingCommandSnapshot: Equatable, Sendable {
    let idempotencyKey: String
    let ownerID: String
    let command: DurableMobileCommand
    let baseRevision: Int?
    let clientCreatedAt: Date
    let status: OutboxCommandStatus
    let serverCommandID: String?
    let attemptCount: Int
    let nextAttemptAt: Date?
    let lastErrorCode: String?
    let lastErrorMessage: String?
    let lastErrorRetryable: Bool
}

@Model
final class PendingCommandRecord {
    @Attribute(.unique) var recordID: String
    var ownerID: String
    var idempotencyKey: String
    var kindRaw: String
    @Attribute(.externalStorage) var commandData: Data
    var baseRevision: Int?
    var clientCreatedAt: Date
    var statusRaw: String
    var serverCommandID: String?
    var entityRevision: Int?
    var operationID: String?
    var approvalID: String?
    var undoExpiresAt: Date?
    var attemptCount: Int
    var nextAttemptAt: Date?
    var lastErrorCode: String?
    var lastErrorMessage: String?
    var lastErrorRetryable: Bool = false
    var createdAt: Date
    var updatedAt: Date

    init(
        ownerID: String,
        idempotencyKey: String,
        command: DurableMobileCommand,
        commandData: Data,
        baseRevision: Int?,
        clientCreatedAt: Date
    ) {
        recordID = Self.recordID(ownerID: ownerID, idempotencyKey: idempotencyKey)
        self.ownerID = ownerID
        self.idempotencyKey = idempotencyKey
        kindRaw = command.kind.rawValue
        self.commandData = commandData
        self.baseRevision = baseRevision
        self.clientCreatedAt = clientCreatedAt
        statusRaw = OutboxCommandStatus.pending.rawValue
        attemptCount = 0
        createdAt = .now
        updatedAt = .now
    }

    static func recordID(ownerID: String, idempotencyKey: String) -> String {
        "\(ownerID):\(idempotencyKey)"
    }
}

@Model
final class SyncCursorRecord {
    @Attribute(.unique) var recordID: String
    var ownerID: String
    var domain: String
    var cursor: String
    var serverRevision: Int
    var updatedAt: Date

    init(ownerID: String, domain: String, cursor: String, serverRevision: Int) {
        recordID = "\(ownerID):\(domain)"
        self.ownerID = ownerID
        self.domain = domain
        self.cursor = cursor
        self.serverRevision = serverRevision
        updatedAt = .now
    }
}

enum AppRoute: Codable, Equatable, Sendable {
    case today
    case mail
    case mailThread(accountID: String, threadID: String)
    case calendar
    case tasks
    case work
    case assistant
    case activity
    case compose(recipient: String?)
    case settings
}

@Model
final class RouteRequestRecord {
    @Attribute(.unique) var id: UUID
    var ownerID: String
    @Attribute(.externalStorage) var routeData: Data
    var source: String
    var createdAt: Date

    init(id: UUID = UUID(), ownerID: String, routeData: Data, source: String, createdAt: Date = .now) {
        self.id = id
        self.ownerID = ownerID
        self.routeData = routeData
        self.source = source
        self.createdAt = createdAt
    }
}

@Model
final class LegacySnapshotImportRecord {
    @Attribute(.unique) var ownerID: String
    var importedAt: Date

    init(ownerID: String, importedAt: Date = .now) {
        self.ownerID = ownerID
        self.importedAt = importedAt
    }
}

@Model
final class CachedAccountRecord {
    @Attribute(.unique) var recordID: String
    var ownerID: String
    var accountID: String
    var email: String
    var provider: String
    var status: String
    var displayName: String?
    var capabilitiesData: Data
    var lastSyncedAt: Date?
    var updatedAt: Date

    init(
        ownerID: String,
        accountID: String,
        email: String,
        provider: String,
        status: String,
        displayName: String?,
        capabilitiesData: Data,
        lastSyncedAt: Date?
    ) {
        recordID = "\(ownerID):\(accountID)"
        self.ownerID = ownerID
        self.accountID = accountID
        self.email = email
        self.provider = provider
        self.status = status
        self.displayName = displayName
        self.capabilitiesData = capabilitiesData
        self.lastSyncedAt = lastSyncedAt
        updatedAt = .now
    }
}

enum MobilePersistence {
    static let schema = Schema([
        PendingCommandRecord.self,
        SyncCursorRecord.self,
        RouteRequestRecord.self,
        LegacySnapshotImportRecord.self,
        CachedAccountRecord.self,
    ])

    static func makeContainer(inMemory: Bool = false, storeURL: URL? = nil) -> ModelContainer {
        do {
            let configuration: ModelConfiguration
            if inMemory {
                configuration = ModelConfiguration(
                    "AlbatrossMobileV1",
                    schema: schema,
                    isStoredInMemoryOnly: true,
                    allowsSave: true
                )
            } else {
                let resolvedStoreURL = try persistentStoreURL(override: storeURL)
                configuration = ModelConfiguration(
                    "AlbatrossMobileV1",
                    schema: schema,
                    url: resolvedStoreURL,
                    allowsSave: true
                )
            }
            return try ModelContainer(for: schema, configurations: [configuration])
        } catch {
            precondition(!inMemory, "The in-memory mobile database must be constructible: \(error)")
            let fallback = ModelConfiguration(
                "AlbatrossMobileV1Fallback",
                schema: schema,
                isStoredInMemoryOnly: true,
                allowsSave: true
            )
            return try! ModelContainer(for: schema, configurations: [fallback])
        }
    }

    private static func persistentStoreURL(override: URL?) throws -> URL {
        let fileManager = FileManager.default
        let storeURL: URL
        if let override {
            storeURL = override
        } else {
            let applicationSupport = try fileManager.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
            storeURL = applicationSupport.appending(path: "AlbatrossMobileV1.store")
        }

        try fileManager.createDirectory(
            at: storeURL.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        return storeURL
    }
}
