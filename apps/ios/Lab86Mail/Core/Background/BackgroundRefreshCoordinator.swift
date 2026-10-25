#if os(iOS)
import BackgroundTasks
import Foundation
import UIKit

@MainActor
final class BackgroundRefreshCoordinator {
    static let shared = BackgroundRefreshCoordinator()
    static let refreshIdentifier = "io.lab86.mail.refresh"

    private var handler: (@MainActor (RemoteWake) async -> Bool)?

    private init() {}

    func register() {
        // The launch handler is formed in this main-actor type, so it carries
        // main-actor isolation. `using: nil` ran it on a background queue and
        // Swift 6 trapped on every refresh launch; the main queue is where it
        // belongs.
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshIdentifier, using: .main) { task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            Task { @MainActor in
                await Self.shared.run(refreshTask)
            }
        }
    }

    /// The shell installs one handler for both wakes: a background refresh
    /// and a push with `content-available`.
    func install(handler: @escaping @MainActor (RemoteWake) async -> Bool) {
        self.handler = handler
    }

    func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        Task.detached {
            try? await BGTaskScheduler.shared.submitTaskRequest(request)
        }
    }

    /// A push woke the app. The handler refreshes what the push names (K2).
    func runRemoteNotification(
        _ payload: RemoteWakePayload,
        completion: @escaping (UIBackgroundFetchResult) -> Void
    ) async {
        let success = await handler?(.push(payload)) ?? false
        schedule()
        completion(success ? .newData : .failed)
    }

    private func run(_ task: BGAppRefreshTask) async {
        schedule()
        let operation = Task { @MainActor in await handler?(.backgroundRefresh) ?? false }
        // The system calls the expiration handler off the main actor. A
        // closure formed in this method would carry main-actor isolation
        // and trap there, so a nonisolated function builds it.
        task.expirationHandler = Self.cancelHandler(for: operation)
        let success = await operation.value
        task.setTaskCompleted(success: success && !operation.isCancelled)
    }

    nonisolated private static func cancelHandler(for operation: Task<Bool, Never>) -> @Sendable () -> Void {
        { operation.cancel() }
    }
}
#endif
