import Foundation

/// One Albatross in the list: an unresolved outcome the user is carrying.
struct WorkListItem: Identifiable, Hashable, Codable, Sendable {
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
    let planError: String?
    let nextStep: String?
    let scheduledStartAt: Date?
    let scheduledEndAt: Date?

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
        planError = json["planError"]?.stringValue?.nilIfBlank
        nextStep = json["nextStep"]?.stringValue?.nilIfBlank
        scheduledStartAt = CalendarDateParser.date(json["scheduledStartAt"])
        scheduledEndAt = CalendarDateParser.date(json["scheduledEndAt"])
    }
}

/// The server's single answer to “what now?” and the separate recovery lane.
struct WorkExecutionMove: Identifiable, Hashable, Codable, Sendable {
    let workID: String
    let workTitle: String
    let stepKey: String?
    let stepTitle: String
    let detail: String?
    let url: String?
    let phase: String
    let scheduledStartAt: Date?
    let scheduledEndAt: Date?
    let remainingSteps: Int
    let totalSteps: Int
    let areaName: String?

    var id: String {
        let scheduled = scheduledStartAt.map { String(Int($0.timeIntervalSince1970 * 1_000)) } ?? "unscheduled"
        return "\(workID):\(stepKey ?? stepTitle):\(scheduled)"
    }

    init(
        workID: String,
        workTitle: String,
        stepKey: String?,
        stepTitle: String,
        detail: String?,
        url: String?,
        phase: String,
        scheduledStartAt: Date?,
        scheduledEndAt: Date?,
        remainingSteps: Int,
        totalSteps: Int,
        areaName: String?
    ) {
        self.workID = workID
        self.workTitle = workTitle
        self.stepKey = stepKey
        self.stepTitle = stepTitle
        self.detail = detail
        self.url = url
        self.phase = phase
        self.scheduledStartAt = scheduledStartAt
        self.scheduledEndAt = scheduledEndAt
        self.remainingSteps = remainingSteps
        self.totalSteps = totalSteps
        self.areaName = areaName
    }

    init?(json: JSONValue) {
        guard let workID = json["workId"]?.stringValue else { return nil }
        self.workID = workID
        workTitle = json["workTitle"]?.stringValue?.nilIfBlank ?? "Albatross"
        stepKey = json["stepKey"]?.stringValue?.nilIfBlank
        stepTitle = json["stepTitle"]?.stringValue?.nilIfBlank ?? "Open the current step"
        detail = json["detail"]?.stringValue?.nilIfBlank
        url = json["url"]?.stringValue?.nilIfBlank
        phase = json["phase"]?.stringValue ?? "unscheduled"
        scheduledStartAt = CalendarDateParser.date(json["scheduledStartAt"])
        scheduledEndAt = CalendarDateParser.date(json["scheduledEndAt"])
        remainingSteps = max(0, Int(json["remainingSteps"]?.doubleValue ?? 0))
        totalSteps = max(0, Int(json["totalSteps"]?.doubleValue ?? 0))
        areaName = json["areaName"]?.stringValue?.nilIfBlank
    }
}

struct WorkExecutionSnapshot: Hashable, Codable, Sendable {
    let currentMove: WorkExecutionMove?
    let missedMoves: [WorkExecutionMove]
    let needsYou: [WorkListItem]

    init(json: JSONValue?) {
        currentMove = json?["currentMove"].flatMap(WorkExecutionMove.init)
        missedMoves = (json?["missedMoves"]?.arrayValue ?? []).compactMap(WorkExecutionMove.init)
        needsYou = (json?["needsYou"]?.arrayValue ?? []).compactMap(WorkListItem.init)
    }
}

struct WorkProofCandidate: Identifiable, Hashable, Codable, Sendable {
    let workID: String
    let workTitle: String
    let proofID: String?
    let proofWhat: String?
    let matchedMessageID: String?
    let matchedContent: String?

    var id: String { "\(workID):\(proofID ?? "outcome")" }

    init?(json: JSONValue, matchedMessageID: String? = nil, matchedContent: String? = nil) {
        guard let workID = json["workId"]?.stringValue,
              let workTitle = json["workTitle"]?.stringValue?.nilIfBlank else { return nil }
        self.workID = workID
        self.workTitle = workTitle
        proofID = json["proofId"]?.stringValue?.nilIfBlank
        proofWhat = json["proofWhat"]?.stringValue?.nilIfBlank
        self.matchedMessageID = matchedMessageID
        self.matchedContent = matchedContent
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
        // A failed plan is a decision waiting on the user, the same as an error
        // state. The web counts it; leaving it out here let a broken Albatross
        // sit quietly under "In progress" on the phone.
        if agentState == "error" || planError != nil { return true }
        return status == "needs_answers"
    }

    var isClosed: Bool {
        let state = workState ?? status
        return state == "done" || state == "released" || state == "archived"
    }

    /// Closed on paper, but Albatross is still waiting on an answer.
    var isUnresolved: Bool { isClosed && openQuestions > 0 }

    var hasUpcomingBooking: Bool {
        hasUpcomingBooking(at: .now)
    }

    func hasUpcomingBooking(at date: Date) -> Bool {
        guard let scheduledEndAt else { return false }
        return scheduledEndAt > date
    }

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
        default:
            if let nextStep { return "Next: \(nextStep)" }
            return "Albatross is carrying this"
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
