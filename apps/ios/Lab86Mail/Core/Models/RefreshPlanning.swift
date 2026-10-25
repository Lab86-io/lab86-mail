import Foundation

/// One data owner the store can refresh on its own.
enum ProductDomain: String, Hashable, Sendable, CaseIterable {
    case mail
    case calendar
    case tasks
    case activity
    case brief
    case work
}

/// What a remote notification said, reduced to values that cross an actor
/// boundary. The payload itself is `[AnyHashable: Any]`, so it is read once
/// where it arrives.
struct RemoteWakePayload: Equatable, Sendable {
    var route: String?
    var category: String?
    var accountID: String?
    var threadID: String?
    var codeAvailable: Bool

    init(
        route: String? = nil,
        category: String? = nil,
        accountID: String? = nil,
        threadID: String? = nil,
        codeAvailable: Bool = false
    ) {
        self.route = route
        self.category = category
        self.accountID = accountID
        self.threadID = threadID
        self.codeAvailable = codeAvailable
    }

    init(userInfo: [AnyHashable: Any]) {
        let aps = userInfo["aps"] as? [AnyHashable: Any]
        self.init(
            route: userInfo["route"] as? String,
            category: aps?["category"] as? String,
            accountID: userInfo["accountId"] as? String,
            threadID: userInfo["threadId"] as? String,
            codeAvailable: userInfo["codeAvailable"] as? Bool == true
        )
    }
}

/// Why the app woke. A push names its domain; a background refresh names
/// nothing and takes what is stale.
enum RemoteWake: Equatable, Sendable {
    case backgroundRefresh
    case push(RemoteWakePayload)
}

/// Which domains one wake refreshes (K2). Every alert push carries
/// `content-available`, so without this plan each push ran a whole bootstrap.
struct RemoteRefreshPlan: Equatable, Sendable {
    var domains: Set<ProductDomain>

    /// True when the wake named no domain the app knows. The store then
    /// refreshes only what is stale.
    var isUnspecific: Bool { domains.isEmpty }

    /// The named domains that are due: all of them in the background, and
    /// while the app is active only the ones not read within `window`.
    func due(
        refreshedAt: [ProductDomain: Date],
        appIsActive: Bool,
        now: Date,
        window: TimeInterval
    ) -> Set<ProductDomain> {
        domains.filter { domain in
            guard appIsActive, let readAt = refreshedAt[domain] else { return true }
            return now.timeIntervalSince(readAt) > window
        }
    }

    static func make(_ payload: RemoteWakePayload) -> RemoteRefreshPlan {
        var domains: Set<ProductDomain> = []
        let words = Set(routeWords(payload.route))
        let category = payload.category ?? ""
        let hasThread = payload.accountID?.isEmpty == false && payload.threadID?.isEmpty == false
        if hasThread || category == "LAB86_MAIL" || category == "LAB86_URGENT"
            || words.contains("mail") || words.contains("thread") || words.contains("inbox") {
            domains.insert(.mail)
        }
        if category == "LAB86_BRIEF" || words.contains("brief") {
            domains.insert(.brief)
        }
        if category == "LAB86_CHECKIN" || words.contains("checkin") || words.contains("activity")
            || words.contains("notifications") || words.contains("approval") || words.contains("suggestion") {
            domains.insert(.activity)
        }
        if category == "LAB86_COMMITMENT" || words.contains("work") || words.contains("albatross")
            || words.contains("albatrosses") || words.contains("area") {
            domains.insert(.work)
        }
        if words.contains("calendar") || words.contains("event") {
            domains.insert(.calendar)
        }
        if words.contains("tasks") || words.contains("task") || words.contains("card") {
            domains.insert(.tasks)
        }
        return RemoteRefreshPlan(domains: domains)
    }

    // "/?view=files&file=x" -> ["view", "files", "file", "x"]. Values and
    // names both count, so `view=mail` names mail the same as `/mail/thread`.
    private static func routeWords(_ route: String?) -> [String] {
        guard let route else { return [] }
        return route.lowercased()
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .map(String.init)
    }
}

/// When data is old enough to read again (K3).
enum RefreshStaleness {
    /// The default age after which a return to the app reads again.
    static let defaultMaxAge: TimeInterval = 5 * 60

    /// Stale after `maxAge`, or when the calendar day changed since the last
    /// refresh: the brief and Today are for one day.
    static func isStale(
        lastRefresh: Date?,
        now: Date,
        maxAge: TimeInterval = defaultMaxAge,
        calendar: Calendar = .autoupdatingCurrent
    ) -> Bool {
        guard let lastRefresh else { return true }
        if now.timeIntervalSince(lastRefresh) > maxAge { return true }
        return !calendar.isDate(lastRefresh, inSameDayAs: now)
    }
}
