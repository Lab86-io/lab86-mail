import ClerkKit
import CoreSpotlight
import SwiftUI

@main
struct Lab86MailApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
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
    }

    private var configuredRoot: some View {
        RootView()
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
                .onReceive(NotificationCenter.default.publisher(for: .lab86OpenRoute)) { notification in
                    guard let route = notification.object as? String else { return }
                    environment.navigation.open(route: route)
                }
                .onReceive(NotificationCenter.default.publisher(for: .lab86NotificationAction)) { notification in
                    guard let input = notification.object as? [String: String],
                          let suggestionId = input["suggestionId"],
                          let action = input["action"] else { return }
                    Task {
                        await environment.store.actOnSuggestion(id: suggestionId, action: action)
                        if let route = input["route"] { environment.navigation.open(route: route) }
                    }
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
