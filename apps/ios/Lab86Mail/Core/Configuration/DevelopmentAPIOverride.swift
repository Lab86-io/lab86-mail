import Foundation

/// Redirects the API base URL of a development build at runtime.
///
/// Distributed builds are pinned to production: `ci_post_clone.sh` refuses to
/// configure any other channel, and `verify_built_configuration.sh` re-checks
/// the processed Info.plist as a post-build phase. That invariant has to
/// survive this type, so the stored value is only ever consulted inside
/// `#if DEBUG`. A Release build returns the bundled URL no matter what is in
/// defaults, and the override cannot be reached from the shipped UI.
///
/// The redirect covers the API host alone. Clerk and Convex stay pointed at
/// production, which is what makes the Tier 1 loop work: the same session and
/// the same data, served by whichever build of the web app is running.
enum DevelopmentAPIOverride {
    static let defaultsKey = "lab86.debug.apiBaseURL"

    /// The tailnet address the local web app is served on, so switching to it
    /// is one tap rather than a remembered URL.
    static let tailnetDevelopmentURL = "https://lab86.tail478321.ts.net:8445"

    static func resolve(bundled: URL?, defaults: UserDefaults) -> URL? {
        #if DEBUG
            guard let stored = defaults.string(forKey: defaultsKey) else { return bundled }
            return normalized(stored) ?? bundled
        #else
            return bundled
        #endif
    }

    /// Accepts only an absolute http(s) URL with a host. A malformed entry
    /// leaves the build on its bundled target rather than silently pointing the
    /// app at nothing.
    static func normalized(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              let host = url.host,
              !host.isEmpty
        else { return nil }
        // A trailing slash would produce doubled separators once request paths
        // are appended.
        guard trimmed.hasSuffix("/") else { return url }
        return URL(string: String(trimmed.dropLast()))
    }

    static func store(_ raw: String?, defaults: UserDefaults) {
        guard let raw, let url = normalized(raw) else {
            defaults.removeObject(forKey: defaultsKey)
            return
        }
        defaults.set(url.absoluteString, forKey: defaultsKey)
    }
}
