import Foundation
import Observation

enum AccountLoadState: Equatable, Sendable {
    case idle
    case loading
    case ready
    case failed
}

@MainActor
@Observable
final class AccountStore {
    private let repository: AccountRepository
    private(set) var state: AccountLoadState = .idle
    private(set) var accounts: [MobileAccount] = []
    private(set) var user: MobileBootstrapUser?
    private(set) var notificationSettings: MobileNotificationSettings?
    private(set) var featureFlags: [String: Bool] = [:]
    private(set) var isRefreshing = false
    private(set) var isUsingCachedData = false
    private(set) var errorMessage: String?
    private var ownerID: String?

    init(repository: AccountRepository) {
        self.repository = repository
    }

    @discardableResult
    func load(ownerID: String) async -> Bool {
        if self.ownerID != ownerID {
            reset(for: ownerID)
        }
        if accounts.isEmpty {
            state = .loading
            do {
                accounts = try await repository.cachedAccounts(ownerID: ownerID)
                isUsingCachedData = !accounts.isEmpty
            } catch {
                errorMessage = error.localizedDescription
            }
        }

        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let snapshot = try await repository.refresh(ownerID: ownerID)
            guard self.ownerID == ownerID else { return false }
            accounts = snapshot.accounts
            user = snapshot.user
            notificationSettings = snapshot.notificationSettings
            featureFlags = snapshot.featureFlags
            isUsingCachedData = false
            errorMessage = nil
            state = .ready
            return true
        } catch {
            guard self.ownerID == ownerID else { return false }
            errorMessage = error.localizedDescription
            isUsingCachedData = !accounts.isEmpty
            state = accounts.isEmpty ? .failed : .ready
            return false
        }
    }

    func clear() {
        reset(for: nil)
    }

    private func reset(for ownerID: String?) {
        self.ownerID = ownerID
        state = .idle
        accounts = []
        user = nil
        notificationSettings = nil
        featureFlags = [:]
        isRefreshing = false
        isUsingCachedData = false
        errorMessage = nil
    }
}
