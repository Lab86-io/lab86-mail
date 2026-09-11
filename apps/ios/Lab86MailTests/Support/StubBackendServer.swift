import Foundation

@testable import Lab86Mail

/// A scripted server behind a real `BackendClient`, so a store's own request
/// paths run end to end without a network. Each instance answers only for
/// its own host, so suites can run in parallel. Routes answer by path; the
/// recorded request list keeps the query string and, for writes, the body.
final class StubBackendServer: @unchecked Sendable {
    struct Request: Equatable, Sendable {
        let method: String
        let path: String
        let body: JSONValue?
    }

    private let lock = NSLock()
    private var storedRoutes: [String: JSONValue] = [:]
    private var storedStatuses: [String: Int] = [:]
    private var storedRequests: [Request] = []
    let host = "stub-\(UUID().uuidString.lowercased()).test"
    let backend: BackendClient

    var routes: [String: JSONValue] {
        get { lock.withLock { storedRoutes } }
        set { lock.withLock { storedRoutes = newValue } }
    }

    /// Non-200 answers by path; a route without one answers 200.
    var statuses: [String: Int] {
        get { lock.withLock { storedStatuses } }
        set { lock.withLock { storedStatuses = newValue } }
    }

    var recorded: [Request] { lock.withLock { storedRequests } }

    /// Paths with their query strings, in arrival order.
    var requests: [String] { recorded.map(\.path) }

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        backend = BackendClient(
            baseURL: URL(string: "https://\(host)")!,
            session: URLSession(configuration: configuration),
            tokenProvider: { "test-token" }
        )
        StubURLProtocol.register(host: host) { [weak self] request in
            guard let self, let url = request.url else { return (404, .null) }
            let path = url.path + (url.query.map { "?\($0)" } ?? "")
            let body = Self.body(of: request).flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
            self.lock.withLock {
                self.storedRequests.append(Request(method: request.httpMethod ?? "GET", path: path, body: body))
            }
            guard let answer = self.routes[url.path] else {
                return (404, .object(["ok": .bool(false), "error": .string("No stub for \(url.path)")]))
            }
            return (self.statuses[url.path] ?? 200, answer)
        }
    }

    func tearDown() {
        StubURLProtocol.unregister(host: host)
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
        while stream.hasBytesAvailable {
            let read = stream.read(buffer, maxLength: bufferSize)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

final class StubURLProtocol: URLProtocol {
    typealias Handler = @Sendable (URLRequest) -> (Int, JSONValue)

    private static let lock = NSLock()
    nonisolated(unsafe) private static var handlers: [String: Handler] = [:]

    static func register(host: String, handler: @escaping Handler) {
        lock.withLock { handlers[host] = handler }
    }

    static func unregister(host: String) {
        lock.withLock { handlers[host] = nil }
    }

    override class func canInit(with request: URLRequest) -> Bool {
        guard let host = request.url?.host() else { return false }
        return lock.withLock { handlers[host] != nil }
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let host = url.host(),
              let handler = Self.lock.withLock({ Self.handlers[host] }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        let (status, body) = handler(request)
        let data = (try? JSONEncoder().encode(body)) ?? Data()
        let response = HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
