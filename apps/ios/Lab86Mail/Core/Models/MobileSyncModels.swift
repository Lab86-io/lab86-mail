import Foundation

struct MobileSyncPage: Equatable, Sendable {
    let domain: MobileDomain
    let changes: [MobileSyncChange]
    let deletedIDs: [String]
    let cursor: String
    let serverRevision: Int
    let hasMore: Bool
}

struct MailThreadSyncPatch: Equatable, Sendable {
    let entityID: String
    let revision: Int
    let accountID: String
    let archived: Bool?
    let trashed: Bool?
    let unread: Bool?
}

struct MailMessageSyncPatch: Equatable, Sendable {
    let entityID: String
    let revision: Int
    let accountID: String
    let unread: Bool?
    let starred: Bool?
}

struct CalendarEventSyncReference: Equatable, Sendable {
    let entityID: String
    let revision: Int
    let accountID: String
    let eventID: String
}

struct TaskSyncPatch: Equatable, Sendable {
    let entityID: String
    let revision: Int
    let cardID: String
    let title: String?
    let completed: Bool?
}

struct WorkSyncReference: Equatable, Sendable {
    let entityID: String
    let revision: Int
    let captureID: String
    let workIDs: [String]
    let fallback: Bool
}

enum ApprovalSyncState: Equatable, Sendable {
    case requested(commandKind: String)
    case resolved(status: ApprovalResolution)
}

enum ApprovalResolution: String, Equatable, Sendable {
    case approved
    case rejected
}

struct ApprovalSyncPatch: Equatable, Sendable {
    let entityID: String
    let revision: Int
    let approvalID: String
    let state: ApprovalSyncState
}

struct OperationSyncPatch: Equatable, Sendable {
    let domain: MobileDomain
    let entityID: String
    let revision: Int
    let operationID: String
    let undone: Bool
}

enum MobileSyncChange: Equatable, Sendable {
    case mailThread(MailThreadSyncPatch)
    case mailMessage(MailMessageSyncPatch)
    case calendarEvent(CalendarEventSyncReference)
    case task(TaskSyncPatch)
    case work(WorkSyncReference)
    case approval(ApprovalSyncPatch)
    case operation(OperationSyncPatch)

    var domain: MobileDomain {
        switch self {
        case .mailThread, .mailMessage: .mail
        case .calendarEvent: .calendar
        case .task: .tasks
        case .work: .work
        case .approval: .activity
        case .operation(let patch): patch.domain
        }
    }

    var revision: Int {
        switch self {
        case .mailThread(let patch): patch.revision
        case .mailMessage(let patch): patch.revision
        case .calendarEvent(let reference): reference.revision
        case .task(let patch): patch.revision
        case .work(let reference): reference.revision
        case .approval(let patch): patch.revision
        case .operation(let patch): patch.revision
        }
    }
}

protocol MobileSyncFetching: Sendable {
    func fetchSync(domain: MobileDomain, cursor: String?, limit: Int) async throws -> MobileSyncPage
}
