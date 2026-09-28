import Foundation
import Observation

/// The suggestion list of one recipient field. Each keystroke asks again after
/// a short pause; a newer keystroke cancels the older request, and a response
/// for a query that is no longer in the field is dropped.
@MainActor
@Observable
final class RecipientSearchModel {
    /// The rows on screen. While a newer query is in flight they can belong to
    /// the older query; `suggestions(matching:)` returns only current rows.
    private(set) var suggestions: [RecipientSuggestion] = []
    /// The query of the rows on screen (normalized). Nil before the first answer.
    private(set) var resultQuery: String?
    private(set) var isSearching = false
    private(set) var didFail = false
    /// The row that Return, Tab, or a separator picks. Arrow keys move it.
    var highlightedIndex: Int?

    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private(set) var currentRequest: RecipientSearchRequest?
    @ObservationIgnored private var cache: [RecipientSearchRequest: [RecipientSuggestion]] = [:]
    @ObservationIgnored private var cacheOrder: [RecipientSearchRequest] = []
    @ObservationIgnored private let debounce: Duration
    @ObservationIgnored private let cacheLimit = 24

    init(debounce: Duration = .milliseconds(80)) {
        self.debounce = debounce
    }

    /// Asks for suggestions. The same request again does nothing; a cached
    /// answer shows at once and makes no request.
    func search(_ request: RecipientSearchRequest, using searcher: (any RecipientSearching)?) {
        if request == currentRequest, !didFail { return }
        currentRequest = request
        didFail = false
        task?.cancel()
        task = nil
        if let cached = cache[request] {
            apply(cached, query: request.query, exclude: request.exclude)
            isSearching = false
            return
        }
        guard let searcher else {
            isSearching = false
            return
        }
        isSearching = true
        let debounce = self.debounce
        task = Task { [weak self] in
            if debounce > .zero {
                do { try await Task.sleep(for: debounce) } catch { return }
            }
            guard !Task.isCancelled else { return }
            do {
                let page = try await searcher.searchRecipients(request)
                guard !Task.isCancelled else { return }
                self?.receive(page, for: request)
            } catch {
                guard !Task.isCancelled else { return }
                self?.receiveFailure(for: request)
            }
        }
    }

    /// Applies an answer when its query still matches the field. Returns
    /// false for a stale answer, which only goes into the cache.
    @discardableResult
    func receive(_ page: RecipientSuggestionPage, for request: RecipientSearchRequest) -> Bool {
        remember(page.items, for: request)
        guard let current = currentRequest,
              Self.accepts(pageQuery: page.query, currentQuery: current.query) else { return false }
        apply(page.items, query: current.query, exclude: current.exclude)
        isSearching = false
        didFail = false
        return true
    }

    /// Stops the pending request and empties the list (the field lost focus).
    func reset() {
        task?.cancel()
        task = nil
        currentRequest = nil
        clearVisible()
        isSearching = false
        didFail = false
    }

    /// Empties the rows on screen and keeps the request state (a chip was added).
    func clearVisible() {
        suggestions = []
        resultQuery = nil
        highlightedIndex = nil
    }

    /// The rows that belong to `query`: empty while the answer for an older
    /// query is still on screen.
    func suggestions(matching query: String) -> [RecipientSuggestion] {
        guard let resultQuery, resultQuery == Self.normalized(query) else { return [] }
        return suggestions
    }

    /// The row that Return picks: the highlighted row, or the first row when
    /// the person typed something.
    func pickable(for query: String) -> RecipientSuggestion? {
        let rows = suggestions(matching: query)
        if let highlightedIndex, rows.indices.contains(highlightedIndex) {
            return rows[highlightedIndex]
        }
        guard !Self.normalized(query).isEmpty else { return nil }
        return rows.first
    }

    /// Like `pickable(for:)`, but first waits a short time for an answer that
    /// is still in flight for this query, so a fast Return picks the person
    /// and does not make a chip of the partial text.
    func settledPickable(for query: String, timeout: Duration = .milliseconds(700)) async -> RecipientSuggestion? {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while isSearching,
              let current = currentRequest,
              Self.normalized(current.query) == Self.normalized(query),
              clock.now < deadline {
            do { try await Task.sleep(for: .milliseconds(20)) } catch { break }
        }
        return pickable(for: query)
    }

    /// Moves the highlighted row; wraps at both ends. Returns false when no
    /// list is on screen.
    @discardableResult
    func moveHighlight(by offset: Int) -> Bool {
        guard !suggestions.isEmpty else { return false }
        let count = suggestions.count
        let start = highlightedIndex ?? (offset > 0 ? -1 : count)
        highlightedIndex = ((start + offset) % count + count) % count
        return true
    }

    nonisolated static func normalized(_ query: String) -> String {
        query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// The contract echoes the trimmed query; any other answer is stale.
    nonisolated static func accepts(pageQuery: String, currentQuery: String) -> Bool {
        normalized(pageQuery) == normalized(currentQuery)
    }

    private func receiveFailure(for request: RecipientSearchRequest) {
        guard request == currentRequest else { return }
        isSearching = false
        didFail = true
    }

    private func apply(_ items: [RecipientSuggestion], query: String, exclude: [String]) {
        let excluded = Set(exclude)
        let normalizedQuery = Self.normalized(query)
        let queryChanged = resultQuery != normalizedQuery
        suggestions = items.filter { !excluded.contains($0.email.lowercased()) }
        resultQuery = normalizedQuery
        if queryChanged {
            highlightedIndex = normalizedQuery.isEmpty || suggestions.isEmpty ? nil : 0
        } else if let index = highlightedIndex, !suggestions.indices.contains(index) {
            highlightedIndex = suggestions.isEmpty ? nil : suggestions.count - 1
        }
    }

    private func remember(_ items: [RecipientSuggestion], for request: RecipientSearchRequest) {
        if cache[request] == nil { cacheOrder.append(request) }
        cache[request] = items
        while cacheOrder.count > cacheLimit {
            cache[cacheOrder.removeFirst()] = nil
        }
    }
}
