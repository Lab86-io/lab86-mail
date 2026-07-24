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
func briefDocumentDegradesFutureAndUnknownNodesWithoutGoingBlank() throws {
    let future = Data(
        """
        {"version":3,"title":"Future brief","summary":"Still readable.","generatedAt":1,
         "regions":[{"newShape":{"cannot":"decode as a v2 region"}}]}
        """.utf8
    )
    let futureDocument = try #require(BriefDocumentV2.decode(future))
    #expect(futureDocument.version == 2)
    #expect(futureDocument.regions.first?.tree.kind == "group")

    let unknown = Data(
        """
        {"version":2,"title":"Today","summary":"Summary","generatedAt":1,"regions":[{"id":"one","summary":"Region fallback","tree":{"kind":"new_layout","children":[{"kind":"text","text":"Known child"}]}}]}
        """.utf8
    )
    let unknownDocument = try #require(BriefDocumentV2.decode(unknown))
    #expect(unknownDocument.regions.first?.tree.kind == "stack")
    #expect(unknownDocument.regions.first?.tree.children?.first?.text == "Known child")
}

@Test
func briefDocumentDecodesOptionalHandoffsWithoutBreakingLegacyEntities() throws {
    let data = Data(
        """
        {"version":2,"title":"Today","summary":"Two conversations.","generatedAt":1,
         "regions":[{"id":"needs-you","summary":"Needs you","tree":{"kind":"entity_list","variant":"rows",
           "items":[
             {"ref":{"kind":"thread","id":"thread-1","account":"jakob@example.com"},
              "framing":{"lane":"reply_owed"},
              "handoff":{"handoffId":"triage-thread-1","itemCount":2,"situation":"Maya wrote about launch.","background":["Confirm the date"],
                "assessment":"The date blocks planning.","recommendation":"Confirm July 31.",
                "recommendations":[{"label":"Confirm July 31.",
                  "ref":{"kind":"thread","id":"thread-1","account":"jakob@example.com"}},
                  {"label":"Update the launch task.","ref":{"kind":"task","id":"task-1"}}],
                "evidence":[{"label":"Source conversation",
                  "ref":{"kind":"thread","id":"thread-1","account":"jakob@example.com"}}]},
             "actions":[]},
             {"ref":{"kind":"thread","id":"legacy","account":"jakob@example.com"},
              "framing":{"reason":"Legacy framing"},"actions":[]},
             {"ref":{"kind":"task","id":"defaulted-handoff"},
              "handoff":{"situation":"A task needs attention.","assessment":"It is due.",
                "recommendation":"Open the task."},"actions":[]}
           ]}}]}
        """.utf8
    )
    let document = try #require(BriefDocumentV2.decode(data))
    let items = try #require(document.regions.first?.tree.items)

    #expect(items.count == 3)
    #expect(items[0].handoff?.recommendation == "Confirm July 31.")
    #expect(items[0].handoff?.handoffId == "triage-thread-1")
    #expect(items[0].handoff?.itemCount == 2)
    #expect(items[0].handoff?.recommendations.count == 2)
    #expect(items[0].handoff?.recommendations.last?.ref?.id == "task-1")
    #expect(items[0].handoff?.background == ["Confirm the date"])
    #expect(items[0].handoff?.evidence.first?.ref?.id == "thread-1")
    #expect(items[1].handoff == nil)
    #expect(items[2].handoff?.recommendations.isEmpty == true)
    #expect(items[2].handoff?.background.isEmpty == true)
    #expect(items[2].handoff?.evidence.isEmpty == true)
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
