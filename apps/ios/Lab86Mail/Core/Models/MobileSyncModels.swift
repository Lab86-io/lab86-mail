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
    // Epoch ms when the thread resurfaces; snoozeCleared reports an explicit
    // un-snooze, distinct from a change that says nothing about snoozing.
    let snoozedUntil: Int?
    let snoozeCleared: Bool?
    let muted: Bool?

    init(
        entityID: String,
        revision: Int,
        accountID: String,
        archived: Bool? = nil,
        trashed: Bool? = nil,
        unread: Bool? = nil,
        snoozedUntil: Int? = nil,
        snoozeCleared: Bool? = nil,
        muted: Bool? = nil
    ) {
        self.entityID = entityID
        self.revision = revision
        self.accountID = accountID
        self.archived = archived
        self.trashed = trashed
        self.unread = unread
        self.snoozedUntil = snoozedUntil
        self.snoozeCleared = snoozeCleared
        self.muted = muted
    }
}

struct MailMessageSyncPatch: Equatable, Sendable {
    let entityID: String
    let revision: Int
    let accountID: String
    let unread: Bool?
    let starred: Bool?
    let labelsAdded: [String]?
    let labelsRemoved: [String]?

    init(
        entityID: String,
        revision: Int,
        accountID: String,
        unread: Bool? = nil,
        starred: Bool? = nil,
        labelsAdded: [String]? = nil,
        labelsRemoved: [String]? = nil
    ) {
        self.entityID = entityID
        self.revision = revision
        self.accountID = accountID
        self.unread = unread
        self.starred = starred
        self.labelsAdded = labelsAdded
        self.labelsRemoved = labelsRemoved
    }
}

struct MailDraftSyncPatch: Equatable, Sendable {
    let entityID: String
    let revision: Int
    let accountID: String
    let draftID: String
    let deleted: Bool
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

// The horizon of one Work changed. `horizonCleared` reports an explicit
// return to "now" (mirrors `snoozeCleared`); a nil horizon with no clear
// says nothing.
struct WorkHorizonSyncPatch: Equatable, Sendable {
    let entityID: String
    let revision: Int
    let workID: String
    let horizon: WorkHorizon?
    let horizonCleared: Bool

    init(entityID: String, revision: Int, workID: String, horizon: WorkHorizon?, horizonCleared: Bool = false) {
        self.entityID = entityID
        self.revision = revision
        self.workID = workID
        self.horizon = horizon
        self.horizonCleared = horizonCleared
    }
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
    case mailDraft(MailDraftSyncPatch)
    case calendarEvent(CalendarEventSyncReference)
    case task(TaskSyncPatch)
    case work(WorkSyncReference)
    case workHorizon(WorkHorizonSyncPatch)
    case approval(ApprovalSyncPatch)
    case operation(OperationSyncPatch)

    var domain: MobileDomain {
        switch self {
        case .mailThread, .mailMessage, .mailDraft: .mail
        case .calendarEvent: .calendar
        case .task: .tasks
        case .work, .workHorizon: .work
        case .approval: .activity
        case .operation(let patch): patch.domain
        }
    }

    var revision: Int {
        switch self {
        case .mailThread(let patch): patch.revision
        case .mailMessage(let patch): patch.revision
        case .mailDraft(let patch): patch.revision
        case .calendarEvent(let reference): reference.revision
        case .task(let patch): patch.revision
        case .work(let reference): reference.revision
        case .workHorizon(let patch): patch.revision
        case .approval(let patch): patch.revision
        case .operation(let patch): patch.revision
        }
    }
}

protocol MobileSyncFetching: Sendable {
    func fetchSync(domain: MobileDomain, cursor: String?, limit: Int) async throws -> MobileSyncPage
}
