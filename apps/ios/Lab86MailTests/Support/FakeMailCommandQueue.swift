import Foundation
@testable import Lab86Mail

/// A mail command queue for store tests (NAT-10). It records what the store
/// sends, and each flush gives every waiting command the state the test sets.
@MainActor
final class FakeMailCommandQueue: MailCommandQueueing {
    struct Entry {
        let key: String
        let command: DurableMobileCommand
        var status: OutboxCommandStatus
        var retryable: Bool
        var message: String?
    }

    private(set) var entries: [Entry] = []
    /// The state a flush gives every command that still waits.
    var flushResult: (status: OutboxCommandStatus, retryable: Bool, message: String?) = (.applied, false, nil)
    var enqueueError: (any Error)?

    var sentCommands: [DurableMobileCommand] { entries.map(\.command) }

    func enqueue(_ command: DurableMobileCommand, idempotencyKey: String) async throws {
        if let enqueueError { throw enqueueError }
        entries.append(Entry(key: idempotencyKey, command: command, status: .pending, retryable: false, message: nil))
    }

    func flush() async -> [PendingCommandSnapshot] {
        settleWaiting(status: flushResult.status, retryable: flushResult.retryable, message: flushResult.message)
    }

    /// Gives every waiting command a new state, the way a later drain would.
    @discardableResult
    func settleWaiting(
        status: OutboxCommandStatus,
        retryable: Bool = false,
        message: String? = nil
    ) -> [PendingCommandSnapshot] {
        for index in entries.indices where MailCommandPhase(Self.snapshot(entries[index])) == .waiting {
            entries[index].status = status
            entries[index].retryable = retryable
            entries[index].message = message
        }
        return snapshots()
    }

    func snapshots() -> [PendingCommandSnapshot] {
        entries.map(Self.snapshot)
    }

    static func snapshot(_ entry: Entry) -> PendingCommandSnapshot {
        PendingCommandSnapshot(
            idempotencyKey: entry.key,
            ownerID: "owner-1",
            command: entry.command,
            baseRevision: nil,
            clientCreatedAt: .now,
            status: entry.status,
            serverCommandID: nil,
            attemptCount: 0,
            nextAttemptAt: nil,
            lastErrorCode: nil,
            lastErrorMessage: entry.message,
            lastErrorRetryable: entry.retryable
        )
    }
}
