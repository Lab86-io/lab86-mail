import SwiftUI
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

// The narrow waist for per-platform system services. Feature code calls these
// instead of UIKit/AppKit directly, so a view ports to the Mac without
// scattering conditionals through its body.

enum PlatformHaptics {
    // Haptic ticks are an iOS vocabulary; the Mac stays silent rather than
    // approximating them with sound.
    @MainActor
    static func lightImpact() {
        #if os(iOS)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        #endif
    }
}

enum PlatformAccessibility {
    @MainActor
    static func announce(_ message: String) {
        #if os(iOS)
        UIAccessibility.post(notification: .announcement, argument: message)
        #else
        if let application = NSApp {
            NSAccessibility.post(
                element: application,
                notification: .announcementRequested,
                userInfo: [
                    .announcement: message,
                    .priority: NSAccessibilityPriorityLevel.high.rawValue,
                ]
            )
        }
        #endif
    }
}

enum PlatformPasteboard {
    @MainActor
    static func copy(_ string: String) {
        #if os(iOS)
        UIPasteboard.general.string = string
        #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
        #endif
    }
}

enum PlatformSettings {
    // Where the user flips the notification permission back on.
    @MainActor
    static func openNotificationSettings() {
        #if os(iOS)
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
        #else
        if let pane = notificationSettingsURL(bundleIdentifier: Bundle.main.bundleIdentifier) {
            NSWorkspace.shared.open(pane)
        }
        #endif
    }

    // System Settings opens straight to this app's row in Notifications when
    // the pane is asked for by bundle identifier; without one it opens the
    // generic list and the user has to find the app themselves.
    nonisolated static func notificationSettingsURL(bundleIdentifier: String?) -> URL? {
        var target = "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
        if let bundleIdentifier, !bundleIdentifier.isEmpty {
            target += "?id=\(bundleIdentifier)"
        }
        return URL(string: target)
    }

    static var systemSettingsName: String {
        #if os(iOS)
        "iOS Settings"
        #else
        "System Settings"
        #endif
    }
}

#if os(macOS)
// SwiftUI's size classes exist only on iOS; a Mac window always behaves as a
// regular-width surface. The shim keeps shared adaptive layouts compiling
// without per-call conditionals.
enum UserInterfaceSizeClass {
    case compact
    case regular
}

extension EnvironmentValues {
    var horizontalSizeClass: UserInterfaceSizeClass? { .regular }
}
#endif
