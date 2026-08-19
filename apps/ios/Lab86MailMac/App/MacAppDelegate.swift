import AppKit
import UserNotifications

// AppKit half of the shared notification loop. Remote pushes register at
// launch — the token only reaches the server once a signed-in coordinator
// consumes the .lab86DeviceToken announcement, so early registration is safe.
// There is no BGTaskScheduler on macOS; a running Mac app stays fresh through
// the Convex live subscriptions and the remote-notification wake below.
final class MacAppDelegate: NSObject, NSApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
        NotificationCoordinator.configureCategories()
        NSApplication.shared.registerForRemoteNotifications()
    }

    // Closing the last window must not kill the product loop: pushes, the
    // menu-bar presence, and the outbox all assume the process stays alive.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .lab86DeviceToken, object: deviceToken)
    }

    func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .lab86DeviceToken, object: nil, userInfo: ["error": error])
    }

    func application(_ application: NSApplication, didReceiveRemoteNotification userInfo: [String: Any]) {
        if userInfo["codeAvailable"] as? Bool == true {
            NotificationCenter.default.post(name: .lab86OneTimeCodeAvailable, object: nil)
        }
        NotificationCenter.default.post(name: .lab86RemoteWake, object: nil)
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

extension Notification.Name {
    // Posted when a silent remote notification wakes the Mac app; the shell
    // responds by flushing the command outbox and refreshing the active data.
    static let lab86RemoteWake = Notification.Name("io.lab86.mail.remote-wake")
}
