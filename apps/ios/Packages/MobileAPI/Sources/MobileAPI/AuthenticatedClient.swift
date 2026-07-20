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

public enum MobileAPIClientFactory {
    public static func make(
        serverURL: URL,
        session: URLSession = .shared,
        tokenProvider: @escaping MobileAPITokenProvider
    ) -> Client {
        Client(
            serverURL: serverURL,
            transport: URLSessionTransport(configuration: .init(session: session)),
            middlewares: [MobileAPIAuthenticationMiddleware(tokenProvider: tokenProvider)]
        )
    }
}
