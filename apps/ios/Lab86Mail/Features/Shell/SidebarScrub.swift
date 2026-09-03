#if os(iOS)
import SwiftUI

// MARK: - Destinations

// Where the sidebar wheel can land. Only navigable rows are destinations —
// section headers, dividers, loading/error rows, and Settings are never wheel
// stops. Settings is deliberately excluded: it is a mode switch rather than a
// peer destination, so rolling onto it on the way past the last mail scope
// would be a bad surprise. It is reachable by tap.
enum SidebarDestination: Hashable, Identifiable {
    case primary(PrimaryTab)
    case mail(MailCategoryScope)
    case area(id: String, name: String)
    case settings

    var id: String {
        switch self {
        case .primary(let tab): "primary.\(tab.rawValue)"
        case .mail(let scope): "mail.\(scope.rawValue)"
        case .area(let id, _): "area.\(id)"
        case .settings: "settings"
        }
    }

    var title: String {
        switch self {
        case .primary(let tab): tab.title
        case .mail(let scope): scope.title
        case .area(_, let name): name
        case .settings: "Settings"
        }
    }

    // Areas carry their name in their identity, but a route can hold a stale or
    // missing one, so an area matches on id alone.
    static func index(of destination: SidebarDestination?, in ordered: [SidebarDestination]) -> Int? {
        guard let destination else { return nil }
        if let exact = ordered.firstIndex(of: destination) { return exact }
        guard case .area(let id, _) = destination else { return nil }
        return ordered.firstIndex {
            if case .area(let other, _) = $0 { return other == id }
            return false
        }
    }
}
#endif
