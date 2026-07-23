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

private struct ServerError: Decodable {
    let error: String?
}
