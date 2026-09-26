import Foundation

/// The durable path for the mail list actions (NAT-10): archive, trash,
/// restore, mark read or unread, star, snooze, and unsnooze. An action lands
/// in the command outbox first, so it survives going offline and a relaunch.
/// The outbox then sends it and tries it again until the server settles it.
@MainActor
protocol MailCommandQueueing: AnyObject {
    /// Stores the command for the signed-in owner. Throws when it cannot.
    func enqueue(_ command: DurableMobileCommand, idempotencyKey: String) async throws
    /// Sends what waits in the outbox. Returns the mail list commands of the
    /// owner with their current state.
    func flush() async -> [PendingCommandSnapshot]
}

/// The idempotency keys of the mail list actions. The prefix keeps them apart
/// from the chat and Brief commands, which read their receipts back later.
enum MailCommandKey {
    static let prefix = "mail-list-"

    static func make() -> String { prefix + UUID().uuidString }
}

/// Where one mail list action is, as the lists see it.
enum MailCommandPhase: Equatable, Sendable {
    /// Not sent yet, or sent and due for another try. The change stays.
    case waiting
    /// The server applied it.
    case confirmed
    /// The server refused it for good. The change rolls back.
    case failed(message: String)

    static let failureCopy = "The mail action did not finish. Try it again."

    init(_ snapshot: PendingCommandSnapshot) {
        switch snapshot.status {
        case .pending, .submitting, .queued:
            self = .waiting
        case .failed where snapshot.lastErrorRetryable:
            self = .waiting
        case .applied, .needsApproval:
            self = .confirmed
        case .failed, .conflicted:
            self = .failed(message: snapshot.lastErrorMessage?.nilIfBlank ?? Self.failureCopy)
        }
    }
}

/// The outbox side of the mail lists. It stores each action for the
/// signed-in owner, drains the outbox, and asks for another drain when an
/// action waits for its next try.
@MainActor
final class OutboxMailCommandQueue: MailCommandQueueing {
    private let outbox: CommandOutbox
    private let ownerID: @MainActor () -> String?
    private let drain: @MainActor (String) async -> Bool
    private var retryTask: Task<Void, Never>?
    /// Runs when a waiting action is due for its next try.
    var onRetryDue: (@MainActor () async -> Void)?

    init(
        outbox: CommandOutbox,
        ownerID: @escaping @MainActor () -> String?,
        drain: @escaping @MainActor (String) async -> Bool
    ) {
        self.outbox = outbox
        self.ownerID = ownerID
        self.drain = drain
    }

    func enqueue(_ command: DurableMobileCommand, idempotencyKey: String) async throws {
        guard let ownerID = ownerID() else { throw BackendError.unauthorized }
        _ = try await outbox.enqueue(ownerID: ownerID, command: command, idempotencyKey: idempotencyKey)
    }

    func flush() async -> [PendingCommandSnapshot] {
        guard let ownerID = ownerID() else { return [] }
        _ = await drain(ownerID)
        return await listCommands(ownerID: ownerID)
    }

    /// The mail list actions of one owner. Settled ones older than a day are
    /// deleted first. When an action still waits, the next drain is set.
    func listCommands(ownerID: String, now: Date = .now) async -> [PendingCommandSnapshot] {
        try? await outbox.pruneSettledCommands(
            ownerID: ownerID,
            keyPrefix: MailCommandKey.prefix,
            before: now.addingTimeInterval(-86_400)
        )
        let commands = (try? await outbox.commands(ownerID: ownerID, keyPrefix: MailCommandKey.prefix)) ?? []
        scheduleRetry(after: Self.retryDelay(for: commands, now: now))
        return commands
    }

    /// Seconds until the next waiting action is due, from 2 to 300, or nil
    /// when no action waits. An action another drain is sending gets 30
    /// seconds to finish before the next look.
    nonisolated static func retryDelay(for commands: [PendingCommandSnapshot], now: Date) -> TimeInterval? {
        let due = commands
            .filter { MailCommandPhase($0) == .waiting }
            .map { $0.nextAttemptAt ?? ($0.status == .submitting ? now.addingTimeInterval(30) : now) }
            .min()
        guard let due else { return nil }
        return min(max(due.timeIntervalSince(now), 2), 300)
    }

    private func scheduleRetry(after delay: TimeInterval?) {
        retryTask?.cancel()
        retryTask = nil
        guard let delay else { return }
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.onRetryDue?()
        }
    }
}
