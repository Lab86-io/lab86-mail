import Foundation
import Testing
@testable import Lab86Mail

// The reader builds one sanitized document for each message body, off the
// main actor, and keeps the last few (M6).
struct EmailDocumentCacheTests {
    @Test
    func theKeyIsStableForTheSameBodyAndDistinctOtherwise() {
        let a = EmailDocumentKey(html: "<p>Hello</p>", allowRemoteContent: true)
        let again = EmailDocumentKey(html: "<p>Hello</p>", allowRemoteContent: true)
        #expect(a == again)
        #expect(a.hashValue == again.hashValue)
        #expect(a != EmailDocumentKey(html: "<p>Hello!</p>", allowRemoteContent: true))
        #expect(a != EmailDocumentKey(html: "<p>Hello</p>", allowRemoteContent: false))
        #expect(a.length == "<p>Hello</p>".utf8.count)
    }

    @Test
    func theSameBodyBuildsOnce() async {
        let cache = EmailDocumentCache(limit: 4) { html, allowRemoteContent in
            "built:\(allowRemoteContent):\(html)"
        }
        let first = await cache.document(for: "<p>a</p>", allowRemoteContent: true)
        let second = await cache.document(for: "<p>a</p>", allowRemoteContent: true)
        #expect(first == "built:true:<p>a</p>")
        #expect(second == first)
        let builds = await cache.buildCount
        #expect(builds == 1)
        // The remote-content setting is part of the identity.
        let blocked = await cache.document(for: "<p>a</p>", allowRemoteContent: false)
        #expect(blocked == "built:false:<p>a</p>")
        let buildsAfter = await cache.buildCount
        #expect(buildsAfter == 2)
    }

    @Test
    func theCacheKeepsOnlyTheLastFewBodies() async {
        let cache = EmailDocumentCache(limit: 2) { html, _ in html.uppercased() }
        _ = await cache.document(for: "a", allowRemoteContent: true)
        _ = await cache.document(for: "b", allowRemoteContent: true)
        _ = await cache.document(for: "c", allowRemoteContent: true)
        let count = await cache.count
        #expect(count == 2)
        // The oldest body builds again; the newer ones do not.
        _ = await cache.document(for: "c", allowRemoteContent: true)
        let afterHit = await cache.buildCount
        #expect(afterHit == 3)
        _ = await cache.document(for: "a", allowRemoteContent: true)
        let afterMiss = await cache.buildCount
        #expect(afterMiss == 4)
    }

    @Test
    func theCacheStaysInsideItsByteBudget() async {
        let cache = EmailDocumentCache(limit: 10, byteBudget: 10) { html, _ in html }
        _ = await cache.document(for: "aaaa", allowRemoteContent: true)
        _ = await cache.document(for: "bbbb", allowRemoteContent: true)
        var bytes = await cache.byteCount
        #expect(bytes == 8)
        // A third body passes the budget: the oldest goes.
        _ = await cache.document(for: "cccc", allowRemoteContent: true)
        bytes = await cache.byteCount
        var count = await cache.count
        #expect(bytes == 8)
        #expect(count == 2)
        // A body larger than the budget comes back but is not kept, and the
        // bodies already here stay.
        let large = await cache.document(for: "dddddddddddd", allowRemoteContent: true)
        #expect(large == "dddddddddddd")
        bytes = await cache.byteCount
        count = await cache.count
        #expect(bytes == 8)
        #expect(count == 2)
        let buildsBefore = await cache.buildCount
        _ = await cache.document(for: "bbbb", allowRemoteContent: true)
        _ = await cache.document(for: "cccc", allowRemoteContent: true)
        let buildsAfter = await cache.buildCount
        #expect(buildsAfter == buildsBefore)
    }

    @Test
    func theDefaultBuilderSanitizesLikeTheReader() async {
        let cache = EmailDocumentCache(limit: 1)
        let document = await cache.document(for: "<p>Hi</p><script>alert(1)</script>", allowRemoteContent: true)
        #expect(document.contains("<p>Hi</p>"))
        #expect(!document.contains("<script"))
        #expect(document == EmailHTMLDocument.make(from: "<p>Hi</p><script>alert(1)</script>", allowRemoteContent: true))
    }
}
