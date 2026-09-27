#if os(macOS)
import Foundation
import Testing
@testable import Lab86Mail

// Sender cleanup on the Mac (round 2, FEATURES item 13): checkboxes, one
// batch id for a batch block, and a footer that says what happened.
@MainActor
struct MacSenderCleanupTests {
    private static func cleanupRow(_ sender: String, name: String? = nil, threads: Int = 3, unread: Int = 2) -> JSONValue {
        var row: [String: JSONValue] = [
            "sender": .string(sender),
            "threads": .number(Double(threads)),
            "unread": .number(Double(unread)),
            "reason": .string("You opened none of the last 3"),
            "latest": .object(["accountId": .string("acc"), "threadId": .string("t-\(sender)")]),
        ]
        if let name { row["name"] = .string(name) }
        return .object(row)
    }

    private static func cleanupTools(
        senders: [JSONValue],
        blockFailsFor: Set<String> = []
    ) -> RecordingTools {
        RecordingTools { name, arguments in
            switch name {
            case "list_sender_cleanup":
                return .object(["senders": .array(senders), "scanned": .number(120)])
            case "block_sender":
                let sender = arguments["sender"]?.stringValue ?? ""
                // A reply without a sender reads as a failed block.
                guard !blockFailsFor.contains(sender) else { return .object([:]) }
                return .object([
                    "sender": .string(sender),
                    "archived": .number(2),
                    "failed": .number(0),
                    "operationId": .string("op-\(sender)"),
                ])
            default:
                return .object([:])
            }
        }
    }

    @Test
    func theCleanupSheetLoadsSendersAndSelectsThemWithCheckboxes() async throws {
        let tools = Self.cleanupTools(senders: [
            Self.cleanupRow("news@acme.com", name: "Acme News"),
            Self.cleanupRow("deals@shop.com"),
        ])
        let model = MacSenderCleanupModel(client: SenderToolsClient(tools: tools))
        await model.load()

        #expect(model.didLoad)
        #expect(model.rows.map(\.sender) == ["news@acme.com", "deals@shop.com"])
        #expect(model.headerLine.hasPrefix("From your 120 most recent threads. "))
        #expect(model.selectionLine == nil)
        #expect(model.blockLabel == "Block sender")
        #expect(!model.canBlock)
        #expect(model.selectAllLabel == "Select all")

        model.setSelected(model.rows[0], true)
        #expect(model.isSelected(model.rows[0]))
        #expect(model.selectionLine == "1 of 2 selected")
        #expect(model.canBlock)

        model.toggleAll()
        #expect(model.allSelected)
        #expect(model.blockLabel == "Block 2 senders")
        #expect(model.selectAllLabel == "Select none")
        model.toggleAll()
        #expect(model.selection.isEmpty)

        let arguments = await tools.arguments(of: "list_sender_cleanup")
        #expect(arguments.first?["limit"] == .number(40))
    }

    @Test
    func theHeaderLeavesOutTheCountBeforeAnyMailWasRead() {
        let model = MacSenderCleanupModel(client: SenderToolsClient(tools: RecordingTools()))
        #expect(model.headerLine.hasPrefix("Block sends their mail to Noise"))
    }

    @Test
    func aSenderThatLeavesTheListLeavesTheSelection() async {
        let tools = Self.cleanupTools(senders: [Self.cleanupRow("news@acme.com")])
        let model = MacSenderCleanupModel(client: SenderToolsClient(tools: tools))
        model.selection = ["news@acme.com", "gone@old.com"]
        await model.load()
        #expect(model.selection == ["news@acme.com"])
    }

    @Test
    func aBatchBlockSendsOneBatchIDAndKeepsFailedSendersSelected() async throws {
        let tools = Self.cleanupTools(
            senders: [Self.cleanupRow("a@x.com"), Self.cleanupRow("b@x.com"), Self.cleanupRow("c@x.com")],
            blockFailsFor: ["b@x.com"]
        )
        let model = MacSenderCleanupModel(client: SenderToolsClient(tools: tools))
        await model.load()
        model.selection = ["a@x.com", "b@x.com"]

        let outcome = try #require(await model.blockSelected())
        #expect(outcome.blocked.map(\.sender) == ["a@x.com"])
        #expect(outcome.failed == ["b@x.com"])
        // A retry is one click.
        #expect(model.selection == ["b@x.com"])
        #expect(!model.isBlocking)

        let calls = await tools.arguments(of: "block_sender")
        #expect(calls.map { $0["sender"]?.stringValue } == ["a@x.com", "b@x.com"])
        let batchIDs = Set(calls.compactMap { $0["operationBatchId"]?.stringValue })
        #expect(batchIDs.count == 1)
        #expect(batchIDs.first?.hasPrefix("batch_") == true)
    }

    @Test
    func nothingSelectedBlocksNothing() async {
        let tools = Self.cleanupTools(senders: [Self.cleanupRow("a@x.com")])
        let model = MacSenderCleanupModel(client: SenderToolsClient(tools: tools))
        await model.load()
        #expect(await model.blockSelected() == nil)
        #expect(await tools.arguments(of: "block_sender").isEmpty)
    }

    @Test
    func theFooterSaysWhatTheBatchDidAndWhatFailed() {
        let one = BlockSenderResult(sender: "a@x.com", archived: 1, failed: 0, operationID: "op-a")
        let two = BlockSenderResult(sender: "b@x.com", archived: 3, failed: 2, operationID: "op-b")

        let clean = MacSenderCleanupModel.outcomeLine(.init(blocked: [one], failed: []))
        #expect(clean.text == "Blocked a@x.com. 1 thread left the inbox.")
        #expect(!clean.isError)

        let mixed = MacSenderCleanupModel.outcomeLine(.init(blocked: [one, two], failed: ["c@x.com"]))
        #expect(mixed.text == "Blocked 2 senders. 4 threads left the inbox. 2 of their threads could not be archived. Could not block c@x.com. Try again.")
        #expect(mixed.isError)

        let none = MacSenderCleanupModel.outcomeLine(.init(blocked: [], failed: ["c@x.com", "d@x.com"]))
        #expect(none.text == "Could not block 2 senders. Try again.")
        #expect(none.isError)
    }

    @Test
    func eachSenderRowNamesItsMailAndItsLastDate() throws {
        let row = try #require(SenderCleanupRow(json: Self.cleanupRow("news@acme.com", threads: 14, unread: 12)))
        #expect(MacSenderCleanupModel.detailLine(row) == "news@acme.com · 14 threads, 12 unread")

        let read = try #require(SenderCleanupRow(json: Self.cleanupRow("one@acme.com", threads: 1, unread: 0)))
        #expect(MacSenderCleanupModel.detailLine(read) == "one@acme.com · 1 thread")

        var dated = Self.cleanupRow("dated@acme.com")
        if case .object(var fields) = dated {
            fields["lastDate"] = .string("2026-09-03T12:00:00.000Z")
            dated = .object(fields)
        }
        let withDate = try #require(SenderCleanupRow(json: dated))
        #expect(MacSenderCleanupModel.detailLine(withDate).hasPrefix("dated@acme.com · 3 threads, 2 unread · last "))
    }
}
#endif
