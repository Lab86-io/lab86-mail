import Foundation

// Needs you on the Mac (docs/needs-you.md, phase 5; docs/needs-you-phases-2-5.md,
// M): the pure rules of the list beside the detail. Which rows the list
// shows and in what order, where a key moves the selection, where the
// selection goes after its row leaves, which single keys act on which rows,
// what Command-C copies, which verb the hover slot shows, and the words and
// enabled states of the Needs You menu. The groups, the words, and the
// first button are the shared NeedsYouGrouping, NeedsYouLabels, and
// NeedsYouPresentation rules; nothing here is a second copy of them.
enum MacNeedsYouLayout {
    /// The ideal width of the list, as the web page's list (440 px).
    static let listWidth: CGFloat = 440
    /// The list at its narrowest and widest beside the detail.
    static let listMinWidth: CGFloat = 340
    static let listMaxWidth: CGFloat = 560
    /// The detail at its narrowest, so the action row keeps one line.
    static let detailMinWidth: CGFloat = 440

    // MARK: - The rows

    /// The rows on screen, in the order of the groups. The Closed today
    /// rows show only while that group is open.
    static func visibleEntries(_ groups: [NeedsYouGroup], showsClosed: Bool) -> [NeedsYouEntry] {
        var entries: [NeedsYouEntry] = []
        for group in groups {
            if group.id == .closedToday, !showsClosed { continue }
            entries.append(contentsOf: group.entries)
        }
        return entries
    }

    static func visibleIDs(_ groups: [NeedsYouGroup], showsClosed: Bool) -> [String] {
        visibleEntries(groups, showsClosed: showsClosed).map(\.id)
    }

    // MARK: - The keys

    enum Move: Equatable, Sendable {
        case up
        case down
        case first
        case last
    }

    /// The row a key moves to. Down from nothing is the first row; up from
    /// nothing is the last. The ends do not wrap, as the web list does not.
    static func target(_ move: Move, from current: String?, in ids: [String]) -> String? {
        guard !ids.isEmpty else { return nil }
        let index = current.flatMap { id in ids.firstIndex(of: id) }
        switch move {
        case .first:
            return ids.first
        case .last:
            return ids.last
        case .down:
            guard let index else { return ids.first }
            return ids[min(index + 1, ids.count - 1)]
        case .up:
            guard let index else { return ids.last }
            return ids[max(index - 1, 0)]
        }
    }

    /// Where the selection goes after its row leaves the list (Done, Later,
    /// Not mine, an expired code, a folded group): the row after it in the
    /// old order that is still there, else the row before it, else nothing.
    static func afterLeaving(_ id: String, old: [String], remaining: [String]) -> String? {
        guard let index = old.firstIndex(of: id) else { return remaining.first }
        let stillThere = Set(remaining)
        for candidate in old[(index + 1)...] where stillThere.contains(candidate) {
            return candidate
        }
        for candidate in old[..<index].reversed() where stillThere.contains(candidate) {
            return candidate
        }
        return nil
    }

    /// What one bare key does to the selected row: `e` marks Done and `l`
    /// offers Later, each only where the detail offers it. Nil is a key the
    /// list does not take.
    enum KeyAction: Equatable, Sendable {
        case done
        case later
    }

    static func keyAction(_ characters: String, on entry: NeedsYouEntry?) -> KeyAction? {
        guard case .obligation(let obligation)? = entry else { return nil }
        switch characters {
        case "e": return canMarkDone(obligation) ? .done : nil
        case "l": return canSnooze(obligation) ? .later : nil
        default: return nil
        }
    }

    // MARK: - What a row allows

    /// Done applies to every open row but a code (it closes itself) and an
    /// invitation (the answer closes it): the detail's own rule, whether
    /// Done is the first button or the one beside it.
    static func canMarkDone(_ obligation: ObligationView) -> Bool {
        NeedsYouPresentation.showsDone(obligation) || NeedsYouPresentation.primaryAction(obligation) == .done
    }

    static func canSnooze(_ obligation: ObligationView) -> Bool {
        NeedsYouPresentation.showsLater(obligation)
    }

    static func canDismiss(_ obligation: ObligationView) -> Bool {
        !obligation.isClosed
    }

    /// Only an open code has something to copy.
    static func canCopy(_ obligation: ObligationView) -> Bool {
        obligation.kind == .code && obligation.code != nil && !obligation.isClosed
    }

    /// Start in Albatross, whether it is the first button or the quiet link.
    static func canStartInAlbatross(_ obligation: ObligationView) -> Bool {
        NeedsYouPresentation.showsStartInAlbatross(obligation)
            || NeedsYouPresentation.primaryAction(obligation) == .startInAlbatross
    }

    /// What Command-C copies: the code of an open code row, else nothing.
    static func copyItems(for entry: NeedsYouEntry?) -> [String] {
        guard case .obligation(let obligation)? = entry, canCopy(obligation), let code = obligation.code else { return [] }
        return [code.value]
    }

    // MARK: - The hover slot

    /// The verb the due slot shows on hover (web design note, row states):
    /// "Copy" on a code row, "Done" on the other open rows. Text only.
    enum HoverVerb: String, Identifiable, Sendable {
        case copy = "Copy"
        case done = "Done"

        var id: String { rawValue }
        var label: String { rawValue }
    }

    static func hoverVerbs(_ obligation: ObligationView) -> [HoverVerb] {
        if canCopy(obligation) { return [.copy] }
        if canMarkDone(obligation) { return [.done] }
        return []
    }
}

/// What the Needs You menu asks the page to do with the selected row.
enum MacNeedsYouAction: Equatable, Sendable {
    case done
    case later(until: ObligationMillis)
    case notMine
    case copyCode
    case startInAlbatross
    case openSource
}

/// The words and the enabled states of the Needs You menu, for the menu
/// and the tests. Title case, as the other Mac menus.
enum MacNeedsYouCommandState {
    static let menu = "Needs You"
    static let markDone = "Mark Done"
    static let later = "Later"
    static let notMine = "Not Mine"
    static let copyCode = "Copy Code"
    static let startInAlbatross = "Start in Albatross"
    static let openInMail = "Open in Mail"

    /// The items work only while the page is up and no sheet is over it.
    static func isPageUp(selectedTab: PrimaryTab, sheetOpen: Bool) -> Bool {
        selectedTab == .needsYou && !sheetOpen
    }

    static func doneEnabled(pageUp: Bool, item: ObligationView?) -> Bool {
        guard pageUp, let item else { return false }
        return MacNeedsYouLayout.canMarkDone(item)
    }

    static func laterEnabled(pageUp: Bool, item: ObligationView?) -> Bool {
        guard pageUp, let item else { return false }
        return MacNeedsYouLayout.canSnooze(item)
    }

    static func notMineEnabled(pageUp: Bool, item: ObligationView?) -> Bool {
        guard pageUp, let item else { return false }
        return MacNeedsYouLayout.canDismiss(item)
    }

    static func copyEnabled(pageUp: Bool, item: ObligationView?) -> Bool {
        guard pageUp, let item else { return false }
        return MacNeedsYouLayout.canCopy(item)
    }

    static func startEnabled(pageUp: Bool, item: ObligationView?) -> Bool {
        guard pageUp, let item else { return false }
        return MacNeedsYouLayout.canStartInAlbatross(item)
    }

    static func openEnabled(pageUp: Bool, item: ObligationView?) -> Bool {
        guard pageUp, let item else { return false }
        return NeedsYouPresentation.openInLabel(item) != nil
    }

    /// "Open in Mail" for a mail thread, "Open in Slack" for a link, and
    /// "Open in Mail" at rest.
    static func openTitle(_ item: ObligationView?) -> String {
        item.flatMap(NeedsYouPresentation.openInLabel) ?? openInMail
    }
}
