import Foundation
import HTTPTypes
import MobileAPI
import OpenAPIRuntime
import Testing

@Test
func generatedContractVersionIsStable() {
    #expect(MobileAPIVersion.current == 1)
    _ = Client.self
}

@Test
func generatedSwiftTypesDecodeSharedGoldenFixtures() throws {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    let bootstrapURL = try #require(
        Bundle.module.url(forResource: "bootstrap-v1", withExtension: "json")
    )
    let receiptURL = try #require(
        Bundle.module.url(forResource: "command-receipt-v1", withExtension: "json")
    )
    let syncURL = try #require(
        Bundle.module.url(forResource: "sync-v1", withExtension: "json")
    )

    let bootstrap = try decoder.decode(
        Components.Schemas.MobileBootstrap.self,
        from: Data(contentsOf: bootstrapURL)
    )
    let receipt = try decoder.decode(
        Components.Schemas.CommandReceipt.self,
        from: Data(contentsOf: receiptURL)
    )
    let sync = try decoder.decode(
        Components.Schemas.SyncEnvelope.self,
        from: Data(contentsOf: syncURL)
    )

    #expect(bootstrap.user.id == "user-fixture-1")
    #expect(bootstrap.accounts.first?.provider == .google)
    #expect(bootstrap.accounts.first?.sync.itemsSynced == 42)
    #expect(bootstrap.cursors.mail == "12")
    #expect(receipt.status == .failed)
    #expect(receipt.recoverableError?.retryable == true)
    #expect(sync.cursor == "2")
    switch try #require(sync.items.first) {
    case .task(let change):
        #expect(change.payload.cardID == "card-1")
        #expect(change.payload.completed == true)
    default:
        Issue.record("The typed sync fixture did not decode as a task change.")
    }
}

@Test
func authenticationMiddlewareAddsFreshCredentialsAndTraceHeaders() async throws {
    let recorder = RequestRecorder()
    let middleware = MobileAPIAuthenticationMiddleware(
        tokenProvider: { "session-token" },
        timeZoneIdentifier: { "America/New_York" },
        requestID: { "request-1" }
    )

    _ = try await middleware.intercept(
        HTTPRequest(method: .get, url: URL(string: "https://example.com/test")!),
        body: nil,
        baseURL: URL(string: "https://example.com")!,
        operationID: "test"
    ) { request, _, _ in
        await recorder.record(request)
        return (HTTPResponse(status: .ok), nil)
    }

    let headers = await recorder.headers
    #expect(headers[.authorization] == "Bearer session-token")
    #expect(headers[HTTPField.Name("x-user-timezone")!] == "America/New_York")
    #expect(headers[HTTPField.Name("x-request-id")!] == "request-1")
}

@Test
func authenticationMiddlewareNeverSendsARequestWithoutCredentials() async {
    let recorder = RequestRecorder()
    let middleware = MobileAPIAuthenticationMiddleware(
        tokenProvider: { "" }
    )

    await #expect(throws: MobileAPIAuthenticationError.self) {
        _ = try await middleware.intercept(
            HTTPRequest(method: .get, url: URL(string: "https://example.com/test")!),
            body: nil,
            baseURL: URL(string: "https://example.com")!,
            operationID: "test"
        ) { request, _, _ in
            await recorder.record(request)
            return (HTTPResponse(status: .ok), nil)
        }
    }

    #expect(await recorder.requestCount == 0)
}

private actor RequestRecorder {
    private(set) var headers = HTTPFields()
    private(set) var requestCount = 0

    func record(_ request: HTTPRequest) {
        requestCount += 1
        headers = request.headerFields
    }
}
