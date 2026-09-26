import Foundation

// The plan and trial, standing orders, optional surfaces, and the data export
// (round 2, FEATURES items 1, 2, 14, 15, 17). Web, iOS, and macOS read the
// same routes: `GET /api/billing/plan`, `GET/POST /api/standing-orders`,
// `GET/POST /api/account/surfaces`, and `GET /api/account/export`.

struct BillingPlan: Equatable, Sendable {
    struct Price: Equatable, Sendable {
        let name: String
        let monthlyUsd: Double
        let annualUsd: Double
        let line: String
    }

    static let path = "/api/billing/plan"

    let plan: String
    let planName: String
    let trialActive: Bool
    let trialEndsAt: Date?
    let trialDaysLeft: Int
    let showsTrialNote: Bool
    let note: String?
    let trialDays: Int
    let pro: Price?
    let ownKey: Price?
    let subscriptionsDisabled: Bool

    init?(json: JSONValue?) {
        guard let json, json.objectValue != nil, json["ok"]?.boolValue != false,
              let plan = json["plan"]?.stringValue?.nilIfBlank else { return nil }
        self.plan = plan
        planName = json["planName"]?.stringValue?.nilIfBlank ?? plan.capitalized
        let trial = json["trial"]
        trialActive = trial?["active"]?.boolValue ?? false
        trialEndsAt = CalendarDateParser.date(trial?["endsAt"])
        trialDaysLeft = Int(trial?["daysLeft"]?.doubleValue ?? 0)
        showsTrialNote = trial?["showNote"]?.boolValue ?? false
        note = json["note"]?.stringValue?.nilIfBlank
        trialDays = Int(json["trialDays"]?.doubleValue ?? 14)
        pro = Self.price(json["prices"]?["pro"])
        ownKey = Self.price(json["prices"]?["byok"])
        subscriptionsDisabled = json["subscriptionsDisabled"]?.boolValue ?? false
    }

    private static func price(_ json: JSONValue?) -> Price? {
        guard let json, let name = json["name"]?.stringValue?.nilIfBlank else { return nil }
        return Price(
            name: name,
            monthlyUsd: json["monthlyUsd"]?.doubleValue ?? 0,
            annualUsd: json["annualUsd"]?.doubleValue ?? 0,
            line: json["line"]?.stringValue?.nilIfBlank ?? name
        )
    }

    /// The quiet "N days left" note. It shows only in the last days of the
    /// trial, and never when the server has turned subscriptions off.
    var trialNote: String? {
        guard !subscriptionsDisabled, showsTrialNote else { return nil }
        return note
    }

    /// The Settings line under the plan name.
    var detailLine: String? {
        if trialActive, let trialEndsAt {
            let day = trialEndsAt.formatted(.dateTime.month(.wide).day())
            return "\(trialDays)-day trial, no card needed. It ends on \(day), then the plan returns to Free."
        }
        switch plan {
        case "pro": return pro?.line
        case "byok": return ownKey?.line
        case "free": return "The Daily Brief, mail, calendar, and search."
        default: return nil
        }
    }
}

// MARK: - Standing orders

enum StandingOrderGroup: String, CaseIterable, Sendable {
    case schedule
    case mail
    case assistant

    var title: String {
        switch self {
        case .schedule: "On a schedule"
        case .mail: "In your mail"
        case .assistant: "What the assistant may do in chat"
        }
    }
}

enum StandingOrderMode: String, Sendable {
    case runsAlone = "runs_alone"
    case draft
    case asksFirst = "asks_first"

    var text: String {
        switch self {
        case .runsAlone: "Runs on its own"
        case .draft: "Drafts, then waits for you"
        case .asksFirst: "Asks you first"
        }
    }
}

struct StandingOrder: Identifiable, Equatable, Sendable {
    struct Item: Identifiable, Equatable, Sendable {
        let id: String
        let label: String
        let detail: String?
    }

    static let path = "/api/standing-orders"
    static let itemLimit = 5

    let id: String
    let group: StandingOrderGroup
    let title: String
    let detail: String
    let mode: StandingOrderMode
    var paused: Bool
    let locked: Bool
    let items: [Item]
    let href: String?

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue?.nilIfBlank,
              let title = json["title"]?.stringValue?.nilIfBlank else { return nil }
        self.id = id
        group = json["group"]?.stringValue.flatMap(StandingOrderGroup.init(rawValue:)) ?? .assistant
        self.title = title
        detail = json["detail"]?.stringValue ?? ""
        mode = json["mode"]?.stringValue.flatMap(StandingOrderMode.init(rawValue:)) ?? .runsAlone
        paused = json["paused"]?.boolValue ?? false
        locked = json["locked"]?.boolValue ?? false
        items = (json["items"]?.arrayValue ?? []).compactMap { row in
            guard let id = row["id"]?.stringValue, let label = row["label"]?.stringValue?.nilIfBlank else { return nil }
            return Item(id: id, label: label, detail: row["detail"]?.stringValue?.nilIfBlank)
        }
        href = json["href"]?.stringValue?.nilIfBlank
    }

    /// "Always on", "Paused", or what the order does when it runs.
    var hint: String {
        if locked { return "Always on" }
        if paused { return "Paused" }
        return mode.text
    }

    static func list(from json: JSONValue) -> [StandingOrder] {
        (json["orders"]?.arrayValue ?? []).compactMap(StandingOrder.init(json:))
    }

    /// `POST /api/standing-orders` body.
    static func toggleBody(id: String, paused: Bool) -> JSONValue {
        .object(["id": .string(id), "paused": .bool(paused)])
    }

    /// "2 paused" or "All on".
    static func summary(_ orders: [StandingOrder]) -> String {
        let paused = orders.filter(\.paused).count
        return paused == 0 ? "All on" : "\(paused) paused"
    }
}

// MARK: - Optional surfaces

struct AccountSurfaces: Equatable, Sendable {
    static let path = "/api/account/surfaces"

    let files: Bool

    init(files: Bool) { self.files = files }

    init?(json: JSONValue?) {
        guard let files = json?["surfaces"]?["files"]?.boolValue ?? json?["files"]?.boolValue else { return nil }
        self.files = files
    }

    static func body(files: Bool) -> JSONValue { .object(["files": .bool(files)]) }
}

// MARK: - Data export

enum DataExport {
    static let path = "/api/account/export"
    static let description =
        "A ZIP with one JSON file for each kind of data Albatross keeps: Albatrosses, editions, memory, tasks, settings, and mail records. Sign-in secrets are left out."
    static let beforeDeletion =
        "Keep a copy first. The export has your Albatrosses, editions, memory, tasks, and settings."

    /// "albatross-export-2026-09-26.zip" in the user's calendar.
    static func fileName(now: Date = .now, calendar: Calendar = .autoupdatingCurrent) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: now)
        let date = String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
        return "albatross-export-\(date).zip"
    }

    /// The server answers with a ZIP, or with a JSON error.
    static func isZip(contentType: String?) -> Bool {
        (contentType ?? "").lowercased().contains("zip")
    }

    /// Moves a downloaded export to a named file the share sheet or the save
    /// panel can offer. The staging folder of the download is removed.
    static func stage(_ download: DownloadedFile, now: Date = .now) throws -> URL {
        guard isZip(contentType: download.contentType) else {
            try? FileManager.default.removeItem(at: download.url.deletingLastPathComponent())
            throw BackendError.server(status: 500, message: "The export did not arrive. Try again.")
        }
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "AlbatrossExport", directoryHint: .isDirectory)
            .appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
        )
        let destination = directory.appending(path: fileName(now: now))
        try FileManager.default.moveItem(at: download.url, to: destination)
        try? FileManager.default.removeItem(at: download.url.deletingLastPathComponent())
        return destination
    }
}
