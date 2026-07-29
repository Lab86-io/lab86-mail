import BackgroundTasks
import Foundation
import UIKit

@MainActor
final class BackgroundRefreshCoordinator {
    static let shared = BackgroundRefreshCoordinator()
    static let refreshIdentifier = "io.lab86.mail.refresh"

    private var handler: (@MainActor () async -> Bool)?

    private init() {}

    func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshIdentifier, using: nil) { task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            Task { @MainActor in
                await Self.shared.run(refreshTask)
            }
        }
    }

    func install(handler: @escaping @MainActor () async -> Bool) {
        self.handler = handler
    }

    func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        Task.detached {
            try? await BGTaskScheduler.shared.submitTaskRequest(request)
        }
    }

    func runRemoteNotification(completion: @escaping (UIBackgroundFetchResult) -> Void) async {
        let success = await handler?() ?? false
        schedule()
        completion(success ? .newData : .failed)
    }

    private func run(_ task: BGAppRefreshTask) async {
        schedule()
        let operation = Task { @MainActor in await handler?() ?? false }
        task.expirationHandler = { operation.cancel() }
        let success = await operation.value
        task.setTaskCompleted(success: success && !operation.isCancelled)
    }
}
