import Foundation

// The Today widget's data (round 2, FEATURES item 19). The app reads
// `GET /api/mobile/v1/today/summary`, writes this snapshot to the shared App
// Group container, and asks WidgetKit to reload. The widget only reads the
// file; it never signs in or calls the server. This file is compiled into
// the app and the widget extension both, so it depends on Foundation only.

struct TodayWidgetSnapshot: Codable, Equatable, Sendable {
    struct Move: Codable, Equatable, Sendable {
        enum Kind: String, Codable, Sendable {
            case thread
            case task
        }

        let title: String
        let detail: String?
        let kind: Kind
        let refID: String
        let accountID: String?
    }

    struct Meeting: Codable, Equatable, Sendable {
        let eventID: String
        let accountID: String?
        let title: String
        let startAt: Date
        let endAt: Date
        let location: String?
    }

    static let appGroup = "group.io.lab86.mail"
    static let fileName = "today-summary.json"
    static let widgetKind = "AlbatrossToday"

    let reportID: String?
    let isWeeklyReview: Bool
    let generatedAt: Date?
    let leadLine: String
    let nextMove: Move?
    let nextMeeting: Meeting?
    let sourcesNeedingAttention: Int
    let fetchedAt: Date

    init(
        reportID: String? = nil,
        isWeeklyReview: Bool = false,
        generatedAt: Date? = nil,
        leadLine: String,
        nextMove: Move? = nil,
        nextMeeting: Meeting? = nil,
        sourcesNeedingAttention: Int = 0,
        fetchedAt: Date = .now
    ) {
        self.reportID = reportID
        self.isWeeklyReview = isWeeklyReview
        self.generatedAt = generatedAt
        self.leadLine = leadLine
        self.nextMove = nextMove
        self.nextMeeting = nextMeeting
        self.sourcesNeedingAttention = sourcesNeedingAttention
        self.fetchedAt = fetchedAt
    }

    /// What the widget shows before the app has written anything.
    static let placeholder = TodayWidgetSnapshot(
        leadLine: "Open Albatross to bring in today’s brief.",
        fetchedAt: .distantPast
    )

    /// The meeting to show at `now`: one that has not ended.
    func upcomingMeeting(at now: Date) -> Meeting? {
        guard let nextMeeting, nextMeeting.endAt > now else { return nil }
        return nextMeeting
    }

    /// "Sources need you" when a mailbox or tool must reconnect.
    var attentionLine: String? {
        switch sourcesNeedingAttention {
        case 0: nil
        case 1: "1 source needs to reconnect"
        default: "\(sourcesNeedingAttention) sources need to reconnect"
        }
    }

    /// Where a tap opens the app: the move, the meeting, or Today.
    static func link(for move: Move) -> URL? {
        var components = URLComponents()
        components.scheme = "lab86"
        switch move.kind {
        case .thread:
            guard let accountID = move.accountID else { return todayLink }
            components.host = "thread"
            components.queryItems = [
                URLQueryItem(name: "account", value: accountID),
                URLQueryItem(name: "thread", value: move.refID),
            ]
        case .task:
            components.host = "tasks"
        }
        return components.url
    }

    static func link(for meeting: Meeting) -> URL? {
        guard let accountID = meeting.accountID else { return URL(string: "lab86://calendar") }
        var components = URLComponents()
        components.scheme = "lab86"
        components.host = "event"
        components.queryItems = [
            URLQueryItem(name: "account", value: accountID),
            URLQueryItem(name: "event", value: meeting.eventID),
        ]
        return components.url
    }

    static let todayLink = URL(string: "lab86://today")

    // MARK: - The shared file

    static func containerURL(fileManager: FileManager = .default) -> URL? {
        fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appending(path: fileName)
    }

    static func read(from url: URL?) -> TodayWidgetSnapshot? {
        guard let url, let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder.decode(TodayWidgetSnapshot.self, from: data)
    }

    func write(to url: URL) throws {
        let data = try Self.encoder.encode(self)
        try data.write(to: url, options: [.atomic])
    }

    static func remove(at url: URL?) {
        guard let url else { return }
        try? FileManager.default.removeItem(at: url)
    }

    private static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        return encoder
    }

    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return decoder
    }
}
