import SwiftUI

struct ShortcutReferenceView: View {
    private let rows: [(String, String)] = [
        ("⌘N", "New message"),
        ("⌘K", "Ask Albatross"),
        ("⌘F", "Search mail"),
        ("⌘1", "Today"),
        ("⌘2", "Tasks"),
        ("⌘3", "Calendar"),
        ("⌘4", "Albatrosses"),
        ("⇧⌘A", "Activity"),
        ("⌘,", "Settings"),
        ("⌘↩", "Do the action that waits in an Albatross"),
        ("⌘.", "Stop Albatross on a step"),
        ("⇧⌘.", "Stop and redirect the run"),
        ("⇧⌘U", "Mark the Albatross as unread"),
        ("⌃⌘P", "Show or hide the page"),
        ("⌃⌘I", "Show or hide the details"),
        ("⌥⌘↓", "Next Albatross"),
        ("⌥⌘↑", "Previous Albatross"),
        ("⌥⌘↩", "Next Albatross that needs you"),
    ]

    var body: some View {
        List(rows, id: \.0) { shortcut, action in
            LabeledContent(action) {
                Text(shortcut)
                    .font(.body.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Keyboard Shortcuts")
        .navigationBarTitleDisplayMode(.inline)
    }
}
