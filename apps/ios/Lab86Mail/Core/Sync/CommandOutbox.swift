import Foundation
import SwiftData

@ModelActor
actor CommandOutbox {
    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    func enqueue(
        ownerID: String,
        command: DurableMobileCommand,
        idempotencyKey: String = UUID().uuidString,
        baseRevision: Int? = nil,
        clientCreatedAt: Date = .now
    ) throws -> PendingCommandSnapshot {
        let recordID = PendingCommandRecord.recordID(ownerID: ownerID, idempotencyKey: idempotencyKey)
        let descriptor = FetchDescriptor<PendingCommandRecord>(
            predicate: #Predicate { $0.recordID == recordID }
        )
        if let existing = try modelContext.fetch(descriptor).first {
            let snapshot = try snapshot(existing)
            guard snapshot.command == command else {
                throw CommandOutboxError.idempotencyKeyReused
            }
            return snapshot
        }
        let data = try Self.encoder.encode(command)
        let record = PendingCommandRecord(
            ownerID: ownerID,
            idempotencyKey: idempotencyKey,
            command: command,
            commandData: data,
            baseRevision: baseRevision,
            clientCreatedAt: clientCreatedAt
        )
        modelContext.insert(record)
        try modelContext.save()
        return try snapshot(record)
    }

    func pending(ownerID: String, now: Date = .now) throws -> [PendingCommandSnapshot] {
        let descriptor = FetchDescriptor<PendingCommandRecord>(
            predicate: #Predicate { $0.ownerID == ownerID },
            sortBy: [SortDescriptor(\.clientCreatedAt)]
        )
        return try modelContext.fetch(descriptor)
            .filter { record in
                let recordStatus = status(record)
                let isReadyStatus = recordStatus == .pending ||
                    recordStatus == .queued ||
                    (recordStatus == .failed && record.lastErrorRetryable) ||
                    (recordStatus == .submitting && record.updatedAt <= now.addingTimeInterval(-300))
                guard isReadyStatus else { return false }
                guard let nextAttemptAt = record.nextAttemptAt else { return true }
                return nextAttemptAt <= now
            }
            .map(snapshot)
    }

    func commands(ownerID: String) throws -> [PendingCommandSnapshot] {
        let descriptor = FetchDescriptor<PendingCommandRecord>(
            predicate: #Predicate { $0.ownerID == ownerID },
            sortBy: [SortDescriptor(\.clientCreatedAt)]
        )
        return try modelContext.fetch(descriptor).map(snapshot)
    }

    func markSubmitting(ownerID: String, idempotencyKey: String) throws {
        let record = try requireRecord(ownerID: ownerID, idempotencyKey: idempotencyKey)
        guard !status(record).isTerminal else { return }
        record.statusRaw = OutboxCommandStatus.submitting.rawValue
        record.attemptCount += 1
        record.nextAttemptAt = nil
        record.updatedAt = .now
        try modelContext.save()
    }

    func apply(ownerID: String, idempotencyKey: String, receipt: OutboxCommandReceipt) throws {
        let record = try requireRecord(ownerID: ownerID, idempotencyKey: idempotencyKey)
        record.statusRaw = receipt.status.rawValue
        record.serverCommandID = receipt.commandID
        record.entityRevision = receipt.entityRevision
        record.operationID = receipt.operationID
        record.approvalID = receipt.approvalID
        record.undoExpiresAt = receipt.undoExpiresAt
        record.lastErrorCode = receipt.errorCode
        record.lastErrorMessage = receipt.errorMessage
        record.lastErrorRetryable = receipt.retryable
        record.nextAttemptAt = nil
        record.updatedAt = .now
        try modelContext.save()
    }

    func scheduleRetry(
        ownerID: String,
        idempotencyKey: String,
        code: String,
        message: String,
        after delay: Duration
    ) throws {
        try fail(
            ownerID: ownerID,
            idempotencyKey: idempotencyKey,
            code: code,
            message: message,
            retryable: true,
            nextAttemptAt: .now.addingTimeInterval(delay.timeInterval)
        )
    }

    func fail(
        ownerID: String,
        idempotencyKey: String,
        code: String,
        message: String,
        retryable: Bool,
        nextAttemptAt: Date? = nil
    ) throws {
        let record = try requireRecord(ownerID: ownerID, idempotencyKey: idempotencyKey)
        record.statusRaw = OutboxCommandStatus.failed.rawValue
        record.lastErrorCode = code
        record.lastErrorMessage = message
        record.lastErrorRetryable = retryable
        record.nextAttemptAt = nextAttemptAt
        record.updatedAt = .now
        try modelContext.save()
    }

    func retry(ownerID: String, idempotencyKey: String) throws {
        let record = try requireRecord(ownerID: ownerID, idempotencyKey: idempotencyKey)
        guard status(record) == .failed else { return }
        record.statusRaw = OutboxCommandStatus.pending.rawValue
        record.lastErrorRetryable = true
        record.nextAttemptAt = nil
        record.updatedAt = .now
        try modelContext.save()
    }

    func deferSubmission(ownerID: String, idempotencyKey: String, after delay: Duration) throws {
        let record = try requireRecord(ownerID: ownerID, idempotencyKey: idempotencyKey)
        guard !status(record).isTerminal else { return }
        record.nextAttemptAt = .now.addingTimeInterval(delay.timeInterval)
        record.updatedAt = .now
        try modelContext.save()
    }

    func saveCursor(ownerID: String, domain: String, cursor: String, serverRevision: Int) throws {
        let recordID = "\(ownerID):\(domain)"
        let descriptor = FetchDescriptor<SyncCursorRecord>(predicate: #Predicate { $0.recordID == recordID })
        if let existing = try modelContext.fetch(descriptor).first {
            guard serverRevision >= existing.serverRevision else { return }
            existing.cursor = cursor
            existing.serverRevision = serverRevision
            existing.updatedAt = .now
        } else {
            modelContext.insert(
                SyncCursorRecord(
                    ownerID: ownerID,
                    domain: domain,
                    cursor: cursor,
                    serverRevision: serverRevision
                )
            )
        }
        try modelContext.save()
    }

    func cursor(ownerID: String, domain: String) throws -> (cursor: String, serverRevision: Int)? {
        let recordID = "\(ownerID):\(domain)"
        let descriptor = FetchDescriptor<SyncCursorRecord>(predicate: #Predicate { $0.recordID == recordID })
        return try modelContext.fetch(descriptor).first.map { ($0.cursor, $0.serverRevision) }
    }

    func enqueueRoute(ownerID: String, route: AppRoute, source: String) throws {
        modelContext.insert(
            RouteRequestRecord(
                ownerID: ownerID,
                routeData: try Self.encoder.encode(route),
                source: source
            )
        )
        try modelContext.save()
    }

    func consumeRoute(ownerID: String) throws -> AppRoute? {
        var descriptor = FetchDescriptor<RouteRequestRecord>(
            predicate: #Predicate { $0.ownerID == ownerID },
            sortBy: [SortDescriptor(\.createdAt)]
        )
        descriptor.fetchLimit = 1
        guard let record = try modelContext.fetch(descriptor).first else { return nil }
        let route = try Self.decoder.decode(AppRoute.self, from: record.routeData)
        modelContext.delete(record)
        try modelContext.save()
        return route
    }

    func purge(ownerID: String) throws {
        try modelContext.delete(model: PendingCommandRecord.self, where: #Predicate { $0.ownerID == ownerID })
        try modelContext.delete(model: SyncCursorRecord.self, where: #Predicate { $0.ownerID == ownerID })
        try modelContext.delete(model: RouteRequestRecord.self, where: #Predicate { $0.ownerID == ownerID })
        try modelContext.delete(model: LegacySnapshotImportRecord.self, where: #Predicate { $0.ownerID == ownerID })
        try modelContext.delete(model: CachedAccountRecord.self, where: #Predicate { $0.ownerID == ownerID })
        try modelContext.save()
    }

    private func requireRecord(ownerID: String, idempotencyKey: String) throws -> PendingCommandRecord {
        let recordID = PendingCommandRecord.recordID(ownerID: ownerID, idempotencyKey: idempotencyKey)
        let descriptor = FetchDescriptor<PendingCommandRecord>(
            predicate: #Predicate { $0.recordID == recordID }
        )
        guard let record = try modelContext.fetch(descriptor).first else {
            throw CommandOutboxError.commandNotFound
        }
        return record
    }

    private func status(_ record: PendingCommandRecord) -> OutboxCommandStatus {
        OutboxCommandStatus(rawValue: record.statusRaw) ?? .failed
    }

    private func snapshot(_ record: PendingCommandRecord) throws -> PendingCommandSnapshot {
        PendingCommandSnapshot(
            idempotencyKey: record.idempotencyKey,
            ownerID: record.ownerID,
            command: try Self.decoder.decode(DurableMobileCommand.self, from: record.commandData),
            baseRevision: record.baseRevision,
            clientCreatedAt: record.clientCreatedAt,
            status: status(record),
            serverCommandID: record.serverCommandID,
            attemptCount: record.attemptCount,
            nextAttemptAt: record.nextAttemptAt,
            lastErrorCode: record.lastErrorCode,
            lastErrorMessage: record.lastErrorMessage,
            lastErrorRetryable: record.lastErrorRetryable
        )
    }
}

enum CommandOutboxError: Error, Equatable {
    case commandNotFound
    case idempotencyKeyReused
}

private extension Duration {
    var timeInterval: TimeInterval {
        let parts = components
        return TimeInterval(parts.seconds) + TimeInterval(parts.attoseconds) / 1e18
    }
}
