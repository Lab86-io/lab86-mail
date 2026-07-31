import UIKit
import UserNotifications

// UNUserNotificationCenterDelegate is imported without isolation, so an async
// method that satisfies it completes wherever its task ends. The compiler then
// calls the Objective-C completion handler from there, and UIKit does real work
// inside that handler — it updates the state-restoration archive and the app
// snapshot, both of which assert that they are on the main thread. A response
// handler left off the main actor therefore aborts the app at the moment the
// user taps the notification. The conformance is declared @preconcurrency so
// these methods can stay main-actor isolated, which is where they belong.
final class AppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        NotificationCoordinator.configureCategories()
        BackgroundRefreshCoordinator.shared.register()
        return true
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        // A code push is the one case where the wake has a specific job: get the
        // code into AutoFill before the user reaches the field they are about to
        // fill. Announced separately from the general refresh so it is not
        // waiting behind a full mail sync.
        if userInfo["codeAvailable"] as? Bool == true {
            NotificationCenter.default.post(name: .lab86OneTimeCodeAvailable, object: nil)
        }
        Task { @MainActor in
            await BackgroundRefreshCoordinator.shared.runRemoteNotification(completion: completionHandler)
        }
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .lab86DeviceToken, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .lab86DeviceToken, object: nil, userInfo: ["error": error])
    }

    @MainActor
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound, .badge]
    }

    @MainActor
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let plan = NotificationResponseRouter.plan(
            for: NotificationResponseInput(
                actionIdentifier: response.actionIdentifier,
                userInfo: response.notification.request.content.userInfo,
                userText: (response as? UNTextInputNotificationResponse)?.userText
            )
        )
        if let textResponse = plan.textResponse {
            let handled = await NotificationCoordinator.handleTextResponse(textResponse)
            if !handled {
                await notifyResponseFailure()
            }
            return
        }
        Self.apply(plan)
    }

    @MainActor
    static func apply(_ plan: NotificationResponsePlan) {
        apply(plan, defaults: .standard)
    }

    @MainActor
    static func apply(_ plan: NotificationResponsePlan, defaults: UserDefaults) {
        if let reply = plan.bannerReply {
            defaults.set("reply", forKey: "pendingAlbatrossComposeMode")
            defaults.set(reply.accountID, forKey: "pendingAlbatrossComposeAccount")
            defaults.set(reply.threadID, forKey: "pendingAlbatrossComposeThread")
            defaults.set(reply.messageID, forKey: "pendingAlbatrossComposeMessage")
            defaults.set("", forKey: "pendingAlbatrossComposeRecipient")
            defaults.set("", forKey: "pendingAlbatrossComposeSubject")
            defaults.set("", forKey: "pendingAlbatrossComposeBody")
        }
        if let action = plan.bannerAction {
            defaults.set(action.kind.rawValue, forKey: "pendingAlbatrossMailNotificationAction")
            defaults.set(action.accountID, forKey: "pendingAlbatrossMailNotificationAccount")
            defaults.set(action.threadID, forKey: "pendingAlbatrossMailNotificationThread")
            NotificationCenter.default.post(name: .lab86MailNotificationAction, object: nil)
        }
        if let suggestion = plan.suggestion {
            NotificationCenter.default.post(
                name: .lab86NotificationAction,
                object: [
                    "suggestionId": suggestion.suggestionID,
                    "action": suggestion.action,
                ]
            )
        }
        if let route = plan.route {
            // A tap that launches the app arrives before the shell exists to
            // hear an announcement, so the route is written down first. The
            // post only asks whoever is already listening to read it now; the
            // shell reads the same key when it appears.
            defaults.set(route, forKey: "pendingAlbatrossDeepLink")
            NotificationCenter.default.post(name: .lab86OpenRoute, object: route)
        }
    }

    private nonisolated func notifyResponseFailure() async {
        let content = UNMutableNotificationContent()
        content.title = "Reply saved for retry"
        content.body = "Albatross will send it when the app reconnects."
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: "notification-response-failed-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        try? await UNUserNotificationCenter.current().add(request)
    }
}
