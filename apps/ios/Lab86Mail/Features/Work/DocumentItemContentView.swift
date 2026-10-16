import SwiftUI

// The selected item of document mode (docs/albatross-goal-runs.md, G3): the
// web editor for a document, a sheet, or a deck; a native viewer for a saved
// file; the read-only draft with its attachments. On the Mac the host passes
// a dock (the title row with "Close"); on the phone the cover gives a file
// or a draft its own bar. iOS and macOS share this file.

struct DocumentItemContentView: View {
    @Environment(\.dismiss) private var dismiss
    let item: DocumentModeItem
    var reloadToken = 0
    var dock: NativeWorkspaceDock? = nil
    var onOpenWeb: () -> Void = {}
    var onEditDraft: (String, String?) -> Void = { _, _ in }

    var body: some View {
        switch item.content {
        case .document:
            if let destination = item.workspaceDestination {
                NativeWorkspaceView(destination: destination, reloadToken: reloadToken, dock: dock)
            }
        case .file(let fileID):
            framed {
                SavedFileView(fileID: fileID, item: item, onOpenWeb: onOpenWeb)
            }
        case .draft(let id, let accountID):
            framed {
                DraftItemView(draftID: id, accountID: accountID, item: item, onEdit: { onEditDraft(id, accountID) })
            }
        }
    }

    /// A file or a draft under the dock header on the Mac, or under its own
    /// bar with "Close" on the phone.
    @ViewBuilder private func framed<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        if let dock {
            VStack(spacing: 0) {
                NativeWorkspaceDockHeader(title: dock.title, onClose: dock.onClose)
                Divider()
                content()
            }
        } else {
            NavigationStack {
                content()
                    .navigationTitle(item.title)
                    #if os(iOS)
                    .navigationBarTitleDisplayMode(.inline)
                    #endif
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button(DocumentHandoffCopy.close) { dismiss() }
                        }
                    }
            }
        }
    }
}

/// The items of document mode as text capsules, the selected one filled.
/// The phone and the iPad use it over the item; the Mac uses it over the
/// editor when the window has no room for the list.
struct DocumentModeItemBar: View {
    @Environment(AppEnvironment.self) private var environment
    let set: DocumentModeSet
    @Binding var selection: String

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(set.items.enumerated()), id: \.element.id) { index, item in
                    capsule(item, index: index)
                }
            }
            .padding(.horizontal, 16)
        }
        .accessibilityElement(children: .contain)
    }

    private func capsule(_ item: DocumentModeItem, index: Int) -> some View {
        let selected = item.id == set.selectedID
        return Button {
            selection = item.id
        } label: {
            Text(item.title)
                .font(.subheadline.weight(selected ? .semibold : .regular))
                .foregroundStyle(selected ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                .lineLimit(1)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(
                    selected ? environment.theme.accentSoftColor : environment.theme.subtleColor,
                    in: Capsule()
                )
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(item.title). \(GoalRunCopy.tab(index: index, count: set.count))")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
