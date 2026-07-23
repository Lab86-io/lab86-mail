import ClerkConvex
import ClerkKit
import ConvexMobile
import Foundation
import Observation
import SwiftData

@MainActor
@Observable
final class AppEnvironment {
    let configuration: AppConfiguration
    let backend: BackendClient
    let tools: ToolClient
    let store: ProductStore
    let sessionStore = SessionStore()
    let navigation = NavigationModel()
    let theme = ThemeStore()
    let notifications: NotificationCoordinator
    let modelRouter: ModelRouter
    let webAuthentication: WebAuthenticationCoordinator
    let convex: ConvexClientWithAuth<String>?
    let mobileContainer: ModelContainer
    let commandOutbox: CommandOutbox
    let syncCoordinator = SyncCoordinator()
    let pendingSends: PendingSendCoordinator
    let mobileClient: MobileV1Client?
    let outboxProcessor: CommandOutboxProcessor?
    let accountStore: AccountStore
    // The current Albatross conversation. Held here so switching destinations
    // does not discard an in-flight exchange; the sidebar plus starts a fresh
    // one. Distinct from intent capture, which stays a form.
    private(set) var assistantChat: AssistantChatModel?

    init(configuration: AppConfiguration) {
        self.configuration = configuration
        let tokenProvider: @Sendable () async throws -> String = {
            try await ClerkSessionAccess.activeToken()
        }
        let backend = BackendClient(
            baseURL: configuration.apiBaseURL,
            tokenProvider: tokenProvider
        )
        let tools = ToolClient(backend: backend)
        let mobileContainer = MobilePersistence.makeContainer()
        let convexClient: ConvexClientWithAuth<String>?
        if configuration.clerkPublishableKey != nil, let deploymentURL = configuration.convexDeploymentURL {
            convexClient = ConvexClientWithAuth(
                deploymentUrl: deploymentURL,
                authProvider: ClerkConvexAuthProvider()
            )
        } else {
            convexClient = nil
        }
        self.backend = backend
        self.tools = tools
        webAuthentication = WebAuthenticationCoordinator(backend: backend)
        pendingSends = PendingSendCoordinator(backend: backend, tools: tools)
        self.mobileContainer = mobileContainer
        let commandOutbox = CommandOutbox(modelContainer: mobileContainer)
        self.commandOutbox = commandOutbox
        let bootstrapSource: any MobileBootstrapFetching
        if let apiBaseURL = configuration.apiBaseURL {
            let mobileClient = MobileV1Client(
                baseURL: apiBaseURL,
                tokenProvider: tokenProvider
            )
            self.mobileClient = mobileClient
            bootstrapSource = mobileClient
            outboxProcessor = CommandOutboxProcessor(
                outbox: commandOutbox,
                submitter: mobileClient
            )
        } else {
            mobileClient = nil
            outboxProcessor = nil
            bootstrapSource = UnavailableMobileBootstrapSource()
        }
        accountStore = AccountStore(
            repository: AccountRepository(
                cache: AccountCache(modelContainer: mobileContainer),
                cursorStore: commandOutbox,
                remote: bootstrapSource
            )
        )
        convex = convexClient
        store = ProductStore(tools: tools, backend: backend, convex: convexClient)
        notifications = NotificationCoordinator(backend: backend)
        modelRouter = ModelRouter(tools: tools)
    }

    func startAssistantChat(scope: AssistantChatScope = .global) {
        assistantChat = AssistantChatModel(
            backend: backend,
            baseURL: configuration.apiBaseURL,
            scope: scope
        )
        navigation.selectPrimary(.chat)
    }

    func flushCommandOutbox(ownerID: String?) async -> Bool {
        guard let ownerID else { return true }
        guard let outboxProcessor else { return false }
        return await syncCoordinator.run(ownerID: ownerID, domain: "command-outbox") {
            let result = await outboxProcessor.drain(ownerID: ownerID)
            return result.deferred == 0 && result.permanentlyFailed == 0
        }
    }

    func refreshAccounts(ownerID: String) async -> Bool {
        let accountStore = accountStore
        return await syncCoordinator.run(ownerID: ownerID, domain: MobileDomain.accounts.rawValue) {
            await accountStore.load(ownerID: ownerID)
        }
    }
}
