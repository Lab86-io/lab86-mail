import Foundation

actor SyncCoordinator {
    struct Key: Hashable, Sendable {
        let ownerID: String
        let domain: String
    }

    private var foregroundTasks: [Key: Task<Bool, Never>] = [:]

    func run(
        ownerID: String,
        domain: String,
        operation: @escaping @Sendable () async -> Bool
    ) async -> Bool {
        let key = Key(ownerID: ownerID, domain: domain)
        if let existing = foregroundTasks[key] {
            return await existing.value
        }
        let task = Task { await operation() }
        foregroundTasks[key] = task
        let result = await task.value
        foregroundTasks[key] = nil
        return result
    }

    func cancel(ownerID: String) {
        for (key, task) in foregroundTasks where key.ownerID == ownerID {
            task.cancel()
            foregroundTasks[key] = nil
        }
    }

    func activeTaskCount(ownerID: String) -> Int {
        foregroundTasks.keys.filter { $0.ownerID == ownerID }.count
    }
}
