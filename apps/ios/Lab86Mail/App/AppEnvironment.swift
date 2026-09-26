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
    let documents: DocumentStore
    let mailIdentity: MailIdentityStore
    let sessionStore: SessionStore
    let navigation = NavigationModel()
    let theme = ThemeStore()
    let notifications: NotificationCoordinator
    let oneTimeCodes: OneTimeCodeCoordinator
    let modelRouter: ModelRouter
    let webAuthentication: WebAuthenticationCoordinator
    let convex: ConvexClientWithAuth<String>?
    let mobileContainer: ModelContainer
    let commandOutbox: CommandOutbox
    let notificationResponseOutbox: NotificationResponseOutbox
    let syncCoordinator: SyncCoordinator
    // The mail list actions go through the command outbox (NAT-10).
    let mailCommands: OutboxMailCommandQueue
    private let drainCommandOutbox: @MainActor (String) async -> Bool
    let pendingSends: PendingSendCoordinator
    // Editable email drafts the agent produced inside conversations. Owned
    // here, not by a conversation, so they survive new chats and relaunch.
    let assistantDrafts: AssistantDraftStore
    let mobileClient: MobileV1Client?
    let briefHydration: BriefHydrationClient?
    // "Prepared for you" under the Brief: GET/POST /api/content?view=brief.
    let preparedWork: PreparedWorkClient?
    let accountStore: AccountStore
    // The plan, the trial note, and the optional Files surface (round 2).
    let trust: AccountTrustStore
    // The current Albatross conversation. Held here so switching destinations
    // does not discard an in-flight exchange; the sidebar plus starts a fresh
    // one. Distinct from intent capture, which stays a form.
    private(set) var assistantChat: AssistantChatModel?

    init(configuration: AppConfiguration) {
        self.configuration = configuration
        let sessionStore = SessionStore()
        self.sessionStore = sessionStore
        let syncCoordinator = SyncCoordinator()
        self.syncCoordinator = syncCoordinator
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
        trust = AccountTrustStore(backend: backend)
        documents = DocumentStore(backend: backend)
        webAuthentication = WebAuthenticationCoordinator(backend: backend)
        pendingSends = PendingSendCoordinator(backend: backend, tools: tools)
        self.mobileContainer = mobileContainer
        let commandOutbox = CommandOutbox(modelContainer: mobileContainer)
        self.commandOutbox = commandOutbox
        let notificationResponseOutbox = NotificationResponseOutbox(modelContainer: mobileContainer)
        self.notificationResponseOutbox = notificationResponseOutbox
        let bootstrapSource: any MobileBootstrapFetching
        let processor: CommandOutboxProcessor?
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
            preparedWork = PreparedWorkClient(
                baseURL: apiBaseURL,
                tokenProvider: tokenProvider
            )
            bootstrapSource = mobileClient
            processor = CommandOutboxProcessor(
                outbox: commandOutbox,
                submitter: mobileClient
            )
        } else {
            mobileClient = nil
            briefHydration = nil
            preparedWork = nil
            processor = nil
            bootstrapSource = UnavailableMobileBootstrapSource()
        }
        // One drain at a time for each owner, whoever asks for it.
        let drainCommandOutbox: @MainActor (String) async -> Bool = { ownerID in
            guard let processor else { return false }
            return await syncCoordinator.run(ownerID: ownerID, domain: "command-outbox") {
                let result = await processor.drain(ownerID: ownerID)
                return result.deferred == 0 && result.permanentlyFailed == 0
            }
        }
        self.drainCommandOutbox = drainCommandOutbox
        let mailCommands = OutboxMailCommandQueue(
            outbox: commandOutbox,
            ownerID: { sessionStore.ownerID },
            drain: drainCommandOutbox
        )
        self.mailCommands = mailCommands
        accountStore = AccountStore(
            repository: AccountRepository(
                cache: AccountCache(modelContainer: mobileContainer),
                cursorStore: commandOutbox,
                remote: bootstrapSource
            )
        )
        convex = convexClient
        let store = ProductStore(
            tools: tools,
            backend: backend,
            convex: convexClient,
            mailPages: mobileClient,
            mailCommands: mailCommands
        )
        self.store = store
        assistantDrafts = AssistantDraftStore(transport: store)
        mailIdentity = MailIdentityStore(tools: tools, baseURL: configuration.apiBaseURL)
        notifications = NotificationCoordinator(
            backend: backend,
            responseOutbox: notificationResponseOutbox
        )
        oneTimeCodes = OneTimeCodeCoordinator(backend: backend)
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
        // A mail action that waits for the network is tried again when due.
        mailCommands.onRetryDue = { [weak self] in
            guard let self else { return }
            _ = await self.flushCommandOutbox(ownerID: self.sessionStore.ownerID)
        }
    }

    func startAssistantChat(scope: AssistantChatScope = .global, route: BarRoute = .ask) {
        let model = makeAssistantChat(scope: scope)
        if route == .hold { model.presetRoute(.hold) }
        assistantChat = model
        #if os(macOS)
        navigation.chatPanelPresented = true
        #else
        navigation.selectPrimary(.chat)
        #endif
    }

    private func makeAssistantChat(scope: AssistantChatScope) -> AssistantChatModel {
        let sessionStore = self.sessionStore
        return AssistantChatModel(
            backend: backend,
            baseURL: configuration.apiBaseURL,
            scope: scope,
            draftStore: assistantDrafts,
            ownerIDProvider: { sessionStore.ownerID }
        )
    }

    /// Brings the conversation that holds an inline draft back on screen,
    /// restoring it from history when it is not the current one.
    func revealAssistantChat(sessionID: String) async {
        if assistantChat?.sessionID != sessionID {
            let model = makeAssistantChat(scope: .global)
            await model.restore(sessionID: sessionID)
            assistantChat = model
        }
        #if os(macOS)
        navigation.chatPanelPresented = true
        #else
        navigation.selectPrimary(.chat)
        #endif
    }

    // ⌘K and the chat button. The Mac toggles its floating panel, keeping the
    // in-flight conversation; iOS keeps its start-a-chat behavior.
    func toggleAssistantChatPanel() {
        #if os(macOS)
        if navigation.chatPanelPresented {
            navigation.chatPanelPresented = false
        } else {
            if assistantChat == nil {
                assistantChat = makeAssistantChat(scope: .global)
            }
            navigation.chatPanelPresented = true
        }
        #else
        startAssistantChat()
        #endif
    }

    func createAndOpenDocument(kind: AlbatrossDocumentKind) async throws {
        let document = try await documents.create(kind: kind)
        navigation.openDocument(id: document.id)
    }

    func flushCommandOutbox(ownerID: String?) async -> Bool {
        guard let ownerID else { return true }
        let drained = await drainCommandOutbox(ownerID)
        // A drain settles mail list actions sent earlier, also before a
        // relaunch; the lists keep or roll back their changes (NAT-10).
        await store.reconcileMailCommands(await mailCommands.listCommands(ownerID: ownerID))
        return drained
    }

    /// Reads the Today summary and hands it to the widget (round 2, FEATURES
    /// item 19). A failed read keeps the widget's last good snapshot.
    func refreshTodayWidget() async {
        #if os(iOS)
        guard sessionStore.ownerID != nil, let mobileClient else { return }
        guard let snapshot = try? await mobileClient.fetchTodaySummary() else { return }
        TodayWidgetBridge.publish(snapshot)
        #endif
    }

    func refreshAccounts(ownerID: String) async -> Bool {
        let accountStore = accountStore
        return await syncCoordinator.run(ownerID: ownerID, domain: MobileDomain.accounts.rawValue) {
            await accountStore.load(ownerID: ownerID)
        }
    }
}
