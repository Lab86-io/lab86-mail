import Foundation
import Testing
@testable import Lab86Mail

// Stage 5 iOS 0.8 parity: project panes live in ProductStore and refresh when
// linked tasks mutate; reorder failures roll back through a server refresh;
// archiving a project never touches board tasks.
@MainActor
struct TasksProjectsTests {
    private actor CountingTools: ToolInvoking {
        private(set) var calls: [String] = []
        private var responses: [String: JSONValue]
        private var failures: Set<String>

        init(responses: [String: JSONValue], failing: Set<String> = []) {
            self.responses = responses
            self.failures = failing
        }

        func invoke(_ name: String, arguments: [String: JSONValue]) async throws -> JSONValue {
            calls.append(name)
            if failures.contains(name) {
                throw NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "scripted failure"])
            }
            return responses[name] ?? .object([:])
        }

        func count(of name: String) -> Int { calls.filter { $0 == name }.count }
        func setResponse(_ value: JSONValue, for name: String) { responses[name] = value }
        func clearFailure(_ name: String) { failures.remove(name) }
    }

    private actor OrderedPaneTools: ToolInvoking {
        private var continuations: [Int: CheckedContinuation<JSONValue, any Error>] = [:]
        private var callCount = 0

        func invoke(_ name: String, arguments: [String: JSONValue]) async throws -> JSONValue {
            let call = callCount
            callCount += 1
            return try await withCheckedThrowingContinuation { continuation in
                continuations[call] = continuation
            }
        }

        func waitForCallCount(_ expected: Int) async {
            while callCount < expected {
                await Task.yield()
            }
        }

        func resolve(call: Int, with value: JSONValue) {
            continuations.removeValue(forKey: call)?.resume(returning: value)
        }
    }

    private func paneJSON(taskIDs: [String]) -> JSONValue {
        .object([
            "pane": .object([
                "tasks": .array(taskIDs.map { id in
                    .object([
                        "card": .object([
                            "cardId": .string(id),
                            "title": .string("Task \(id)"),
                            "columnName": .string("Doing"),
                            "completed": .bool(false),
                            "order": .number(100),
                        ]),
                    ])
                }),
            ]),
        ])
    }

    private func boardJSON() -> JSONValue {
        .object(["board": .object(["columns": .array([]), "cards": .array([])])])
    }

    @Test
    func projectPaneLoadsOnceAndForceReloads() async {
        let tools = CountingTools(responses: [
            "albatross_get_project_pane": paneJSON(taskIDs: ["t1", "t2"]),
        ])
        let store = ProductStore(tools: tools, backend: BackendClient(baseURL: nil))

        await store.loadProjectPane(projectID: "p1")
        #expect(store.projectPanes["p1"]?.tasks.map(\.id) == ["t1", "t2"])
        #expect(store.projectPanes["p1"]?.lastRefreshed != nil)
        #expect(store.projectPanes["p1"]?.error == nil)

        // A fresh pane is a no-op without force…
        await store.loadProjectPane(projectID: "p1")
        #expect(await tools.count(of: "albatross_get_project_pane") == 1)
        // …and force always refetches.
        await store.loadProjectPane(projectID: "p1", force: true)
        #expect(await tools.count(of: "albatross_get_project_pane") == 2)
    }

    @Test
    func projectPaneErrorIsRetryable() async {
        let tools = CountingTools(
            responses: ["albatross_get_project_pane": paneJSON(taskIDs: ["t1"])],
            failing: ["albatross_get_project_pane"]
        )
        let store = ProductStore(tools: tools, backend: BackendClient(baseURL: nil))

        await store.loadProjectPane(projectID: "p1")
        #expect(store.projectPanes["p1"]?.error == "scripted failure")
        #expect(store.projectPanes["p1"]?.tasks.isEmpty == true)
        #expect(store.projectPanes["p1"]?.lastRefreshed == nil)

        await tools.clearFailure("albatross_get_project_pane")
        await store.loadProjectPane(projectID: "p1", force: true)
        #expect(store.projectPanes["p1"]?.error == nil)
        #expect(store.projectPanes["p1"]?.tasks.map(\.id) == ["t1"])
    }

    @Test
    func newerForcedProjectPaneLoadWinsWhenOlderRequestFinishesLast() async {
        let tools = OrderedPaneTools()
        let store = ProductStore(tools: tools, backend: BackendClient(baseURL: nil))

        let older = Task { await store.loadProjectPane(projectID: "p1", force: true) }
        await tools.waitForCallCount(1)
        let newer = Task { await store.loadProjectPane(projectID: "p1", force: true) }
        await tools.waitForCallCount(2)

        await tools.resolve(call: 1, with: paneJSON(taskIDs: ["newer"]))
        await newer.value
        await tools.resolve(call: 0, with: paneJSON(taskIDs: ["older"]))
        await older.value

        #expect(store.projectPanes["p1"]?.tasks.map(\.id) == ["newer"])
        #expect(store.projectPanes["p1"]?.isLoading == false)
    }

    @Test
    func signOutClearsProjectPanesAndRejectsInFlightResponsesFromThePriorSession() async {
        let tools = OrderedPaneTools()
        let store = ProductStore(tools: tools, backend: BackendClient(baseURL: nil))

        let priorSession = Task {
            await store.loadProjectPane(projectID: "p1", force: true)
        }
        await tools.waitForCallCount(1)
        #expect(store.projectPanes["p1"]?.isLoading == true)

        await store.clearForSignOut()
        #expect(store.projectPanes.isEmpty)

        await tools.resolve(call: 0, with: paneJSON(taskIDs: ["prior-account-task"]))
        await priorSession.value
        #expect(store.projectPanes.isEmpty)

        let nextSession = Task {
            await store.loadProjectPane(projectID: "p1", force: true)
        }
        await tools.waitForCallCount(2)
        await tools.resolve(call: 1, with: paneJSON(taskIDs: ["next-account-task"]))
        await nextSession.value
        #expect(store.projectPanes["p1"]?.tasks.map(\.id) == ["next-account-task"])
    }

    @Test
    func completingALinkedTaskRefreshesThePaneWithTheSameCardIdentity() async {
        let tools = CountingTools(responses: [
            "albatross_get_project_pane": paneJSON(taskIDs: ["t1"]),
            "tasks_update_card": .object([:]),
            "tasks_get_board": boardJSON(),
        ])
        let store = ProductStore(tools: tools, backend: BackendClient(baseURL: nil))

        await store.loadProjectPane(projectID: "p1")
        let linked = store.projectPanes["p1"]?.tasks.first
        #expect(linked?.id == "t1")

        await store.setTaskCompleted(
            TaskSummary(id: "t1", title: "Task t1", column: "Doing", due: nil, completed: false, order: 100),
            completed: true
        )
        // The pane refetched because it links the mutated task…
        #expect(await tools.count(of: "albatross_get_project_pane") == 2)
        // …and the card kept one identity — a pane row is a link, not a copy.
        #expect(store.projectPanes["p1"]?.tasks.map(\.id) == ["t1"])
    }

    @Test
    func mutatingAnUnlinkedTaskLeavesThePaneAlone() async {
        let tools = CountingTools(responses: [
            "albatross_get_project_pane": paneJSON(taskIDs: ["t1"]),
            "tasks_update_card": .object([:]),
            "tasks_get_board": boardJSON(),
        ])
        let store = ProductStore(tools: tools, backend: BackendClient(baseURL: nil))
        await store.loadProjectPane(projectID: "p1")

        await store.setTaskCompleted(
            TaskSummary(id: "unrelated", title: "Other", column: "Doing", due: nil, completed: false, order: 5),
            completed: true
        )
        #expect(await tools.count(of: "albatross_get_project_pane") == 1)
    }

    @Test
    func failedReorderRollsBackThroughServerRefreshAndSurfacesTheError() async {
        let tools = CountingTools(
            responses: ["tasks_get_board": boardJSON()],
            failing: ["tasks_move_card"]
        )
        let store = ProductStore(tools: tools, backend: BackendClient(baseURL: nil))
        store.tasks = [
            TaskSummary(id: "t1", title: "One", column: "Todo", due: nil, completed: false, order: 100),
            TaskSummary(id: "t2", title: "Two", column: "Doing", due: nil, completed: false, order: 200),
        ]

        await store.reorderTask(id: "t1", to: "Doing", before: "t2")
        #expect(store.taskError == "scripted failure")
        // The failure path re-reads the board so the optimistic move never
        // survives locally.
        #expect(await tools.count(of: "tasks_get_board") == 1)
    }

    @Test
    func archivingAProjectKeepsBoardTasksOnTheirBoards() async throws {
        let tools = CountingTools(responses: [
            "albatross_update_project": .object([:]),
            "albatross_list_projects": .object(["projects": .array([])]),
        ])
        let store = ProductStore(tools: tools, backend: BackendClient(baseURL: nil))
        store.tasks = [
            TaskSummary(id: "t1", title: "Keep me", column: "Doing", due: nil, completed: false, order: 100),
        ]
        let project = ProjectSummary(json: .object([
            "projectId": .string("p1"),
            "title": .string("Project"),
            "status": .string("active"),
        ]))

        let changed = await store.updateProject(try #require(project), status: "archived")
        #expect(changed)
        // Archive is project metadata only — the task card stays on its board.
        #expect(store.tasks.map(\.id) == ["t1"])
    }
}
