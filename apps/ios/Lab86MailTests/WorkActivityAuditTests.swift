import Foundation
import Testing
@testable import Lab86Mail

// TSK-1, NAT-5, NAT-9, NAT-12 (audit 2026-09-26).
@MainActor
struct WorkActivityAuditTests {
    private func board(_ id: String, owned: Bool, isDefault: Bool) -> TaskBoardSummary {
        TaskBoardSummary(json: .object([
            "boardId": .string(id),
            "title": .string(id),
            "owned": .bool(owned),
            "isDefault": .bool(isDefault),
        ]))!
    }

    @Test
    func theDefaultBoardIsNeverAnotherPersonsBoard() {
        let shared = board("shared", owned: false, isDefault: true)
        let own = board("own", owned: true, isDefault: false)
        let ownDefault = board("own-default", owned: true, isDefault: true)
        #expect(TaskBoardSummary.defaultBoardID(in: [shared, own, ownDefault]) == "own-default")
        #expect(TaskBoardSummary.defaultBoardID(in: [shared, own]) == "own")
        // No owned board: the server creates the user's default board.
        #expect(TaskBoardSummary.defaultBoardID(in: [shared]) == nil)
    }

    @Test
    func theActivityBadgeCountsOnlyWhatTheSheetShows() {
        #expect(!ActivityInbox.needsAttention(approvals: 0, suggestions: 0, questions: 0))
        #expect(ActivityInbox.needsAttention(approvals: 0, suggestions: 1, questions: 0))
        #expect(ActivityInbox.needsAttention(approvals: 0, suggestions: 0, questions: 2))
    }

    @Test
    func actingOnASuggestionRemovesItFromActivity() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes["/api/suggestions/act"] = .object(["ok": .bool(true)])
        let store = ProductStore(tools: RecordingTools(), backend: server.backend)
        store.suggestions = [try #require(SuggestionSummary(json: .object([
            "_id": .string("s1"), "title": .string("Dinner"), "kind": .string("event"),
        ])))]
        await store.actOnSuggestion(id: "s1", action: "dismiss")
        #expect(store.suggestions.isEmpty)
        let body = try #require(server.recorded.first(where: { $0.path == "/api/suggestions/act" })?.body)
        #expect(body["suggestionId"] == .string("s1"))
        #expect(body["action"] == .string("dismiss"))
    }

    @Test
    func createAreaPostsTheTrimmedNameAndReturnsTheID() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes["/api/albatross/areas"] = .object(["ok": .bool(true), "areaId": .string("area-9")])
        let store = ProductStore(tools: RecordingTools(), backend: server.backend)

        #expect(await store.createArea(name: "   ") == nil)
        #expect(server.recorded.isEmpty)

        let areaID = await store.createArea(name: "  Lake house ")
        #expect(areaID == "area-9")
        let body = try #require(server.recorded.first(where: { $0.path == "/api/albatross/areas" })?.body)
        #expect(body["action"] == .string("create_area"))
        #expect(body["name"] == .string("Lake house"))
    }

    @Test
    func createAreaReportsAFailure() async {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes["/api/albatross/areas"] = .object(["ok": .bool(false), "error": .string("name required")])
        server.statuses["/api/albatross/areas"] = 400
        let store = ProductStore(tools: RecordingTools(), backend: server.backend)
        #expect(await store.createArea(name: "Lake house") == nil)
        #expect(store.errorMessage != nil)
    }

    @Test
    func aWorkQuestionOptionAnswersThroughTheEndpoint() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes["/api/albatross/work/questions/q1/answer"] = .object(["ok": .bool(true)])
        let store = ProductStore(tools: RecordingTools(), backend: server.backend)
        let question = WorkDetail.Question(
            id: "q1",
            status: "pending",
            prompt: "Which venue?",
            reason: nil,
            options: [WorkDetail.Question.Option(id: "o2", label: "The lake", detail: nil)]
        )
        let saved = await store.answerWorkQuestion(question, answer: "The lake", optionID: "o2")
        #expect(saved)
        let body = try #require(server.recorded.first(where: { $0.path.hasPrefix("/api/albatross/work/questions/q1/answer") })?.body)
        #expect(body["answer"] == .string("The lake"))
        #expect(body["answeredOptionId"] == .string("o2"))
    }
}
