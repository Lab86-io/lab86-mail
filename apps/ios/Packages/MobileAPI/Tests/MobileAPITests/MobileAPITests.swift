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
func briefDocumentHandoffCollectionsDefaultNullAndEnforceCaps() throws {
    let data = Data(
        """
        {"version":2,"title":"Today","summary":"Collection boundaries.","generatedAt":1,
         "regions":[{"id":"limits","summary":"Limits","tree":{"kind":"entity_list","items":[
           {"ref":{"kind":"task","id":"nulls"},
            "handoff":{"situation":"Null collections","background":null,"assessment":"Still valid.",
              "recommendation":"Open the task.","recommendations":null,"evidence":null},"actions":[]},
           {"ref":{"kind":"task","id":"caps"},
            "handoff":{"situation":"Long collections","background":["b1","b2","b3","b4"],
              "assessment":"Keep bounded.","recommendation":"Take the first move.",
              "recommendations":[{"label":"r1"},{"label":"r2"},{"label":"r3"},{"label":"r4"},{"label":"r5"}],
              "evidence":[{"label":"e1"},{"label":"e2"},{"label":"e3"},{"label":"e4"},{"label":"e5"}]},
            "actions":[]}
         ]}}]}
        """.utf8
    )

    let document = try #require(BriefDocumentV2.decode(data))
    let items = try #require(document.regions.first?.tree.items)
    #expect(items[0].handoff?.background.isEmpty == true)
    #expect(items[0].handoff?.recommendations.isEmpty == true)
    #expect(items[0].handoff?.evidence.isEmpty == true)
    #expect(items[1].handoff?.background == ["b1", "b2", "b3"])
    #expect(items[1].handoff?.recommendations.map(\.label) == ["r1", "r2", "r3", "r4"])
    #expect(items[1].handoff?.evidence.map(\.label) == ["e1", "e2", "e3", "e4"])
}

@Test
func briefDocumentPreservesBoundedEditorialFootprints() throws {
    let data = Data(
        """
        {"version":2,"title":"The Thursday Brief","summary":"One lead.","generatedAt":1,
         "regions":[{"id":"lead","summary":"Lead","tree":{"kind":"grid","children":[
           {"kind":"group","title":"Big idea","footprint":"feature","children":[
             {"kind":"text","role":"body","text":"The dominant concept."}
           ]},
           {"kind":"text","role":"body","text":"Supporting context.","footprint":"standard"},
           {"kind":"text","role":"body","text":"Invalid leaf.","footprint":"unbounded"}
         ]}}]}
        """.utf8
    )
    let document = try #require(BriefDocumentV2.decode(data))
    let children = try #require(document.regions.first?.tree.children)
    #expect(children.first?.footprint == "feature")
    #expect(children[1].footprint == "standard")
    #expect(children.last?.footprint == nil)
}

@Test
func briefDocumentDecodesCrossClientToolNodes() throws {
    let data = Data(
        """
        {"version":2,"title":"Tool brief","summary":"Rich tools.","generatedAt":1,
         "regions":[{"id":"tools","summary":"Grounded tools.","tree":{"kind":"stack","children":[
           {"kind":"data_table","title":"Builds","columns":[{"key":"build","label":"Build","format":"number"}],
            "rows":[{"build":85}],"sourceRefs":[{"kind":"mcp","id":"builds"}]},
           {"kind":"progress","title":"Release","steps":[{"id":"ship","label":"Ship","status":"in-progress"}],
            "sourceRefs":[{"kind":"mcp","id":"release"}]},
           {"kind":"weather","title":"Lake weather","location":"Lake George","latitude":43.42,"longitude":-73.71,
            "timezone":"America/New_York","unit":"fahrenheit",
            "current":{"conditionCode":"clear","temperature":78,"tempMin":61,"tempMax":81},
            "hourly":[{"label":"9 AM","conditionCode":"clear","temperature":72}],
            "daily":[{"label":"Today","conditionCode":"clear","tempMin":61,"tempMax":81}],
            "source":"Apple Weather","attributionURL":"https://weatherkit.apple.com/legal-attribution.html",
            "sourceRefs":[{"kind":"mcp","id":"weather"}]},
           {"kind":"plan","title":"Runway","items":[{"id":"focus","label":"Focus","status":"in_progress",
            "ref":{"kind":"task","id":"task-1"}}],"actions":[],"sourceRefs":[{"kind":"task","id":"task-1"}]},
           {"kind":"email_preview","channel":"email","title":"Confirm","sender":"Maya","recipients":["Jakob"],"snippet":"Confirm the date.",
            "attachmentCount":1,"messageCount":2,"ref":{"kind":"thread","id":"thread-1","account":"mail@example.com"},
            "actions":[],"sourceRefs":[{"kind":"thread","id":"thread-1","account":"mail@example.com"}]},
           {"kind":"decision","title":"Path","options":[
              {"id":"stage","label":"Stage","action":{"action":"open_view","label":"Open","payload":{}}},
              {"id":"hold","label":"Hold","action":{"action":"open_view","label":"Hold","payload":{}}}],
            "sourceRefs":[{"kind":"mcp","id":"decision"}]},
           {"kind":"citations","title":"Sources","citations":[
              {"id":"one","href":"https://example.com","title":"Source","type":"document"}],
            "sourceRefs":[{"kind":"mcp","id":"sources"}]},
           {"kind":"geo_map","title":"Lake","markers":[{"id":"lake","lat":43.42,"lng":-73.71,"label":"Lake"}],
            "routes":[],"sourceRefs":[{"kind":"event","id":"event-1"}]},
           {"kind":"code_diff","title":"Change","filename":"Push.swift","language":"swift",
            "oldCode":"false","newCode":"true","sourceRefs":[{"kind":"mcp","id":"diff"}]},
           {"kind":"terminal","title":"Build","command":"xcodebuild test","stdout":"TEST SUCCEEDED","stderr":"",
            "exitCode":0,"truncated":false,"sourceRefs":[{"kind":"mcp","id":"terminal"}]}
         ]}}]}
        """.utf8
    )

    let document = try #require(BriefDocumentV2.decode(data))
    let children = try #require(document.regions.first?.tree.children)
    #expect(children.map(\.kind) == [
        "data_table", "progress", "weather", "plan", "email_preview",
        "decision", "citations", "geo_map", "code_diff", "terminal",
    ])
    #expect(children[0].tableColumns?.first?.key == "build")
    #expect(children[0].tableRows?.first?["build"]?.doubleValue == 85)
    #expect(children[1].progressSteps?.first?.status == "in-progress")
    #expect(children[2].weatherCurrent?.conditionCode == "clear")
    #expect(children[2].attributionURL?.host == "weatherkit.apple.com")
    #expect(children[3].planItems?.first?.ref?.id == "task-1")
    #expect(children[4].previewRef?.id == "thread-1")
    #expect(children[4].channel == "email")
    #expect(children[5].decisionOptions?.count == 2)
    #expect(children[6].citations?.first?.title == "Source")
    #expect(children[7].mapMarkers?.first?.lat == 43.42)
    #expect(children[8].filename == "Push.swift")
    #expect(children[9].exitCode == 0)
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
func generatedTypesCarryTheWorkHorizonContract() throws {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601

    let change = try decoder.decode(
        Components.Schemas.SyncChange.self,
        from: Data(
            #"{"domain":"work","entityKind":"workHorizon","entityID":"work-1","revision":4,"operation":"upsert","payload":{"workID":"work-1","horizon":{"kind":"later","notBefore":1793509200000,"label":"not before November"}}}"#.utf8
        )
    )
    switch change {
    case .workHorizon(let horizon):
        #expect(horizon.payload.workID == "work-1")
        #expect(horizon.payload.horizon?.kind == .later)
        #expect(horizon.payload.horizon?.notBefore == 1_793_509_200_000)
        #expect(horizon.payload.horizonCleared == nil)
    default:
        Issue.record("The workHorizon change did not decode as a workHorizon case.")
    }

    let cleared = try decoder.decode(
        Components.Schemas.SyncChange.self,
        from: Data(
            #"{"domain":"work","entityKind":"workHorizon","entityID":"work-2","revision":5,"operation":"upsert","payload":{"workID":"work-2","horizonCleared":true}}"#.utf8
        )
    )
    if case .workHorizon(let horizon) = cleared {
        #expect(horizon.payload.horizon == nil)
        #expect(horizon.payload.horizonCleared == true)
    } else {
        Issue.record("The cleared change did not decode as a workHorizon case.")
    }

    let command = try decoder.decode(
        Components.Schemas.MobileCommand.self,
        from: Data(
            #"{"idempotencyKey":"h-1","clientCreatedAt":"2026-09-03T09:00:00Z","kind":"work.setHorizon","payload":{"workID":"work-1","horizon":{"kind":"someday","label":"one day"}}}"#.utf8
        )
    )
    if case .work_setHorizon(let setHorizon) = command {
        #expect(setHorizon.payload.horizon?.kind == .someday)
        #expect(setHorizon.payload.horizon?.label == "one day")
    } else {
        Issue.record("The work.setHorizon command did not decode as a work_setHorizon case.")
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
