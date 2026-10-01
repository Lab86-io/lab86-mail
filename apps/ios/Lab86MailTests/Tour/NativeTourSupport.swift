import Foundation
import MobileAPI
@testable import Lab86Mail

// Shared parts of the native screenshot tour (NativeTourTests on iOS and
// iPadOS, NativeTourMacTests on the Mac): the fixture data, a stub backend
// that answers every request from it, and the files each image leaves
// behind. The tour reads no network: a request that no fixture covers gets
// an empty answer and is listed in the image's sidecar file.

enum TourError: Error, CustomStringConvertible {
    case missingFixtures
    case unreadableImage(String)

    var description: String {
        switch self {
        case .missingFixtures: "NativeTourFixtures.json is not in the test bundle or next to the tour sources."
        case .unreadableImage(let name): "Could not encode \(name) as PNG."
        }
    }
}

/// Resolves the time tokens in the fixtures, so every run shows a believable
/// day: events today, mail from minutes ago, a brief from this morning.
///
/// Whole-string tokens: `@ms:<spec>` (epoch milliseconds), `@iso:<spec>` (ISO
/// 8601 text), and `@art` (a local image for the brief masthead). Inline
/// tokens: `{{weekday:<spec>}}`, `{{time:<spec>}}`, `{{date:<spec>}}`. A spec
/// is `now`, `now-12m`, `now+2h`, `now-3d`, `day`, `day+1`, `day-2@09:30`, or
/// `utcday+2` (UTC midnight of a local date, as an all-day event is stored).
struct TourTime {
    let now: Date
    let calendar: Calendar
    let locale: Locale

    func date(_ spec: String) -> Date? {
        var body = Substring(spec)
        var clock: (hour: Int, minute: Int)?
        if let at = spec.firstIndex(of: "@") {
            body = spec[..<at]
            let parts = spec[spec.index(after: at)...].split(separator: ":")
            guard parts.count == 2, let hour = Int(parts[0]), let minute = Int(parts[1]) else { return nil }
            clock = (hour, minute)
        }
        let base: String
        if body.hasPrefix("utcday") {
            base = "utcday"
        } else if body.hasPrefix("day") {
            base = "day"
        } else if body.hasPrefix("now") {
            base = "now"
        } else {
            return nil
        }
        var offset = body.dropFirst(base.count)
        var amount = 0
        var unit: Character = base == "now" ? "m" : "d"
        if let sign = offset.first {
            guard sign == "+" || sign == "-" else { return nil }
            offset = offset.dropFirst()
            if let last = offset.last, last.isLetter {
                unit = last
                offset = offset.dropLast()
            }
            guard let value = Int(offset) else { return nil }
            amount = sign == "-" ? -value : value
        }
        switch base {
        case "now":
            let seconds: Double
            switch unit {
            case "h": seconds = 3_600
            case "d": seconds = 86_400
            default: seconds = 60
            }
            return now.addingTimeInterval(Double(amount) * seconds)
        case "day":
            let start = calendar.startOfDay(for: now)
            guard let day = calendar.date(byAdding: .day, value: amount, to: start) else { return nil }
            guard let clock else { return day }
            return calendar.date(bySettingHour: clock.hour, minute: clock.minute, second: 0, of: day)
        default:
            let parts = calendar.dateComponents([.year, .month, .day], from: now)
            var utc = Calendar(identifier: .gregorian)
            utc.timeZone = TimeZone(identifier: "UTC") ?? .gmt
            let components = DateComponents(year: parts.year, month: parts.month, day: parts.day)
            guard let midnight = utc.date(from: components) else { return nil }
            return utc.date(byAdding: .day, value: amount, to: midnight)
        }
    }

    func resolve(_ value: JSONValue, art: URL?) -> JSONValue {
        switch value {
        case .object(let object):
            return .object(object.mapValues { resolve($0, art: art) })
        case .array(let values):
            return .array(values.map { resolve($0, art: art) })
        case .string(let string):
            return resolveString(string, art: art)
        default:
            return value
        }
    }

    private func resolveString(_ string: String, art: URL?) -> JSONValue {
        if string == "@art" {
            guard let art else { return .null }
            return .string(art.absoluteString)
        }
        if string.hasPrefix("@ms:"), let date = date(String(string.dropFirst(4))) {
            return .number((date.timeIntervalSince1970 * 1_000).rounded())
        }
        if string.hasPrefix("@iso:"), let date = date(String(string.dropFirst(5))) {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return .string(formatter.string(from: date))
        }
        guard string.contains("{{") else { return .string(string) }
        return .string(expandInline(string))
    }

    private func expandInline(_ string: String) -> String {
        var output = ""
        var rest = Substring(string)
        while let open = rest.range(of: "{{") {
            output += rest[..<open.lowerBound]
            let afterOpen = rest[open.upperBound...]
            guard let close = afterOpen.range(of: "}}") else {
                output += rest[open.lowerBound...]
                return output
            }
            let token = String(afterOpen[..<close.lowerBound])
            output += inlineValue(token) ?? "{{\(token)}}"
            rest = afterOpen[close.upperBound...]
        }
        output += rest
        return output
    }

    private func inlineValue(_ token: String) -> String? {
        guard let colon = token.firstIndex(of: ":") else { return nil }
        let kind = String(token[..<colon])
        guard let date = date(String(token[token.index(after: colon)...])) else { return nil }
        switch kind {
        case "weekday":
            let formatter = DateFormatter()
            formatter.locale = locale
            formatter.timeZone = calendar.timeZone
            formatter.dateFormat = "EEEE"
            return formatter.string(from: date)
        case "time":
            let formatter = DateFormatter()
            formatter.locale = locale
            formatter.timeZone = calendar.timeZone
            formatter.dateStyle = .none
            formatter.timeStyle = .short
            return formatter.string(from: date)
        case "date":
            let formatter = DateFormatter()
            formatter.locale = locale
            formatter.timeZone = calendar.timeZone
            formatter.setLocalizedDateFormatFromTemplate("MMMd")
            return formatter.string(from: date)
        default:
            return nil
        }
    }
}

private final class TourBundleMarker {}

/// The fixture file, read once for each test process and resolved against
/// the current time.
@MainActor
enum TourFixtures {
    private static var cached: JSONValue?

    static func load() throws -> JSONValue {
        if let cached { return cached }
        let data = try Data(contentsOf: try fixtureURL())
        let raw = try JSONDecoder().decode(JSONValue.self, from: data)
        let time = TourTime(now: .now, calendar: .autoupdatingCurrent, locale: .autoupdatingCurrent)
        let resolved = time.resolve(raw, art: artURL())
        cached = resolved
        return resolved
    }

    private static func fixtureURL() throws -> URL {
        if let url = Bundle(for: TourBundleMarker.self).url(forResource: "NativeTourFixtures", withExtension: "json") {
            return url
        }
        let local = sourceDirectory.appending(path: "NativeTourFixtures.json")
        guard FileManager.default.fileExists(atPath: local.path(percentEncoded: false)) else {
            throw TourError.missingFixtures
        }
        return local
    }

    /// The brief masthead art: the web's own fallback painting, read from the
    /// checkout (the tests run on the machine that built them). Without it
    /// the masthead shows its accent field, as the app does when art fails.
    private static func artURL() -> URL? {
        if let path = ProcessInfo.processInfo.environment["TOUR_ART"], FileManager.default.fileExists(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        // apps/ios/Lab86MailTests/Tour → the repository root.
        let root = sourceDirectory
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let art = root.appending(path: "public/art/fallback-1.jpg")
        return FileManager.default.fileExists(atPath: art.path(percentEncoded: false)) ? art : nil
    }

    private static var sourceDirectory: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    }
}

/// Answers one request from the fixtures. A scenario (for example
/// `mail-error`) can replace a tool result, fail a tool, or replace a path.
struct TourRoutes: Sendable {
    let fixtures: JSONValue
    let scenario: JSONValue?

    init(fixtures: JSONValue, scenarioID: String) {
        self.fixtures = fixtures
        scenario = fixtures["scenarios"]?[scenarioID]
    }

    func answer(method: String, path: String, body: JSONValue?) -> (status: Int, body: JSONValue, covered: Bool) {
        let toolPrefix = "/api/tools/"
        if path.hasPrefix(toolPrefix) {
            let name = String(path.dropFirst(toolPrefix.count))
            if let message = scenario?["toolErrors"]?[name]?.stringValue {
                return (500, Self.failure(message), true)
            }
            if let result = toolResult(name, arguments: body) {
                return (200, .object(["ok": .bool(true), "result": result]), true)
            }
            return (200, .object(["ok": .bool(true), "result": .object([:])]), false)
        }
        if let message = scenario?["pathErrors"]?[path]?.stringValue {
            return (500, Self.failure(message), true)
        }
        if let answer = scenario?["paths"]?[path] ?? fixtures["paths"]?[path] {
            return (200, answer, true)
        }
        return (200, .object([:]), false)
    }

    private static func failure(_ message: String) -> JSONValue {
        .object(["ok": .bool(false), "error": .string(message)])
    }

    private func toolResult(_ name: String, arguments: JSONValue?) -> JSONValue? {
        if let override = scenario?["tools"]?[name] { return override }
        switch name {
        case "list_account_threads":
            let account = arguments?["account"]?.stringValue ?? ""
            let rows = scenario?["threadsByAccount"]?[account] ?? fixtures["threadsByAccount"]?[account]
            return .object(["threads": rows ?? .array([])])
        case "get_thread":
            let threadID = arguments?["threadId"]?.stringValue ?? ""
            return fixtures["threadDetails"]?[threadID] ?? summaryThread(threadID)
        case "work_home":
            let workID = arguments?["workId"]?.stringValue ?? ""
            guard let detail = fixtures["workHome"]?[workID] else { return nil }
            return .object(["detail": detail])
        case "area_home":
            let areaID = arguments?["areaId"]?.stringValue ?? ""
            guard let home = fixtures["areaHome"]?[areaID] else { return nil }
            return .object(["home": home])
        default:
            return fixtures["tools"]?[name]
        }
    }

    /// A one-message thread built from the list row, for a thread that has
    /// no detail fixture of its own.
    private func summaryThread(_ threadID: String) -> JSONValue? {
        let accounts = fixtures["threadsByAccount"]?.objectValue ?? [:]
        for rows in accounts.values {
            for row in rows.arrayValue ?? [] where row["threadId"]?.stringValue == threadID {
                var message: [String: JSONValue] = [:]
                message["id"] = .string("m-\(threadID)")
                message["from"] = row["fromAddress"] ?? .string("")
                message["to"] = .string("Casey Morgan <casey@northwind.example>")
                message["date"] = row["lastDate"] ?? .null
                message["snippet"] = row["snippet"] ?? .string("")
                message["textBody"] = row["snippet"] ?? .string("")
                var thread: [String: JSONValue] = [:]
                thread["subject"] = row["subject"] ?? .string("")
                thread["messages"] = .array([.object(message)])
                return .object(thread)
            }
        }
        return nil
    }
}

/// Decodes a mobile v1 body the way the generated client does: dates may
/// carry fractional seconds (`Date.toISOString()`).
enum MobileContractJSON {
    static func decode<Value: Decodable>(_ type: Value.Type, from data: Data) throws -> Value {
        let transcoder = LenientISO8601DateTranscoder()
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            try transcoder.decode(try decoder.singleValueContainer().decode(String.self))
        }
        return try decoder.decode(type, from: data)
    }
}

/// The send-as lists of the tour mailboxes (`sendAs` in the fixtures, and
/// `sendAsAnchored` for a reply or a forward), read through the same
/// generated type and mapping as the app.
struct TourSendAs: SendAsFetching {
    let fixtures: JSONValue

    func fetchSendAs(accountID: String, anchor: SendAsAnchor?) async throws -> SendAsPage {
        let anchored = anchor == nil ? nil : fixtures["sendAsAnchored"]?[accountID]
        guard let value = anchored ?? fixtures["sendAs"]?[accountID] else {
            throw URLError(.resourceUnavailable)
        }
        let page = try MobileContractJSON.decode(
            Components.Schemas.MobileSendAsPage.self,
            from: try JSONEncoder().encode(value)
        )
        return MobileV1Client.sendAsPage(from: page)
    }
}

/// A real `BackendClient` whose requests the stub protocol answers from the
/// tour routes. Every request is logged for the image's sidecar file.
final class TourBackend: @unchecked Sendable {
    struct Entry: Codable, Sendable {
        let method: String
        let path: String
        let status: Int
        let covered: Bool
    }

    let host = "tour-\(UUID().uuidString.lowercased()).test"
    let client: BackendClient
    private let routes: TourRoutes
    private let lock = NSLock()
    private var entries: [Entry] = []

    init(routes: TourRoutes) {
        self.routes = routes
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        client = BackendClient(
            baseURL: URL(string: "https://\(host)"),
            session: URLSession(configuration: configuration),
            tokenProvider: { "tour-token" }
        )
        StubURLProtocol.register(host: host) { [weak self] request in
            guard let self, let url = request.url else { return (404, .null) }
            return self.answer(request, url: url)
        }
    }

    var requestCount: Int { lock.withLock { entries.count } }

    var log: [Entry] { lock.withLock { entries } }

    func tearDown() {
        StubURLProtocol.unregister(host: host)
    }

    private func answer(_ request: URLRequest, url: URL) -> (Int, JSONValue) {
        let body = Self.body(of: request).flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
        let method = request.httpMethod ?? "GET"
        let result = routes.answer(method: method, path: url.path, body: body)
        var shown = url.path
        if let query = url.query { shown += "?\(query)" }
        if let tool = body?["account"]?.stringValue ?? body?["threadId"]?.stringValue ?? body?["workId"]?.stringValue {
            shown += " (\(tool))"
        }
        let entry = Entry(method: method, path: shown, status: result.status, covered: result.covered)
        lock.withLock { entries.append(entry) }
        return (result.status, result.body)
    }

    private static func body(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 16_384
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        while true {
            let read = stream.read(buffer, maxLength: bufferSize)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

/// The sidecar file for one image. The gallery script reads these.
struct TourRecord: Codable, Sendable {
    let file: String
    let platform: String
    let screen: String
    let screenTitle: String
    let section: String
    let screenOrder: Int
    let variant: String
    let variantOrder: Int
    let device: String
    let sizeClass: String
    let orientation: String
    let appearance: String
    let textSize: String
    let width: Double
    let height: Double
    let scale: Double
    let captureMethod: String
    let distinctBytes: Int
    let blankWarning: Bool
    let notes: [String]
    let requests: [TourBackend.Entry]
    let uncovered: [String]
}

/// A signed-in session for each scenario, as in the app. Mail actions go
/// through the command outbox, which needs an owner. Each scenario has its
/// own owner, so no scenario reads another scenario's cache.
@MainActor
enum TourSession {
    static func signIn(_ environment: AppEnvironment) async -> String {
        let ownerID = "tour-owner-\(UUID().uuidString.lowercased())"
        let snapshot = SessionSnapshot(isLoaded: true, userID: ownerID, sessionID: "tour-session", isActive: true)
        await environment.sessionStore.synchronize(snapshot: snapshot) { "tour-token" }
        return ownerID
    }
}

enum TourOutput {
    /// Where the tour writes. CI sets `TEST_RUNNER_TOUR_DIR`, which reaches
    /// the test process as `TOUR_DIR`. Without it the tour skips.
    static var directory: URL? {
        guard let path = ProcessInfo.processInfo.environment["TOUR_DIR"], !path.isEmpty else { return nil }
        return URL(fileURLWithPath: path, isDirectory: true)
    }

    static func write(png: Data, record: TourRecord, to directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try png.write(to: directory.appending(path: record.file))
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let sidecar = String(record.file.dropLast(".png".count)) + ".json"
        try encoder.encode(record).write(to: directory.appending(path: sidecar))
    }
}

enum TourPixels {
    /// How many of the 256 byte values occur in a sample of the raw pixels.
    /// A blank or single-color frame has very few.
    static func distinctBytes(_ data: Data, stride step: Int = 7) -> Int {
        data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) -> Int in
            var seen = [Bool](repeating: false, count: 256)
            var count = 0
            var index = 0
            while index < buffer.count {
                let byte = Int(buffer[index])
                if !seen[byte] {
                    seen[byte] = true
                    count += 1
                }
                index += step
            }
            return count
        }
    }

    static let blankThreshold = 16
}
