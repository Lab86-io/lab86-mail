import ClerkConvex
import ClerkKit
import ConvexMobile
import Foundation
import MobileAPI
import Observation
import SwiftData

@MainActor
@Observable
final class AppEnvironment {
    let configuration: AppConfiguration
    let backend: BackendClient
    let tools: ToolClient
    let store: ProductStore
    let mailIdentity: MailIdentityStore
    let sessionStore = SessionStore()
    let navigation = NavigationModel()
    let theme = ThemeStore()
    let notifications: NotificationCoordinator
    let modelRouter: ModelRouter
    let webAuthentication: WebAuthenticationCoordinator
    let convex: ConvexClientWithAuth<String>?
    let mobileContainer: ModelContainer
    let commandOutbox: CommandOutbox
    let notificationResponseOutbox: NotificationResponseOutbox
    let syncCoordinator = SyncCoordinator()
    let pendingSends: PendingSendCoordinator
    let mobileClient: MobileV1Client?
    let briefHydration: BriefHydrationClient?
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
        let notificationResponseOutbox = NotificationResponseOutbox(modelContainer: mobileContainer)
        self.notificationResponseOutbox = notificationResponseOutbox
        let bootstrapSource: any MobileBootstrapFetching
        if let apiBaseURL = configuration.apiBaseURL {
            let mobileClient = MobileV1Client(
                baseURL: apiBaseURL,
                tokenProvider: tokenProvider
            )
            self.mobileClient = mobileClient
            briefHydration = BriefHydrationClient(
                baseURL: apiBaseURL,
                tokenProvider: tokenProvider
            )
            bootstrapSource = mobileClient
            outboxProcessor = CommandOutboxProcessor(
                outbox: commandOutbox,
                submitter: mobileClient
            )
        } else {
            mobileClient = nil
            briefHydration = nil
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
        mailIdentity = MailIdentityStore(tools: tools)
        notifications = NotificationCoordinator(
            backend: backend,
            responseOutbox: notificationResponseOutbox
        )
        modelRouter = ModelRouter(tools: tools)
        NotificationCoordinator.installTextResponseHandler { [backend, store] response in
            do {
                switch response.kind {
                case .checkIn(let notificationID, let promptKind):
                    let result = try await backend.post(
                        path: "/api/mobile/notifications/respond",
                        body: .object([
                            "notificationId": .string(notificationID),
                            "promptKind": .string(promptKind),
                            "responseText": .string(response.text),
                        ])
                    )
                    guard result["ok"]?.boolValue == true else { return false }
                    await store.refreshToday()
                    return true
                case .mail(let accountID, let threadID, let messageID):
                    try await store.reply(
                        accountID: accountID,
                        threadID: threadID,
                        messageID: messageID,
                        body: response.text
                    )
                    await store.refreshMail()
                    return true
                }
            } catch {
                return false
            }
        }
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
