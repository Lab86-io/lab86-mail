import Foundation

// Document mode with several items (docs/albatross-goal-runs.md, G3, and
// docs/research/goal-runs-native-design-2026-10-15.md, section 3.6): the
// items of one package that open in the thread, one at a time, with a bar
// (iPhone, iPad) or a list (Mac) to switch. Pure, so iOS and the Mac mount
// the same rules.

/// One item of document mode: a document, a sheet, or a deck (the web
/// editor), a saved file (a native viewer), or a draft (the composer).
struct DocumentModeItem: Identifiable, Hashable, Sendable {
    enum Content: Hashable, Sendable {
        case document(DocumentTarget)
        case file(fileID: String)
        case draft(id: String, accountID: String?)

        /// The kind of a lone item opened from a target, not from a package.
        var defaultKind: HandoffItem.Kind {
            switch self {
            case .document: .document
            case .file: .file
            case .draft: .draft
            }
        }

        /// A stable id for a lone item.
        var defaultID: String {
            switch self {
            case .document(let target): "document:\(target.provider.rawValue):\(target.id)"
            case .file(let fileID): "file:\(fileID)"
            case .draft(let id, _): "draft:\(id)"
            }
        }
    }

    let id: String
    let kind: HandoffItem.Kind
    let title: String
    let content: Content
    let blanks: [String]
    let note: String?
    let state: HandoffItem.State

    init(
        id: String,
        kind: HandoffItem.Kind,
        title: String,
        content: Content,
        blanks: [String] = [],
        note: String? = nil,
        state: HandoffItem.State = .ready
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.content = content
        self.blanks = blanks
        self.note = note
        self.state = state
    }

    var documentTarget: DocumentTarget? {
        if case .document(let target) = content { return target }
        return nil
    }

    var fileID: String? {
        if case .file(let fileID) = content { return fileID }
        return nil
    }

    /// The chat context while this item is selected. A file or a draft
    /// sends none (lead decision, 2026-10-15).
    var documentAttachment: DocumentContextAttachment? {
        documentTarget?.attachment
    }

    var workspaceDestination: NativeWorkspaceDestination? {
        documentTarget?.workspaceDestination
    }

    /// A saved file with a field that fills in at send or download time
    /// (docs/albatross-goal-runs.md, G5): the item note names it.
    var isSealed: Bool {
        kind == .file && state == .check && note != nil
    }
}

/// The items open in document mode and the selected one.
struct DocumentModeSet: Hashable, Sendable, Identifiable {
    /// The handoff the items belong to, when a handoff owns them.
    let runID: String?
    let items: [DocumentModeItem]
    private(set) var selectedID: String

    init(runID: String?, items: [DocumentModeItem], selectedID: String) {
        self.runID = runID
        self.items = items
        self.selectedID = items.contains(where: { $0.id == selectedID }) ? selectedID : (items.first?.id ?? selectedID)
    }

    var selected: DocumentModeItem {
        items.first { $0.id == selectedID } ?? items[0]
    }

    var index: Int {
        items.firstIndex { $0.id == selectedID } ?? 0
    }

    var count: Int { items.count }

    /// The bar and the list show only with more than one item.
    var showsSwitcher: Bool { items.count > 1 }

    mutating func select(id: String) {
        guard items.contains(where: { $0.id == id }) else { return }
        selectedID = id
    }

    /// The identity of the set as a whole, for a cover that must not present
    /// again when the selection moves.
    var id: String { items.map(\.id).joined(separator: "|") }

    /// "Next Item" (+1) and "Previous Item" (-1), with wrap.
    mutating func select(step: Int) {
        guard !items.isEmpty else { return }
        let next = ((index + step) % items.count + items.count) % items.count
        selectedID = items[next].id
    }
}

enum DocumentModeItems {
    /// The item a package row becomes, or nil for a kind that opens
    /// elsewhere (an approval, an event, a page).
    static func item(from item: HandoffItem, artifacts: [StepRunView.Artifact]) -> DocumentModeItem? {
        guard item.kind.opensInDocumentMode else { return nil }
        let content: DocumentModeItem.Content
        switch PackageItemBehaviour.from(item, artifacts: artifacts) {
        case .openDraft(let id, let accountID):
            content = .draft(id: id, accountID: accountID)
        case .openDocument(let target):
            content = .document(target)
        case .openFile(let fileID, _):
            content = .file(fileID: fileID)
        case .openApproval, .openEvent, .openURL, .none:
            return nil
        }
        return DocumentModeItem(
            id: item.id,
            kind: item.kind,
            title: item.title,
            content: content,
            blanks: item.blanks,
            note: item.note,
            state: item.state
        )
    }

    /// The set to open: the items of the open handoff that owns `opening`,
    /// in package order, with `opening` selected. With no such handoff, or a
    /// handoff without items (an older run), `opening` alone.
    static func set(opening: DocumentModeItem.Content, title: String?, runs: [ThreadRunView]) -> DocumentModeSet {
        let loneTitle = title?.nilIfBlank ?? defaultTitle(of: opening, runs: runs)
        let lone = DocumentModeItem(id: opening.defaultID, kind: opening.defaultKind, title: loneTitle, content: opening)
        guard let owner = DocumentHandoff.run(for: runs, content: opening) else {
            return DocumentModeSet(runID: nil, items: [lone], selectedID: lone.id)
        }
        let items = owner.run.items.compactMap { item(from: $0, artifacts: owner.run.artifacts) }
        if let match = items.first(where: { $0.content == opening }) {
            return DocumentModeSet(runID: owner.id, items: items, selectedID: match.id)
        }
        // The handoff names the document, but not as an item: one item with
        // the handoff's own blanks.
        let withBlanks = DocumentModeItem(
            id: lone.id,
            kind: lone.kind,
            title: loneTitle,
            content: opening,
            blanks: owner.run.next?.blanks ?? [],
            note: nil,
            state: (owner.run.next?.blanks.isEmpty ?? true) ? .ready : .blanks
        )
        return DocumentModeSet(runID: owner.id, items: [withBlanks], selectedID: lone.id)
    }

    /// The title of a lone item: the newest artifact that names it, else the
    /// kind word.
    static func defaultTitle(of content: DocumentModeItem.Content, runs: [ThreadRunView]) -> String {
        for view in runs.reversed() {
            for artifact in view.run.artifacts {
                switch content {
                case .document(let target):
                    if DocumentTarget.of(url: artifact.url, id: artifact.referenceID)?.id == target.id,
                       let title = artifact.title.nilIfBlank { return title }
                case .file(let fileID):
                    if artifact.kind == .file,
                       (artifact.referenceID == fileID || artifact.url.flatMap(SavedFileLink.fileID(in:)) == fileID),
                       let title = artifact.title.nilIfBlank { return title }
                case .draft(let id, _):
                    if artifact.kind == .draft, artifact.referenceID == id, let title = artifact.title.nilIfBlank { return title }
                }
            }
        }
        return content.defaultKind.word
    }
}
