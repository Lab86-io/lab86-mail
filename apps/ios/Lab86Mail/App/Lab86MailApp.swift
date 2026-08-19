import ClerkKit
import CoreSpotlight
import SwiftUI

@main
struct Lab86MailApp: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #else
    @NSApplicationDelegateAdaptor(MacAppDelegate.self) private var appDelegate
    #endif
    @State private var environment: AppEnvironment
    private let configuration: AppConfiguration

    init() {
        FontRegistrar.registerBundledFonts()
        let configuration = AppConfiguration.current
        self.configuration = configuration
        if let key = configuration.clerkPublishableKey {
            Clerk.configure(
                publishableKey: key,
                options: ClerkConfiguration.options(for: key)
            )
        }
        _environment = State(initialValue: AppEnvironment(configuration: configuration))
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if configuration.clerkPublishableKey != nil {
                    configuredRoot
                } else {
                    ConfigurationRequiredView(keys: configuration.missingKeys)
                }
            }
        }
        .commands {
            AlbatrossCommands(environment: environment)
        }
        #if os(macOS)
        // The torn-out chat panel. Shares the live conversation model with the
        // in-window panel; opened from the panel's pop-out control.
        Window("Albatross Chat", id: MacChatWindowScene.identifier) {
            MacChatWindowRoot()
                .tint(environment.theme.accentColor)
                .environment(environment)
        }
        .defaultSize(width: 440, height: 620)
        #endif
    }

    private var configuredRoot: some View {
        RootView()
            .overlay {
                GrainOverlay(amount: environment.theme.grain)
            }
            .tint(environment.theme.accentColor)
            .preferredColorScheme(environment.theme.appearance.colorScheme)
            .environment(environment)
            .environment(Clerk.shared)
                .onOpenURL { url in
                    Task {
                        _ = try? await Clerk.shared.handle(url)
                        environment.navigation.open(url)
                    }
                }
                .onReceive(NotificationCenter.default.publisher(for: .lab86DeviceToken)) { notification in
                    guard let token = notification.object as? Data else { return }
                    Task { await environment.notifications.register(deviceToken: token) }
                }
                .onReceive(NotificationCenter.default.publisher(for: .lab86NotificationRequest)) { _ in
                    environment.navigation.consumeAppIntentRequests()
                }
                .onReceive(NotificationCenter.default.publisher(for: .lab86NotificationAction)) { notification in
                    guard let input = notification.object as? [String: String],
                          let suggestionId = input["suggestionId"],
                          let action = input["action"] else { return }
                    Task { await environment.store.actOnSuggestion(id: suggestionId, action: action) }
                }
                .onContinueUserActivity(CSSearchableItemActionType) { activity in
                    guard let identifier = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
                          let route = MailSpotlightRecord.threadRoute(fromUniqueIdentifier: identifier) else {
                        return
                    }
                    environment.navigation.selectedTab = .mail
                    environment.navigation.threadRoute = route
                }
    }
}
