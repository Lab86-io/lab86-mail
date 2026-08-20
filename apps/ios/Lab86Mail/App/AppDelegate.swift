#if os(iOS)
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
        await NotificationResponseApplier.handle(
            actionIdentifier: response.actionIdentifier,
            userInfo: response.notification.request.content.userInfo,
            userText: (response as? UNTextInputNotificationResponse)?.userText
        )
    }
}
#endif
