import Foundation

// The thread list on the wire (docs/albatross-threads.md, "Server contract"):
// one row for each Work that is not archived, with its live status, and the
// notes a run read. Decoded at the repository boundary with the same
// tolerance as StepRunModels.swift: a missing key reads as nil or a safe
// default, and an unknown status reads as `.idle`, so a newer server never
// breaks decoding.

/// The live state of one Work, as `GET /api/albatross/threads` sends it.
enum ThreadRowStatus: String, Hashable, Codable, Sendable, CaseIterable {
    case inProgress = "in_progress"
    case startsSoon = "starts_soon"
    case answering
    case needsAnswer = "needs_answer"
    case yourTurn = "your_turn"
    case readyForYou = "ready_for_you"
    case didNotFinish = "did_not_finish"
    case stopped
    case done
    case waiting
    case paused
    case idle

    static func from(_ raw: String?) -> ThreadRowStatus {
        raw.flatMap { ThreadRowStatus(rawValue: $0) } ?? .idle
    }

    /// The status word of this build (lead decision 1). The server's
    /// `statusLabel` wins when it is present. Nil for a row with nothing
    /// in motion.
    var word: String? {
        switch self {
        case .inProgress: "In progress"
        case .startsSoon: "Starts soon"
        case .answering: "Reply in progress"
        case .needsAnswer: "Needs your answer"
        case .yourTurn: "Your turn"
        case .readyForYou: "Ready for you"
        case .didNotFinish: "Did not finish"
        case .stopped: "Stopped"
        case .done: "Done"
        case .waiting, .paused, .idle: nil
        }
    }

    /// The row sits in "Needs you". "Did not finish" counts (lead decision 1).
    var needsYou: Bool {
        switch self {
        case .needsAnswer, .yourTurn, .readyForYou, .didNotFinish: true
        default: false
        }
    }

    /// The row sits in "In progress".
    var inMotion: Bool {
        switch self {
        case .inProgress, .startsSoon, .answering: true
        default: false
        }
    }
}

/// One row of the thread list.
struct ThreadRow: Identifiable, Hashable, Codable, Sendable {
    let workID: String
    let title: String
    let areaName: String?
    let status: ThreadRowStatus
    /// The server's status word. Nil for a row with nothing in motion.
    let statusLabel: String?
    /// The line after the status word: the newest log line, the question,
    /// the handoff, or the next step.
    let preview: String?
    let stepTitle: String?
    let needsYou: Bool
    /// A run or a reply works now. The list polls every 5 s while any row works.
    let working: Bool
    let latestRunID: String?
    let workingRunID: String?
    let runStartedAt: Date?
    let lastActivityAt: Date?
    let seenAt: Date?
    let unread: Bool
    let closed: Bool

    var id: String { workID }

    init(
        workID: String,
        title: String,
        areaName: String? = nil,
        status: ThreadRowStatus = .idle,
        statusLabel: String? = nil,
        preview: String? = nil,
        stepTitle: String? = nil,
        needsYou: Bool? = nil,
        working: Bool? = nil,
        latestRunID: String? = nil,
        workingRunID: String? = nil,
        runStartedAt: Date? = nil,
        lastActivityAt: Date? = nil,
        seenAt: Date? = nil,
        unread: Bool = false,
        closed: Bool = false
    ) {
        self.workID = workID
        self.title = title
        self.areaName = areaName
        self.status = status
        self.statusLabel = statusLabel
        self.preview = preview
        self.stepTitle = stepTitle
        self.needsYou = needsYou ?? status.needsYou
        self.working = working ?? (status == .inProgress || status == .answering)
        self.latestRunID = latestRunID
        self.workingRunID = workingRunID
        self.runStartedAt = runStartedAt
        self.lastActivityAt = lastActivityAt
        self.seenAt = seenAt
        self.unread = unread
        self.closed = closed
    }

    init?(json: JSONValue) {
        guard let workID = json["workId"]?.stringValue?.nilIfBlank else { return nil }
        let status = ThreadRowStatus.from(json["status"]?.stringValue)
        self.init(
            workID: workID,
            title: json["title"]?.stringValue?.nilIfBlank ?? "Something you asked for",
            areaName: json["areaName"]?.stringValue?.nilIfBlank,
            status: status,
            statusLabel: json["statusLabel"]?.stringValue?.nilIfBlank,
            preview: json["preview"]?.stringValue?.nilIfBlank,
            stepTitle: json["stepTitle"]?.stringValue?.nilIfBlank,
            needsYou: json["needsYou"]?.boolValue,
            working: json["working"]?.boolValue,
            latestRunID: json["latestRunId"]?.stringValue?.nilIfBlank,
            workingRunID: json["workingRunId"]?.stringValue?.nilIfBlank,
            runStartedAt: CalendarDateParser.date(json["runStartedAt"]),
            lastActivityAt: CalendarDateParser.date(json["lastActivityAt"]),
            seenAt: CalendarDateParser.date(json["seenAt"]),
            unread: json["unread"]?.boolValue ?? false,
            closed: json["closed"]?.boolValue ?? false
        )
    }

    /// The route answers `{ ok, threads, now }`, already sorted; a bare
    /// array reads the same way.
    static func list(from json: JSONValue) -> [ThreadRow] {
        let rows = json["threads"]?.arrayValue ?? json.arrayValue ?? []
        return rows.compactMap(ThreadRow.init(json:))
    }

    /// The server's clock, for elapsed times that do not drift with the device.
    static func serverNow(from json: JSONValue) -> Date? {
        CalendarDateParser.date(json["now"])
    }

    /// The status word the row shows: the server's, else this build's.
    var word: String? { statusLabel ?? status.word }

    /// The same row with the unread mark set or cleared (an optimistic write).
    func with(unread: Bool) -> ThreadRow {
        ThreadRow(
            workID: workID,
            title: title,
            areaName: areaName,
            status: status,
            statusLabel: statusLabel,
            preview: preview,
            stepTitle: stepTitle,
            needsYou: needsYou,
            working: working,
            latestRunID: latestRunID,
            workingRunID: workingRunID,
            runStartedAt: runStartedAt,
            lastActivityAt: lastActivityAt,
            seenAt: seenAt,
            unread: unread,
            closed: closed
        )
    }

    /// The same row in another state, after "Stop" or "Continue" from the
    /// list. The next read settles it.
    func with(status: ThreadRowStatus, statusLabel: String?, preview: String?) -> ThreadRow {
        ThreadRow(
            workID: workID,
            title: title,
            areaName: areaName,
            status: status,
            statusLabel: statusLabel,
            preview: preview,
            stepTitle: stepTitle,
            needsYou: status.needsYou,
            working: status == .inProgress || status == .answering || status == .startsSoon,
            latestRunID: latestRunID,
            workingRunID: status.inMotion ? workingRunID : nil,
            runStartedAt: runStartedAt,
            lastActivityAt: lastActivityAt,
            seenAt: seenAt,
            unread: unread,
            closed: closed
        )
    }
}

/// A note the user sent to a run, and when the run read it. The id is the
/// thread message id (`noteId` on the wire), so a receipt finds its note
/// across the runs of a step: an unread note carries to the next run.
struct ThreadNote: Identifiable, Hashable, Sendable {
    let id: String
    let at: Date?
    let text: String
    let readAt: Date?

    init(id: String, at: Date? = nil, text: String, readAt: Date? = nil) {
        self.id = id
        self.at = at
        self.text = text
        self.readAt = readAt
    }

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue?.nilIfBlank,
              let text = json["text"]?.stringValue else { return nil }
        self.id = id
        self.text = text
        at = CalendarDateParser.date(json["at"])
        readAt = CalendarDateParser.date(json["readAt"])
    }

    var isRead: Bool { readAt != nil }
}

/// The id of a steer note: the id of the thread message that carries it.
/// The same shape as every message id this client writes.
enum ThreadNoteID {
    static func make() -> String {
        "msg-" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }
}
