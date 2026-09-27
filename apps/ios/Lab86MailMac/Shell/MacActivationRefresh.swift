import Foundation

// The Mac process stays up for days, so reads that the phone repeats on each
// launch must repeat on return to the app: the Files choice, the plan with
// its trial note, and the source health line under the Today masthead
// (round 2, FEATURES items 2, 17, 18). A return to the app runs them at most
// once in five minutes.
@MainActor
final class MacActivationRefresh {
    let interval: TimeInterval
    private(set) var lastRun: Date?

    init(interval: TimeInterval = 300) {
        self.interval = interval
    }

    /// True when the reads are due, and marks them as run.
    func claim(now: Date = .now) -> Bool {
        if let lastRun, now.timeIntervalSince(lastRun) < interval { return false }
        lastRun = now
        return true
    }

    func run(_ environment: AppEnvironment, now: Date = .now) async {
        guard claim(now: now) else { return }
        await environment.trust.refreshSurfaces()
        await environment.trust.refreshPlan(now: now)
        await environment.store.refreshBriefSources()
    }
}
