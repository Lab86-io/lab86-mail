import UIKit
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
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

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound, .badge]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        let route = info["route"] as? String
            ?? info["deepLink"] as? String
            ?? "/activity"
        if let textResponse = response as? UNTextInputNotificationResponse {
            let text = textResponse.userText.trimmingCharacters(in: .whitespacesAndNewlines)
            let input: NotificationTextResponse?
            if response.actionIdentifier == "ANSWER_CHECKIN",
               let notificationID = info["notificationId"] as? String {
                input = NotificationTextResponse(
                    kind: .checkIn(
                        notificationID: notificationID,
                        promptKind: info["promptKind"] as? String ?? "reflection"
                    ),
                    text: text
                )
            } else if response.actionIdentifier == "MAIL_REPLY",
                      let accountID = info["accountId"] as? String,
                      let threadID = info["threadId"] as? String,
                      let messageID = info["messageId"] as? String {
                input = NotificationTextResponse(
                    kind: .mail(
                        accountID: accountID,
                        threadID: threadID,
                        messageID: messageID
                    ),
                    text: text
                )
            } else {
                input = nil
            }
            if let input, !text.isEmpty {
                let handled = await NotificationCoordinator.handleTextResponse(input)
                if !handled {
                    await notifyResponseFailure()
                }
                return
            }
        }
        if let accountID = info["accountId"] as? String,
           let threadID = info["threadId"] as? String,
           ["MAIL_MARK_READ", "MAIL_ARCHIVE", "MAIL_REPLY"].contains(response.actionIdentifier) {
            if response.actionIdentifier == "MAIL_REPLY" {
                let defaults = UserDefaults.standard
                defaults.set("reply", forKey: "pendingAlbatrossComposeMode")
                defaults.set(accountID, forKey: "pendingAlbatrossComposeAccount")
                defaults.set(threadID, forKey: "pendingAlbatrossComposeThread")
                defaults.set(info["messageId"] as? String, forKey: "pendingAlbatrossComposeMessage")
                defaults.set("", forKey: "pendingAlbatrossComposeRecipient")
                defaults.set("", forKey: "pendingAlbatrossComposeSubject")
                defaults.set("", forKey: "pendingAlbatrossComposeBody")
            } else {
                let defaults = UserDefaults.standard
                defaults.set(
                    response.actionIdentifier == "MAIL_MARK_READ" ? "mark_read" : "archive",
                    forKey: "pendingAlbatrossMailNotificationAction"
                )
                defaults.set(accountID, forKey: "pendingAlbatrossMailNotificationAccount")
                defaults.set(threadID, forKey: "pendingAlbatrossMailNotificationThread")
                NotificationCenter.default.post(name: .lab86MailNotificationAction, object: nil)
            }
            return
        }
        if response.actionIdentifier == "CHECKIN_LATER" { return }
        if let suggestionId = info["suggestionId"] as? String,
           (response.actionIdentifier == "ADD_TO_CALENDAR" || response.actionIdentifier == "DISMISS") {
            NotificationCenter.default.post(
                name: .lab86NotificationAction,
                object: [
                    "suggestionId": suggestionId,
                    "action": response.actionIdentifier == "ADD_TO_CALENDAR" ? "accept" : "dismiss",
                    "route": route,
                ]
            )
        }
        NotificationCenter.default.post(name: .lab86OpenRoute, object: route)
    }

    private nonisolated func notifyResponseFailure() async {
        let content = UNMutableNotificationContent()
        content.title = "Albatross couldn’t send that reply"
        content.body = "Open the app to try again."
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: "notification-response-failed-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        try? await UNUserNotificationCenter.current().add(request)
    }
}
