import Foundation

/// One Albatross in the list: an unresolved outcome the user is carrying.
struct WorkListItem: Identifiable, Hashable, Sendable {
    let id: String
    let title: String?
    let rawText: String
    let status: String
    let workState: String?
    let agentState: String?
    let primaryAreaID: String?
    let areaName: String?
    let openQuestions: Int
    let updatedAt: Date?

    /// What the row calls itself. Never an id, never a blank line.
    var displayTitle: String {
        if let title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return title }
        let raw = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        return raw.isEmpty ? "Something you asked for" : raw
    }

    init?(json: JSONValue) {
        guard let id = json["_id"]?.stringValue ?? json["id"]?.stringValue else { return nil }
        self.id = id
        title = json["title"]?.stringValue?.nilIfBlank
        rawText = json["rawText"]?.stringValue ?? ""
        status = json["status"]?.stringValue ?? "ready"
        workState = json["workState"]?.stringValue?.nilIfBlank
        agentState = json["agentState"]?.stringValue?.nilIfBlank
        primaryAreaID = json["primaryAreaId"]?.stringValue?.nilIfBlank
        areaName = json["areaName"]?.stringValue?.nilIfBlank
        openQuestions = Int(json["openQuestions"]?.doubleValue ?? 0)
        updatedAt = CalendarDateParser.date(json["updatedAt"])
    }
}

/// The one definition of what state an Albatross is in.
///
/// A mirror of `lib/albatross/work-state.ts`. The rail, the list, Today and the
/// notifications all read from this on the web; the native client must not
/// invent a second answer to the same question.
enum WorkState: String, CaseIterable, Sendable {
    case needsYou = "needs_you"
    case inProgress = "in_progress"
    case waiting
    case unresolved
    case paused
    case done
    case released
    case archived

    /// The order the list shows them in: what asks for you comes first.
    static let order: [WorkState] = [
        .needsYou, .inProgress, .waiting, .unresolved, .paused, .done, .released, .archived,
    ]

    /// Closed on paper, one way or another.
    static let closed: Set<WorkState> = [.done, .released, .archived]

    var label: String {
        switch self {
        case .needsYou: "Needs you"
        case .inProgress: "In progress"
        case .waiting: "Waiting"
        case .unresolved: "Still asking"
        case .paused: "Paused"
        case .done: "Done"
        case .released: "Put down"
        case .archived: "Archived"
        }
    }

    var hint: String {
        switch self {
        case .needsYou: "Albatross cannot move these without you."
        case .inProgress: "Albatross is working on these."
        case .waiting: "These depend on somebody or something else."
        case .unresolved: "You put these down, but Albatross never got an answer."
        case .paused: "You stopped these on purpose."
        case .done: "These reached the outcome you wanted."
        case .released: "You decided these no longer deserved your attention."
        case .archived: "Hidden from the list."
        }
    }

    /// Whether the section rule carries the accent. Only what is asking for the
    /// user earns it.
    var asksForYou: Bool { self == .needsYou || self == .unresolved }
}

extension WorkListItem {
    /// True when Albatross cannot move without the user.
    var needsYou: Bool {
        if isClosed { return false }
        if openQuestions > 0 { return true }
        if agentState == "needs_input" { return true }
        if agentState == "error" { return true }
        return status == "needs_answers"
    }

    var isClosed: Bool {
        let state = workState ?? status
        return state == "done" || state == "released" || state == "archived"
    }

    /// Closed on paper, but Albatross is still waiting on an answer.
    var isUnresolved: Bool { isClosed && openQuestions > 0 }

    var state: WorkState {
        if isUnresolved { return .unresolved }
        // Released is checked before archived: a thing put down on purpose must
        // never be filed under "hidden", or the product can never tell the user
        // how much they consciously chose to stop carrying.
        if workState == "released" { return .released }
        if workState == "archived" || status == "archived" { return .archived }
        if workState == "done" || status == "done" { return .done }
        if needsYou { return .needsYou }
        if workState == "paused" { return .paused }
        if workState == "waiting" || workState == "blocked" { return .waiting }
        return .inProgress
    }

    /// The line under the title. It says what is true, never a raw count alone.
    var standingLine: String {
        if openQuestions == 1 { return "One question waiting for you" }
        if openQuestions > 1 { return "\(openQuestions) questions waiting for you" }
        switch state {
        case .waiting: return "Waiting on somebody else"
        case .paused: return "You stopped this on purpose"
        case .done: return "This reached the outcome you wanted"
        case .released: return "You put this down"
        case .archived: return "Filed away"
        default: return "Albatross is carrying this"
        }
    }
}

/// How the Albatrosses page is filtered.
enum WorkFilter: String, CaseIterable, Sendable {
    case all, needsYou, unhomed

    var label: String {
        switch self {
        case .all: "Everything"
        case .needsYou: "Needs you"
        case .unhomed: "No area yet"
        }
    }
}

enum WorkGrouping {
    static func filter(_ rows: [WorkListItem], by filter: WorkFilter, areaID: String?) -> [WorkListItem] {
        rows.filter { row in
            if let areaID, row.primaryAreaID != areaID { return false }
            switch filter {
            case .needsYou: return row.needsYou
            case .unhomed: return row.primaryAreaID == nil
            case .all: return true
            }
        }
    }

    /// Groups in the order the list shows them, with empty groups dropped.
    static func group(_ rows: [WorkListItem]) -> [(state: WorkState, items: [WorkListItem])] {
        var byState: [WorkState: [WorkListItem]] = [:]
        for row in rows { byState[row.state, default: []].append(row) }
        return WorkState.order.compactMap { state in
            guard let items = byState[state], !items.isEmpty else { return nil }
            return (state, items)
        }
    }
}
