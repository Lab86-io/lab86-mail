import Foundation
import Testing
@testable import Lab86Mail

// The device registration identity behind `/api/mobile/devices`: the platform
// the server sees, and a per-install identifier that survives token rotation.
struct NotificationDeviceIdentityTests {
    @Test
    func devicePlatformNamesTheBuildPlatform() {
        #if os(macOS)
        #expect(NotificationCoordinator.devicePlatform == "macos")
        #else
        #expect(NotificationCoordinator.devicePlatform == "ios")
        #endif
    }

    @Test
    @MainActor
    func deviceIdentifierIsStableAcrossReads() {
        let first = NotificationCoordinator.deviceIdentifier
        let second = NotificationCoordinator.deviceIdentifier
        #expect(!first.isEmpty)
        #expect(first == second)
        #if os(macOS)
        // No vendor identifier on the Mac: a persisted, prefixed UUID stands in.
        #expect(first.hasPrefix("mac-"))
        #expect(UserDefaults.standard.string(forKey: "lab86-mail-install-identifier") == first)
        #endif
    }
}
