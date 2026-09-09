import Foundation
import Testing
@testable import Lab86Mail

struct NarrativeBriefTests {
    private static let at = Date(timeIntervalSince1970: 1_700_000_000)

    private static func entry(_ id: String = "brief-1") -> JSONValue {
        .object([
            "_id": .string(id), "title": .string("Your day in context"),
            "text": .string("Yesterday's meeting explains today's work."),
            "sourceIds": .array([.string("source-1")]), "model": .string("writer"),
        ])
    }

    private static func brief() -> JSONValue {
        .object(["enabled": .bool(true), "entry": entry(), "running": .bool(false)])
    }

    @Test @MainActor func briefUsesEditionMillisecondsAndRevalidatesConsent() async {
        let store = NarrativeBriefStore()
        await store.load(.brief(Self.at)) { path in
            let components = URLComponents(string: path)!
            #expect(components.queryItems?.first(where: { $0.name == "at" })?.value == "1700000000000.0")
            return Self.brief()
        }
        #expect(store.entry?.id == "brief-1")
        #expect(store.entry?.modelWritten == true)
        await store.load(.brief(Self.at)) { _ in .object(["enabled": .bool(false)]) }
        #expect(store.entry == nil)
        #expect(!store.enabled)
    }

    @Test @MainActor func failedOrMalformedReadsNeverKeepPrivateProse() async {
        let store = NarrativeBriefStore()
        await store.load(.brief(Self.at)) { _ in Self.brief() }
        await store.load(.brief(Self.at)) { _ in throw BackendError.unauthorized }
        #expect(store.entry == nil)
        #expect(store.error != nil)
        await store.load(.brief(Self.at)) { _ in
            .object(["enabled": .bool(true), "entry": .object(["_id": .string("bad")])])
        }
        #expect(store.entry == nil)
        #expect(store.error != nil)
    }

    @Test @MainActor func sourcesDisappearWhenAccountIsRevoked() async {
        let store = NarrativeBriefStore()
        await store.load(.sources("brief-1")) { _ in
            .object(["entry": Self.entry(), "sources": .array([Self.entry("source-1")])])
        }
        #expect(store.sources.map(\.id) == ["source-1"])
        await store.load(.sources("brief-1")) { _ in .object(["available": .bool(true)]) }
        #expect(store.entry == nil)
        #expect(store.sources.isEmpty)
    }

    @Test @MainActor func malformedSourcesRejectTheWholePacket() async {
        let store = NarrativeBriefStore()
        await store.load(.sources("brief-1")) { _ in
            .object(["entry": Self.entry(), "sources": .array([Self.entry("source-1"), .null])])
        }
        #expect(store.entry == nil)
        #expect(store.sources.isEmpty)
        #expect(store.error != nil)
    }

    @Test @MainActor func aClearedOrSupersededRequestCannotRestoreAnOldEdition() async {
        let store = NarrativeBriefStore()
        let gate = NarrativeReadGate()
        let old = Task { await store.load(.brief(Self.at)) { _ in await gate.wait() } }
        await gate.started()
        store.clear()
        await store.load(.brief(Self.at.addingTimeInterval(86_400))) { _ in
            .object(["enabled": .bool(true), "entry": Self.entry("tomorrow")])
        }
        await gate.finish(Self.brief())
        await old.value
        #expect(store.entry?.id == "tomorrow")
    }

    @Test @MainActor func refreshUsesExistingConsentAndSurfacesFailure() async {
        let store = NarrativeBriefStore()
        await store.requestRefresh { Issue.record("Memory off must not request generation"); return .null }
        await store.load(.brief(Self.at)) { _ in Self.brief() }
        await store.requestRefresh { .object(["ok": .bool(true)]) }
        #expect(store.running)
        await store.requestRefresh { throw BackendError.invalidResponse }
        #expect(store.error != nil)
        #expect(store.entry?.id == "brief-1")
    }

    @Test func sourceIDsAreEncodedAsOneQueryValue() {
        let id = "source&another=value#fragment"
        let components = URLComponents(string: NarrativeBriefStore.Query.sources(id).path)!
        #expect(components.queryItems == [URLQueryItem(name: "id", value: id)])
    }

    @Test @MainActor func toolbarAndMastheadUseTheSelectedHistoricalEdition() {
        let report = DailyReportModel(json: .object([
            "_id": .string("old"), "generatedAt": .number(Self.at.timeIntervalSince1970 * 1000),
            "title": .string("Past edition"), "narrative": .string("An older day"),
        ]))
        #expect(report != nil)
        #expect(TodayView.editionDate(report: report, now: Self.at.addingTimeInterval(86_400)) == Self.at)
        #expect(TodayView.editionDate(report: nil, now: Self.at) == Self.at)
    }

    @Test @MainActor func mountedMailConsumesRequestsAndPreservesFocusOnlyQueries() {
        let navigation = NavigationModel()
        navigation.requestMailSearch(query: "latest meeting")
        #expect(navigation.consumeMailSearch(currentQuery: "old") == "latest meeting")
        #expect(navigation.pendingMailSearch == nil)
        navigation.requestMailSearch()
        #expect(navigation.consumeMailSearch(currentQuery: "latest meeting") == "latest meeting")
        #expect(navigation.consumeMailSearch(currentQuery: "latest meeting") == nil)
    }
}

private actor NarrativeReadGate {
    private var response: CheckedContinuation<JSONValue, Never>?
    private var start: CheckedContinuation<Void, Never>?
    func wait() async -> JSONValue {
        await withCheckedContinuation { continuation in
            response = continuation
            start?.resume()
            start = nil
        }
    }
    func started() async {
        if response != nil { return }
        await withCheckedContinuation { start = $0 }
    }
    func finish(_ value: JSONValue) { response?.resume(returning: value); response = nil }
}
