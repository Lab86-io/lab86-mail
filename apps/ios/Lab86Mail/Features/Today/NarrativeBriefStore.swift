import Foundation
import Observation

struct NarrativeEvidence: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let text: String
    let sourceIDs: [String]
    let modelWritten: Bool

    init?(json: JSONValue?) {
        guard let json, let id = json["_id"]?.stringValue, !id.isEmpty,
              let title = json["title"]?.stringValue,
              let text = json["text"]?.stringValue, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let sources = json["sourceIds"]?.arrayValue,
              sources.allSatisfy({ $0.stringValue != nil }) else { return nil }
        self.id = id
        self.title = title
        self.text = text
        sourceIDs = sources.compactMap(\.stringValue)
        modelWritten = !(json["model"]?.stringValue ?? "").isEmpty
    }
}

/// Read-through memory, deliberately absent from ProductSnapshot and disk caches.
/// A correction, withdrawn source, failed authorization, or changed edition must
/// never leave the previously read private account on screen.
@MainActor
@Observable
final class NarrativeBriefStore {
    enum Query: Equatable, Sendable {
        case brief(Date)
        case sources(String)

        var path: String {
            var components = URLComponents()
            components.path = "/api/narrative"
            switch self {
            case .brief(let at):
                components.queryItems = [
                    URLQueryItem(name: "op", value: "brief"),
                    URLQueryItem(name: "at", value: String(at.timeIntervalSince1970 * 1000)),
                ]
            case .sources(let id):
                components.queryItems = [URLQueryItem(name: "id", value: id)]
            }
            return components.string ?? "/api/narrative"
        }
    }

    private(set) var entry: NarrativeEvidence?
    private(set) var sources: [NarrativeEvidence] = []
    private(set) var enabled = false
    private(set) var running = false
    private(set) var isLoading = false
    private(set) var error: String?
    private var revision = 0
    private var query: Query?

    func clear() {
        revision += 1
        entry = nil
        sources = []
        enabled = false
        running = false
        isLoading = false
        error = nil
        query = nil
    }

    func load(_ requested: Query, fetch: @Sendable (String) async throws -> JSONValue) async {
        if query != requested { clear() }
        query = requested
        revision += 1
        let requestRevision = revision
        isLoading = true
        defer { if revision == requestRevision { isLoading = false } }
        do {
            let response = try await fetch(requested.path)
            guard revision == requestRevision, !Task.isCancelled else { return }
            let parsed = NarrativeEvidence(json: response["entry"])
            if let raw = response["entry"], raw != .null, parsed == nil { throw BackendError.invalidResponse }
            switch requested {
            case .brief:
                guard let allowed = response["enabled"]?.boolValue else { throw BackendError.invalidResponse }
                enabled = allowed
                running = allowed && response["running"]?.boolValue == true
                entry = allowed ? parsed : nil
                sources = []
            case .sources(let id):
                guard parsed == nil || parsed?.id == id else { throw BackendError.invalidResponse }
                let rows = response["sources"]?.arrayValue ?? []
                let decoded = rows.compactMap { NarrativeEvidence(json: $0) }
                guard rows.count == decoded.count else { throw BackendError.invalidResponse }
                enabled = parsed != nil
                entry = parsed
                sources = parsed == nil ? [] : decoded
                running = false
            }
            error = nil
        } catch {
            guard revision == requestRevision, !Task.isCancelled else { return }
            entry = nil
            sources = []
            running = false
            self.error = "Narrative context is unavailable. Reconnect and try again."
        }
    }

    func requestRefresh(post: @Sendable () async throws -> JSONValue) async {
        guard enabled else { return }
        let requestRevision = revision
        do {
            let response = try await post()
            guard revision == requestRevision, !Task.isCancelled else { return }
            guard response["ok"]?.boolValue == true else { throw BackendError.invalidResponse }
            running = true
            error = nil
        } catch {
            guard revision == requestRevision, !Task.isCancelled else { return }
            self.error = "The narrative refresh could not be started. Try again."
        }
    }
}
