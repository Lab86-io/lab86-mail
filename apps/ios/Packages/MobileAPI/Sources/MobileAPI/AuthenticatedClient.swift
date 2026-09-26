import Foundation
import HTTPTypes
import OpenAPIRuntime
import OpenAPIURLSession

public typealias MobileAPITokenProvider = @Sendable () async throws -> String

public enum MobileAPIAuthenticationError: Error, Sendable {
    case missingToken
}

public struct MobileAPIAuthenticationMiddleware: ClientMiddleware {
    private let tokenProvider: MobileAPITokenProvider
    private let timeZoneIdentifier: @Sendable () -> String
    private let requestID: @Sendable () -> String

    public init(
        tokenProvider: @escaping MobileAPITokenProvider,
        timeZoneIdentifier: @escaping @Sendable () -> String = { TimeZone.current.identifier },
        requestID: @escaping @Sendable () -> String = { UUID().uuidString }
    ) {
        self.tokenProvider = tokenProvider
        self.timeZoneIdentifier = timeZoneIdentifier
        self.requestID = requestID
    }

    public func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var request = request
        let token = try await tokenProvider()
        guard !token.isEmpty else { throw MobileAPIAuthenticationError.missingToken }
        request.headerFields[.authorization] = "Bearer \(token)"
        request.headerFields[Self.timeZoneHeader] = timeZoneIdentifier()
        request.headerFields[Self.requestIDHeader] = requestID()
        return try await next(request, body, baseURL)
    }

    private static let timeZoneHeader = HTTPField.Name("x-user-timezone")!
    private static let requestIDHeader = HTTPField.Name("x-request-id")!
}

/// Reads RFC 3339 dates with or without fractional seconds. The server writes
/// `Date.toISOString()`, which always carries milliseconds (`.000Z`), and the
/// runtime's default transcoder refuses them. Dates this client sends keep
/// the plain form the server has always accepted.
public struct LenientISO8601DateTranscoder: DateTranscoder, @unchecked Sendable {
    private let lock = NSLock()
    private let fractional: ISO8601DateFormatter
    private let plain: ISO8601DateFormatter

    public init() {
        fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
    }

    public func encode(_ date: Date) throws -> String {
        lock.lock()
        defer { lock.unlock() }
        return plain.string(from: date)
    }

    public func decode(_ dateString: String) throws -> Date {
        lock.lock()
        defer { lock.unlock() }
        if let date = fractional.date(from: dateString) ?? plain.date(from: dateString) { return date }
        throw DecodingError.dataCorrupted(
            .init(codingPath: [], debugDescription: "Expected an ISO 8601 date, found \(dateString).")
        )
    }
}

public enum MobileAPIClientFactory {
    public static func make(
        serverURL: URL,
        session: URLSession = .shared,
        tokenProvider: @escaping MobileAPITokenProvider
    ) -> Client {
        Client(
            serverURL: serverURL,
            configuration: Configuration(dateTranscoder: LenientISO8601DateTranscoder()),
            transport: URLSessionTransport(configuration: .init(session: session)),
            middlewares: [MobileAPIAuthenticationMiddleware(tokenProvider: tokenProvider)]
        )
    }
}
