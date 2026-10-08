import Foundation

// The pure rules of the Albatrosses section in the Mac source list
// (docs/research/albatross-threads-macos-design-2026-10-08.md, sections 2.3,
// 3.3, and 4.3): which rows the sidebar shows and how many, the hover verbs
// in the time slot, the dot on a folded set of rows, the hop order of the Go
// menu, and where the window goes when the open thread leaves the list. The
// words, the dot, the sections, and the sort are the shared
// ThreadRowPresentation rules; nothing here is a second copy of them.
enum MacThreadListLayout {
    /// The rows the section shows before "Show N more".
    static let rowLimit = 12
    /// A quiet row stays awake this long after its last activity.
    static let awakeWindow: TimeInterval = 7 * 24 * 60 * 60
    /// The section's "Stopped …" notice leaves after this long.
    static let noticeDuration: Duration = .seconds(10)
    /// "Sent to the run" under a row's steer field stays this long.
    static let sentLineDuration: Duration = .seconds(6)
    /// The filter words of the header and the View menu (T12).
    static let filters: [WorkFilter] = [.all, .needsYou, .inProgress]

    /// A row is awake when it needs the user, works, is unread, or had
    /// activity in the last seven days. Done, put down, and dormant rows
    /// live on the Albatrosses page only.
    static func isAwake(_ row: ThreadListRow, now: Date) -> Bool {
        if row.item.horizon?.isDormant(at: now) == true { return false }
        if let live = row.live {
            if live.needsYou || live.status.needsYou { return true }
            if live.working || live.status.inMotion { return true }
            if live.unread { return true }
            if live.closed { return false }
        }
        if row.item.isClosed, !row.item.isUnresolved { return false }
        if row.item.needsYou || row.item.isUnresolved { return true }
        guard let at = row.lastActivityAt else { return false }
        return now.timeIntervalSince(at) <= awakeWindow
    }

    /// The section's rows: awake, under the filter, in section order (needs
    /// you, in progress, open), each section sorted by the shared rule.
    static func rows(items: [WorkListItem], live: [ThreadRow], filter: WorkFilter, now: Date) -> [ThreadListRow] {
        let awake = ThreadListGrouping.rows(items: items, live: live).filter { isAwake($0, now: now) }
        let filtered = ThreadListGrouping.filter(awake, by: filter, areaID: nil)
        return ThreadListGrouping.sections(filtered).flatMap(\.rows)
    }

    /// The rows on screen, and the count behind "Show N more".
    static func visible(_ rows: [ThreadListRow], showsAll: Bool) -> (shown: [ThreadListRow], hidden: Int) {
        guard !showsAll, rows.count > rowLimit else { return (rows, 0) }
        return (Array(rows.prefix(rowLimit)), rows.count - rowLimit)
    }

    /// The rows "Show N more" folds, for the dot on that row.
    static func folded(_ rows: [ThreadListRow], showsAll: Bool) -> [ThreadListRow] {
        guard !showsAll, rows.count > rowLimit else { return [] }
        return Array(rows.dropFirst(rowLimit))
    }

    /// "Show 4 more" while rows are folded; "Show fewer" after; nil when
    /// the rows fit.
    static func moreLabel(total: Int, showsAll: Bool) -> String? {
        guard total > rowLimit else { return nil }
        return showsAll ? "Show fewer" : "Show \(total - rowLimit) more"
    }

    /// The dot on a folded set of rows (the "Show N more" row, the collapsed
    /// header): the most urgent kind inside.
    static func dot(for rows: [ThreadListRow]) -> ThreadRowDot {
        var found: ThreadRowDot = .none
        for row in rows {
            switch ThreadRowPresentation.dot(row) {
            case .needsYou:
                return .needsYou
            case .working:
                found = .working
            case .startsSoon:
                if found == .none { found = .startsSoon }
            case .none:
                break
            }
        }
        return found
    }

    /// The hover actions in the time slot (design note 3.3). Text only, the
    /// most destructive last.
    static func hoverVerbs(_ status: ThreadRowStatus) -> [ThreadRowVerb] {
        switch status {
        case .needsAnswer: [.answer]
        case .yourTurn: [.openPage]
        case .inProgress: [.steer, .stop]
        case .answering: [.stopReply]
        case .startsSoon: [.stop]
        case .stopped: [.continueRun]
        case .readyForYou, .didNotFinish, .done, .waiting, .paused, .idle: []
        }
    }

    /// The empty line under a filter with no rows.
    static func emptyLine(filter: WorkFilter) -> String {
        switch filter {
        case .needsYou: "Nothing needs you."
        case .inProgress: "Nothing in progress."
        case .all, .unhomed: "No Albatrosses yet."
        }
    }

    // MARK: - The hop (the Go menu)

    enum Move: Equatable, Sendable {
        case previous
        case next
        case nextNeedsYou
    }

    /// The row a move opens, from the open thread (nil when none is open).
    /// Next and previous wrap. "Next that needs you" is the first needs-you
    /// row after the open one, then from the top; nil when none.
    static func target(_ move: Move, from current: String?, in rows: [ThreadListRow]) -> ThreadListRow? {
        guard !rows.isEmpty else { return nil }
        let index = current.flatMap { id in rows.firstIndex { $0.id == id } }
        switch move {
        case .next:
            guard let index else { return rows.first }
            return rows[(index + 1) % rows.count]
        case .previous:
            guard let index else { return rows.last }
            return rows[(index - 1 + rows.count) % rows.count]
        case .nextNeedsYou:
            let needs = rows.filter { ThreadRowPresentation.section($0) == .needsYou }
            guard let index else { return needs.first }
            if let after = rows[(index + 1)...].first(where: { ThreadRowPresentation.section($0) == .needsYou }) {
                return after
            }
            return needs.first { $0.id != current }
        }
    }

    /// Where the window goes after the open thread leaves the list ("Mark
    /// done", "Archive"): the next row that needs the user, else the next
    /// row, else the Albatrosses page (nil).
    static func afterLeaving(_ workID: String, in rows: [ThreadListRow]) -> ThreadListRow? {
        let rest = rows.filter { $0.id != workID }
        guard !rest.isEmpty else { return nil }
        if let needs = rest.first(where: { ThreadRowPresentation.section($0) == .needsYou }) { return needs }
        guard let index = rows.firstIndex(where: { $0.id == workID }) else { return rest.first }
        return rows[(index + 1)...].first(where: { $0.id != workID }) ?? rest.first
    }

    /// The thread shows the "needs you" banner only while the source list is
    /// hidden; otherwise the row beside the thread shows the change.
    static func showsBanner(sidebarShown: Bool) -> Bool {
        !sidebarShown
    }
}

/// The words of the section that are not a row's.
enum MacThreadRowsCopy {
    static let title = "Albatrosses"
    static let filterHelp = "Which Albatrosses the list shows"
    static let showInArea = "Show in Area"
    static let open = "Open"
    static let sendHint = "↩"

    /// "Stopped Renew the car registration"
    static func stopped(_ title: String) -> String {
        "Stopped \(title)"
    }

    /// "Note to the run for Renew the car registration"
    static func steerLabel(_ title: String) -> String {
        "Note to the run for \(title)"
    }

    static let steerHint = "Return sends. Escape cancels."

    /// "Albatrosses, 2 need you, collapsed"
    static func headerLabel(needsYou: Int, expanded: Bool) -> String {
        var parts = [title]
        if needsYou == 1 {
            parts.append("1 needs you")
        } else if needsYou > 1 {
            parts.append("\(needsYou) need you")
        }
        parts.append(expanded ? "expanded" : "collapsed")
        return parts.joined(separator: ", ")
    }
}
