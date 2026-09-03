import Foundation
import Testing
@testable import Lab86Mail

struct DevelopmentAPIOverrideTests {
    /// Each case gets its own suite so a stored override cannot leak between
    /// tests or into the standard defaults of whatever runs next.
    private func makeDefaults(_ name: String = UUID().uuidString) -> UserDefaults {
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    private let bundled = URL(string: "https://mail.lab86.io")!

    @Test func usesTheBundledTargetWhenNothingIsStored() {
        let resolved = DevelopmentAPIOverride.resolve(bundled: bundled, defaults: makeDefaults())

        #expect(resolved == bundled)
    }

    @Test func redirectsToAStoredTailnetAddress() {
        let defaults = makeDefaults()
        DevelopmentAPIOverride.store(DevelopmentAPIOverride.tailnetDevelopmentURL, defaults: defaults)

        let resolved = DevelopmentAPIOverride.resolve(bundled: bundled, defaults: defaults)

        #expect(resolved?.absoluteString == "https://lab86.tail478321.ts.net:8445")
    }

    /// A bad entry must not strand the build with no server at all.
    @Test(arguments: ["", "   ", "not a url", "mail.lab86.io", "ftp://mail.lab86.io", "https://"])
    func fallsBackToTheBundledTargetForUnusableInput(_ raw: String) {
        let defaults = makeDefaults()
        defaults.set(raw, forKey: DevelopmentAPIOverride.defaultsKey)

        let resolved = DevelopmentAPIOverride.resolve(bundled: bundled, defaults: defaults)

        #expect(resolved == bundled)
        #expect(DevelopmentAPIOverride.normalized(raw) == nil)
    }

    /// Request paths are appended to this URL, so a trailing slash would produce
    /// doubled separators.
    @Test func dropsATrailingSlash() {
        #expect(DevelopmentAPIOverride.normalized("https://lab86.tail478321.ts.net:8445/")?.absoluteString
            == "https://lab86.tail478321.ts.net:8445")
    }

    @Test func storingNothingClearsAPreviousRedirect() {
        let defaults = makeDefaults()
        DevelopmentAPIOverride.store(DevelopmentAPIOverride.tailnetDevelopmentURL, defaults: defaults)

        DevelopmentAPIOverride.store(nil, defaults: defaults)

        #expect(defaults.string(forKey: DevelopmentAPIOverride.defaultsKey) == nil)
        #expect(DevelopmentAPIOverride.resolve(bundled: bundled, defaults: defaults) == bundled)
    }

    /// The redirect covers the API host alone: Clerk and Convex keep pointing at
    /// production, which is what lets a redirected build keep the same session
    /// and the same data.
    @Test func doesNotDisturbTheClerkOrConvexConfiguration() {
        let defaults = makeDefaults()
        DevelopmentAPIOverride.store(DevelopmentAPIOverride.tailnetDevelopmentURL, defaults: defaults)

        let configuration = AppConfiguration(bundle: .main, defaults: defaults)

        #expect(configuration.apiBaseURL?.host() == "lab86.tail478321.ts.net")
        #expect(configuration.clerkPublishableKey == AppConfiguration(bundle: .main).clerkPublishableKey)
        #expect(configuration.convexDeploymentURL == AppConfiguration(bundle: .main).convexDeploymentURL)
    }
}
