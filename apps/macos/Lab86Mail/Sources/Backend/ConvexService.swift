import Combine
import ConvexMobile
import Foundation

// Thin typed wrapper over the Convex live-query surface (liveMail.*).
@MainActor
final class ConvexService {
    let client: ConvexClientWithAuth<String>
    let authProvider: Lab86ConvexAuthProvider

    init() {
        let provider = Lab86ConvexAuthProvider()
        client = ConvexClientWithAuth(deploymentUrl: Config.convexDeploymentUrl, authProvider: provider)
        provider.bind(client: client)
        authProvider = provider
    }

    func accounts() -> AnyPublisher<AccountsResult, ClientError> {
        client.subscribe(to: "liveMail:listAccounts", yielding: AccountsResult.self)
    }

    func threads(accountIds: [String]?, category: String?, query: String?, limit: Int)
        -> AnyPublisher<ThreadListResult, ClientError>
    {
        var args: [String: ConvexEncodable?] = ["limit": Double(limit)]
        if let accountIds, !accountIds.isEmpty { args["accountIds"] = accountIds.map { $0 as (any ConvexEncodable)? } }
        if let category, !category.isEmpty { args["category"] = category }
        if let query, !query.isEmpty { args["query"] = query }
        return client.subscribe(to: "liveMail:listThreads", with: args, yielding: ThreadListResult.self)
    }

    func thread(account: String, threadId: String) -> AnyPublisher<ThreadDetail?, ClientError> {
        client.subscribe(
            to: "liveMail:getThread",
            with: ["account": account, "threadId": threadId],
            yielding: ThreadDetail?.self
        )
    }

    func categoryCounts(accountIds: [String]?) -> AnyPublisher<CategoryCountsResult, ClientError> {
        var args: [String: ConvexEncodable?] = [:]
        if let accountIds, !accountIds.isEmpty { args["accountIds"] = accountIds.map { $0 as (any ConvexEncodable)? } }
        return client.subscribe(to: "liveMail:categoryCounts", with: args, yielding: CategoryCountsResult.self)
    }
}
