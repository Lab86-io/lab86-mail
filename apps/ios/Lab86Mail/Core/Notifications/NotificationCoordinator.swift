import Foundation
import Observation
import UserNotifications
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

extension Notification.Name {
    static let lab86DeviceToken = Notification.Name("io.lab86.mail.device-token")
    // A notification response wrote something down for the shell to read. It
    // carries no payload on purpose: the durable keys are the payload, so an
    // app that was started by the response reads exactly the same thing as an
    // app that was already running.
    static let lab86NotificationRequest = Notification.Name("io.lab86.mail.notification-request")
    static let lab86NotificationAction = Notification.Name("io.lab86.mail.notification-action")
    static let lab86MailNotificationAction = Notification.Name("io.lab86.mail.mail-notification-action")
    static let lab86OneTimeCodeAvailable = Notification.Name("io.lab86.mail.one-time-code-available")
}

enum NotificationCategoryID {
    static let commitment = "LAB86_COMMITMENT"
    static let checkIn = "LAB86_CHECKIN"
    static let mail = "LAB86_MAIL"
    static let brief = "LAB86_BRIEF"
    static let urgent = "LAB86_URGENT"
}

struct NotificationTextResponse: Codable, Equatable, Sendable {
    enum Kind: Codable, Equatable, Sendable {
        case checkIn(notificationID: String, promptKind: String)
        case mail(accountID: String, threadID: String, messageID: String)
    }

    let kind: Kind
    let text: String
}

struct MobileNotificationPreferences: Equatable, Sendable {
    var nativePushEnabled = true
    var newMailPushEnabled = true
    var urgentMailPushEnabled = true
    var eventSuggestionPushEnabled = true
    var oneTimeCodeAutofillEnabled = true
    var oneTimeCodeCleanupEnabled = false
    var morningBriefEnabled = true
    var eveningCheckinEnabled = true
    var eveningCheckinLocalTime = "19:00"
    var timezone = TimeZone.current.identifier
    var inAppEnabled = true
    var emailFallbackEnabled = true
    var emailFallbackDelayMinutes = 90
    var briefLocationEnabled = false
    var briefLatitude: Double?
    var briefLongitude: Double?
    var briefLocationLabel: String?
    var briefLocationAccuracy: Double?
    var briefLocationUpdatedAt: Double?
}

@MainActor
@Observable
final class NotificationCoordinator {
    typealias TextResponseHandler = @MainActor @Sendable (NotificationTextResponse) async -> Bool
    private static var textResponseHandler: TextResponseHandler?
    private static var responseOutbox: NotificationResponseOutbox?

    private let backend: BackendClient
    var authorizationStatus: UNAuthorizationStatus = .notDetermined
    var registrationError: String?
    var lastRegisteredAt: Date?
    var preferences = MobileNotificationPreferences()
    var preferencesError: String?

    init(backend: BackendClient, responseOutbox: NotificationResponseOutbox) {
        self.backend = backend
        Self.responseOutbox = responseOutbox
    }

    deinit {}

    static func installTextResponseHandler(_ handler: @escaping TextResponseHandler) {
        textResponseHandler = handler
    }

    static func handleTextResponse(_ response: NotificationTextResponse) async -> Bool {
        guard let responseOutbox else { return false }
        guard let pending = try? await responseOutbox.enqueue(response) else { return false }
        guard let textResponseHandler else {
            try? await responseOutbox.release(id: pending.id)
            return false
        }
        let handled = await textResponseHandler(response)
        if handled {
            try? await responseOutbox.remove(id: pending.id)
        } else {
            try? await responseOutbox.release(id: pending.id)
        }
        return handled
    }

    func retryPendingTextResponses() async {
        guard let responseOutbox = Self.responseOutbox,
              let textResponseHandler = Self.textResponseHandler,
              let pending = try? await responseOutbox.claimPending() else { return }
        for item in pending {
            if await textResponseHandler(item.response) {
                try? await responseOutbox.remove(id: item.id)
            } else {
                try? await responseOutbox.release(id: item.id)
            }
        }
    }

    func refreshAuthorizationStatus() async {
        authorizationStatus = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    func requestAuthorization() async {
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            await refreshAuthorizationStatus()
            if granted { Self.registerForRemoteNotifications() }
        } catch {
            registrationError = error.localizedDescription
        }
    }

    func activateForSignedInUser() async {
        await refreshAuthorizationStatus()
        switch authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            Self.registerForRemoteNotifications()
        default:
            break
        }
    }

    private static func registerForRemoteNotifications() {
        #if canImport(UIKit)
        UIApplication.shared.registerForRemoteNotifications()
        #else
        NSApplication.shared.registerForRemoteNotifications()
        #endif
    }

    func loadPreferences() async {
        do {
            let response = try await backend.post(path: "/api/mobile/preferences", body: .object([:]))
            guard let value = response["preferences"] else { throw BackendError.invalidResponse }
            preferences = MobileNotificationPreferences(
                nativePushEnabled: value["nativePushEnabled"]?.boolValue ?? true,
                newMailPushEnabled: value["newMailPushEnabled"]?.boolValue ?? true,
                urgentMailPushEnabled: value["urgentMailPushEnabled"]?.boolValue ?? true,
                eventSuggestionPushEnabled: value["eventSuggestionPushEnabled"]?.boolValue ?? true,
                oneTimeCodeAutofillEnabled: value["oneTimeCodeAutofillEnabled"]?.boolValue ?? true,
                oneTimeCodeCleanupEnabled: value["oneTimeCodeCleanupEnabled"]?.boolValue ?? false,
                morningBriefEnabled: value["morningBriefEnabled"]?.boolValue ?? true,
                eveningCheckinEnabled: value["eveningCheckinEnabled"]?.boolValue ?? true,
                eveningCheckinLocalTime: value["eveningCheckinLocalTime"]?.stringValue ?? "19:00",
                timezone: value["timezone"]?.stringValue ?? TimeZone.current.identifier,
                inAppEnabled: value["inAppEnabled"]?.boolValue ?? true,
                emailFallbackEnabled: value["emailFallbackEnabled"]?.boolValue ?? true,
                emailFallbackDelayMinutes: Int(value["emailFallbackDelayMinutes"]?.doubleValue ?? 90),
                briefLocationEnabled: value["briefLocationEnabled"]?.boolValue ?? false,
                briefLatitude: value["briefLatitude"]?.doubleValue,
                briefLongitude: value["briefLongitude"]?.doubleValue,
                briefLocationLabel: value["briefLocationLabel"]?.stringValue,
                briefLocationAccuracy: value["briefLocationAccuracy"]?.doubleValue,
                briefLocationUpdatedAt: value["briefLocationUpdatedAt"]?.doubleValue
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
            var body: [String: JSONValue] = [
                "nativePushEnabled": .bool(value.nativePushEnabled),
                "newMailPushEnabled": .bool(value.newMailPushEnabled),
                "urgentMailPushEnabled": .bool(value.urgentMailPushEnabled),
                "eventSuggestionPushEnabled": .bool(value.eventSuggestionPushEnabled),
                "oneTimeCodeAutofillEnabled": .bool(value.oneTimeCodeAutofillEnabled),
                "oneTimeCodeCleanupEnabled": .bool(value.oneTimeCodeCleanupEnabled),
                "morningBriefEnabled": .bool(value.morningBriefEnabled),
                "eveningCheckinEnabled": .bool(value.eveningCheckinEnabled),
                "eveningCheckinLocalTime": .string(value.eveningCheckinLocalTime),
                "timezone": .string(value.timezone),
                "inAppEnabled": .bool(value.inAppEnabled),
                "emailFallbackEnabled": .bool(value.emailFallbackEnabled),
                "emailFallbackDelayMinutes": .number(Double(value.emailFallbackDelayMinutes)),
                "briefLocationEnabled": .bool(value.briefLocationEnabled),
            ]
            if let latitude = value.briefLatitude { body["briefLatitude"] = .number(latitude) }
            if let longitude = value.briefLongitude { body["briefLongitude"] = .number(longitude) }
            if let label = value.briefLocationLabel { body["briefLocationLabel"] = .string(label) }
            if let accuracy = value.briefLocationAccuracy {
                body["briefLocationAccuracy"] = .number(accuracy)
            }
            if let updatedAt = value.briefLocationUpdatedAt {
                body["briefLocationUpdatedAt"] = .number(updatedAt)
            }
            _ = try await backend.put(
                path: "/api/mobile/preferences",
                body: .object(body)
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
                    "platform": .string(Self.devicePlatform),
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
        #if canImport(UIKit)
        UIApplication.shared.unregisterForRemoteNotifications()
        #else
        NSApplication.shared.unregisterForRemoteNotifications()
        #endif
        lastRegisteredAt = nil
    }

    static func configureCategories() {
        let add = UNNotificationAction(
            identifier: NotificationActionID.addToCalendar,
            title: "Add to Calendar",
            options: [.foreground]
        )
        let view = UNNotificationAction(
            identifier: NotificationActionID.view,
            title: "View Email",
            options: [.foreground]
        )
        let dismiss = UNNotificationAction(
            identifier: NotificationActionID.dismiss,
            title: "Dismiss",
            options: [.foreground, .destructive]
        )
        let commitment = UNNotificationCategory(
            identifier: NotificationCategoryID.commitment,
            actions: [add, view, dismiss],
            intentIdentifiers: []
        )
        let answer = UNTextInputNotificationAction(
            identifier: NotificationActionID.answerCheckIn,
            title: "Reply",
            options: [],
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Type or dictate your answer"
        )
        let later = UNNotificationAction(identifier: NotificationActionID.checkInLater, title: "Later")
        let checkIn = UNNotificationCategory(
            identifier: NotificationCategoryID.checkIn,
            actions: [answer, later],
            intentIdentifiers: []
        )
        let markRead = UNNotificationAction(identifier: NotificationActionID.mailMarkRead, title: "Mark Read")
        let archive = UNNotificationAction(
            identifier: NotificationActionID.mailArchive,
            title: "Archive",
            options: [.destructive]
        )
        let reply = UNTextInputNotificationAction(
            identifier: NotificationActionID.mailReply,
            title: "Reply",
            options: [],
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Write a reply"
        )
        let mail = UNNotificationCategory(
            identifier: NotificationCategoryID.mail,
            actions: [reply, markRead, archive],
            intentIdentifiers: []
        )
        let openBrief = UNNotificationAction(
            identifier: NotificationActionID.openBrief,
            title: "Open Brief",
            options: [.foreground]
        )
        let brief = UNNotificationCategory(
            identifier: NotificationCategoryID.brief,
            actions: [openBrief],
            intentIdentifiers: []
        )
        // Urgent mail offers the same actions as ordinary mail. What differs is
        // the interruption level the server sets on it, not what can be done
        // from the banner.
        let urgent = UNNotificationCategory(
            identifier: NotificationCategoryID.urgent,
            actions: [reply, markRead, archive],
            intentIdentifiers: []
        )
        UNUserNotificationCenter.current()
            .setNotificationCategories([commitment, checkIn, mail, brief, urgent])
    }

    private static var pushEnvironment: String {
        #if DEBUG
        "development"
        #else
        "production"
        #endif
    }

    nonisolated static var devicePlatform: String {
        #if os(macOS)
        "macos"
        #else
        "ios"
        #endif
    }

    static var deviceIdentifier: String {
        #if canImport(UIKit)
        UIDevice.current.identifierForVendor?.uuidString ?? "ios-unknown-install"
        #else
        // macOS has no vendor identifier; a persisted per-install UUID gives
        // token rotation the same stable device identity.
        let key = "lab86-mail-install-identifier"
        if let existing = UserDefaults.standard.string(forKey: key) { return existing }
        let created = "mac-\(UUID().uuidString.lowercased())"
        UserDefaults.standard.set(created, forKey: key)
        return created
        #endif
    }
}
