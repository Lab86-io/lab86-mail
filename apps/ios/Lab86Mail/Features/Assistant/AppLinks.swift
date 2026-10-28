import Foundation
import SwiftUI

/// Links in a reply that lead into the app (`/?view=files&file=<id>`, the
/// app's own site, `lab86://`, `mailto:`) open inside it; the rest go to the
/// browser. `NavigationModel.isAppLink` decides; this gives the router its
/// path.
enum AppLinks {
    /// The route string for `NavigationModel.open(appPath:)`: the path with
    /// its query for a link into the app's site, the link itself otherwise.
    static func appPath(for href: String) -> String {
        let trimmed = href.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else { return trimmed }
        var path = url.path.isEmpty ? "/" : url.path
        if let query = url.query, !query.isEmpty { path += "?\(query)" }
        return path
    }

    /// Opens an app link in the app. False when the link is not one.
    @MainActor
    @discardableResult
    static func open(_ href: String, navigation: NavigationModel) -> Bool {
        guard NavigationModel.isAppLink(href) else { return false }
        navigation.open(appPath: appPath(for: href))
        return true
    }

    /// The `openURL` action for a reply: app links stay in the app, the
    /// others take the system route. SwiftUI calls the handler on the main
    /// thread; the assume covers SDKs that do not say so in the type.
    @MainActor
    static func action(navigation: NavigationModel) -> OpenURLAction {
        let box = NavigationBox(navigation: navigation)
        return OpenURLAction { url in
            MainActor.assumeIsolated {
                open(url.absoluteString, navigation: box.navigation) ? .handled : .systemAction
            }
        }
    }

    /// Carries the main-actor router into the handler closure.
    private final class NavigationBox: @unchecked Sendable {
        let navigation: NavigationModel
        init(navigation: NavigationModel) { self.navigation = navigation }
    }
}
