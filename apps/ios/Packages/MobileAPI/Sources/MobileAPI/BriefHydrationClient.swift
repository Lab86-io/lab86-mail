import Foundation

public enum BriefHydrationError: LocalizedError, Sendable {
    case invalidURL
    case unauthorized
    case invalidResponse
    case server(status: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .invalidURL: "The Albatross server is not configured."
        case .unauthorized: "Sign in again to refresh this brief."
        case .invalidResponse: "The brief service returned an unreadable response."
        case .server(_, let message): message
        }
    }
}

public struct BriefQueryResult: Codable, Hashable, Sendable {
    public let items: [BriefHydratedEntity]
    public let count: Int
}

public struct BriefHydrationClient: Sendable {
    private let baseURL: URL
    private let session: URLSession
    private let tokenProvider: MobileAPITokenProvider

    public init(
        baseURL: URL,
        session: URLSession = .shared,
        tokenProvider: @escaping MobileAPITokenProvider
    ) {
        self.baseURL = baseURL
        self.session = session
        self.tokenProvider = tokenProvider
    }

    public func resolve(_ refs: [BriefSourceRef]) async throws -> [BriefHydratedEntity] {
        struct Request: Encodable { let refs: [BriefSourceRef] }
        struct Response: Decodable { let ok: Bool; let entities: [BriefHydratedEntity] }
        let response: Response = try await post(path: "/api/mobile/briefs/resolve", body: Request(refs: refs))
        return response.entities
    }

    /// Asks the server which work, task, and card refs are no longer active.
    /// Returns the `key` of each inactive ref so the caller can hide its
    /// rows. Refs of other kinds never reach the server.
    public func inactiveRefs(_ refs: [BriefSourceRef]) async throws -> Set<String> {
        struct Request: Encodable {
            struct Ref: Encodable { let kind: String; let id: String }
            let refs: [Ref]
        }
        struct Response: Decodable { let inactive: [String] }
        let actionable = refs.filter { BriefInactiveRefs.kinds.contains($0.kind) }
        guard !actionable.isEmpty else { return [] }
        var inactive: [String] = []
        for start in stride(from: 0, to: actionable.count, by: BriefInactiveRefs.batchSize) {
            let batch = Array(actionable[start..<min(start + BriefInactiveRefs.batchSize, actionable.count)])
            let response: Response = try await post(
                path: "/api/brief/state",
                body: Request(refs: batch.map { Request.Ref(kind: $0.kind, id: $0.id) })
            )
            inactive.append(contentsOf: response.inactive)
        }
        return BriefInactiveRefs.hiddenKeys(refs: actionable, inactiveIDs: inactive)
    }

    /// Records one user action on a brief item. Callers fire and forget; a
    /// failure here never blocks the action.
    public func recordEvent(_ event: BriefEventRecord) async throws {
        struct Response: Decodable { let ok: Bool? }
        let _: Response = try await post(path: "/api/brief/events", body: event)
    }

    public func query(_ query: BriefQuery, limit: Int = 12) async throws -> BriefQueryResult {
        struct Request: Encodable { let query: BriefQuery; let limit: Int }
        struct Response: Decodable {
            let ok: Bool
            let items: [BriefHydratedEntity]
            let count: Int
        }
        let response: Response = try await post(
            path: "/api/mobile/briefs/query",
            body: Request(query: query, limit: min(48, max(1, limit)))
        )
        return BriefQueryResult(items: response.items, count: response.count)
    }

    private func post<Body: Encodable, Response: Decodable>(
        path: String,
        body: Body
    ) async throws -> Response {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw BriefHydrationError.invalidURL
        }
        let token = try await tokenProvider()
        guard !token.isEmpty else { throw BriefHydrationError.unauthorized }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        request.setValue(TimeZone.current.identifier, forHTTPHeaderField: "x-user-timezone")
        request.setValue(UUID().uuidString, forHTTPHeaderField: "x-request-id")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, urlResponse) = try await session.data(for: request)
        guard let http = urlResponse as? HTTPURLResponse else {
            throw BriefHydrationError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw BriefHydrationError.unauthorized }
            let error = (try? JSONDecoder().decode(ServerError.self, from: data))?.error
            throw BriefHydrationError.server(
                status: http.statusCode,
                message: error ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            )
        }
        guard let decoded = try? JSONDecoder().decode(Response.self, from: data) else {
            throw BriefHydrationError.invalidResponse
        }
        return decoded
    }
}

/// The pure part of the inactive-ref call: which kinds the server accepts
/// and how an inactive id maps back to a row key. The server answers with
/// ids only, the same way the web reads `inactive.includes(ref.id)`.
public enum BriefInactiveRefs {
    public static let kinds: Set<String> = ["work", "task", "card"]
    public static let batchSize = 100

    public static func hiddenKeys(refs: [BriefSourceRef], inactiveIDs: [String]) -> Set<String> {
        let inactive = Set(inactiveIDs)
        return Set(refs.filter { kinds.contains($0.kind) && inactive.contains($0.id) }.map(\.key))
    }
}

/// One telemetry row for `POST /api/brief/events`.
public struct BriefEventRecord: Codable, Hashable, Sendable {
    public struct Ref: Codable, Hashable, Sendable {
        public let kind: String
        public let id: String
        public let account: String?

        public init(kind: String, id: String, account: String? = nil) {
            self.kind = kind
            self.id = id
            self.account = account
        }
    }

    public let reportId: String?
    public let surface: String
    public let regionId: String
    public let action: String
    public let ref: Ref
    public let outcome: String

    public init(
        reportId: String?,
        surface: String,
        regionId: String,
        action: String,
        ref: Ref,
        outcome: String
    ) {
        self.reportId = reportId
        self.surface = surface
        self.regionId = regionId
        self.action = action
        self.ref = ref
        self.outcome = outcome
    }
}

private struct ServerError: Decodable {
    let error: String?
}
