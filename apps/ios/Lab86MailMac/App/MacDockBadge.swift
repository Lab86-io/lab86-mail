import AppKit
import SwiftUI

// The Dock badge (docs/albatross-threads.md, lead decision 10): the number
// of Albatrosses that need the user, the same number as the count beside
// "Albatrosses" in the source list. Not the unread count: a finished run is
// news, not a task. The icon never bounces.
enum MacDockBadge {
    /// The badge text, or nil to clear it.
    static func label(needsYou count: Int) -> String? {
        count > 0 ? String(count) : nil
    }

    static func apply(needsYou count: Int) {
        NSApplication.shared.dockTile.badgeLabel = label(needsYou: count)
    }
}

/// Keeps the Dock badge in step with the thread list.
struct MacDockBadgeModifier: ViewModifier {
    @Environment(AppEnvironment.self) private var environment

    func body(content: Content) -> some View {
        content
            .onChange(of: environment.threads.needsYouCount, initial: true) { _, count in
                MacDockBadge.apply(needsYou: count)
            }
    }
}

extension View {
    func macDockBadge() -> some View {
        modifier(MacDockBadgeModifier())
    }
}
