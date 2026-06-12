import Combine
import Foundation
import Observation

// What the thread list is currently showing — the native analog of the web
// app's primaryView + query/category state.
enum MailScope: Hashable {
    case inbox
    case category(SmartCategory)
    case customLabel(String)  // categoryCounts key, e.g. "custom:smart-label-dev-ops"
    case quickSearch(QuickSearch)
    case search(String)

    var title: String {
        switch self {
        case .inbox: "Inbox"
        case let .category(category): category.title
        case let .customLabel(key): MailStore.customLabelTitle(for: key)
        case let .quickSearch(quick): quick.title
        case .search: "Search"
        }
    }
}

@MainActor
@Observable
final class MailStore {
    let convex: ConvexService
    let api: MailAPI

    var accounts: [MailAccount] = []
    // nil = unified inbox across every connected account.
    var accountFilter: [String]? {
        didSet {
            if accountFilter != oldValue {
                resubscribeCounts()
                resubscribeThreads()
            }
        }
    }
    var scope: MailScope = .inbox {
        didSet { if scope != oldValue { resubscribeThreads() } }
    }
    var threads: [MailThread] = []
    var threadsLoading = false
    var categoryCounts: [String: Int] = [:]
    var attention: Set<String> = []
    // Custom smart labels discovered from live categoryCounts keys.
    var customLabelKeys: [String] = []

    var selectedThreadKey: String? {
        didSet { if selectedThreadKey != oldValue { resubscribeDetail() } }
    }
    var threadDetail: ThreadDetail?
    var detailLoading = false

    var pageLimit = 60
    var lastError: String?
    var composePresented = false

    @ObservationIgnored private var threadsCancellable: AnyCancellable?
    @ObservationIgnored private var detailCancellable: AnyCancellable?
    @ObservationIgnored private var accountsCancellable: AnyCancellable?
    @ObservationIgnored private var countsCancellable: AnyCancellable?

    init(convex: ConvexService, api: MailAPI) {
        self.convex = convex
        self.api = api
    }

    var selectedThread: MailThread? {
        threads.first { $0.id == selectedThreadKey }
    }

    static func customLabelTitle(for key: String) -> String {
        key.replacingOccurrences(of: "custom:", with: "")
            .replacingOccurrences(of: "smart-label-", with: "")
            .split(separator: "-")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    func start() {
        // Complete the Clerk→Convex token exchange BEFORE subscribing.
        // Subscriptions opened mid-handshake execute unauthenticated, the
        // server throws ("Server Error"), and the dead publishers never
        // recover — which is how the rail ended up with no accounts/badges.
        Task { @MainActor in
            _ = await convex.client.loginFromCache()
            subscribeAccounts()
            resubscribeCounts()
            resubscribeThreads()
        }
    }

    func stop() {
        accountsCancellable = nil
        countsCancellable = nil
        threadsCancellable = nil
        detailCancellable = nil
        threads = []
        accounts = []
        threadDetail = nil
        categoryCounts = [:]
        customLabelKeys = []
    }

    func loadMore() {
        guard pageLimit < 200 else { return }
        pageLimit = min(200, pageLimit + 60)
        resubscribeThreads()
    }

    private func subscribeAccounts() {
        accountsCancellable = convex.accounts()
            .retry(2)
            .receive(on: DispatchQueue.main)
            .sink { _ in } receiveValue: { [weak self] result in
                self?.accounts = result.accounts
            }
    }

    private func resubscribeCounts() {
        countsCancellable = convex.categoryCounts(accountIds: accountFilter)
            .retry(2)
            .receive(on: DispatchQueue.main)
            .sink { _ in } receiveValue: { [weak self] result in
                guard let self else { return }
                categoryCounts = result.counts.mapValues { Int($0.unread ?? 0) }
                attention = Set(result.counts.filter { $0.value.attention == true }.keys)
                customLabelKeys = result.counts.keys
                    .filter { $0.hasPrefix("custom:") }
                    .sorted()
            }
    }

    private func resubscribeThreads() {
        threadsLoading = true
        var category: String?
        var query: String?
        switch scope {
        case .inbox:
            break
        case let .category(c):
            category = c.rawValue
        case let .customLabel(key):
            category = key
        case let .quickSearch(quick):
            query = quick.query
        case let .search(text):
            query = text
        }
        threadsCancellable = convex
            .threads(accountIds: accountFilter, category: category, query: query, limit: pageLimit)
            .retry(2)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] completion in
                self?.threadsLoading = false
                if case let .failure(error) = completion {
                    self?.lastError = String(describing: error)
                }
            } receiveValue: { [weak self] result in
                self?.threadsLoading = false
                self?.threads = result.items
            }
    }

    private func resubscribeDetail() {
        threadDetail = nil
        guard let thread = selectedThread else {
            detailCancellable = nil
            return
        }
        detailLoading = true
        detailCancellable = convex.thread(account: thread.account, threadId: thread.threadId)
            .retry(2)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] completion in
                self?.detailLoading = false
                if case let .failure(error) = completion {
                    self?.lastError = String(describing: error)
                }
            } receiveValue: { [weak self] detail in
                self?.detailLoading = false
                self?.threadDetail = detail
            }
        if thread.unread {
            markRead(thread)
        }
    }

    // MARK: - Actions (optimistic, server-confirmed via live queries)

    func archive(_ thread: MailThread) {
        threads.removeAll { $0.id == thread.id }
        if selectedThreadKey == thread.id { selectedThreadKey = nil }
        Task { [api] in
            do { try await api.archiveThread(account: thread.account, threadId: thread.threadId) }
            catch { self.lastError = error.localizedDescription }
        }
    }

    func trash(_ thread: MailThread) {
        threads.removeAll { $0.id == thread.id }
        if selectedThreadKey == thread.id { selectedThreadKey = nil }
        Task { [api] in
            do { try await api.trashThread(account: thread.account, threadId: thread.threadId) }
            catch { self.lastError = error.localizedDescription }
        }
    }

    func markRead(_ thread: MailThread) {
        if let index = threads.firstIndex(where: { $0.id == thread.id }) {
            threads[index].unread = false
        }
        Task { [api] in
            try? await api.markThreadRead(account: thread.account, threadId: thread.threadId)
        }
    }

    func toggleStar(message: MailMessage) {
        Task { [api] in
            do { try await api.setStar(account: message.account, messageId: message._id, starred: !message.starred) }
            catch { self.lastError = error.localizedDescription }
        }
    }

    // MARK: - Keyboard navigation

    func selectNext() {
        guard !threads.isEmpty else { return }
        guard let current = threads.firstIndex(where: { $0.id == selectedThreadKey }) else {
            selectedThreadKey = threads.first?.id
            return
        }
        if current + 1 < threads.count { selectedThreadKey = threads[current + 1].id }
    }

    func selectPrevious() {
        guard !threads.isEmpty else { return }
        guard let current = threads.firstIndex(where: { $0.id == selectedThreadKey }) else {
            selectedThreadKey = threads.first?.id
            return
        }
        if current > 0 { selectedThreadKey = threads[current - 1].id }
    }
}
