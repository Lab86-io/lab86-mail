import Foundation

/// How a fresh first page meets the list already on screen (K10). Earlier the
/// first page replaced the whole list, so a refresh undid Load More and an
/// older response that ended late could replace a newer list.
enum MailListMerge {
    /// The rows that survive a refresh under the new first page: rows older
    /// than the page's oldest row and not in the page. The page owns its own
    /// window, so a row inside the window that the page left out is gone
    /// (archived, trashed, or moved). An empty page keeps nothing.
    static func pagedTail(existing: [MailThreadSummary], firstPage: [MailThreadSummary]) -> [MailThreadSummary] {
        guard let oldest = firstPage.map(\.date).min() else { return [] }
        let pageKeys = Set(firstPage.map(key))
        return existing.filter { !pageKeys.contains(key($0)) && $0.date < oldest }
    }

    /// The new list: the first page, then the tail, newest first.
    static func replacingFirstPage(existing: [MailThreadSummary], firstPage: [MailThreadSummary]) -> [MailThreadSummary] {
        (firstPage + pagedTail(existing: existing, firstPage: firstPage)).sorted { $0.date > $1.date }
    }

    private static func key(_ thread: MailThreadSummary) -> String {
        "\(thread.accountID):\(thread.id)"
    }
}

/// The most recent keys, newest last, with a cap (K8). The cache snapshot
/// held every area and Work detail ever opened; now it keeps the 20 most
/// recent of each.
struct RecentKeys: Equatable, Sendable {
    let limit: Int
    private(set) var keys: [String] = []

    init(limit: Int = 20) {
        self.limit = max(1, limit)
    }

    /// Marks a key as used now and drops the oldest past the limit.
    /// Returns the keys that fell off.
    @discardableResult
    mutating func touch(_ key: String) -> [String] {
        keys.removeAll { $0 == key }
        keys.append(key)
        guard keys.count > limit else { return [] }
        let dropped = Array(keys.prefix(keys.count - limit))
        keys.removeFirst(keys.count - limit)
        return dropped
    }

    mutating func remove(_ key: String) {
        keys.removeAll { $0 == key }
    }

    mutating func removeAll() {
        keys = []
    }

    /// The dictionary cut down to the recent keys. A key the list does not
    /// know yet (a cache restore) counts as old and is dropped once the
    /// list is full.
    func trimmed<Value>(_ details: [String: Value]) -> [String: Value] {
        guard details.count > limit else { return details }
        let kept = Set(keys.suffix(limit))
        return details.filter { kept.contains($0.key) }
    }
}
