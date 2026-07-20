import Foundation

protocol MobileBootstrapFetching: Sendable {
    func fetchBootstrap() async throws -> MobileBootstrapSnapshot
}

struct UnavailableMobileBootstrapSource: MobileBootstrapFetching {
    func fetchBootstrap() async throws -> MobileBootstrapSnapshot {
        throw AccountRepositoryError.configuration
    }
}

actor AccountRepository {
    private let cache: AccountCache
    private let cursorStore: CommandOutbox
    private let remote: any MobileBootstrapFetching

    init(
        cache: AccountCache,
        cursorStore: CommandOutbox,
        remote: any MobileBootstrapFetching
    ) {
        self.cache = cache
        self.cursorStore = cursorStore
        self.remote = remote
    }

    func cachedAccounts(ownerID: String) async throws -> [MobileAccount] {
        try await cache.accounts(ownerID: ownerID)
    }

    func refresh(ownerID: String) async throws -> MobileBootstrapSnapshot {
        let snapshot = try await remote.fetchBootstrap()
        guard snapshot.user.id == ownerID else {
            throw AccountRepositoryError.ownerMismatch(
                expected: ownerID,
                received: snapshot.user.id
            )
        }
        try await cache.replace(ownerID: ownerID, accounts: snapshot.accounts)
        if let cursor = snapshot.cursors[.accounts] {
            try await cursorStore.saveCursor(
                ownerID: ownerID,
                domain: MobileDomain.accounts.rawValue,
                cursor: cursor,
                serverRevision: Int(cursor) ?? 0
            )
        }
        return snapshot
    }
}
