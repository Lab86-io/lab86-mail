import Foundation
import Observation
import UIKit
import UserNotifications

extension Notification.Name {
    static let lab86DeviceToken = Notification.Name("io.lab86.mail.device-token")
    static let lab86OpenRoute = Notification.Name("io.lab86.mail.open-route")
    static let lab86NotificationAction = Notification.Name("io.lab86.mail.notification-action")
    static let lab86MailNotificationAction = Notification.Name("io.lab86.mail.mail-notification-action")
}

enum NotificationCategoryID {
    static let commitment = "LAB86_COMMITMENT"
    static let checkIn = "LAB86_CHECKIN"
    static let mail = "LAB86_MAIL"
}

struct MobileNotificationPreferences: Equatable, Sendable {
    var nativePushEnabled = true
    var newMailPushEnabled = true
    var eventSuggestionPushEnabled = true
    var eveningCheckinEnabled = true
    var eveningCheckinLocalTime = "19:00"
    var timezone = TimeZone.current.identifier
    var inAppEnabled = true
    var emailFallbackEnabled = true
    var emailFallbackDelayMinutes = 90
}

@MainActor
@Observable
final class NotificationCoordinator {
    private let backend: BackendClient
    var authorizationStatus: UNAuthorizationStatus = .notDetermined
    var registrationError: String?
    var lastRegisteredAt: Date?
    var preferences = MobileNotificationPreferences()
    var preferencesError: String?

    init(backend: BackendClient) { self.backend = backend }

    func refreshAuthorizationStatus() async {
        authorizationStatus = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    func requestAuthorization() async {
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            await refreshAuthorizationStatus()
            if granted { UIApplication.shared.registerForRemoteNotifications() }
        } catch {
            registrationError = error.localizedDescription
        }
    }

    func activateForSignedInUser() async {
        await refreshAuthorizationStatus()
        switch authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            UIApplication.shared.registerForRemoteNotifications()
        default:
            break
        }
    }

    func loadPreferences() async {
        do {
            let response = try await backend.post(path: "/api/mobile/preferences", body: .object([:]))
            guard let value = response["preferences"] else { throw BackendError.invalidResponse }
            preferences = MobileNotificationPreferences(
                nativePushEnabled: value["nativePushEnabled"]?.boolValue ?? true,
                newMailPushEnabled: value["newMailPushEnabled"]?.boolValue ?? true,
                eventSuggestionPushEnabled: value["eventSuggestionPushEnabled"]?.boolValue ?? true,
                eveningCheckinEnabled: value["eveningCheckinEnabled"]?.boolValue ?? true,
                eveningCheckinLocalTime: value["eveningCheckinLocalTime"]?.stringValue ?? "19:00",
                timezone: value["timezone"]?.stringValue ?? TimeZone.current.identifier,
                inAppEnabled: value["inAppEnabled"]?.boolValue ?? true,
                emailFallbackEnabled: value["emailFallbackEnabled"]?.boolValue ?? true,
                emailFallbackDelayMinutes: Int(value["emailFallbackDelayMinutes"]?.doubleValue ?? 90)
            )
            preferencesError = nil
        } catch {
            preferencesError = error.localizedDescription
        }
    }

    func savePreferences(_ value: MobileNotificationPreferences) async {
        let previous = preferences
        preferences = value
        do {
            _ = try await backend.put(
                path: "/api/mobile/preferences",
                body: .object([
                    "nativePushEnabled": .bool(value.nativePushEnabled),
                    "newMailPushEnabled": .bool(value.newMailPushEnabled),
                    "eventSuggestionPushEnabled": .bool(value.eventSuggestionPushEnabled),
                    "eveningCheckinEnabled": .bool(value.eveningCheckinEnabled),
                    "eveningCheckinLocalTime": .string(value.eveningCheckinLocalTime),
                    "timezone": .string(value.timezone),
                    "inAppEnabled": .bool(value.inAppEnabled),
                    "emailFallbackEnabled": .bool(value.emailFallbackEnabled),
                    "emailFallbackDelayMinutes": .number(Double(value.emailFallbackDelayMinutes)),
                ])
            )
            preferencesError = nil
        } catch {
            preferences = previous
            preferencesError = error.localizedDescription
        }
    }

    func register(deviceToken: Data) async {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        guard !token.isEmpty else { return }
        do {
            let response = try await backend.post(
                path: "/api/mobile/devices",
                body: .object([
                    "platform": .string("ios"),
                    "token": .string(token),
                    "deviceId": .string(Self.deviceIdentifier),
                    "appVersion": .string(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"),
                    "environment": .string(Self.pushEnvironment),
                ])
            )
            guard response["ok"]?.boolValue == true else {
                throw BackendError.server(status: 500, message: response["error"]?.stringValue ?? "Push registration failed.")
            }
            registrationError = nil
            lastRegisteredAt = .now
        } catch {
            registrationError = error.localizedDescription
        }
    }

    func revoke() async throws {
        let response = try await backend.delete(
            path: "/api/mobile/devices",
            body: .object([
                "deviceId": .string(Self.deviceIdentifier),
            ])
        )
        guard response["ok"]?.boolValue == true else {
            throw BackendError.server(status: 500, message: response["error"]?.stringValue ?? "Push revocation failed.")
        }
        unregisterLocally()
    }

    func unregisterLocally() {
        UIApplication.shared.unregisterForRemoteNotifications()
        lastRegisteredAt = nil
    }

    static func configureCategories() {
        let add = UNNotificationAction(identifier: "ADD_TO_CALENDAR", title: "Add to Calendar", options: [.foreground])
        let view = UNNotificationAction(identifier: "VIEW", title: "View Email", options: [.foreground])
        let dismiss = UNNotificationAction(identifier: "DISMISS", title: "Dismiss", options: [.foreground, .destructive])
        let commitment = UNNotificationCategory(
            identifier: NotificationCategoryID.commitment,
            actions: [add, view, dismiss],
            intentIdentifiers: []
        )
        let answer = UNNotificationAction(identifier: "ANSWER_CHECKIN", title: "Answer", options: [.foreground])
        let later = UNNotificationAction(identifier: "CHECKIN_LATER", title: "Later")
        let checkIn = UNNotificationCategory(
            identifier: NotificationCategoryID.checkIn,
            actions: [answer, later],
            intentIdentifiers: []
        )
        let markRead = UNNotificationAction(identifier: "MAIL_MARK_READ", title: "Mark Read")
        let archive = UNNotificationAction(identifier: "MAIL_ARCHIVE", title: "Archive", options: [.destructive])
        let reply = UNNotificationAction(identifier: "MAIL_REPLY", title: "Reply", options: [.foreground])
        let mail = UNNotificationCategory(
            identifier: NotificationCategoryID.mail,
            actions: [reply, markRead, archive],
            intentIdentifiers: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([commitment, checkIn, mail])
    }

    private static var pushEnvironment: String {
        #if DEBUG
        "development"
        #else
        "production"
        #endif
    }

    private static var deviceIdentifier: String {
        UIDevice.current.identifierForVendor?.uuidString ?? "ios-unknown-install"
    }
}
