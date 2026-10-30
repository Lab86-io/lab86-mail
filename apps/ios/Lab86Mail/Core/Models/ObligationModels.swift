import Foundation

// Needs you (docs/needs-you.md, phase 5): the native copy of the shared
// contract in `lib/obligations/contract.ts`. The server gives epoch
// milliseconds; the pure layer keeps them as milliseconds so the grouping
// and the labels give the same answers as the web. Every enum decodes
// tolerantly: a value this build does not know never drops the whole list.

/// Epoch milliseconds, as the server writes them.
typealias ObligationMillis = Double

/// What the user owes, or waits for. `unknown` keeps a row the server added
/// after this build shipped; it reads as a plain item with Done.
enum ObligationKind: String, Hashable, Sendable, CaseIterable {
    case reply
    case action
    case waiting
    case change
    case code
    case rsvp
    case prepare
    case unknown

    static func from(_ raw: String?) -> ObligationKind {
        guard let raw, let known = ObligationKind(rawValue: raw) else { return .unknown }
        return known
    }
}

enum ObligationState: String, Hashable, Sendable {
    case open
    case snoozed
    case done
    case resolved
    case dismissed
    case expired

    /// An unknown state reads as open: the server still lists it.
    static func from(_ raw: String?) -> ObligationState {
        guard let raw, let known = ObligationState(rawValue: raw) else { return .open }
        return known
    }

    /// The states that count as closed (`CLOSED_STATES`).
    var isClosed: Bool {
        switch self {
        case .done, .resolved, .dismissed, .expired: true
        case .open, .snoozed: false
        }
    }
}

/// Where the item came from. A source this build does not know keeps its
/// raw word, so the row can still name it.
enum ObligationSource: Hashable, Sendable {
    case mail
    case slack
    case atlassian
    case granola
    case drive
    case github
    case bitbucket
    case calendar
    case other(String)

    static func from(_ raw: String?) -> ObligationSource {
        let value = raw ?? ""
        switch value {
        case "mail": return .mail
        case "slack": return .slack
        case "atlassian": return .atlassian
        case "granola": return .granola
        case "drive": return .drive
        case "github": return .github
        case "bitbucket": return .bitbucket
        case "calendar": return .calendar
        default: return .other(value)
        }
    }

    var rawValue: String {
        switch self {
        case .mail: "mail"
        case .slack: "slack"
        case .atlassian: "atlassian"
        case .granola: "granola"
        case .drive: "drive"
        case .github: "github"
        case .bitbucket: "bitbucket"
        case .calendar: "calendar"
        case .other(let value): value
        }
    }

    /// The source name the page shows next to the asker
    /// (`OBLIGATION_SOURCE_LABELS`). An unknown source shows its word with a
    /// capital, or "Source" when the word is empty.
    var label: String {
        switch self {
        case .mail: "Mail"
        case .slack: "Slack"
        case .atlassian: "Jira"
        case .granola: "Granola"
        case .drive: "Drive"
        case .github: "GitHub"
        case .bitbucket: "Bitbucket"
        case .calendar: "Calendar"
        case .other(let value):
            let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return clean.isEmpty ? "Source" : clean.prefix(1).uppercased() + clean.dropFirst()
        }
    }
}

/// Jev's answer to the `due` question.
enum ObligationDue: String, Hashable, Sendable {
    case today
    case soon
    case later
    case none

    static func from(_ raw: String?) -> ObligationDue {
        guard let raw, let known = ObligationDue(rawValue: raw) else { return .none }
        return known
    }
}

enum ObligationPushLevel: String, Hashable, Sendable {
    case none
    case normal
    case timeSensitive = "time_sensitive"

    static func from(_ raw: String?) -> ObligationPushLevel {
        guard let raw, let known = ObligationPushLevel(rawValue: raw) else { return .normal }
        return known
    }
}

/// Why an obligation closed. `unknown` keeps a reason this build does not
/// know; the row then says "Closed".
enum ObligationCloseReason: String, Hashable, Sendable {
    case sentReply = "sent_reply"
    case userDone = "user_done"
    case userDoneNoReply = "user_done_no_reply"
    case evidence
    case notMine = "not_mine"
    case codeUsed = "code_used"
    case expired
    case eventPassed = "event_passed"
    case agedOut = "aged_out"
    case unknown

    static func from(_ raw: String?) -> ObligationCloseReason? {
        guard let raw, !raw.isEmpty else { return nil }
        return ObligationCloseReason(rawValue: raw) ?? .unknown
    }
}

/// The value of a `code` obligation.
struct ObligationCode: Hashable, Sendable {
    let value: String
    var issuer: String?
    var expiresAt: ObligationMillis?

    init(value: String, issuer: String? = nil, expiresAt: ObligationMillis? = nil) {
        self.value = value
        self.issuer = issuer
        self.expiresAt = expiresAt
    }

    init?(json: JSONValue?) {
        guard let value = json?["value"]?.stringValue?.nilIfBlank else { return nil }
        self.init(
            value: value,
            issuer: json?["issuer"]?.stringValue?.nilIfBlank,
            expiresAt: json?["expiresAt"]?.doubleValue
        )
    }
}

/// One open, snoozed, or recently closed obligation, as the page reads it
/// (`ObligationView`).
struct ObligationView: Identifiable, Hashable, Sendable {
    let id: String
    var kind: ObligationKind
    var state: ObligationState
    var source: ObligationSource
    var sourceKey: String
    var sourceLabel: String?
    var url: URL?
    var accountID: String?
    var threadID: String?
    var messageID: String?
    var title: String
    var asker: String
    var askerAddress: String?
    var why: String?
    var excerpt: String?
    var due: ObligationDue
    var dueAt: ObligationMillis?
    var workID: String?
    var workTitle: String?
    var eventID: String?
    var eventStart: ObligationMillis?
    var pushLevel: ObligationPushLevel
    var probability: Double
    var code: ObligationCode?
    var snoozedUntil: ObligationMillis?
    var draftReady: Bool
    var createdAt: ObligationMillis
    var updatedAt: ObligationMillis
    var closedAt: ObligationMillis?
    var closeReason: ObligationCloseReason?

    init(
        id: String,
        kind: ObligationKind = .reply,
        state: ObligationState = .open,
        source: ObligationSource = .mail,
        sourceKey: String = "",
        sourceLabel: String? = nil,
        url: URL? = nil,
        accountID: String? = nil,
        threadID: String? = nil,
        messageID: String? = nil,
        title: String,
        asker: String,
        askerAddress: String? = nil,
        why: String? = nil,
        excerpt: String? = nil,
        due: ObligationDue = .none,
        dueAt: ObligationMillis? = nil,
        workID: String? = nil,
        workTitle: String? = nil,
        eventID: String? = nil,
        eventStart: ObligationMillis? = nil,
        pushLevel: ObligationPushLevel = .normal,
        probability: Double = 0.9,
        code: ObligationCode? = nil,
        snoozedUntil: ObligationMillis? = nil,
        draftReady: Bool = false,
        createdAt: ObligationMillis,
        updatedAt: ObligationMillis? = nil,
        closedAt: ObligationMillis? = nil,
        closeReason: ObligationCloseReason? = nil
    ) {
        self.id = id
        self.kind = kind
        self.state = state
        self.source = source
        self.sourceKey = sourceKey
        self.sourceLabel = sourceLabel
        self.url = url
        self.accountID = accountID
        self.threadID = threadID
        self.messageID = messageID
        self.title = title
        self.asker = asker
        self.askerAddress = askerAddress
        self.why = why
        self.excerpt = excerpt
        self.due = due
        self.dueAt = dueAt
        self.workID = workID
        self.workTitle = workTitle
        self.eventID = eventID
        self.eventStart = eventStart
        self.pushLevel = pushLevel
        self.probability = probability
        self.code = code
        self.snoozedUntil = snoozedUntil
        self.draftReady = draftReady
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
        self.closedAt = closedAt
        self.closeReason = closeReason
    }

    /// One row from the server. Nil only without an id, a title, or a
    /// creation time: everything else has a safe default.
    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue?.nilIfBlank,
              let createdAt = json["createdAt"]?.doubleValue else { return nil }
        let title = json["title"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !title.isEmpty else { return nil }
        let urlText = json["url"]?.stringValue?.nilIfBlank
        self.init(
            id: id,
            kind: ObligationKind.from(json["kind"]?.stringValue),
            state: ObligationState.from(json["state"]?.stringValue),
            source: ObligationSource.from(json["source"]?.stringValue),
            sourceKey: json["sourceKey"]?.stringValue ?? "",
            sourceLabel: json["sourceLabel"]?.stringValue?.nilIfBlank,
            url: urlText.flatMap(Self.openableURL),
            accountID: json["accountId"]?.stringValue?.nilIfBlank,
            threadID: json["threadId"]?.stringValue?.nilIfBlank,
            messageID: json["messageId"]?.stringValue?.nilIfBlank,
            title: title,
            asker: json["asker"]?.stringValue?.nilIfBlank ?? "Someone",
            askerAddress: json["askerAddress"]?.stringValue?.nilIfBlank,
            why: json["why"]?.stringValue?.nilIfBlank,
            excerpt: json["excerpt"]?.stringValue?.nilIfBlank,
            due: ObligationDue.from(json["due"]?.stringValue),
            dueAt: json["dueAt"]?.doubleValue,
            workID: json["workId"]?.stringValue?.nilIfBlank,
            workTitle: json["workTitle"]?.stringValue?.nilIfBlank,
            eventID: json["eventId"]?.stringValue?.nilIfBlank,
            eventStart: json["eventStart"]?.doubleValue,
            pushLevel: ObligationPushLevel.from(json["pushLevel"]?.stringValue),
            probability: json["probability"]?.doubleValue ?? 0,
            code: ObligationCode(json: json["code"]),
            snoozedUntil: json["snoozedUntil"]?.doubleValue,
            draftReady: json["draftReady"]?.boolValue ?? false,
            createdAt: createdAt,
            updatedAt: json["updatedAt"]?.doubleValue ?? createdAt,
            closedAt: json["closedAt"]?.doubleValue,
            closeReason: ObligationCloseReason.from(json["closeReason"]?.stringValue)
        )
    }

    /// Only an https link with a host opens in another app. Anything else
    /// is a readable label at most.
    static func openableURL(_ text: String) -> URL? {
        guard let url = URL(string: text), url.scheme?.lowercased() == "https",
              let host = url.host, !host.isEmpty else { return nil }
        return url
    }

    var isClosed: Bool { state.isClosed }

    /// True when the item quotes one mail thread the app can open.
    var hasMailThread: Bool { accountID != nil && threadID != nil }

    /// The key of one mail thread, as `mailSourceKey` writes it.
    static func mailSourceKey(accountID: String, threadID: String) -> String {
        "mail:\(accountID):\(threadID)"
    }
}

/// `GET /api/mobile/v1/needs-you`.
struct NeedsYouSnapshot: Hashable, Sendable {
    /// False when the user is not in the flag. The sidebar then shows no row.
    var enabled: Bool
    /// The user's IANA time zone, for "today" and "this week".
    var timezone: String
    var items: [ObligationView]

    init(enabled: Bool, timezone: String, items: [ObligationView]) {
        self.enabled = enabled
        self.timezone = timezone
        self.items = items
    }

    /// The snapshot from the server. Rows this build cannot read are left
    /// out; the rest still show.
    init?(json: JSONValue) {
        guard let enabled = json["enabled"]?.boolValue else { return nil }
        self.init(
            enabled: enabled,
            timezone: json["timezone"]?.stringValue?.nilIfBlank ?? TimeZone.current.identifier,
            items: (json["items"]?.arrayValue ?? []).compactMap(ObligationView.init(json:))
        )
    }
}

/// The user's actions on one obligation (`ObligationAction`).
enum ObligationAction: Hashable, Sendable {
    case done
    case later(until: ObligationMillis)
    case notMine
    case undo
    case rsvp(RSVPResponse)

    enum RSVPResponse: String, Hashable, Sendable, CaseIterable {
        case yes
        case no
        case maybe

        var label: String {
            switch self {
            case .yes: "Yes"
            case .no: "No"
            case .maybe: "Maybe"
            }
        }
    }

    /// The JSON body the route reads.
    var body: JSONValue {
        switch self {
        case .done: .object(["action": .string("done")])
        case .later(let until): .object(["action": .string("later"), "until": .number(until)])
        case .notMine: .object(["action": .string("not_mine")])
        case .undo: .object(["action": .string("undo")])
        case .rsvp(let response): .object(["action": .string("rsvp"), "response": .string(response.rawValue)])
        }
    }

    /// The word the Undo notice uses for the action.
    var noticeWord: String {
        switch self {
        case .done: "Done"
        case .later: "Later"
        case .notMine: "Not mine"
        case .undo: "Undone"
        case .rsvp(let response): "Answered \(response.label.lowercased())"
        }
    }
}

/// `{ obligation, undoUntil? }`: the row after an action, a reply, or an undo.
struct ObligationActionResult: Hashable, Sendable {
    let obligation: ObligationView
    /// The end of the Undo window, when the action can be undone.
    let undoUntil: ObligationMillis?

    init?(json: JSONValue?) {
        guard let row = json?["obligation"], let obligation = ObligationView(json: row) else { return nil }
        self.obligation = obligation
        undoUntil = json?["undoUntil"]?.doubleValue
    }
}

/// `POST .../draft`: a prepared reply for a mail `reply` obligation.
struct ObligationDraft: Hashable, Sendable {
    let to: [String]
    let cc: [String]
    let subject: String
    let body: String

    init(to: [String], cc: [String] = [], subject: String, body: String) {
        self.to = to
        self.cc = cc
        self.subject = subject
        self.body = body
    }

    init?(json: JSONValue?) {
        guard let draft = json?["draft"], let body = draft["body"]?.stringValue else { return nil }
        self.init(
            to: (draft["to"]?.arrayValue ?? []).compactMap(\.stringValue),
            cc: (draft["cc"]?.arrayValue ?? []).compactMap(\.stringValue),
            subject: draft["subject"]?.stringValue ?? "",
            body: body
        )
    }
}

/// `POST .../albatross` ("Start in Albatross").
struct ObligationAlbatrossResult: Hashable, Sendable {
    let workID: String
    /// True when a new Albatross was made.
    let created: Bool
    let obligation: ObligationView

    init?(json: JSONValue?) {
        guard let workID = json?["workId"]?.stringValue?.nilIfBlank,
              let row = json?["obligation"], let obligation = ObligationView(json: row) else { return nil }
        self.workID = workID
        created = json?["created"]?.boolValue ?? false
        self.obligation = obligation
    }
}

/// The constants of the contract the app needs.
enum NeedsYouContract {
    /// Done, Later, and Not mine show Undo for this long (`UNDO_WINDOW_MS`).
    static let undoWindowMillis: ObligationMillis = 10_000
    /// The page groups, in display order (`NEEDS_YOU_GROUP_ORDER`).
    static let groupOrder: [NeedsYouGroupID] = [
        .now, .today, .thisWeek, .afterThisWeek, .noDate, .waiting, .closedToday,
    ]
}

/// The page groups (`NeedsYouGroupId`).
enum NeedsYouGroupID: String, Hashable, Sendable, CaseIterable {
    case now
    case today
    case thisWeek = "this_week"
    case afterThisWeek = "after_this_week"
    case noDate = "no_date"
    case waiting
    case closedToday = "closed_today"

    /// `NEEDS_YOU_GROUP_LABELS`.
    var label: String {
        switch self {
        case .now: "Now"
        case .today: "Today"
        case .thisWeek: "This week"
        case .afterThisWeek: "After this week"
        case .noDate: "No due date"
        case .waiting: "Waiting on others"
        case .closedToday: "Closed today"
        }
    }
}
