import Foundation
#if canImport(UIKit)
import UIKit
#endif

// The warm thread models (docs/albatross-threads.md, T4 and T5): the last
// three Albatross threads a person opened keep their model, so Back and a
// return show the thread at once with its scroll position, and a reply that
// streams on this device keeps its task. The fourth thread evicts the
// oldest; the server save still guarantees the reply. A memory warning
// empties the cache.

@MainActor
final class WorkThreadModelCache {
    static let limit = 3

    private var models: [String: WorkThreadModel] = [:]
    /// Oldest first.
    private var order: [String] = []
    private var observer: (any NSObjectProtocol)?

    init() {
        #if os(iOS)
        observer = NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.removeAll() }
        }
        #endif
    }

    /// The warm model of a Work, or a new one. The newest three stay.
    func model(for workID: String, title: String?, environment: AppEnvironment) -> WorkThreadModel {
        if let model = models[workID] {
            touch(workID)
            return model
        }
        let model = WorkThreadModel(workID: workID, title: title, environment: environment)
        models[workID] = model
        touch(workID)
        while order.count > Self.limit, let oldest = order.first {
            order.removeFirst()
            models[oldest] = nil
        }
        return model
    }

    func cached(_ workID: String) -> WorkThreadModel? {
        models[workID]
    }

    var count: Int { models.count }

    /// The warm Works, oldest first.
    var workIDs: [String] { order }

    func remove(_ workID: String) {
        models[workID] = nil
        order.removeAll { $0 == workID }
    }

    func removeAll() {
        models = [:]
        order = []
    }

    private func touch(_ workID: String) {
        order.removeAll { $0 == workID }
        order.append(workID)
    }
}
