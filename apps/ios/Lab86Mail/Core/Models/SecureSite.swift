import Foundation

/// Where a prefilled site in the add sheet came from.
enum SecureSiteSource: Equatable, Sendable {
    /// The user types it (Settings, the composer notice).
    case user
    /// The page a run opened (the V13 offer): the site is the real page.
    case run
    /// The model's `ask_secure_detail` input: the user must check it.
    case suggested
}

/// The site rules of Passwords and IDs on the client. The server is the
/// authority: it reduces a host to its registrable domain with the public
/// suffix list (`dmv.ny.gov` is on the site `ny.gov`). The client only cleans
/// what the user typed, so the sheet can show "Saved as secure.chase.com".
enum SecureSite {
    /// Lowercases, and strips the scheme, the user info, the port, the path,
    /// the query, the fragment, and a leading "www.".
    static func clean(_ raw: String) -> String {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let scheme = text.range(of: "://") {
            text = String(text[scheme.upperBound...])
        } else if text.hasPrefix("//") {
            text = String(text.dropFirst(2))
        }
        if let end = text.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) {
            text = String(text[..<end])
        }
        if let at = text.lastIndex(of: "@") {
            text = String(text[text.index(after: at)...])
        }
        if let colon = text.firstIndex(of: ":") {
            text = String(text[..<colon])
        }
        if text.hasPrefix("www.") {
            text = String(text.dropFirst(4))
        }
        while text.hasSuffix(".") { text.removeLast() }
        while text.hasPrefix(".") { text.removeFirst() }
        return text
    }

    /// A cleaned host that can be a site: a dot inside, host characters only.
    static func isPlausible(_ host: String) -> Bool {
        guard host.contains("."), !host.hasPrefix("."), !host.hasSuffix("."), !host.contains(".."), host.count <= 253 else {
            return false
        }
        return host.unicodeScalars.allSatisfy { scalar in
            CharacterSet.alphanumerics.contains(scalar) || scalar == "-" || scalar == "."
        }
    }

    /// The warning line under a prefilled site shows while the site is the
    /// model's suggestion and the user has not touched the field. An injected
    /// chat could name a fake site; the user must check it before a real
    /// password binds to it.
    static func showsSuggestedSiteWarning(source: SecureSiteSource, edited: Bool) -> Bool {
        source == .suggested && !edited
    }

    /// A site covers itself and every host under it: `chase.com` covers `secure.chase.com`.
    static func covers(site: String, host: String) -> Bool {
        let site = clean(site)
        let host = clean(host)
        guard !site.isEmpty, !host.isEmpty else { return false }
        return host == site || host.hasSuffix("." + site)
    }
}
