import Foundation
import Testing
@testable import Lab86Mail

// Round 2 trust parity (FEATURES items 2, 14, 15, 17): the plan and trial
// note, standing orders, the Files switch, the data export, and a paused
// call in chat.
@MainActor
struct TrustRoundTwoTests {
    private func planJSON(
        plan: String = "pro",
        active: Bool = true,
        daysLeft: Int = 3,
        showNote: Bool = true,
        disabled: Bool = false
    ) -> JSONValue {
        .object([
            "ok": .bool(true),
            "plan": .string(plan),
            "planName": .string(active ? "Pro trial" : "Pro"),
            "trial": .object([
                "active": .bool(active),
                "endsAt": .number(1_788_400_000_000),
                "daysLeft": .number(Double(daysLeft)),
                "showNote": .bool(showNote),
            ]),
            "note": showNote ? .string("3 days left in your Pro trial.") : .null,
            "trialDays": .number(14),
            "prices": .object([
                "pro": .object(["name": .string("Pro"), "monthlyUsd": .number(15), "annualUsd": .number(150), "line": .string("$15 a month or $150 a year")]),
                "byok": .object(["name": .string("Own key"), "monthlyUsd": .number(12), "annualUsd": .number(50.4), "line": .string("$12 a month or $50.40 a year")]),
            ]),
            "subscriptionsDisabled": .bool(disabled),
        ])
    }

    // MARK: - Plan

    @Test
    func thePlanDecodesAndTheTrialNoteShowsOnlyInItsLastDays() throws {
        let plan = try #require(BillingPlan(json: planJSON()))
        #expect(plan.planName == "Pro trial")
        #expect(plan.trialActive)
        #expect(plan.trialDaysLeft == 3)
        #expect(plan.trialNote == "3 days left in your Pro trial.")
        #expect(plan.pro?.monthlyUsd == 15)
        #expect(plan.ownKey?.name == "Own key")
        #expect(plan.detailLine?.hasPrefix("14-day trial, no card needed. It ends on ") == true)

        let early = try #require(BillingPlan(json: planJSON(daysLeft: 12, showNote: false)))
        #expect(early.trialNote == nil)
        let off = try #require(BillingPlan(json: planJSON(disabled: true)))
        #expect(off.trialNote == nil)
        let paid = try #require(BillingPlan(json: planJSON(active: false, showNote: false)))
        #expect(paid.detailLine == "$15 a month or $150 a year")
        #expect(BillingPlan(json: .object(["ok": .bool(false), "error": .string("Sign in")])) == nil)
    }

    @Test
    func theTrustStoreReadsThePlanOnceAndKeepsTheFilesChoicePerOwner() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[BillingPlan.path] = planJSON()
        server.routes[AccountSurfaces.path] = .object(["ok": .bool(true), "surfaces": .object(["files": .bool(false)])])
        let suite = "trust-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = AccountTrustStore(backend: server.backend, defaults: defaults)

        store.activate(ownerID: "owner-1")
        #expect(store.showsFiles)
        await store.refreshSurfaces()
        #expect(!store.showsFiles)
        #expect(defaults.object(forKey: AccountTrustStore.filesKey(ownerID: "owner-1")) as? Bool == false)

        let now = Date()
        await store.refreshPlan(now: now)
        await store.refreshPlan(now: now.addingTimeInterval(60))
        #expect(store.plan?.planName == "Pro trial")
        #expect(server.requests.filter { $0 == BillingPlan.path }.count == 1)
        await store.refreshPlan(force: true, now: now.addingTimeInterval(60))
        #expect(server.requests.filter { $0 == BillingPlan.path }.count == 2)

        server.routes[AccountSurfaces.path] = .object(["ok": .bool(true), "surfaces": .object(["files": .bool(true)])])
        try await store.setFilesSurface(true)
        #expect(store.showsFiles)
        #expect(server.recorded.last?.body == .object(["files": .bool(true)]))

        // Another owner starts from its own cache; signing out forgets it.
        store.activate(ownerID: "owner-2")
        #expect(store.filesSurface == nil)
        #expect(store.plan == nil)
        store.activate(ownerID: "owner-1")
        #expect(store.filesSurface == true)
        store.clear()
        #expect(defaults.object(forKey: AccountTrustStore.filesKey(ownerID: "owner-1")) == nil)
    }

    @Test
    func filesLeavesTheSidebarOnlyWhenTheSwitchIsOff() {
        #expect(PrimaryTab.sourceList(showsFiles: true) == [.today, .mail, .work, .calendar, .files])
        #expect(PrimaryTab.sourceList(showsFiles: false) == [.today, .mail, .work, .calendar])
        #expect(AccountSurfaces(json: .object(["files": .bool(true)]))?.files == true)
        #expect(AccountSurfaces(json: .object(["ok": .bool(true)])) == nil)
        #expect(AccountSurfaces.body(files: false) == .object(["files": .bool(false)]))
    }

    // MARK: - Standing orders

    @Test
    func standingOrdersDecodeWithTheirStateAndToggle() async throws {
        let json = JSONValue.object(["ok": .bool(true), "orders": .array([
            .object([
                "id": .string("brief"), "group": .string("schedule"), "title": .string("Daily Brief"),
                "detail": .string("Every morning at 7"), "mode": .string("runs_alone"), "paused": .bool(false),
                "locked": .bool(false), "items": .array([]),
            ]),
            .object([
                "id": .string("risk:reach_person"), "group": .string("assistant"), "title": .string("Reach other people"),
                "detail": .string("Mail, invitations"), "mode": .string("asks_first"), "paused": .bool(true),
                "locked": .bool(false),
                "items": .array([.object(["id": .string("i1"), "label": .string("send_message"), "detail": .string("Send mail")])]),
            ]),
            .object([
                "id": .string("risk:read"), "group": .string("assistant"), "title": .string("Look things up"),
                "detail": .string(""), "mode": .string("runs_alone"), "paused": .bool(false), "locked": .bool(true),
            ]),
            .object(["id": .string("broken")]),
        ])])
        let orders = StandingOrder.list(from: json)
        #expect(orders.map(\.id) == ["brief", "risk:reach_person", "risk:read"])
        #expect(orders[0].hint == "Runs on its own")
        #expect(orders[1].hint == "Paused")
        #expect(orders[1].items.first?.detail == "Send mail")
        #expect(orders[2].hint == "Always on")
        #expect(StandingOrder.summary(orders) == "1 paused")
        #expect(StandingOrder.summary([orders[0]]) == "All on")
        #expect(StandingOrderGroup.assistant.title == "What the assistant may do in chat")
        #expect(StandingOrderMode.draft.text == "Drafts, then waits for you")

        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[StandingOrder.path] = .object(["ok": .bool(true), "order": .object([
            "id": .string("brief"), "group": .string("schedule"), "title": .string("Daily Brief"), "paused": .bool(true),
        ])])
        let saved = try await server.backend.post(path: StandingOrder.path, body: StandingOrder.toggleBody(id: "brief", paused: true))
        #expect(saved["order"].flatMap(StandingOrder.init(json:))?.paused == true)
        #expect(server.recorded.last?.body == .object(["id": .string("brief"), "paused": .bool(true)]))
    }

    // MARK: - Export

    @Test
    func theExportIsAZipWithADatedName() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = Date(timeIntervalSince1970: 1_790_380_800)
        #expect(DataExport.fileName(now: now, calendar: calendar) == "albatross-export-2026-09-26.zip")
        #expect(DataExport.isZip(contentType: "application/zip"))
        #expect(DataExport.isZip(contentType: "Application/ZIP; charset=binary"))
        #expect(!DataExport.isZip(contentType: "application/json"))
        #expect(!DataExport.isZip(contentType: nil))

        let folder = FileManager.default.temporaryDirectory.appending(path: "export-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let download = folder.appending(path: "download")
        try Data("PK".utf8).write(to: download)
        let staged = try DataExport.stage(DownloadedFile(url: download, contentType: "application/zip"), now: now)
        #expect(staged.lastPathComponent.hasPrefix("albatross-export-"))
        #expect(FileManager.default.fileExists(atPath: staged.path))
        #expect(!FileManager.default.fileExists(atPath: folder.path))
        try? FileManager.default.removeItem(at: staged.deletingLastPathComponent())

        let other = FileManager.default.temporaryDirectory.appending(path: "export-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
        let json = other.appending(path: "download")
        try Data("{}".utf8).write(to: json)
        #expect(throws: BackendError.self) {
            try DataExport.stage(DownloadedFile(url: json, contentType: "application/json"))
        }
        #expect(!FileManager.default.fileExists(atPath: other.path))
    }

    // MARK: - Paused in chat

    @Test
    func aPausedCallReadsAsPausedNotFailed() {
        let output = JSONValue.object([
            "ok": .bool(false), "status": .string("paused_by_user"), "risk": .string("reach_person"),
            "message": .string("The user paused this kind of action in Settings, Standing orders, so send_message did not run."),
        ])
        #expect(AssistantToolRow.outcomeState(output: output) == .paused)
        let row = AssistantToolRow(callID: "c1", toolName: "send_message", state: .paused, output: output)
        #expect(row.sentence == AssistantToolRow.pausedSentence)
        #expect(AssistantWorkLog.headerState(rows: [row], turnFinished: true) == .paused(count: 1))
        #expect(AssistantWorkLog.headerText(.paused(count: 1)) == "Paused by you")
        #expect(AssistantWorkLog.headerText(.paused(count: 2)) == "2 steps paused by you")
        let done = AssistantToolRow(callID: "c2", toolName: "list_accounts", state: .done)
        #expect(!AssistantWorkLog.collapsesByDefault(rows: [row, done, done], turnFinished: true))
        // A paused call is saved as an output, so a restored chat reads it the same way.
        let part = AssistantChatModel.toolRowPartJSON(row)
        #expect(part["state"] == .string("output-available"))
        #expect(part["output"]?["status"] == .string("paused_by_user"))
        // A real failure still fails.
        #expect(AssistantToolRow.outcomeState(output: .object(["ok": .bool(false), "error": .string("x")])) == .failed)
    }
}
