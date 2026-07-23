import SwiftUI

struct ShortcutReferenceView: View {
    private let rows: [(String, String)] = [
        ("⌘N", "New message"),
        ("⌘K", "Ask Albatross"),
        ("⌘F", "Search mail"),
        ("⌘1", "Brief"),
        ("⌘2", "Tasks"),
        ("⌘3", "Calendar"),
        ("⌘4", "Areas"),
        ("⇧⌘A", "Activity"),
        ("⌘,", "Settings"),
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
