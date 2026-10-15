import SwiftUI

// The package list of document mode on the Mac (docs/albatross-goal-runs.md,
// G3, and the native design note of 2026-10-15, section 3.6): a leading
// column with one row for each item, the selected one with the system fill.
// It shows only with more than one item and room for it; without the room
// the capsules sit over the editor instead. The widths live here, not on the
// generic split, which cannot hold static stored properties.

enum MacDocumentModeLayout {
    static let listMinWidth: CGFloat = 200
    static let listIdealWidth: CGFloat = 240
    static let listMaxWidth: CGFloat = 300

    /// The list at its ideal width in a wide window, else at its least.
    static func listWidth(for windowWidth: CGFloat) -> CGFloat {
        windowWidth >= 1_200 ? listIdealWidth : listMinWidth
    }

    /// The list needs more than one item, and the detail column must hold
    /// the list, the editor, and the thread column.
    static func showsList(itemCount: Int, windowWidth: CGFloat, sidebarShown: Bool) -> Bool {
        guard itemCount > 1 else { return false }
        let detail = MacThreadLayout.detailWidth(windowWidth: windowWidth, sidebarShown: sidebarShown)
        return detail >= MacThreadLayout.documentMinimumWidth + listMinWidth
    }
}

enum MacPackageListCopy {
    /// The second line of a row: the blanks as plain words, else the state.
    static func stateLine(_ item: DocumentModeItem) -> String {
        if !item.blanks.isEmpty { return BlankSentenceRules.text(item.blanks) }
        return item.state == .ready ? GoalRunCopy.ready : GoalRunCopy.checkIt
    }
}

struct MacPackageList: View {
    @Environment(AppEnvironment.self) private var environment
    let set: DocumentModeSet
    @Binding var selection: String

    var body: some View {
        List(selection: Binding<String?>(
            get: { selection },
            set: { if let id = $0 { selection = id } }
        )) {
            ForEach(set.items) { item in
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(2)
                    Text(MacPackageListCopy.stateLine(item))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                .padding(.vertical, 4)
                .tag(item.id)
                .accessibilityLabel("\(item.title). \(MacPackageListCopy.stateLine(item))")
            }
        }
        .listStyle(.inset)
        .scrollContentBackground(.hidden)
        .background(environment.theme.paperColor)
        .accessibilityLabel(MacDocumentModeCopy.package)
    }
}
