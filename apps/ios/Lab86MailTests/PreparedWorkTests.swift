import Foundation
import MobileAPI
import Testing
@testable import Lab86Mail

// "Prepared for you" (2026-09-22): the native mirror of
// `components/report/PreparedWork.tsx`. These tests pin the payload decode
// against the web's shape, the latest-only mounting rule, the action bodies
// the server parses, and the store's optimistic dismiss.
struct PreparedWorkTests {
    // MARK: - Fixture

    // One row as `convex/briefPreparations.list` returns it through
    // `GET /api/content?view=brief`, plus a row still being prepared.
    private static let listFixture = """
    {
      "items": [
        {
          "_id": "prep_1",
          "_creationTime": 1758540000000,
          "userId": "user_1",
          "key": "seed:content_9",
          "seedId": "content_9",
          "seedVersion": "v3",
          "status": "pending",
          "revision": 2,
          "userNotes": "Ask Maya about the venue.",
          "needsRefresh": false,
          "preparedAt": 1758543600000,
          "updatedAt": 1758543700000,
          "createdAt": 1758540000000,
          "nextAttemptAt": 0,
          "draft": {
            "title": "Confirm the launch date",
            "shape": "project",
            "situation": "Maya asked for a launch date by Friday.",
            "background": "The thread has three replies.",
            "assessment": "The date blocks the venue booking.",
            "recommendation": "Reply with July 31 and book the venue.",
            "questions": ["Is July 31 still open?", "Who books the venue?"],
            "steps": ["Reply to Maya", "Book the venue"],
            "files": [
              { "name": "launch-plan.md", "content": "# Launch plan\\n\\n- Reply to Maya" },
              { "name": "vendors.csv", "content": "name,contact\\nAcme,acme@example.com" }
            ],
            "evidence": [
              { "sourceId": "content_9", "quote": "launch date by Friday" }
            ]
          },
          "sources": [
            {
              "_id": "content_9",
              "title": "Launch date",
              "source": "mail",
              "version": "v3",
              "url": "/?view=mail&thread=thread_9",
              "modifiedAt": 1758540000000,
              "partial": false
            }
          ]
        },
        {
          "_id": "prep_2",
          "revision": 0,
          "userNotes": "",
          "needsRefresh": true,
          "updatedAt": 1758543000000,
          "error": "The writing model is unavailable.",
          "sources": [],
          "futureField": { "ignored": true }
        }
      ]
    }
    """

    private func decodedItems() throws -> [PreparedItem] {
        try PreparedItem.decodeList(Data(Self.listFixture.utf8))
    }

    // MARK: - Decoding

    @Test func decodesTheWebPayloadShape() throws {
        let items = try decodedItems()
        #expect(items.count == 2)

        let first = try #require(items.first)
        #expect(first.id == "prep_1")
        #expect(first.revision == 2)
        #expect(first.userNotes == "Ask Maya about the venue.")
        #expect(first.needsRefresh == false)
        #expect(first.preparedAt == Date(timeIntervalSince1970: 1_758_543_600))
        #expect(first.workID == nil)

        let draft = try #require(first.draft)
        #expect(draft.title == "Confirm the launch date")
        #expect(draft.shape == "project")
        #expect(draft.situation == "Maya asked for a launch date by Friday.")
        #expect(draft.background == "The thread has three replies.")
        #expect(draft.assessment == "The date blocks the venue booking.")
        #expect(draft.recommendation == "Reply with July 31 and book the venue.")
        #expect(draft.questions == ["Is July 31 still open?", "Who books the venue?"])
        #expect(draft.steps == ["Reply to Maya", "Book the venue"])
        #expect(draft.files.map(\.name) == ["launch-plan.md", "vendors.csv"])
        #expect(draft.files.first?.kind == "MD")
        #expect(draft.files.last?.kind == "CSV")
        #expect(draft.evidence == [PreparedEvidence(sourceID: "content_9", quote: "launch date by Friday")])

        let source = try #require(first.source(for: draft.evidence[0]))
        #expect(source.title == "Launch date")
        #expect(source.version == "v3")
        #expect(source.url?.path == "/")
        #expect(source.partial == false)
        // No user edits yet, so the card shows the draft's files.
        #expect(first.files == draft.files)
    }

    @Test func decodesARowStillBeingPreparedAndIgnoresUnknownKeys() throws {
        let second = try #require(try decodedItems().last)
        #expect(second.id == "prep_2")
        #expect(second.draft == nil)
        #expect(second.needsRefresh)
        #expect(second.error == "The writing model is unavailable.")
        #expect(second.preparedAt == nil)
        #expect(second.sources.isEmpty)
        #expect(second.userFiles == nil)
    }

    @Test func decodeDegradesWrongTypesAndDropsRowsWithoutAnID() throws {
        let data = Data(
            """
            {"items":[
              {"_id":"ok","revision":"not a number","needsRefresh":"yes","userNotes":7,
               "draft":{"title":"Kept","questions":[1,"Real question",null],
                        "files":[{"name":"a.md"},{"name":"b.txt","content":"b"}],
                        "evidence":"nope"},
               "userFiles":[{"name":"edited.md","content":"changed"}],
               "sources":[{"title":"no id"},{"_id":"s1"}]},
              {"_id":"huge","revision":1e30},
              {"_id":"fraction","revision":2.6},
              {"revision":1},
              "garbage"
            ]}
            """.utf8
        )
        let items = try PreparedItem.decodeList(data)
        #expect(items.count == 3)
        let item = try #require(items.first)
        #expect(item.revision == 0)
        // A revision outside Int range never traps; a fraction rounds.
        #expect(items[1].revision == 0)
        #expect(items[2].revision == 3)
        #expect(item.needsRefresh == false)
        #expect(item.userNotes == "")
        #expect(item.draft?.questions == ["Real question"])
        #expect(item.draft?.files.map(\.name) == ["b.txt"])
        #expect(item.draft?.evidence.isEmpty == true)
        #expect(item.sources.map(\.id) == ["s1"])
        #expect(item.sources.first?.title == "Source")
        // Saved user edits win over the draft's files.
        #expect(item.files.map(\.name) == ["edited.md"])
    }

    @Test func decodeListToleratesAMissingItemsArray() throws {
        #expect(try PreparedItem.decodeList(Data("{}".utf8)).isEmpty)
        #expect(try PreparedItem.decodeList(Data("{\"items\":null}".utf8)).isEmpty)
    }

    @Test func decodesTheWriteResult() throws {
        let adopted = try #require(PreparedWorkActionResult.decode(Data(
            "{\"ok\":true,\"result\":{\"workId\":\"work_9\",\"documents\":[]}}".utf8
        )))
        #expect(adopted.ok)
        #expect(adopted.workID == "work_9")

        let dismissed = try #require(PreparedWorkActionResult.decode(Data(
            "{\"ok\":true,\"result\":{\"dismissed\":true}}".utf8
        )))
        #expect(dismissed.dismissed)
        #expect(dismissed.workID == nil)
        #expect(PreparedWorkPolicy.resultMessage(adopted) == "Saved to your work.")
        #expect(PreparedWorkPolicy.resultMessage(dismissed) == "Saved.")
    }

    // MARK: - Latest only

    @Test func theSectionMountsOnlyUnderTheLatestEdition() {
        // The web renders `<PreparedWork />` only while `!selectedId`.
        #expect(PreparedWorkPolicy.mounts(hasArtifact: true, showsLatest: true))
        #expect(!PreparedWorkPolicy.mounts(hasArtifact: true, showsLatest: false))
        #expect(!PreparedWorkPolicy.mounts(hasArtifact: false, showsLatest: true))
        #expect(!PreparedWorkPolicy.mounts(hasArtifact: false, showsLatest: false))
    }

    @Test func theSectionStaysHiddenUntilThereIsSomethingToSay() {
        #expect(!PreparedWorkPolicy.visible(itemCount: 0, error: nil, message: nil))
        #expect(PreparedWorkPolicy.visible(itemCount: 1, error: nil, message: nil))
        #expect(PreparedWorkPolicy.visible(itemCount: 0, error: "Sign in required.", message: nil))
        #expect(PreparedWorkPolicy.visible(itemCount: 0, error: nil, message: "Saved."))
    }

    // MARK: - Card copy

    @Test func statusLineAndLabelsMirrorTheWeb() throws {
        let items = try decodedItems()
        let prepared = items[0]
        let preparing = items[1]
        let english = Locale(identifier: "en_US")

        #expect(PreparedWorkPolicy.statusLine(prepared, locale: english).hasPrefix("Prepared "))
        #expect(PreparedWorkPolicy.statusLine(preparing, locale: english) == "Sources changed · refresh before adopting")
        #expect(
            PreparedWorkPolicy.statusLine(PreparedItem(id: "x"), locale: english) == "Preparing in the background"
        )
        #expect(
            PreparedWorkPolicy.statusLine(PreparedItem(id: "x", userFiles: []), locale: english)
                == "Preparing in the background · Your file edits are saved"
        )

        #expect(PreparedWorkPolicy.shapeLabel(prepared) == "Project")
        #expect(PreparedWorkPolicy.shapeLabel(preparing) == nil)
        let related = PreparedItem(id: "r", draft: PreparedDraft(title: "T"), workID: "work_1")
        #expect(PreparedWorkPolicy.shapeLabel(related) == "For existing work")
        #expect(PreparedWorkPolicy.adoptLabel(related) == "Add to work")
        #expect(PreparedWorkPolicy.adoptLabel(prepared) == "Adopt")

        #expect(PreparedWorkPolicy.canAdopt(prepared, busy: false, dirty: false))
        #expect(!PreparedWorkPolicy.canAdopt(prepared, busy: true, dirty: false))
        #expect(!PreparedWorkPolicy.canAdopt(prepared, busy: false, dirty: true))
        #expect(!PreparedWorkPolicy.canAdopt(preparing, busy: false, dirty: false))
        #expect(!PreparedWorkPolicy.showsRefresh(prepared))
        #expect(PreparedWorkPolicy.showsRefresh(preparing))
    }

    @Test func temporaryFileURLsAreScopedPerPreparation() {
        let file = PreparedFile(name: "notes/plan.md", content: "x")
        let url = PreparedWorkPolicy.temporaryURL(for: file, itemID: "prep_1")
        #expect(url.lastPathComponent == "notes-plan.md")
        #expect(url.deletingLastPathComponent().lastPathComponent == "prep_1")
        #expect(PreparedWorkPolicy.temporaryURL(for: file, itemID: "prep_2") != url)
    }

    @Test func stagedFilesKeepPrivateContentProtectedAcrossRewrites() throws {
        let itemID = "test-\(UUID().uuidString)"
        let file = PreparedFile(name: "private.md", content: "Original private draft")
        let directory = PreparedWorkPolicy.temporaryURL(for: file, itemID: itemID).deletingLastPathComponent()
        defer { try? FileManager.default.removeItem(at: directory) }
        // Existing directories also need their protection upgraded.
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let fileManager = PreparedFileManagerSpy()
        for content in [file.content, "Revised private draft"] {
            fileManager.reset()
            var requestedOptions: Data.WritingOptions?
            let url = try PreparedWorkPolicy.stageFile(
                PreparedFile(name: file.name, content: content), itemID: itemID, fileManager: fileManager
            ) { data, destination, options in
                requestedOptions = options
                try data.write(to: destination, options: options)
            }
            #expect(try String(contentsOf: url, encoding: .utf8) == content)
            #expect(requestedOptions?.contains(.atomic) == true)
            #expect(requestedOptions?.contains(.completeFileProtection) == true)
            #expect(fileManager.createdProtection == .complete)
            #expect(fileManager.updatedProtection == .complete)
            #expect(fileManager.updatedPath == directory.path)
            // Simulator has no data-protection metadata. Exercise the real
            // filesystem above and verify its protection metadata on devices.
            #if os(iOS) && !targetEnvironment(simulator)
            let fileAttributes = try FileManager.default.attributesOfItem(atPath: url.path)
            let directoryAttributes = try FileManager.default.attributesOfItem(atPath: directory.path)
            // FileManager bridges protection attributes back as NSString values.
            let fileProtection = try #require(fileAttributes[.protectionKey] as? String)
            let directoryProtection = try #require(directoryAttributes[.protectionKey] as? String)
            #expect(fileProtection == FileProtectionType.complete.rawValue)
            #expect(directoryProtection == FileProtectionType.complete.rawValue)
            #endif
        }
    }

    // MARK: - Action bodies

    private func json(_ action: PreparedWorkAction) throws -> [String: Any] {
        let data = try JSONEncoder().encode(action)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test func actionBodiesMatchTheServerSchema() throws {
        let item = try #require(try decodedItems().first)

        let adopt = try json(.adopt(item))
        #expect(adopt["operation"] as? String == "adopt")
        #expect(adopt["id"] as? String == "prep_1")
        #expect(adopt["revision"] as? Int == 2)
        // `.strict()` on the server: no extra keys, and no nulls for absent ones.
        #expect(Set(adopt.keys) == ["operation", "id", "revision"])

        #expect(try json(.dismiss(item))["operation"] as? String == "dismiss")
        #expect(try json(.refresh(item))["operation"] as? String == "refresh")

        let answer = try json(.edit(item, notes: "July 31 is open."))
        #expect(answer["operation"] as? String == "edit")
        #expect(answer["notes"] as? String == "July 31 is open.")
        #expect(Set(answer.keys) == ["operation", "id", "revision", "notes"])

        let files = try json(.edit(item, notes: "n", files: [PreparedFile(name: "a.md", content: "b")]))
        let encodedFiles = try #require(files["files"] as? [[String: String]])
        #expect(encodedFiles == [["name": "a.md", "content": "b"]])
    }

    // MARK: - Transport

    @Test func clientReadsAndWritesTheBriefContentView() async throws {
        let host = "prepared-\(UUID().uuidString.lowercased()).test"
        let recorder = RequestRecorder()
        StubURLProtocol.register(host: host) { request in
            recorder.record(request)
            if request.httpMethod == "GET" {
                return (200, .object(["items": .array([.object(["_id": .string("prep_1"), "revision": .number(1)])])]))
            }
            return (200, .object(["ok": .bool(true), "result": .object(["workId": .string("work_1")])]))
        }
        defer { StubURLProtocol.unregister(host: host) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        let client = PreparedWorkClient(
            baseURL: URL(string: "https://\(host)")!,
            session: URLSession(configuration: configuration),
            tokenProvider: { "test-token" }
        )

        let items = try await client.list()
        #expect(items.map(\.id) == ["prep_1"])
        let result = try await client.act(.adopt(items[0]))
        #expect(result.workID == "work_1")

        let requests = recorder.requests
        #expect(requests.map(\.method) == ["GET", "POST"])
        #expect(requests.map(\.path) == ["/api/content?view=brief", "/api/content?view=brief"])
        #expect(requests.allSatisfy { $0.authorization == "Bearer test-token" })
        #expect(requests.last?.body?["operation"]?.stringValue == "adopt")
        #expect(requests.last?.body?["revision"]?.doubleValue == 1)
    }

    @Test func clientSurfacesTheServerErrorText() async throws {
        let host = "prepared-\(UUID().uuidString.lowercased()).test"
        StubURLProtocol.register(host: host) { _ in
            (409, .object(["error": .string("This preparation changed. Refresh it before continuing.")]))
        }
        defer { StubURLProtocol.unregister(host: host) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        let client = PreparedWorkClient(
            baseURL: URL(string: "https://\(host)")!,
            session: URLSession(configuration: configuration),
            tokenProvider: { "test-token" }
        )
        await #expect(throws: PreparedWorkError.server(
            status: 409,
            message: "This preparation changed. Refresh it before continuing."
        )) {
            try await client.act(.refresh(PreparedItem(id: "prep_1")))
        }
    }

    // MARK: - Store

    @Test @MainActor func dismissRemovesTheCardFirstAndRestoresItOnFailure() async throws {
        let items = try decodedItems()
        let transport = ScriptedTransport(items: items)
        let store = PreparedWorkStore()
        await store.load(transport)
        #expect(store.items.map(\.id) == ["prep_1", "prep_2"])
        #expect(store.isVisible)

        transport.failure = PreparedWorkError.server(status: 503, message: "Connected content is unavailable. Please retry.")
        let failed = await store.perform(.dismiss(items[0]), transport: transport)
        #expect(failed == nil)
        #expect(store.items.map(\.id) == ["prep_1", "prep_2"])
        #expect(store.error == "Connected content is unavailable. Please retry.")

        transport.failure = nil
        transport.items = [items[1]]
        let result = await store.perform(.dismiss(items[0]), transport: transport)
        #expect(result?.ok == true)
        #expect(store.items.map(\.id) == ["prep_2"])
        #expect(store.error == nil)
        #expect(store.message == "Saved.")
        #expect(transport.actions.map(\.operation) == [.dismiss, .dismiss])
    }

    @Test @MainActor func adoptReturnsTheCreatedWorkAndReloads() async throws {
        let items = try decodedItems()
        let transport = ScriptedTransport(items: items)
        transport.workID = "work_42"
        let store = PreparedWorkStore()
        await store.load(transport)
        transport.items = [items[1]]
        let result = await store.perform(.adopt(items[0]), transport: transport)
        #expect(result?.workID == "work_42")
        #expect(store.message == "Saved to your work.")
        #expect(store.items.map(\.id) == ["prep_2"])
    }

    @Test @MainActor func aFailedLoadShowsTheServerText() async {
        let transport = ScriptedTransport(items: [])
        transport.failure = PreparedWorkError.unauthorized
        let store = PreparedWorkStore()
        await store.load(transport)
        #expect(store.items.isEmpty)
        #expect(store.error == "Sign in again to see what was prepared for you.")
        #expect(store.isVisible)
        store.clear()
        #expect(!store.isVisible)
    }
}

// MARK: - Test doubles

private final class ScriptedTransport: PreparedWorkTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var storedItems: [PreparedItem]
    private var storedFailure: Error?
    private var storedActions: [PreparedWorkAction] = []
    private var storedWorkID: String?

    init(items: [PreparedItem]) { storedItems = items }

    var items: [PreparedItem] {
        get { lock.withLock { storedItems } }
        set { lock.withLock { storedItems = newValue } }
    }

    var failure: Error? {
        get { lock.withLock { storedFailure } }
        set { lock.withLock { storedFailure = newValue } }
    }

    var workID: String? {
        get { lock.withLock { storedWorkID } }
        set { lock.withLock { storedWorkID = newValue } }
    }

    var actions: [PreparedWorkAction] { lock.withLock { storedActions } }

    func list() async throws -> [PreparedItem] {
        if let failure { throw failure }
        return items
    }

    func act(_ action: PreparedWorkAction) async throws -> PreparedWorkActionResult {
        lock.withLock { storedActions.append(action) }
        if let failure { throw failure }
        return PreparedWorkActionResult(
            ok: true,
            workID: action.operation == .adopt ? workID : nil,
            dismissed: action.operation == .dismiss
        )
    }
}

private final class PreparedFileManagerSpy: FileManager, @unchecked Sendable {
    private let lock = NSLock()
    private var creationProtection: FileProtectionType?
    private var replacementProtection: FileProtectionType?
    private var replacementPath: String?

    var createdProtection: FileProtectionType? { lock.withLock { creationProtection } }
    var updatedProtection: FileProtectionType? { lock.withLock { replacementProtection } }
    var updatedPath: String? { lock.withLock { replacementPath } }

    private func protection(_ attributes: [FileAttributeKey: Any]?) -> FileProtectionType? {
        let value = attributes?[.protectionKey]
        return (value as? FileProtectionType) ?? (value as? String).map(FileProtectionType.init(rawValue:))
    }

    func reset() {
        lock.withLock {
            creationProtection = nil
            replacementProtection = nil
            replacementPath = nil
        }
    }

    override func createDirectory(
        at url: URL, withIntermediateDirectories createIntermediates: Bool,
        attributes: [FileAttributeKey: Any]? = nil
    ) throws {
        lock.withLock { creationProtection = protection(attributes) }
        try super.createDirectory(at: url, withIntermediateDirectories: createIntermediates, attributes: attributes)
    }

    override func setAttributes(_ attributes: [FileAttributeKey: Any], ofItemAtPath path: String) throws {
        lock.withLock {
            replacementProtection = protection(attributes)
            replacementPath = path
        }
        try super.setAttributes(attributes, ofItemAtPath: path)
    }
}

private final class RequestRecorder: @unchecked Sendable {
    struct Entry {
        let method: String
        let path: String
        let authorization: String?
        let body: JSONValue?
    }

    private let lock = NSLock()
    private var stored: [Entry] = []

    var requests: [Entry] { lock.withLock { stored } }

    func record(_ request: URLRequest) {
        guard let url = request.url else { return }
        let body = Self.body(of: request).flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
        let entry = Entry(
            method: request.httpMethod ?? "GET",
            path: url.path + (url.query.map { "?\($0)" } ?? ""),
            authorization: request.value(forHTTPHeaderField: "authorization"),
            body: body
        )
        lock.withLock { stored.append(entry) }
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
