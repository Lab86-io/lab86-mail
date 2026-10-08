import Foundation

// The pure rules of the Albatross thread window on the Mac
// (docs/research/albatross-thread-macos-design-2026-10-07.md): when the
// trailing pane may open, how wide it is, when the source list gives way,
// and how the pane follows the page. Views stay thin; these rules are tested.

/// What the trailing pane shows.
enum MacThreadPaneMode: String, Equatable, Sendable {
    case none
    case page
    case details
}

enum MacThreadLayout {
    /// The detail column must hold the conversation and the pane side by side.
    static let minimumWidth: CGFloat = 960
    static let conversationMinWidth: CGFloat = 480
    /// One width band for both pane modes, so the restored inspector width
    /// never fights a mode change.
    static let paneMinWidth: CGFloat = 460
    static let paneIdealMax: CGFloat = 640
    static let paneMaxWidth: CGFloat = 760
    /// The source list at its ideal width (`MacShellView`).
    static let sidebarWidth: CGFloat = 260
    /// The transcript keeps a reading measure; the column may be wider.
    static let readingMeasure: CGFloat = 720
    /// The plan popover, and the details popover of a narrow window.
    static let popoverWidth: CGFloat = 360
    static let popoverMaxHeight: CGFloat = 560

    /// What the window can do for a pane.
    enum Room: Equatable, Sendable {
        /// The detail column holds the pane beside the conversation.
        case pane
        /// The column is too narrow with the source list, and wide enough
        /// without it: the source list gives way first.
        case collapseSidebarFirst
        /// No room: the page is a sheet and the details are a popover.
        case none
    }

    static func allowsPane(width: CGFloat) -> Bool {
        width >= minimumWidth
    }

    /// About half the column, between the pane limits. The user may drag
    /// past the ideal, up to `paneMaxWidth`.
    static func paneWidth(for width: CGFloat) -> CGFloat {
        min(paneIdealMax, max(paneMinWidth, (width * 0.52).rounded()))
    }

    /// The detail column of a window: the window minus the source list.
    static func detailWidth(windowWidth: CGFloat, sidebarShown: Bool) -> CGFloat {
        sidebarShown ? windowWidth - sidebarWidth : windowWidth
    }

    static func room(windowWidth: CGFloat, sidebarShown: Bool) -> Room {
        if allowsPane(width: detailWidth(windowWidth: windowWidth, sidebarShown: sidebarShown)) { return .pane }
        if sidebarShown, windowWidth >= minimumWidth { return .collapseSidebarFirst }
        return .none
    }

    /// The pane after the page changes. A new page takes the pane, and
    /// displaces the details (decision 14). A page that closes takes its
    /// pane with it; the details stay.
    static func paneAfterPageChange(current: MacThreadPaneMode, hasPage: Bool, allowsPane: Bool) -> MacThreadPaneMode {
        guard allowsPane else { return .none }
        if hasPage { return .page }
        return current == .page ? .none : current
    }

    /// The pane after a toolbar toggle or a View menu item. The same mode
    /// again closes the pane. The page needs a page to show.
    static func paneAfterToggle(_ target: MacThreadPaneMode, current: MacThreadPaneMode, canShowPage: Bool) -> MacThreadPaneMode {
        if target == current { return .none }
        if target == .page, !canShowPage { return current }
        return target
    }

    /// The pane after the window changes size. A pane with no room closes.
    static func paneAfterWidthChange(current: MacThreadPaneMode, allowsPane: Bool) -> MacThreadPaneMode {
        allowsPane ? current : .none
    }

    // MARK: - Document mode (docs/albatross-document-handoff.md, D5)

    /// The document in the center must keep an editor's width.
    static let documentMinWidth: CGFloat = 480
    /// The thread column on the right: 380 to 440 pt by the window, and the
    /// user may drag it up to `documentColumnMaxWidth`.
    static let documentColumnMinWidth: CGFloat = 380
    static let documentColumnIdealMax: CGFloat = 440
    static let documentColumnMaxWidth: CGFloat = 560

    /// The detail column must hold the document and the thread column.
    static var documentMinimumWidth: CGFloat { documentMinWidth + documentColumnMinWidth }

    /// About a third of the column, within the band.
    static func documentColumnWidth(for width: CGFloat) -> CGFloat {
        min(documentColumnIdealMax, max(documentColumnMinWidth, (width * 0.36).rounded()))
    }

    /// What the window can do for the document: the split, the source list
    /// gives way first, or the split squeezed as it is.
    static func documentRoom(windowWidth: CGFloat, sidebarShown: Bool) -> Room {
        if detailWidth(windowWidth: windowWidth, sidebarShown: sidebarShown) >= documentMinimumWidth { return .pane }
        if sidebarShown, windowWidth >= documentMinimumWidth { return .collapseSidebarFirst }
        return .none
    }
}
