import Foundation
import Testing
@testable import Lab86Mail

// Scheduled sends on the phone follow the web list
// (lib/shell/scheduled-sends.ts): the provider's rows under their several
// keys, pending only, soonest first, and Cancel through `cancel_scheduled`.
struct ScheduledSendsTests {
    private actor ToolsStub: ToolInvoking {
        private let answer: @Sendable (String, [String: JSONValue]) throws -> JSONValue
        private(set) var calls: [(name: String, arguments: [String: JSONValue])] = []

        init(answer: @escaping @Sendable (String, [String: JSONValue]) throws -> JSONValue) {
            self.answer = answer
        }

        func invoke(_ name: String, arguments: [String: JSONValue]) async throws -> JSONValue {
            calls.append((name, arguments))
            return try answer(name, arguments)
        }

        func names() -> [String] { calls.map(\.name) }
        func arguments(of name: String) -> [String: JSONValue]? { calls.first { $0.name == name }?.arguments }
    }

    private static func account(_ id: String, email: String) -> AccountSummary? {
        AccountSummary(json: .object([
            "accountId": .string(id),
            "email": .string(email),
            "provider": .string("google"),
            "authed": .bool(true),
        ]))
    }

    // MARK: - Rows

    @Test
    func aRowReadsTheIDStatusAndTimeUnderTheirSeveralKeys() throws {
        let camel = try #require(ScheduledSendRow(
            json: .object([
                "scheduleId": .string("sch-1"),
                "status": .object(["code": .string("pending")]),
                "closeTime": .number(1_800_000_000),
            ]),
            accountID: "acct-1",
            accountLabel: "casey@northwind.example"
        ))
        #expect(camel.scheduleID == "sch-1")
        #expect(camel.status == .pending)
        #expect(camel.sendAt == Date(timeIntervalSince1970: 1_800_000_000))
        #expect(camel.id == "acct-1:sch-1")

        let snake = try #require(ScheduledSendRow(
            json: .object([
                "schedule_id": .number(42),
                "status": .string("SUCCESS"),
                "close_time": .string("1800000000000"),
            ]),
            accountID: "acct-1",
            accountLabel: "casey@northwind.example"
        ))
        #expect(snake.scheduleID == "42")
        #expect(snake.status == .sent)
        // Milliseconds are accepted too.
        #expect(snake.sendAt == Date(timeIntervalSince1970: 1_800_000_000))

        let bare = try #require(ScheduledSendRow(
            json: .object(["id": .string("x"), "sendAt": .number(0)]),
            accountID: "acct-1",
            accountLabel: "a"
        ))
        #expect(bare.sendAt == nil)
        #expect(bare.status == .pending)
        #expect(ScheduledSendRow(json: .object(["status": .string("pending")]), accountID: "a", accountLabel: "a") == nil)
    }

    @Test
    func statusWordsFollowTheWebRegexes() {
        // The web's rule is /succ?ess|sent/: "success" is sent, "succeeded" is not.
        #expect(ScheduledSendRow.status(from: "success") == .sent)
        #expect(ScheduledSendRow.status(from: "succeeded") == .pending)
        #expect(ScheduledSendRow.status(from: "SENT") == .sent)
        #expect(ScheduledSendRow.status(from: "failed") == .failed)
        #expect(ScheduledSendRow.status(from: "error") == .failed)
        #expect(ScheduledSendRow.status(from: "cancelled") == .cancelled)
        #expect(ScheduledSendRow.status(from: "canceled") == .cancelled)
        #expect(ScheduledSendRow.status(from: "pending") == .pending)
        #expect(ScheduledSendRow.status(from: nil) == .pending)
    }

    @Test
    func pendingRowsOnlySoonestFirstAndUnknownTimesLast() {
        let rows = [
            ScheduledSendRow(accountID: "a", accountLabel: "a", scheduleID: "late", status: .pending, sendAt: Date(timeIntervalSince1970: 3_000)),
            ScheduledSendRow(accountID: "a", accountLabel: "a", scheduleID: "sent", status: .sent, sendAt: Date(timeIntervalSince1970: 100)),
            ScheduledSendRow(accountID: "a", accountLabel: "a", scheduleID: "none", status: .pending, sendAt: nil),
            ScheduledSendRow(accountID: "a", accountLabel: "a", scheduleID: "soon", status: .pending, sendAt: Date(timeIntervalSince1970: 1_000)),
        ]
        #expect(ScheduledSendRow.pending(rows).map(\.scheduleID) == ["soon", "late", "none"])
    }

    @Test
    func theRowLineSaysWhenItSendsWithoutAMiddleDot() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        let row = ScheduledSendRow(
            accountID: "a", accountLabel: "a", scheduleID: "s", status: .pending,
            sendAt: Date(timeIntervalSince1970: 1_792_400_400)
        )
        let line = row.sendLine(locale: Locale(identifier: "en_US"), calendar: calendar)
        #expect(line.hasPrefix("Sends "))
        #expect(line.contains("2026"))
        #expect(!line.contains("·"))
        let unknown = ScheduledSendRow(accountID: "a", accountLabel: "a", scheduleID: "s", status: .pending, sendAt: nil)
        #expect(unknown.sendLine() == "Send time not known")
    }

    // MARK: - Client and model

    @Test
    func cancelSendsTheAccountAndTheScheduleID() {
        let row = ScheduledSendRow(accountID: "acct-1", accountLabel: "a", scheduleID: "sch-9", status: .pending, sendAt: nil)
        #expect(ScheduledSendsClient.cancelArguments(row) == ["account": .string("acct-1"), "scheduleId": .string("sch-9")])
    }

    @Test @MainActor
    func theModelReadsEveryMailboxAndKeepsTheOnesThatDidNotAnswer() async throws {
        let tools = ToolsStub { name, arguments in
            guard name == "list_scheduled" else { return .object([:]) }
            if arguments["account"]?.stringValue == "acct-home" {
                throw BackendError.server(status: 500, message: "down")
            }
            return .object(["scheduled": .array([
                .object(["scheduleId": .string("s-1"), "status": .object(["code": .string("pending")]), "closeTime": .number(2_000)]),
                .object(["scheduleId": .string("s-0"), "status": .object(["code": .string("sent")]), "closeTime": .number(1_000)]),
            ])])
        }
        let accounts = try [
            #require(Self.account("acct-work", email: "casey@northwind.example")),
            #require(Self.account("acct-home", email: "casey.morgan@example.com")),
        ]
        let model = ScheduledSendsModel()
        await model.load(accounts: accounts, client: ScheduledSendsClient(tools: tools))
        #expect(model.phase == .loaded)
        #expect(model.rows.map(\.scheduleID) == ["s-1"])
        #expect(model.rows.first?.accountLabel == "casey@northwind.example")
        #expect(model.failedAccounts == ["casey.morgan@example.com"])
        let names = await tools.names()
        #expect(names == ["list_scheduled", "list_scheduled"])
    }

    @Test
    func theListFailsOnlyWhenNoMailboxAnswers() {
        #expect(ScheduledSendsModel.phase(accountCount: 2, failedCount: 2) == .failed)
        #expect(ScheduledSendsModel.phase(accountCount: 2, failedCount: 1) == .loaded)
        #expect(ScheduledSendsModel.phase(accountCount: 0, failedCount: 0) == .loaded)
    }

    @Test @MainActor
    func cancelRemovesTheRowOrKeepsItWithTheReason() async {
        let tools = ToolsStub { name, arguments in
            guard name == "cancel_scheduled" else { return .object([:]) }
            if arguments["scheduleId"]?.stringValue == "bad" {
                throw BackendError.server(status: 500, message: "Connect this mailbox with Nylas before cancelling scheduled sends.")
            }
            return .object(["ok": .bool(true)])
        }
        let listTools = ToolsStub { _, _ in
            .object(["scheduled": .array([
                .object(["scheduleId": .string("good"), "status": .string("pending")]),
                .object(["scheduleId": .string("bad"), "status": .string("pending")]),
            ])])
        }
        let model = ScheduledSendsModel()
        if let account = Self.account("acct-1", email: "a@example.com") {
            await model.load(accounts: [account], client: ScheduledSendsClient(tools: listTools))
        }
        #expect(model.rows.count == 2)
        let good = model.rows[0]
        let bad = model.rows[1]
        await model.cancel(good, client: ScheduledSendsClient(tools: tools))
        #expect(model.rows.map(\.scheduleID) == ["bad"])
        #expect(model.cancelError == nil)
        await model.cancel(bad, client: ScheduledSendsClient(tools: tools))
        #expect(model.rows.map(\.scheduleID) == ["bad"])
        #expect(model.cancelError?.isEmpty == false)
        #expect(model.cancellingID == nil)
        let arguments = await tools.arguments(of: "cancel_scheduled")
        #expect(arguments?["account"]?.stringValue == "acct-1")
    }
}
