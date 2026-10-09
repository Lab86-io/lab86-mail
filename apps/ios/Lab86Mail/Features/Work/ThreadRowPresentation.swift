import Foundation

// The pure rules behind the thread list (docs/albatross-threads.md and the
// iOS design note of 2026-10-08): the dot, the words, the time label, the
// section, the sort, the filter, the VoiceOver label, and the verbs a row
// offers. Views stay thin and these rules stay testable. The Mac rail reads
// the same rules, so the two never drift.

/// The dot before the title (lead decision 2). One indicator for each row.
enum ThreadRowDot: Equatable, Sendable {
    case none
    /// Accent, steady: the row waits on the user.
    case needsYou
    /// Accent-2 with one slow halo (static under Reduce Motion): a run or a
    /// reply works.
    case working
    /// Accent-2, hollow: a run waits for a free slot.
    case startsSoon
}

/// The open sections of the list, in order.
enum ThreadListSection: String, CaseIterable, Hashable, Sendable {
    case needsYou
    case inProgress
    case open

    var label: String {
        switch self {
        case .needsYou: "Needs you"
        case .inProgress: "In progress"
        case .open: "Open"
        }
    }

    var hint: String {
        switch self {
        case .needsYou: "Albatross cannot move these without you."
        case .inProgress: "Albatross works on these now."
        case .open: "Nothing waits on you here."
        }
    }

    /// Whether the section rule carries the accent.
    var asksForYou: Bool { self == .needsYou }
}

/// One verb a row offers from the list: a swipe button or a menu item.
enum ThreadRowVerb: String, Hashable, Sendable, Identifiable, CaseIterable {
    case answer
    case openPage
    case steer
    case stopAndRedirect
    case stop
    case stopReply
    case continueRun

    var id: String { rawValue }

    /// The swipe button. Text only.
    var label: String {
        switch self {
        case .answer: "Answer"
        case .openPage: "Open the page"
        case .steer: "Steer"
        case .stopAndRedirect: "Stop and redirect"
        case .stop: "Stop"
        case .stopReply: "Stop"
        case .continueRun: "Continue"
        }
    }

    /// The context menu item. A verb that opens a sheet ends with an ellipsis.
    var menuLabel: String {
        switch self {
        case .answer: "Answer…"
        case .steer: "Steer…"
        case .stopAndRedirect: "Stop and redirect…"
        case .stopReply: "Stop the reply"
        case .openPage, .stop, .continueRun: label
        }
    }
}

/// One row of the list: the Work as `work_list` sends it, and its live
/// state when the threads read has one.
struct ThreadListRow: Identifiable, Hashable, Sendable {
    let item: WorkListItem
    let live: ThreadRow?

    var id: String { item.id }

    var title: String { item.displayTitle }

    var areaName: String? { item.areaName }

    var status: ThreadRowStatus { live?.status ?? .idle }

    var unread: Bool { live?.unread ?? false }

    var working: Bool { live?.working ?? false }

    var lastActivityAt: Date? { live?.lastActivityAt ?? item.updatedAt }
}

enum ThreadRowPresentation {
    static func dot(_ row: ThreadListRow) -> ThreadRowDot {
        guard let live = row.live else {
            return row.item.needsYou || row.item.isUnresolved ? .needsYou : .none
        }
        if live.needsYou || live.status.needsYou { return .needsYou }
        if live.status == .startsSoon { return .startsSoon }
        if live.working || live.status == .inProgress || live.status == .answering { return .working }
        return .none
    }

    /// The status word: the server's label, else this build's word. Nil for
    /// a row with nothing in motion.
    static func word(_ row: ThreadListRow) -> String? {
        row.live?.word
    }

    /// Line 2 of the row: "Status word · preview". Without a word, the
    /// preview alone; without both, today's standing line.
    static func statusLine(_ row: ThreadListRow) -> String {
        let preview = row.live?.preview?.nilIfBlank ?? (row.working ? row.live?.stepTitle?.nilIfBlank : nil)
        switch (word(row), preview) {
        case (let word?, let preview?): return "\(word) · \(preview)"
        case (let word?, nil): return word
        case (nil, let preview?): return preview
        case (nil, nil): return row.item.standingLine
        }
    }

    /// The blanks a row draws in place of line 2: only for an open
    /// `ready_for_you` or `your_turn` handoff (docs/albatross-blank-design.md).
    static func blanks(_ row: ThreadListRow) -> [String] {
        guard let live = row.live, live.status == .readyForYou || live.status == .yourTurn else { return [] }
        return live.blanks
    }

    /// Line 2 after two failed reads in a row: a live row says when it was
    /// last seen instead of a false "In progress".
    static func staleLine(_ row: ThreadListRow, locale: Locale = .current) -> String {
        guard row.working, let word = word(row), let at = row.lastActivityAt else { return statusLine(row) }
        return "\(word) · last seen \(at.formatted(.dateTime.hour().minute().locale(locale)))"
    }

    /// The time at the trailing edge: the elapsed time of the run while a
    /// run works, else the time since the last activity (lead decision 2).
    static func timeLabel(_ row: ThreadListRow, now: Date, locale: Locale = .current) -> String? {
        if row.working, let started = row.live?.runStartedAt {
            return elapsed(from: started, to: now, locale: locale)
        }
        guard let at = row.lastActivityAt else { return nil }
        return elapsed(from: at, to: now, locale: locale)
    }

    /// "now", "4 min", "2 h", "3 d", then the date.
    static func elapsed(from start: Date, to now: Date, locale: Locale = .current) -> String {
        let seconds = max(0, now.timeIntervalSince(start))
        if seconds < 60 { return "now" }
        let minutes = Int(seconds / 60)
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours) h" }
        let days = hours / 24
        if days < 7 { return "\(days) d" }
        return start.formatted(.dateTime.month(.abbreviated).day().locale(locale))
    }

    /// The section a row sits in. The live status wins; without one, the
    /// list item's own rules decide.
    static func section(_ row: ThreadListRow) -> ThreadListSection {
        if let live = row.live {
            if live.needsYou || live.status.needsYou { return .needsYou }
            if live.working || live.status.inMotion { return .inProgress }
            return .open
        }
        return row.item.needsYou || row.item.isUnresolved ? .needsYou : .open
    }

    /// Newest activity first. A run that waits for a slot sorts last.
    static func sorted(_ rows: [ThreadListRow]) -> [ThreadListRow] {
        rows.sorted { left, right in
            let leftWaits = left.status == .startsSoon
            let rightWaits = right.status == .startsSoon
            if leftWaits != rightWaits { return rightWaits }
            let leftAt = left.lastActivityAt ?? .distantPast
            let rightAt = right.lastActivityAt ?? .distantPast
            if leftAt != rightAt { return leftAt > rightAt }
            return left.title < right.title
        }
    }

    /// The VoiceOver label: the title leads, then the state, the time, the
    /// area, and the unread mark.
    static func accessibilityLabel(_ row: ThreadListRow, time: String?, area: String?, stale: Bool = false) -> String {
        let rowBlanks: [String] = stale ? [] : Self.blanks(row)
        var parts = [row.title]
        if rowBlanks.isEmpty {
            parts.append(stale ? staleLine(row) : statusLine(row))
        } else {
            if let status = Self.word(row) { parts.append(status) }
            parts.append(BlankSentenceRules.text(rowBlanks))
        }
        if let time { parts.append(time) }
        if let area { parts.append(area) }
        if row.unread { parts.append("Unread") }
        return parts.joined(separator: ". ")
    }

    /// The trailing swipe buttons, from the edge inward. Two at most.
    static func swipeVerbs(_ status: ThreadRowStatus) -> [ThreadRowVerb] {
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

    /// The context menu verbs, in order.
    static func menuVerbs(_ status: ThreadRowStatus) -> [ThreadRowVerb] {
        switch status {
        case .needsAnswer: [.answer]
        case .yourTurn: [.openPage]
        case .inProgress: [.steer, .stopAndRedirect, .stop]
        case .answering: [.stopReply]
        case .startsSoon: [.stop]
        case .stopped: [.continueRun]
        case .readyForYou, .didNotFinish, .done, .waiting, .paused, .idle: []
        }
    }
}

/// The list rows from the two reads, the filter, and the sections.
enum ThreadListGrouping {
    /// `work_list` rows overlaid by the threads rows on the Work id. A Work
    /// without a threads row is idle.
    static func rows(items: [WorkListItem], live: [ThreadRow]) -> [ThreadListRow] {
        var byID: [String: ThreadRow] = [:]
        for row in live { byID[row.workID] = row }
        return items.map { ThreadListRow(item: $0, live: byID[$0.id]) }
    }

    static func filter(_ rows: [ThreadListRow], by filter: WorkFilter, areaID: String?) -> [ThreadListRow] {
        rows.filter { row in
            if let areaID, row.item.primaryAreaID != areaID { return false }
            switch filter {
            case .all: return true
            case .needsYou: return ThreadRowPresentation.section(row) == .needsYou
            case .inProgress: return ThreadRowPresentation.section(row) == .inProgress
            case .unhomed: return row.item.primaryAreaID == nil
            }
        }
    }

    /// The open sections in order, each sorted, empty ones dropped.
    static func sections(_ rows: [ThreadListRow]) -> [(section: ThreadListSection, rows: [ThreadListRow])] {
        var grouped: [ThreadListSection: [ThreadListRow]] = [:]
        for row in rows {
            grouped[ThreadRowPresentation.section(row), default: []].append(row)
        }
        return ThreadListSection.allCases.compactMap { section in
            guard let list = grouped[section], !list.isEmpty else { return nil }
            return (section, ThreadRowPresentation.sorted(list))
        }
    }
}
