import Foundation

struct OutboxDrainResult: Equatable, Sendable {
    var attempted = 0
    var applied = 0
    var needsApproval = 0
    var conflicted = 0
    var deferred = 0
    var permanentlyFailed = 0

    var completedWithoutPermanentFailure: Bool {
        permanentlyFailed == 0
    }
}

actor CommandOutboxProcessor {
    private let outbox: CommandOutbox
    private let submitter: any MobileCommandSubmitting

    init(outbox: CommandOutbox, submitter: any MobileCommandSubmitting) {
        self.outbox = outbox
        self.submitter = submitter
    }

    func drain(ownerID: String, now: Date = .now) async -> OutboxDrainResult {
        var result = OutboxDrainResult()
        let commands: [PendingCommandSnapshot]
        do {
            commands = try await outbox.pending(ownerID: ownerID, now: now)
        } catch {
            result.permanentlyFailed = 1
            return result
        }

        for command in commands {
            guard !Task.isCancelled else { break }
            result.attempted += 1
            do {
                try await outbox.markSubmitting(
                    ownerID: ownerID,
                    idempotencyKey: command.idempotencyKey
                )
                let receipt = try await submitter.submit(command)
                try await outbox.apply(
                    ownerID: ownerID,
                    idempotencyKey: command.idempotencyKey,
                    receipt: receipt
                )
                switch receipt.status {
                case .applied:
                    result.applied += 1
                case .needsApproval:
                    result.needsApproval += 1
                case .conflicted:
                    result.conflicted += 1
                case .queued:
                    result.deferred += 1
                    try await outbox.deferSubmission(
                        ownerID: ownerID,
                        idempotencyKey: command.idempotencyKey,
                        after: .seconds(5)
                    )
                case .failed:
                    if receipt.retryable {
                        result.deferred += 1
                        try await outbox.deferSubmission(
                            ownerID: ownerID,
                            idempotencyKey: command.idempotencyKey,
                            after: retryDelay(attempt: command.attemptCount + 1)
                        )
                    } else {
                        result.permanentlyFailed += 1
                    }
                case .pending, .submitting:
                    result.deferred += 1
                }
            } catch {
                let failure = Self.failureDetails(error)
                do {
                    try await outbox.fail(
                        ownerID: ownerID,
                        idempotencyKey: command.idempotencyKey,
                        code: failure.code,
                        message: failure.message,
                        retryable: failure.retryable,
                        nextAttemptAt: failure.retryable
                            ? now.addingTimeInterval(retryDelay(attempt: command.attemptCount + 1).timeInterval)
                            : nil
                    )
                } catch {
                    result.permanentlyFailed += 1
                    continue
                }
                if failure.retryable {
                    result.deferred += 1
                } else {
                    result.permanentlyFailed += 1
                }
            }
        }
        return result
    }

    private func retryDelay(attempt: Int) -> Duration {
        let exponent = min(max(attempt, 1), 8)
        return .seconds(min(1 << exponent, 300))
    }

    private static func failureDetails(_ error: Error) -> (code: String, message: String, retryable: Bool) {
        if case let MobileV1ClientError.server(_, code, message, retryable) = error {
            return (code, message, retryable)
        }
        if case let MobileV1ClientError.undocumented(status) = error {
            return ("UNSUPPORTED_RESPONSE", "The server returned HTTP \(status).", status >= 500)
        }
        if let urlError = error as? URLError {
            return ("NETWORK_ERROR", urlError.localizedDescription, true)
        }
        return ("CLIENT_ERROR", error.localizedDescription, true)
    }
}

private extension Duration {
    var timeInterval: TimeInterval {
        let parts = components
        return TimeInterval(parts.seconds) + TimeInterval(parts.attoseconds) / 1e18
    }
}
