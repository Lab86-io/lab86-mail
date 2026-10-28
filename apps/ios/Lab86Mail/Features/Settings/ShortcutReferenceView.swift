import SwiftUI

/// The keyboard shortcut list. The numbered page shortcuts come from
/// `PrimaryTab.commandShortcuts`, the same source as the menu, so the list
/// cannot drift from the keys that work.
enum ShortcutReference {
    struct Row: Identifiable, Equatable {
        let keys: String
        let action: String
        var id: String { keys }
    }

    static func rows(showsFiles: Bool) -> [Row] {
        var rows = [
            Row(keys: "⌘N", action: "New message"),
            Row(keys: "⌘K", action: "Ask Albatross"),
            Row(keys: "⌘F", action: "Search mail"),
        ]
        rows += PrimaryTab.commandShortcuts(showsFiles: showsFiles).map { shortcut in
            Row(keys: "⌘\(shortcut.key)", action: shortcut.tab.title)
        }
        rows += [
            Row(keys: "⇧⌘A", action: "Activity"),
            Row(keys: "⌘,", action: "Settings"),
            Row(keys: "⌘↩", action: "Do the action that waits in an Albatross"),
            Row(keys: "⌘.", action: "Stop Albatross on a step"),
            Row(keys: "⇧⌘.", action: "Stop and redirect the run"),
            Row(keys: "⇧⌘U", action: "Mark the Albatross as unread"),
            Row(keys: "⌃⌘P", action: "Show or hide the page"),
            Row(keys: "⌃⌘I", action: "Show or hide the details"),
            Row(keys: "⌥⌘↓", action: "Next Albatross"),
            Row(keys: "⌥⌘↑", action: "Previous Albatross"),
            Row(keys: "⌥⌘↩", action: "Next Albatross that needs you"),
        ]
        return rows
    }
}

struct ShortcutReferenceView: View {
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        List(ShortcutReference.rows(showsFiles: environment.trust.showsFiles)) { row in
            LabeledContent(row.action) {
                Text(row.keys)
                    .font(.body.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Keyboard shortcuts")
        .navigationBarTitleDisplayMode(.inline)
    }
}
