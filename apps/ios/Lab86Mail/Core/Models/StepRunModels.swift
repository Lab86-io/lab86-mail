import Foundation

// The step runner on the wire: `StepRunView` from docs/albatross-step-runner.md.
// Decoded at the repository boundary from JSON; views never inspect JSONValue.
// Every field tolerates an older server: a missing key reads as nil or empty,
// and an enum word this build does not know reads as `.unknown`, so a newer
// server never breaks decoding or the offline cache.

struct StepRunView: Identifiable, Hashable, Codable, Sendable {
    enum State: String, Hashable, Codable, Sendable {
        case queued, running
        case handedOff = "handed_off"
        case done, failed, cancelled, closed
        case unknown

        init(from decoder: any Decoder) throws {
            self = Self.from(try decoder.singleValueContainer().decode(String.self))
        }

        static func from(_ raw: String?) -> State {
            raw.flatMap { State(rawValue: $0) } ?? .unknown
        }

        /// The run still works. Show progress and "Stop".
        var isOpen: Bool { self == .queued || self == .running }
    }

    enum Trigger: String, Hashable, Codable, Sendable {
        case user, brief, conductor, resume
        case unknown

        init(from decoder: any Decoder) throws {
            self = Self.from(try decoder.singleValueContainer().decode(String.self))
        }

        static func from(_ raw: String?) -> Trigger {
            raw.flatMap { Trigger(rawValue: $0) } ?? .unknown
        }
    }

    enum Outcome: String, Hashable, Codable, Sendable {
        case done
        case readyForYou = "ready_for_you"
        case yourTurn = "your_turn"
        case needsAnswer = "needs_answer"
        case stopped
        case unknown

        init(from decoder: any Decoder) throws {
            self = Self.from(try decoder.singleValueContainer().decode(String.self))
        }

        static func from(_ raw: String?) -> Outcome {
            raw.flatMap { Outcome(rawValue: $0) } ?? .unknown
        }
    }

    enum StoppedBy: String, Hashable, Codable, Sendable {
        case time, cost
        case unknown

        init(from decoder: any Decoder) throws {
            self = Self.from(try decoder.singleValueContainer().decode(String.self))
        }

        static func from(_ raw: String?) -> StoppedBy {
            raw.flatMap { StoppedBy(rawValue: $0) } ?? .unknown
        }
    }

    /// One live line the runner wrote, oldest first on the wire.
    struct LogLine: Hashable, Codable, Sendable {
        let at: Date?
        let text: String

        init(at: Date?, text: String) {
            self.at = at
            self.text = text
        }

        init?(json: JSONValue) {
            guard let text = json["text"]?.stringValue?.nilIfBlank else { return nil }
            self.text = text
            at = CalendarDateParser.date(json["at"])
        }
    }

    /// What the next action points at.
    struct Target: Hashable, Codable, Sendable {
        enum Kind: String, Hashable, Codable, Sendable {
            case draft, document, approval, session, question, url, card, event
            case unknown

            init(from decoder: any Decoder) throws {
                self = Self.from(try decoder.singleValueContainer().decode(String.self))
            }

            static func from(_ raw: String?) -> Kind {
                raw.flatMap { Kind(rawValue: $0) } ?? .unknown
            }
        }

        let kind: Kind
        let id: String?
        let url: String?
        let accountID: String?

        init(kind: Kind, id: String? = nil, url: String? = nil, accountID: String? = nil) {
            self.kind = kind
            self.id = id
            self.url = url
            self.accountID = accountID
        }

        init?(json: JSONValue) {
            guard json.objectValue != nil else { return nil }
            kind = Kind.from(json["kind"]?.stringValue)
            id = json["id"]?.stringValue?.nilIfBlank
            url = json["url"]?.stringValue?.nilIfBlank
            accountID = json["accountId"]?.stringValue?.nilIfBlank
        }
    }

    /// The one next action for the user.
    struct Next: Hashable, Codable, Sendable {
        enum Kind: String, Hashable, Codable, Sendable {
            case reviewDraft = "review_draft"
            case reviewDocument = "review_document"
            case approve
            case signIn = "sign_in"
            case finishOnPage = "finish_on_page"
            case answer
            case doOffline = "do_offline"
            case review
            case continueRun = "continue"
            case unknown

            init(from decoder: any Decoder) throws {
                self = Self.from(try decoder.singleValueContainer().decode(String.self))
            }

            static func from(_ raw: String?) -> Kind {
                raw.flatMap { Kind(rawValue: $0) } ?? .unknown
            }

            /// The button text when the server sends none.
            var defaultLabel: String {
                switch self {
                case .reviewDraft: "Read and send"
                case .reviewDocument: "Open the document"
                case .approve: "Approve"
                case .signIn: "Sign in"
                case .finishOnPage: "Check and submit"
                case .answer: "Answer"
                case .doOffline: "Mark this step done"
                case .review, .unknown: "Open"
                case .continueRun: "Continue"
                }
            }
        }

        static let labelLimit = 48

        let kind: Kind
        let label: String
        let detail: String?
        let target: Target?
        /// The button that ends the user's part of a page handoff ("I paid",
        /// "I signed in"). Nil when the server sends none: "Continue".
        let doneLabel: String?

        init(kind: Kind, label: String? = nil, detail: String? = nil, target: Target? = nil, doneLabel: String? = nil) {
            self.kind = kind
            self.label = String((label?.nilIfBlank ?? kind.defaultLabel).prefix(Self.labelLimit))
            self.detail = detail
            self.target = target
            self.doneLabel = doneLabel?.nilIfBlank.map { String($0.prefix(Self.labelLimit)) }
        }

        init?(json: JSONValue) {
            guard json.objectValue != nil else { return nil }
            let kind = Kind.from(json["kind"]?.stringValue)
            self.kind = kind
            label = String((json["label"]?.stringValue?.nilIfBlank ?? kind.defaultLabel).prefix(Self.labelLimit))
            detail = json["detail"]?.stringValue?.nilIfBlank
            target = json["target"].flatMap { Target(json: $0) }
            doneLabel = json["doneLabel"]?.stringValue?.nilIfBlank.map { String($0.prefix(Self.labelLimit)) }
        }
    }

    /// One thing the run made.
    struct Artifact: Identifiable, Hashable, Codable, Sendable {
        enum Kind: String, Hashable, Codable, Sendable {
            case document, draft, event, card, approval, page
            case unknown

            init(from decoder: any Decoder) throws {
                self = Self.from(try decoder.singleValueContainer().decode(String.self))
            }

            static func from(_ raw: String?) -> Kind {
                raw.flatMap { Kind(rawValue: $0) } ?? .unknown
            }

            var label: String {
                switch self {
                case .document: "Document"
                case .draft: "Draft"
                case .event: "Event"
                case .card: "Card"
                case .approval: "Approval"
                case .page: "Page"
                case .unknown: "File"
                }
            }
        }

        let kind: Kind
        let referenceID: String?
        let title: String
        let url: String?
        let accountID: String?

        var id: String { "\(kind.rawValue):\(referenceID ?? url ?? title)" }

        init(kind: Kind, referenceID: String? = nil, title: String, url: String? = nil, accountID: String? = nil) {
            self.kind = kind
            self.referenceID = referenceID
            self.title = title
            self.url = url
            self.accountID = accountID
        }

        init?(json: JSONValue) {
            guard let title = json["title"]?.stringValue?.nilIfBlank else { return nil }
            kind = Kind.from(json["kind"]?.stringValue)
            referenceID = json["id"]?.stringValue?.nilIfBlank
            self.title = title
            url = json["url"]?.stringValue?.nilIfBlank
            accountID = json["accountId"]?.stringValue?.nilIfBlank
        }
    }

    let id: String
    let workID: String
    let stepKey: String
    let stepIdentity: String
    let stepTitle: String
    let state: State
    let trigger: Trigger
    let outcome: Outcome?
    let summary: String?
    let log: [LogLine]
    let next: Next?
    let artifacts: [Artifact]
    let browserSessionID: String?
    let stoppedBy: StoppedBy?
    let error: String?
    let createdAt: Date?
    let updatedAt: Date?
    let finishedAt: Date?
    /// The run this one continues ("Continue" after a handoff). Optional so
    /// cached runs from older servers keep decoding.
    let parentRunID: String?

    init(
        id: String,
        workID: String,
        stepKey: String,
        stepIdentity: String? = nil,
        stepTitle: String,
        state: State,
        trigger: Trigger = .user,
        outcome: Outcome? = nil,
        summary: String? = nil,
        log: [LogLine] = [],
        next: Next? = nil,
        artifacts: [Artifact] = [],
        browserSessionID: String? = nil,
        stoppedBy: StoppedBy? = nil,
        error: String? = nil,
        createdAt: Date? = nil,
        updatedAt: Date? = nil,
        finishedAt: Date? = nil,
        parentRunID: String? = nil
    ) {
        self.id = id
        self.workID = workID
        self.stepKey = stepKey
        self.stepIdentity = stepIdentity ?? stepKey
        self.stepTitle = stepTitle
        self.state = state
        self.trigger = trigger
        self.outcome = outcome
        self.summary = summary
        self.log = log
        self.next = next
        self.artifacts = artifacts
        self.browserSessionID = browserSessionID
        self.stoppedBy = stoppedBy
        self.error = error
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.finishedAt = finishedAt
        self.parentRunID = parentRunID
    }

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue?.nilIfBlank ?? json["_id"]?.stringValue?.nilIfBlank else {
            return nil
        }
        self.id = id
        workID = json["workId"]?.stringValue ?? ""
        let stepKey = json["stepKey"]?.stringValue ?? ""
        self.stepKey = stepKey
        stepIdentity = json["stepIdentity"]?.stringValue?.nilIfBlank ?? stepKey
        stepTitle = json["stepTitle"]?.stringValue?.nilIfBlank ?? "This step"
        state = State.from(json["state"]?.stringValue)
        trigger = Trigger.from(json["trigger"]?.stringValue)
        outcome = json["outcome"]?.stringValue.map { Outcome.from($0) }
        summary = json["summary"]?.stringValue?.nilIfBlank
        log = (json["log"]?.arrayValue ?? []).compactMap { LogLine(json: $0) }
        next = json["next"].flatMap { Next(json: $0) }
        artifacts = (json["artifacts"]?.arrayValue ?? []).compactMap { Artifact(json: $0) }
        browserSessionID = json["browserSessionId"]?.stringValue?.nilIfBlank
        stoppedBy = json["stoppedBy"]?.stringValue.map { StoppedBy.from($0) }
        error = json["error"]?.stringValue?.nilIfBlank
        createdAt = CalendarDateParser.date(json["createdAt"])
        updatedAt = CalendarDateParser.date(json["updatedAt"])
        finishedAt = CalendarDateParser.date(json["finishedAt"])
        parentRunID = json["parentRunId"]?.stringValue?.nilIfBlank
    }

    /// The run ended with a handoff and still waits for the user.
    var isHandoff: Bool { state == .handedOff }

    /// The newest line the runner wrote.
    var latestLogLine: LogLine? { log.last }

    /// The same run in another state. The optimistic write after "Stop" or
    /// "Dismiss", before the next `work_home` read settles it.
    func with(state: State) -> StepRunView {
        StepRunView(
            id: id,
            workID: workID,
            stepKey: stepKey,
            stepIdentity: stepIdentity,
            stepTitle: stepTitle,
            state: state,
            trigger: trigger,
            outcome: outcome,
            summary: summary,
            log: log,
            next: next,
            artifacts: artifacts,
            browserSessionID: browserSessionID,
            stoppedBy: stoppedBy,
            error: error,
            createdAt: createdAt,
            updatedAt: updatedAt,
            finishedAt: finishedAt,
            parentRunID: parentRunID
        )
    }

    /// The run the server just queued, before it sends the first line.
    static func queued(id: String, workID: String, stepKey: String, stepTitle: String, now: Date = .now) -> StepRunView {
        StepRunView(
            id: id,
            workID: workID,
            stepKey: stepKey,
            stepTitle: stepTitle,
            state: .queued,
            trigger: .user,
            createdAt: now,
            updatedAt: now
        )
    }
}

/// One row of the Brief's "Ready for you" list (`GET /api/albatross/handoffs`).
struct StepHandoffItem: Identifiable, Hashable, Sendable {
    static let path = "/api/albatross/handoffs"

    let workID: String
    let workTitle: String
    let run: StepRunView

    var id: String { run.id }

    init(workID: String, workTitle: String, run: StepRunView) {
        self.workID = workID
        self.workTitle = workTitle
        self.run = run
    }

    init?(json: JSONValue) {
        guard let run = json["run"].flatMap({ StepRunView(json: $0) }) else { return nil }
        self.run = run
        workID = json["workId"]?.stringValue?.nilIfBlank ?? run.workID
        workTitle = json["workTitle"]?.stringValue?.nilIfBlank ?? run.stepTitle
    }

    /// The route answers `{ ok, items }`; a bare array is read the same way.
    static func list(from json: JSONValue) -> [StepHandoffItem] {
        let rows = json["items"]?.arrayValue ?? json.arrayValue ?? []
        return rows.compactMap { StepHandoffItem(json: $0) }
    }
}

/// Whether a saved sign-in context exists (`GET /api/albatross/browser-context`).
struct BrowserContextStatus: Equatable, Sendable {
    static let path = "/api/albatross/browser-context"

    let saved: Bool
    let createdAt: Date?
    let lastUsedAt: Date?

    init(saved: Bool, createdAt: Date? = nil, lastUsedAt: Date? = nil) {
        self.saved = saved
        self.createdAt = createdAt
        self.lastUsedAt = lastUsedAt
    }

    init(json: JSONValue) {
        saved = json["saved"]?.boolValue ?? false
        createdAt = CalendarDateParser.date(json["createdAt"])
        lastUsedAt = CalendarDateParser.date(json["lastUsedAt"])
    }

    /// "Saved · last used 3 Oct", "Saved", or "None saved".
    func line(locale: Locale = .current) -> String {
        guard saved else { return "None saved" }
        if let lastUsedAt {
            let day = lastUsedAt.formatted(.dateTime.day().month(.abbreviated).locale(locale))
            return "Saved · last used \(day)"
        }
        return "Saved"
    }
}

/// The live session row of one Work, as the Convex query
/// `albatrossBrowserSessions:activeSessionForWork` sends it.
struct WorkBrowserSessionPayload: Decodable, Sendable {
    let sessionId: String
    let status: String
    let statusDetail: String?
    let stepKey: String?
    let liveViewUrl: String
    let replayUrl: String?
    let updatedAt: Double?

    /// Albatross drives the page while the runner holds the session.
    var agentHasPage: Bool {
        status == "agent" || status == "starting" || status == "verifying"
    }
}
