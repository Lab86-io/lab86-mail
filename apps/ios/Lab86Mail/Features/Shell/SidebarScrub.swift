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
    // A custom label shown as a mail view (NAT-4).
    case mailLabel(id: String, name: String)
    case area(id: String, name: String)
    case settings

    var id: String {
        switch self {
        case .primary(let tab): "primary.\(tab.rawValue)"
        case .mail(let scope): "mail.\(scope.rawValue)"
        case .mailLabel(let id, _): "label.\(id)"
        case .area(let id, _): "area.\(id)"
        case .settings: "settings"
        }
    }

    var title: String {
        switch self {
        case .primary(let tab): tab.title
        case .mail(let scope): scope.title
        case .mailLabel(_, let name): name
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

// MARK: - A tap on a row

// What a tap on a sidebar row does. The riffle never selects, and neither
// does a first tap: both load the row's page in the strip of page beside the
// sidebar, and the sidebar stays open. A tap on the row whose page already
// shows goes to that page. VoiceOver goes in one step, because the strip
// beside the sidebar is hidden from it. Settings is a sheet, so it opens.
enum SidebarRowTap: Equatable {
    case load
    case open

    static func outcome(
        for destination: SidebarDestination,
        showing: SidebarDestination?,
        voiceOver: Bool
    ) -> SidebarRowTap {
        if voiceOver { return .open }
        if case .settings = destination { return .open }
        // `id` matches an area on its id alone, so a route with a stale name
        // still counts as the page that shows.
        return showing?.id == destination.id ? .open : .load
    }
}
#endif
