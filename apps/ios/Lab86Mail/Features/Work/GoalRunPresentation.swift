import Foundation

// The pure rules behind a goal run's block (docs/albatross-goal-runs.md and
// docs/research/goal-runs-native-design-2026-10-15.md): the words, which
// messages show and which fold, the checklist summary, what each package row
// says and does, and whether a Work is a goal Work. Views stay thin and
// these rules stay testable. iOS and macOS share this file.

/// The words of a goal run. Sentence case, no -ing forms.
enum GoalRunCopy {
    static let earlierMessages = "Earlier messages"
    static let checklist = "Checklist"
    static let noChecklist = "No checklist yet. Albatross writes one when it starts."
    static let checklistFooter = "Albatross keeps this list while it works. Tell Albatross in the conversation when something changed."
    static let notSure = "Not sure"
    static let openOnWeb = "Open on the web"
    /// The second button of a goal handoff: the same words as document mode.
    static let doneContinue = DocumentHandoffCopy.done
    static let fromAlbatross = "From Albatross"
    /// The plan line of a goal Work while a run works.
    static let worksOnIt = "Albatross works on it"

    /// "Now: Find the hours for each month"
    static func now(_ item: String) -> String {
        "Now: \(item)"
    }

    /// The state word of a package row, as a short sentence.
    static let ready = "Ready."
    static let checkIt = "Check it."

    /// The line under a saved file with a field that fills in later.
    static func sealedLine(field: String) -> String {
        "The \(field) fills in when you send or download."
    }

    /// The same line on a composer row, where only a send fills it in.
    static func sealedComposerLine(field: String) -> String {
        "The \(field) fills in when you send."
    }

    /// The composer row of a sealed file when nothing names the field.
    static let sealedGenericComposerLine = "A field fills in when you send."
    /// The composer line when the server needs a send permission for a
    /// sealed file (409 `needs_allow`). The permission lives on the web.
    static let sendNeedsAllow = "This file needs your permission to send. Give it on the web, then send again."
    /// The second sentence after the item, the file, and the domain.
    static let allowOnWeb = "Allow it on the web, then send again."
    /// The file viewer line when the bytes need the identity check (403 `verify_identity`).
    static let fileNeedsIdentity = "This file fills in a sealed field. Open it on the web with one more check."

    /// "Tab 2 of 3", for VoiceOver on the item bar.
    static func tab(index: Int, count: Int) -> String {
        "Tab \(index + 1) of \(count)"
    }
}

/// The second line of a source capsule: the title first, then one specific
/// locator in the secondary style, with no middle dot. The server sends it
/// as `detail` (a host, "Priya, Jul 30", an issue key, a short date). Without
/// one, a web page still shows its host; the rest shows nothing.
enum RunSourceLocator {
    static func text(_ source: RunSource) -> String? {
        let candidate = source.detail ?? (source.kind == .web ? host(of: source.url) : nil)
        guard let candidate else { return nil }
        // The same rule as the web: a locator the title already holds does
        // not show twice ("BP-214 worklog, July" and "BP-214").
        return contains(source.title, candidate) ? nil : candidate
    }

    /// True when the title holds the detail, case and outer spaces aside.
    static func contains(_ title: String, _ detail: String) -> Bool {
        let needle = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return true }
        return title.range(of: needle, options: [.caseInsensitive]) != nil
    }

    /// "irs.gov" for "https://www.irs.gov/forms/w9".
    static func host(of raw: String?) -> String? {
        guard let raw, let host = URL(string: raw)?.host()?.nilIfBlank else { return nil }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
}

/// True when the Work works as one goal: the server says so on the detail,
/// or one of its runs is a goal run (an older `work_home`).
enum ThreadGoal {
    static func isGoalWork(detail: WorkDetail?, runs: [ThreadRunView]) -> Bool {
        if detail?.isGoalWork == true { return true }
        return runs.contains { $0.run.isGoal }
    }
}

/// Which messages a block shows in full, and which fold under "Earlier messages".
enum GoalRunMessages {
    /// An open run shows the newest three; a run that ended shows the newest one.
    static func shownCount(_ state: RunBlockState) -> Int {
        state.isOpen ? 3 : 1
    }

    static func split(_ messages: [RunMessage], state: RunBlockState) -> (earlier: [RunMessage], shown: [RunMessage]) {
        let count = shownCount(state)
        guard messages.count > count else { return ([], messages) }
        return (Array(messages.dropLast(count)), Array(messages.suffix(count)))
    }
}

/// A run message holds simple Markdown (lists, bold, links). Images and HTML
/// never render: an image keeps its alt text, and a tag drops out.
enum RunMessageText {
    private static let image = try? NSRegularExpression(pattern: "!\\[([^\\]]*)\\]\\([^)]*\\)")
    private static let tag = try? NSRegularExpression(pattern: "<[^>\\n]{1,200}>")

    static func safe(_ text: String) -> String {
        var out = text
        if let image {
            out = image.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: "$1")
        }
        if let tag {
            out = tag.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: "")
        }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// The checklist summary and the default disclosure state.
enum ChecklistSummary {
    /// The count beside the "Checklist" label, in the secondary style: "2 of
    /// 6 done", or "2 of 6 done, 1 for you". Nil with no items.
    static func count(_ items: [ChecklistItem]) -> String? {
        guard !items.isEmpty else { return nil }
        let done = items.filter { $0.state == .done }.count
        var line = "\(done) of \(items.count) done"
        let yours = items.filter { $0.state == .yours }.count
        if yours > 0 { line += ", \(yours) for you" }
        return line
    }

    /// Open on the newest run while it works or after it stopped at a
    /// limit (the user wants to see where it got to); folded elsewhere.
    static func expandedByDefault(isNewest: Bool, state: RunBlockState) -> Bool {
        guard isNewest else { return false }
        return state.isOpen || state == .stopped
    }

    /// The VoiceOver line of the list.
    static func accessibilityLine(_ items: [ChecklistItem]) -> String {
        var parts = [count(items).map { "\(GoalRunCopy.checklist), \($0)." } ?? "\(GoalRunCopy.checklist)."]
        if let doing = items.first(where: { $0.state == .doing }) { parts.append("Now: \(doing.text).") }
        return parts.joined(separator: " ")
    }
}

/// What a tap on a package row does on this client.
enum PackageItemBehaviour: Equatable, Sendable {
    case openDraft(id: String, accountID: String?)
    case openDocument(DocumentTarget)
    case openFile(fileID: String, title: String)
    case openApproval(id: String?)
    case openEvent(accountID: String, id: String)
    case openURL(String)
    case none

    /// The client never builds an open path: every item carries `url` from
    /// the server, and the link decides the editor, as the primary button's
    /// `DocumentTarget.resolve` does.
    static func from(_ item: HandoffItem, artifacts: [StepRunView.Artifact] = []) -> PackageItemBehaviour {
        switch item.kind {
        case .draft:
            guard let id = item.referenceID else { return .none }
            return .openDraft(id: id, accountID: item.accountID)
        case .document, .sheet, .deck:
            if let target = DocumentTarget.resolve(url: item.url, id: item.referenceID, artifacts: artifacts) {
                return .openDocument(target)
            }
            return item.url.map { .openURL($0) } ?? .none
        case .file:
            guard let id = item.savedFileID else { return item.url.map { .openURL($0) } ?? .none }
            return .openFile(fileID: id, title: item.title)
        case .approval:
            return .openApproval(id: item.referenceID)
        case .event:
            if let accountID = item.accountID, let id = item.referenceID { return .openEvent(accountID: accountID, id: id) }
            return item.url.map { .openURL($0) } ?? .none
        case .page, .unknown:
            return item.url.map { .openURL($0) } ?? .none
        }
    }

    /// Document mode shows these as items (one tab each).
    var opensInDocumentMode: Bool {
        switch self {
        case .openDraft, .openDocument, .openFile: true
        case .openApproval, .openEvent, .openURL, .none: false
        }
    }
}

/// What line 2 of a package row shows.
enum PackageStateLine: Equatable, Sendable {
    case ready(note: String?)
    case blanks([String], note: String?)
    case check(note: String?)
}

/// The rows of the package card and the Brief line.
enum PackageRows {
    static func stateLine(_ item: HandoffItem) -> PackageStateLine {
        switch item.state {
        case .blanks:
            return item.blanks.isEmpty ? .check(note: item.note) : .blanks(item.blanks, note: item.note)
        case .ready:
            return .ready(note: item.note)
        case .check, .unknown:
            return .check(note: item.note)
        }
    }

    /// "Ready." or "Check it." as a short sentence. Nil when the row draws
    /// blanks: the blank sentence says what waits.
    static func stateWord(_ item: HandoffItem) -> String? {
        switch stateLine(item) {
        case .ready: GoalRunCopy.ready
        case .check: GoalRunCopy.checkIt
        case .blanks: nil
        }
    }

    /// The item's note, on its own line under the state word.
    static func noteLine(_ item: HandoffItem) -> String? {
        switch stateLine(item) {
        case .ready(let note), .check(let note), .blanks(_, let note): note
        }
    }

    static func verb(_ item: HandoffItem) -> String {
        item.kind.verb
    }

    /// The Brief line: "3 items: Draft to Priya Shah, Invoice 2026-10, and
    /// Form W-9." Past three titles: "…, and 2 more." Nil with no items.
    static func line(_ items: [HandoffItem]) -> String? {
        guard !items.isEmpty else { return nil }
        let titles = items.map(\.title)
        let count = titles.count
        let names: String
        switch count {
        case 1: names = titles[0]
        case 2: names = "\(titles[0]) and \(titles[1])"
        case 3: names = "\(titles[0]), \(titles[1]), and \(titles[2])"
        default: names = "\(titles[0]), \(titles[1]), \(titles[2]), and \(count - 3) more"
        }
        return "\(count) \(count == 1 ? "item" : "items"): \(names)."
    }

    /// The VoiceOver label of a row.
    static func accessibilityLabel(_ item: HandoffItem) -> String {
        var parts = ["\(item.title).", "\(item.kind.word)."]
        if case .blanks(let blanks, _) = stateLine(item) {
            parts.append(BlankSentenceRules.text(blanks))
        } else if let word = stateWord(item) {
            parts.append(word)
        }
        if let note = noteLine(item) { parts.append(note) }
        return parts.joined(separator: " ")
    }
}
