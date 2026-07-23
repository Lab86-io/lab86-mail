import Foundation

struct ProductSnapshot: Codable, Sendable {
    var accounts: [AccountSummary]
    var threads: [MailThreadSummary]
    var events: [CalendarEventSummary]
    var tasks: [TaskSummary]
    var areas: [AreaSummary]
    var approvals: [ApprovalSummary]
    var suggestions: [SuggestionSummary]
    var checkin: CheckinSummary? = nil
    var dailyBrief: String?
    // Optional so pre-typed snapshots (which only carried `dailyBrief`) still
    // decode — the cached artifact edition survives relaunch/offline.
    var dailyReport: DailyReportModel? = nil
    // Optional preserves decoding of snapshots created before Area detail was
    // durable. The dictionary remains scoped by the snapshot owner filename.
    var areaDetails: [String: AreaDetail]? = nil
    // Optional preserves snapshots created before Work plan briefs were cached.
    var workDetails: [String: WorkDetail]? = nil
    var savedAt: Date
}

actor ProductCache {
    static let shared = ProductCache()

    private let directory: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(directory: URL? = nil) {
        if let directory {
            self.directory = directory
        } else {
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            self.directory = support.appending(path: "Albatross", directoryHint: .isDirectory)
        }
        encoder.dateEncodingStrategy = .millisecondsSince1970
        decoder.dateDecodingStrategy = .millisecondsSince1970
    }

    func load(owner: String) throws -> ProductSnapshot? {
        let url = fileURL(owner: owner)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try decoder.decode(ProductSnapshot.self, from: Data(contentsOf: url))
    }

    func save(_ snapshot: ProductSnapshot, owner: String) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var directoryValues = URLResourceValues()
        directoryValues.isExcludedFromBackup = true
        var mutableDirectory = directory
        try? mutableDirectory.setResourceValues(directoryValues)
        let url = fileURL(owner: owner)
        try encoder.encode(snapshot).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableURL = url
        try? mutableURL.setResourceValues(values)
    }

    func remove(owner: String) throws {
        let url = fileURL(owner: owner)
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }

    private func fileURL(owner: String) -> URL {
        let safeOwner = owner.map { character in
            character.isLetter || character.isNumber || character == "_" || character == "-" ? character : "_"
        }
        return directory.appending(path: "snapshot-\(String(safeOwner).prefix(160)).json")
    }
}
