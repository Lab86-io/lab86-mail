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
        let pane = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")
        if let pane { NSWorkspace.shared.open(pane) }
        #endif
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
