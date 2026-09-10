import Foundation
import Testing
@testable import Lab86Mail

struct NativeFileCompatibilityTests {
    private func json(_ string: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(string.utf8))
    }

    @Test func optionalNativeModelFieldsAreOmittedNotNullForStrictServerSchema() throws {
        let block = AlbatrossDocBlock(id: "p", text: "A paragraph")
        #expect(block.json["level"] == nil)
        #expect(block.json["runs"] == nil)
        let cell = AlbatrossSheetCell(value: .text("Budget"))
        #expect(cell.json == .object(["value": .string("Budget")]))
        let formula = AlbatrossSheetCell(formula: "SUM(B1:B5)")
        #expect(formula.json == .object(["formula": .string("SUM(B1:B5)")]))
        let element = AlbatrossDeckElement(id: "t", text: "Launch", role: nil, fontSize: nil)
        for field in ["role", "fill", "color", "fontSize"] { #expect(element.json[field] == nil) }
        let slide = AlbatrossDeckSlide(id: "s", title: "Launch", elements: [element])
        #expect(slide.json["background"] == nil)
        let models: [AlbatrossDocumentModel] = [
            .doc(blocks: [block]),
            .sheet(activeSheetID: "s", sheets: [AlbatrossSheetTab(id: "s", cells: ["A1": cell, "B1": formula])]),
            .deck(activeSlideID: "s", slides: [slide]),
        ]
        for model in models { #expect(AlbatrossDocumentModel(json: model.json) == model) }
        // Synthetic contract payloads can also be parsed by the actual shared
        // TypeScript schema during release verification.
        let encoded = try JSONEncoder().encode(models.map(\.json))
        print("NATIVE_DOCUMENT_SCHEMA_FIXTURE=" + String(decoding: encoded, as: UTF8.self))
    }

    @Test func workbookRoundTripPreservesEntireEngineSnapshot() throws {
        let raw = try json(#"{"kind":"sheet","version":2,"engine":"o-spreadsheet","activeSheetId":"second","workbook":{"version":19,"sheets":[{"id":"first","name":"Budget","rowNumber":100,"colNumber":26,"cells":{"B10":{"content":"=SUM(B2:B9)","style":3},"A2":{"content":"Travel"},"B2":{"content":"200"}},"merges":["A1:B1"],"figures":[{"id":"chart","tag":"chart","data":{"type":"bar"}}]},{"id":"second","name":"Notes","rowNumber":100,"colNumber":26,"cells":{"A1":{"content":"Keep me"}}}],"styles":{"3":{"bold":true}},"definedNames":{"budget":"Budget!B2"},"futureExtension":{"nested":[1,true,"original"]}}}"#)
        let model = try #require(AlbatrossDocumentModel(json: raw))
        guard case .workbook(let snapshot) = model else { Issue.record("Must not flatten a v2 workbook into v1"); return }
        #expect(model.json == raw)
        #expect(model.requiresWebEditor)
        #expect(snapshot.activeSheetID == "second")
        #expect(snapshot.sheets[0].cells.map(\.address) == ["A2", "B2", "B10"])
        #expect(snapshot.sheets[0].cells.last?.content == "=SUM(B2:B9)")
        #expect(snapshot.sheets[0].cells.last?.isFormula == true)
        #expect(AlbatrossDocumentModel(json: model.json) == model)
    }

    @Test func invalidWorkbookDoesNotFallBackToDestructiveLegacyEditing() throws {
        for payload in [
            #"{"kind":"sheet","version":2,"engine":"unknown","sheets":[{"id":"a"}]}"#,
            #"{"kind":"sheet","version":2,"engine":"o-spreadsheet","workbook":{"sheets":[]}}"#,
            #"{"kind":"sheet","version":2,"engine":"o-spreadsheet","workbook":{"sheets":[{"id":"a","name":"First"},{"id":"a","name":"Duplicate"}]}}"#
        ] { #expect(AlbatrossDocumentModel(json: try json(payload)) == nil) }
    }

    @Test @MainActor func titleSaveSendsFullWorkbookAndAIIsExplicitlyReadOnly() async throws {
        let raw = try json(#"{"kind":"sheet","version":2,"engine":"o-spreadsheet","activeSheetId":"s","workbook":{"version":19,"sheets":[{"id":"s","name":"Budget","cells":{"A1":{"content":"=SUM(B1:B5)","style":7}},"figures":[{"id":"chart","tag":"chart"}]}],"styles":{"7":{"bold":true}},"futureExtension":{"keep":true}}}"#)
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes = ["/api/documents/workbook": .object(["document": .object([
            "documentId": .string("workbook"), "kind": .string("sheet"), "title": .string("Budget"),
            "currentRevision": .number(7), "model": raw,
        ])])]
        let store = DocumentStore(backend: server.backend)
        var document = try await store.fetchDocument(id: "workbook")
        document.title = "Budget reviewed"
        _ = try await store.save(document)
        let request = try #require(server.recorded.first { $0.method == "PATCH" })
        #expect(request.body?["model"] == raw)
        #expect(request.body?["title"]?.stringValue == "Budget reviewed")
        #expect(request.body?["expectedRevision"]?.doubleValue == 7)
        let count = server.recorded.count
        await #expect(throws: BackendError.self) {
            try await store.suggest(documentID: "workbook", instruction: "Change the chart")
        }
        #expect(server.recorded.count == count, "Unsupported native AI never silently mutates a workbook")
    }

    @Test @MainActor func googleImportAndRefreshOmitMissingWebURL() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        let mimeType = "application/vnd.google-apps.document"
        let model = AlbatrossDocumentModel.doc(blocks: [AlbatrossDocBlock(id: "p", text: "Imported")])
        server.routes = ["/api/files/google/import": .object(["document": .object([
            "documentId": .string("imported"), "kind": .string("doc"), "model": model.json,
            "google": .object(["connectionId": .string("drive"), "fileId": .string("file"), "mimeType": .string(mimeType)]),
        ])])]
        let item = try #require(CloudFileItem(json: .object([
            "id": .string("file"), "name": .string("Plan"), "connectionId": .string("drive"), "mimeType": .string(mimeType),
        ])))
        let store = DocumentStore(backend: server.backend)
        let imported = try await store.importGoogle(item)
        _ = try await store.refreshFromGoogle(imported)
        #expect(server.recorded.count == 2)
        for request in server.recorded {
            #expect(request.body?["webUrl"] == nil)
            #expect(request.body?["connectionId"]?.stringValue == "drive")
            #expect(request.body?["fileId"]?.stringValue == "file")
        }
        #expect(server.recorded.last?.body?["mode"]?.stringValue == "refresh")
    }

    @Test func richRunsSurviveUnchangedTextAndClearOnPlainTextReplacement() throws {
        let raw = try json(#"{"id":"p","type":"paragraph","text":"Hello world","runs":[{"text":"Hello ","bold":true,"italic":false},{"text":"world","italic":true,"underline":true,"strike":false,"code":true}]}"#)
        var block = try #require(AlbatrossDocBlock(json: raw))
        #expect(block.json["runs"] == raw["runs"])
        block.text = "Hello world"
        #expect(block.json["runs"] == raw["runs"])
        block.type = "heading"
        block.level = 2
        #expect(block.json["runs"] == raw["runs"])
        block.text = "My edited words"
        #expect(block.runs == nil)
        #expect(block.json["runs"] == nil)
        #expect(block.json["text"]?.stringValue == "My edited words")
    }

    @Test func webEditorLinkPreservesEnvironmentAndEncodesIdentity() throws {
        let url = try #require(AlbatrossDocumentWebLink.url(baseURL: URL(string: "https://mail-staging.lab86.io/old?x=1#old"), documentID: "doc / & ?"))
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(components.host == "mail-staging.lab86.io")
        #expect(components.path == "/")
        #expect(components.queryItems == [URLQueryItem(name: "view", value: "files"), URLQueryItem(name: "document", value: "doc / & ?")])
        #expect(components.fragment == nil)
        #expect(AlbatrossDocumentWebLink.url(baseURL: URL(string: "file:///tmp/document"), documentID: "d") == nil)
    }

    @Test func fileReaderBoundsAggregateBytesAndDoesNotReturnPartialSuccess() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "NativeFileReader-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = directory.appending(path: "first.txt")
        let second = directory.appending(path: "second.txt")
        try Data("first".utf8).write(to: first)
        try Data("second".utf8).write(to: second)
        let files = try await AssistantDraftFileReader.read([first, second], byteLimit: 11)
        #expect(files.map(\.filename) == ["first.txt", "second.txt"])
        #expect(files.map(\.data) == [Data("first".utf8), Data("second".utf8)])
        await #expect(throws: AssistantDraftFileReader.Failure.self) {
            try await AssistantDraftFileReader.read([first, second], byteLimit: 10)
        }
        await #expect(throws: AssistantDraftFileReader.Failure.self) {
            try await AssistantDraftFileReader.read([first, directory.appending(path: "missing.txt")], byteLimit: 20)
        }
        await #expect(throws: AssistantDraftFileReader.Failure.self) {
            try await AssistantDraftFileReader.read([directory], byteLimit: 20)
        }
    }
}
