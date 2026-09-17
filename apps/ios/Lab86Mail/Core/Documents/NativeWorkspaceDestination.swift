import Foundation

struct NativeWorkspaceDestination: Identifiable, Hashable, Sendable {
    let title: String
    let path: String
    var id: String { path }

    static let files = Self(title: "Files", path: "/native/files?view=files")
    static let settings = Self(title: "All settings", path: "/settings")

    static func document(_ id: String) -> Self {
        Self(title: "File editor", path: query(path: "/native/files", values: [("view", "files"), ("document", id)]))
    }

    static func google(_ route: GoogleDocumentRoute) -> Self {
        Self(title: "File editor", path: query(path: "/native/files", values: [
            ("view", "files"), ("provider", "google_drive"), ("connection", route.connectionID),
            ("file", route.fileID), ("mime", route.mimeType),
        ]))
    }

    static func workspace(_ tab: PrimaryTab) -> Self {
        if tab == .files { return .files }
        let view: String
        switch tab {
        case .today: view = "today"
        case .tasks: view = "tasks"
        case .work: view = "albatrosses"
        case .calendar: view = "calendar"
        case .mail: view = "mail"
        case .chat: view = "chat"
        case .files: view = "files"
        }
        return Self(title: "\(tab.title) · All tools", path: query(path: "/", values: [("view", view)]))
    }

    @MainActor static func current(_ navigation: NavigationModel) -> Self {
        if let route = navigation.documentRoute {
            switch route.source {
            case .albatross(let id): return .document(id)
            case .google(let google): return .google(google)
            }
        }
        if let work = navigation.workRoute {
            return Self(title: work.title ?? "Albatross", path: query(path: "/", values: [("view", "albatrosses"), ("work", work.workID)]))
        }
        if let area = navigation.areaRoute {
            return Self(title: area.name ?? "Area", path: query(path: "/", values: [("view", "areas"), ("area", area.areaID)]))
        }
        return .workspace(navigation.selectedTab)
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
