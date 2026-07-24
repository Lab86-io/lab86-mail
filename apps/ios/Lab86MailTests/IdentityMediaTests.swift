import Foundation
import Testing
@testable import Lab86Mail

// Stage 1 iOS 0.8 parity: senderEmail/fromEmail decode contracts, the split
// AreaSummary/AreaDetail.Identity image fields, MailIdentityStore account
// grouping + caching, and the AreaIdentityMark fallback-ordering helper.
struct IdentityMediaTests {
    private enum StubError: Error { case failed }

    private actor RecordingToolInvoker: ToolInvoking {
        private(set) var calls: [(name: String, arguments: [String: JSONValue])] = []
        private let responder: @Sendable (String, [String: JSONValue]) -> JSONValue

        init(responder: @escaping @Sendable (String, [String: JSONValue]) -> JSONValue) {
            self.responder = responder
        }

        func invoke(_ name: String, arguments: [String: JSONValue]) async throws -> JSONValue {
            calls.append((name, arguments))
            return responder(name, arguments)
        }

        var callCount: Int { calls.count }

        func callArguments(at index: Int) -> [String: JSONValue] {
            calls[index].arguments
        }
    }

    // MARK: - MailThreadSummary.senderEmail

    @Test
    func mailThreadSummaryDecodesExplicitSenderEmail() {
        let thread = MailThreadSummary(json: .object([
            "_id": .string("t1"),
            "fromAddress": .string("Sender <sender@example.com>"),
            "senderEmail": .string("Override@Example.com"),
        ]))
        #expect(thread?.senderEmail == "override@example.com")
    }

    @Test
    func mailThreadSummaryFallsBackToHeaderParsedEmail() {
        let thread = MailThreadSummary(json: .object([
            "_id": .string("t2"),
            "fromAddress": .string("\"A Person\" <person@example.com>"),
        ]))
        #expect(thread?.senderEmail == "person@example.com")
    }

    @Test
    func mailThreadSummarySenderEmailIsNilWhenUnavailable() {
        let thread = MailThreadSummary(json: .object([
            "_id": .string("t3"),
        ]))
        #expect(thread?.senderEmail == nil)
    }

    // MARK: - MailMessage.fromEmail

    @Test
    func mailMessageDecodesExplicitFromEmail() {
        let message = MailMessage(
            json: .object([
                "_id": .string("m1"),
                "from": .string("Sender <sender@example.com>"),
                "fromEmail": .string("Override@Example.com"),
            ]),
            index: 0
        )
        #expect(message.fromEmail == "override@example.com")
    }

    @Test
    func mailMessageFallsBackToHeaderParsedFromEmail() {
        let message = MailMessage(
            json: .object([
                "_id": .string("m2"),
                "from": .string("\"A Person\" <person@example.com>"),
            ]),
            index: 0
        )
        #expect(message.fromEmail == "person@example.com")
    }

    @Test
    func mailMessageFromEmailIsNilWhenUnavailable() {
        let message = MailMessage(json: .object(["_id": .string("m3")]), index: 0)
        #expect(message.fromEmail == nil)
    }

    // MARK: - AreaSummary split imageURL/faviconURL

    @Test
    func areaSummaryDecodesSplitImageAndFaviconFromTool() {
        let area = AreaSummary(json: .object([
            "_id": .string("a1"),
            "name": .string("Area One"),
            "imageUrl": .string("https://example.com/image.png"),
            "faviconUrl": .string("https://example.com/favicon.ico"),
        ]))
        #expect(area?.imageURL == "https://example.com/image.png")
        #expect(area?.faviconURL == "https://example.com/favicon.ico")
    }

    @Test
    func areaSummaryOldMergedCachedSnapshotStillDecodes() throws {
        // Pre-split cached snapshots only ever wrote `imageURL` (already merged
        // imageUrl||faviconUrl server-side) and never had a `faviconURL` key.
        let json = """
        {"id":"a1","name":"Area One","kind":"area","imageURL":"https://example.com/legacy.png"}
        """
        let area = try JSONDecoder().decode(AreaSummary.self, from: Data(json.utf8))
        #expect(area.imageURL == "https://example.com/legacy.png")
        #expect(area.faviconURL == nil)
    }

    // MARK: - AreaImageSource.ordered

    @Test
    func areaImageSourceOrdersImageBeforeFavicon() {
        let ordered = AreaImageSource.ordered(imageURL: "https://img", faviconURL: "https://icon")
        #expect(ordered == ["https://img", "https://icon"])
    }

    @Test
    func areaImageSourceDropsBlankValues() {
        #expect(AreaImageSource.ordered(imageURL: "  ", faviconURL: "https://icon") == ["https://icon"])
        #expect(AreaImageSource.ordered(imageURL: nil, faviconURL: nil).isEmpty)
        #expect(AreaImageSource.ordered(imageURL: "https://img", faviconURL: nil) == ["https://img"])
    }

    // MARK: - MailIdentityStore

    @Test @MainActor
    func mailIdentityStoreGroupsByAccountAndDedupesLowercasedEmails() async {
        let invoker = RecordingToolInvoker { name, arguments in
            #expect(name == "resolve_photos")
            let account = arguments["account"]?.stringValue ?? ""
            if account == "acct1" {
                return .object(["photos": .object(["a@example.com": .string("https://cdn.example.com/a.jpg")])])
            }
            return .object(["photos": .object(["b@example.com": .null])])
        }
        let store = MailIdentityStore(tools: invoker)

        await store.resolve(entries: [
            (email: "A@Example.com", account: "acct1"),
            (email: "a@example.com", account: "acct1"),
            (email: "b@example.com", account: "acct2"),
        ])

        let callCount = await invoker.callCount
        #expect(callCount == 2)

        let acct1Arguments = await invoker.callArguments(at: 0)
        let emails = acct1Arguments["emails"]?.arrayValue?.compactMap(\.stringValue) ?? []
        #expect(emails == ["a@example.com"])

        #expect(store.photoURL(for: "A@Example.com") == URL(string: "https://cdn.example.com/a.jpg"))
        #expect(store.photoURL(for: "b@example.com") == nil)
    }

    @Test @MainActor
    func mailIdentityStoreCachesPositiveAndNegativeResultsAcrossCalls() async {
        let invoker = RecordingToolInvoker { _, arguments in
            let account = arguments["account"]?.stringValue ?? ""
            if account == "acct1" {
                return .object(["photos": .object(["a@example.com": .string("https://cdn.example.com/a.jpg")])])
            }
            return .object(["photos": .object(["b@example.com": .null])])
        }
        let store = MailIdentityStore(tools: invoker)
        let entries: [(email: String, account: String)] = [
            (email: "a@example.com", account: "acct1"),
            (email: "b@example.com", account: "acct2"),
        ]

        await store.resolve(entries: entries)
        let firstCallCount = await invoker.callCount
        #expect(firstCallCount == 2)

        // Same entries again: both the positive and the negative result are
        // already cached, so no new resolve_photos calls should go out.
        await store.resolve(entries: entries)
        let secondCallCount = await invoker.callCount
        #expect(secondCallCount == firstCallCount)
    }

    @Test @MainActor
    func mailIdentityStoreIgnoresInvalidURLStrings() async {
        let invoker = RecordingToolInvoker { _, _ in
            .object(["photos": .object(["c@example.com": .string("not a valid url")])])
        }
        let store = MailIdentityStore(tools: invoker)

        await store.resolve(entries: [(email: "c@example.com", account: "acct1")])

        #expect(store.photoURL(for: "c@example.com") == nil)
    }
}
