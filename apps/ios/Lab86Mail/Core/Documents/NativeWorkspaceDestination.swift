import Foundation

// A web surface that has no native form yet, opened in the in-app browser
// sheet: the full file library, the file editor, and the full settings page.
// There is deliberately no destination for "this screen, on the web" — a
// native screen does its own work instead of handing people a web copy of
// itself.
struct NativeWorkspaceDestination: Identifiable, Hashable, Sendable {
    let title: String
    let path: String
    var id: String { path }

    static let files = Self(title: "Files", path: "/native/files?view=files")
    static let settings = Self(title: "All settings", path: "/settings")

    static func document(_ id: String) -> Self {
        Self(title: "File editor", path: query(path: "/native/files", values: [("view", "files"), ("document", id)]))
    }

    /// A Word document in the Office editor (`?office=<id>`).
    static func officeDocument(_ id: String) -> Self {
        Self(title: "File editor", path: query(path: "/native/files", values: [("view", "files"), ("office", id)]))
    }

    static func google(_ route: GoogleDocumentRoute) -> Self {
        Self(title: "File editor", path: query(path: "/native/files", values: [
            ("view", "files"), ("provider", "google_drive"), ("connection", route.connectionID),
            ("file", route.fileID), ("mime", route.mimeType),
        ]))
    }

    private static func query(path: String, values: [(String, String)]) -> String {
        var components = URLComponents()
        components.path = path
        components.queryItems = values.map { URLQueryItem(name: $0.0, value: $0.1) }
        return components.string ?? path
    }
}

enum NativeWorkspacePolicy {
    static func acceptsBaseURL(_ url: URL) -> Bool {
        guard url.user == nil, url.password == nil, let host = url.host, !host.isEmpty else { return false }
        if url.scheme?.lowercased() == "https" { return true }
        #if DEBUG
        return url.scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host)
        #else
        return false
        #endif
    }

    static func sameOrigin(_ url: URL, _ base: URL) -> Bool {
        url.scheme?.lowercased() == base.scheme?.lowercased()
            && url.host?.lowercased() == base.host?.lowercased()
            && (url.port ?? (url.scheme == "https" ? 443 : 80)) == (base.port ?? (base.scheme == "https" ? 443 : 80))
            && url.user == nil && url.password == nil
    }

    static func acceptsBridgeMessage(url: URL?, base: URL, isMainFrame: Bool) -> Bool {
        guard isMainFrame, let url else { return false }
        return sameOrigin(url, base) && url.path == "/native/session"
    }

    static func acceptsDownloadURL(_ url: URL, base: URL) -> Bool {
        if sameOrigin(url, base) { return true }
        guard url.scheme == "blob", let source = URL(string: String(url.absoluteString.dropFirst(5))) else { return false }
        return sameOrigin(source, base)
    }

    static func safeDownloadName(_ name: String) -> String {
        let basename = name.replacingOccurrences(of: "\\", with: "/").components(separatedBy: "/").last ?? ""
        let clean = basename.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }
        let value = String(String.UnicodeScalarView(clean)).trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty || value == "." || value == ".." ? "Download" : String(value.prefix(180))
    }
}
