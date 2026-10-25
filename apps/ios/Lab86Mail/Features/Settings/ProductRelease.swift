import Foundation
import Observation

// The product updates the web ships (app/updates, lib/updates/*). The native
// app reads the same data from `GET /api/app-release`, which returns the
// release the server runs: its id, its version, and its notes. The app keeps
// the id it last saw, so a new release shows a one-time notice, as the web's
// ProductUpdateNotice does.

/// One change in a batch of notes.
struct ProductUpdateChange: Identifiable, Hashable, Sendable {
    enum Kind: String, Sendable {
        case new
        case improved
        case fixed

        /// The quiet word after the title. Sentence case, never a badge.
        var label: String {
            switch self {
            case .new: "New"
            case .improved: "Improved"
            case .fixed: "Fixed"
            }
        }
    }

    let id: String
    let kind: Kind
    let title: String
    let description: String

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue?.nilIfBlank,
              let kind = Kind(rawValue: json["kind"]?.stringValue ?? ""),
              let title = json["title"]?.stringValue?.nilIfBlank
        else { return nil }
        self.id = id
        self.kind = kind
        self.title = title
        description = json["description"]?.stringValue ?? ""
    }

    init(id: String, kind: Kind, title: String, description: String) {
        self.id = id
        self.kind = kind
        self.title = title
        self.description = description
    }
}

/// A picture of the change, when the notes have one. HTML demos stay on the
/// web; the native page links to them.
struct ProductUpdateScreenshot: Hashable, Sendable {
    let caption: String
    /// A path on the web app, "/updates/….png".
    let imagePath: String
    let alt: String
    let width: Int
    let height: Int

    init?(json: JSONValue) {
        guard let path = json["image"]?.stringValue?.nilIfBlank,
              let width = json["width"]?.doubleValue, width > 0,
              let height = json["height"]?.doubleValue, height > 0
        else { return nil }
        caption = json["caption"]?.stringValue ?? ""
        imagePath = path
        alt = json["alt"]?.stringValue ?? ""
        self.width = Int(width)
        self.height = Int(height)
    }

    var aspectRatio: Double { Double(width) / Double(height) }
}

/// One batch of notes: a title, a date, its changes, and an optional picture.
struct ProductUpdate: Identifiable, Hashable, Sendable {
    let id: String
    /// A calendar date, "2026-10-15".
    let publishedAt: String
    let version: String?
    let title: String
    let summary: String?
    let changes: [ProductUpdateChange]
    let screenshot: ProductUpdateScreenshot?
    /// True when the notes carry an HTML demo the native page cannot draw.
    let hasWebDemo: Bool

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue?.nilIfBlank,
              let publishedAt = json["publishedAt"]?.stringValue?.nilIfBlank,
              let title = json["title"]?.stringValue?.nilIfBlank
        else { return nil }
        self.id = id
        self.publishedAt = publishedAt
        self.title = title
        version = json["version"]?.stringValue?.nilIfBlank
        summary = json["summary"]?["text"]?.stringValue?.nilIfBlank
        changes = (json["changes"]?.arrayValue ?? []).compactMap { ProductUpdateChange(json: $0) }
        let preview = json["preview"]
        screenshot = preview.flatMap { ProductUpdateScreenshot(json: $0) }
        let previewHTML = preview?["html"]?.stringValue
        let summaryDemo = json["summary"]?["demo"]
        hasWebDemo = previewHTML != nil || summaryDemo != nil
    }

    init(
        id: String,
        publishedAt: String,
        version: String? = nil,
        title: String,
        summary: String? = nil,
        changes: [ProductUpdateChange],
        screenshot: ProductUpdateScreenshot? = nil,
        hasWebDemo: Bool = false
    ) {
        self.id = id
        self.publishedAt = publishedAt
        self.version = version
        self.title = title
        self.summary = summary
        self.changes = changes
        self.screenshot = screenshot
        self.hasWebDemo = hasWebDemo
    }
}

/// The release the server runs, from `GET /api/app-release`.
struct ProductRelease: Hashable, Sendable {
    let id: String
    let version: String
    /// Newest first, as the web sorts them.
    let updates: [ProductUpdate]

    init?(json: JSONValue) {
        guard json["schemaVersion"]?.doubleValue == 1,
              let id = json["id"]?.stringValue?.nilIfBlank,
              let version = json["version"]?.stringValue?.nilIfBlank
        else { return nil }
        self.id = id
        self.version = version
        updates = (json["updates"]?.arrayValue ?? [])
            .compactMap { ProductUpdate(json: $0) }
            .sorted { $0.publishedAt > $1.publishedAt }
    }

    init(id: String, version: String, updates: [ProductUpdate]) {
        self.id = id
        self.version = version
        self.updates = updates
    }
}

/// The rules of the notice, pure.
enum ProductReleaseNotice {
    static let path = "/api/app-release"

    /// What the app remembers after a read. The first release the app ever
    /// sees is recorded in silence: nothing is new to a first run. A later,
    /// different id is unseen until the user looks.
    static func next(seen: String?, fetched: String) -> (seen: String, unseen: Bool) {
        guard let seen else { return (fetched, false) }
        return (seen, seen != fetched)
    }

    /// The update ids the user has not seen in a release.
    static func newUpdateIDs(in release: ProductRelease, known: Set<String>) -> Set<String> {
        Set(release.updates.map(\.id)).subtracting(known)
    }

    /// "October 15, 2026" for "2026-10-15". Release dates are calendar dates,
    /// independent of the reader's time zone, so the parse is in UTC.
    static func dateLabel(_ date: String, locale: Locale = Locale(identifier: "en_US")) -> String {
        let parts = date.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return date }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        let components = DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12)
        guard let value = calendar.date(from: components) else { return date }
        return value.formatted(
            Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
                .month(.wide).day().year()
        )
    }
}

/// Reads the release and remembers which one the user saw.
@MainActor
@Observable
final class ProductReleaseStore {
    static let shared = ProductReleaseStore()

    private static let seenKey = "albatrossProductRelease.seenID"
    private static let knownUpdatesKey = "albatrossProductRelease.knownUpdateIDs"

    private(set) var release: ProductRelease?
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private(set) var seenReleaseID: String?
    private(set) var knownUpdateIDs: Set<String>

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        seenReleaseID = defaults.string(forKey: Self.seenKey)
        knownUpdateIDs = Set(defaults.stringArray(forKey: Self.knownUpdatesKey) ?? [])
    }

    /// True when a release arrived that the user has not looked at.
    var hasUnseenRelease: Bool {
        guard let release, let seenReleaseID else { return false }
        return release.id != seenReleaseID
    }

    /// The updates in the current release the user has not seen.
    var newUpdateIDs: Set<String> {
        guard let release else { return [] }
        return ProductReleaseNotice.newUpdateIDs(in: release, known: knownUpdateIDs)
    }

    func load(backend: BackendClient) async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let json = try await backend.get(path: ProductReleaseNotice.path)
            guard let parsed = ProductRelease(json: json) else {
                errorMessage = "The update notes did not read."
                return
            }
            errorMessage = nil
            record(parsed)
        } catch {
            guard !error.isCancellation else { return }
            errorMessage = error.localizedDescription
        }
    }

    /// Stores one release, as a read would. Tests and the tour use it.
    func record(_ parsed: ProductRelease) {
        release = parsed
        let next = ProductReleaseNotice.next(seen: seenReleaseID, fetched: parsed.id)
        if seenReleaseID == nil {
            // A first run has nothing new: remember the release and its notes.
            knownUpdateIDs = Set(parsed.updates.map(\.id))
            defaults.set(Array(knownUpdateIDs).sorted(), forKey: Self.knownUpdatesKey)
        }
        seenReleaseID = next.seen
        defaults.set(next.seen, forKey: Self.seenKey)
    }

    /// The user looked: the current release and its notes are seen.
    func markSeen() {
        guard let release else { return }
        seenReleaseID = release.id
        knownUpdateIDs = Set(release.updates.map(\.id))
        defaults.set(release.id, forKey: Self.seenKey)
        defaults.set(Array(knownUpdateIDs).sorted(), forKey: Self.knownUpdatesKey)
    }
}
