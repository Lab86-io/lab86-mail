import Foundation
import UserNotifications

// Platform-neutral half of notification response handling. Both application
// delegates (UIKit and AppKit) route their UNUserNotificationCenter responses
// here so banner replies, banner actions, suggestions, and deep-link routes
// behave identically on every platform.
enum NotificationResponseApplier {
    @MainActor
    static func apply(_ plan: NotificationResponsePlan, defaults: UserDefaults = .standard) {
        // Anything written here is read by the shell, either now or when it
        // appears. The announcement at the end is what covers the case where
        // the app was already in front of the user.
        var wroteRequest = false
        if let reply = plan.bannerReply {
            defaults.set("reply", forKey: "pendingAlbatrossComposeMode")
            defaults.set(reply.accountID, forKey: "pendingAlbatrossComposeAccount")
            defaults.set(reply.threadID, forKey: "pendingAlbatrossComposeThread")
            defaults.set(reply.messageID, forKey: "pendingAlbatrossComposeMessage")
            defaults.set("", forKey: "pendingAlbatrossComposeRecipient")
            defaults.set("", forKey: "pendingAlbatrossComposeSubject")
            // What the user dictated, when the reply could not be sent from the
            // banner. Losing it and opening an empty composer is worse than
            // opening one that already holds their words.
            defaults.set(reply.text, forKey: "pendingAlbatrossComposeBody")
            wroteRequest = true
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
            // A response that launches the app arrives before the shell exists
            // to hear an announcement, so the route is written down first. The
            // shell reads the same key when it appears.
            defaults.set(route, forKey: "pendingAlbatrossDeepLink")
            wroteRequest = true
        }
        if wroteRequest {
            NotificationCenter.default.post(name: .lab86NotificationRequest, object: nil)
        }
    }

    // Shared response entry for both platform delegates: text responses go to
    // the durable outbox-backed handler; everything else applies immediately.
    @MainActor
    static func handle(
        actionIdentifier: String,
        userInfo: [AnyHashable: Any],
        userText: String?
    ) async {
        let plan = NotificationResponseRouter.plan(
            for: NotificationResponseInput(
                actionIdentifier: actionIdentifier,
                userInfo: userInfo,
                userText: userText
            )
        )
        if let textResponse = plan.textResponse {
            let handled = await NotificationCoordinator.handleTextResponse(textResponse)
            if !handled {
                await notifyResponseFailure()
            }
            return
        }
        apply(plan)
    }

    static func notifyResponseFailure() async {
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
