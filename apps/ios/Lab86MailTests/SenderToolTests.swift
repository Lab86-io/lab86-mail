import Foundation
import Testing
@testable import Lab86Mail

// Round 2 unsubscribe, block sender, and sender cleanup (FEATURES item 13):
// the confirmation copy, a request only after the user confirms, and the
// block Undo.
@MainActor
struct SenderToolTests {
    // MARK: - Unsubscribe and block

    @Test
    func theUnsubscribeConfirmationSaysWhereTheRequestGoes() throws {
        let oneClick = try #require(UnsubscribeOptions(json: .object([
            "sender": .string("Acme News"), "senderEmail": .string("news@acme.com"),
            "method": .string("one_click"), "destination": .string("list.acme.com"),
            "url": .string("https://list.acme.com/u?x=1"),
        ])))
        let copy = UnsubscribeConfirmCopy.make(oneClick, mailbox: nil)
        #expect(copy.title == "Unsubscribe from Acme News?")
        #expect(copy.message == "Albatross sends a one-click unsubscribe request to list.acme.com. An unsubscribe cannot be undone.")
        #expect(copy.confirmLabel == "Unsubscribe")
        #expect(copy.action == .unsubscribe)

        let mailto = UnsubscribeOptions(sender: "Acme", method: .mailto, destination: "leave@acme.com")
        #expect(UnsubscribeConfirmCopy.make(mailto, mailbox: "ann@example.com").message
            == "Albatross sends an email from ann@example.com to leave@acme.com that asks to take you off the list. An unsubscribe cannot be undone.")
        #expect(UnsubscribeConfirmCopy.make(mailto, mailbox: nil).confirmLabel == "Send the request")

        let link = UnsubscribeOptions(sender: "Acme", method: .link, destination: "acme.com")
        #expect(UnsubscribeConfirmCopy.make(link, mailbox: nil).action == .openLink)
        #expect(UnsubscribeConfirmCopy.make(link, mailbox: nil).confirmLabel == "Open the page")

        let none = UnsubscribeOptions(sender: "", method: nil, destination: nil)
        let block = UnsubscribeConfirmCopy.make(none, mailbox: nil)
        #expect(block.title == "This sender has no unsubscribe option")
        #expect(block.action == .block)

        // Only a web page may open in the browser.
        let unsafe = try #require(UnsubscribeOptions(json: .object([
            "sender": .string("x"), "method": .string("link"), "url": .string("javascript:alert(1)"),
        ])))
        #expect(unsafe.url == nil)
    }

    @Test
    func theUnsubscribeFlowAsksFirstAndSendsConfirmed() async throws {
        let tools = RecordingTools { name, _ in
            switch name {
            case "get_unsubscribe_options":
                return .object(["sender": .string("Acme"), "method": .string("one_click"), "destination": .string("acme.com")])
            case "unsubscribe_sender":
                return .object(["ok": .bool(true), "status": .string("unsubscribed"), "method": .string("one_click"), "sender": .string("Acme")])
            default:
                return .object([:])
            }
        }
        let model = UnsubscribeFlowModel(client: SenderToolsClient(tools: tools))
        let target = SenderTarget(accountID: "a1", threadID: "t1")
        await model.begin(target)
        guard case .confirm(_, let options, let copy) = model.phase else {
            Issue.record("Expected the confirmation.")
            return
        }
        #expect(options.method == .oneClick)
        #expect(copy.action == .unsubscribe)
        #expect(await tools.arguments(of: "unsubscribe_sender").isEmpty)

        // The confirmation is taken at once, so the alert can close first.
        #expect(model.accept())
        #expect(model.phase == .running(target, options, copy))
        #expect(!model.accept())
        let outcome = try await model.confirm()
        guard case .unsubscribed(let result, let resultTarget) = outcome else {
            Issue.record("Expected an unsubscribe.")
            return
        }
        #expect(result.message == "Unsubscribed from Acme")
        #expect(resultTarget == target)
        #expect(model.phase == .idle)
        #expect(await tools.arguments(of: "unsubscribe_sender") == [[
            "account": .string("a1"), "threadId": .string("t1"),
            "confirmed": .bool(true), "method": .string("one_click"),
        ]])
        // Nothing runs without a confirmation on screen.
        #expect(try await model.confirm() == nil)
    }

    @Test
    func aSenderWithNoUnsubscribeIsBlockedInstead() async throws {
        let tools = RecordingTools { name, _ in
            switch name {
            case "get_unsubscribe_options":
                return .object(["sender": .string("Spam Co"), "method": .null, "methods": .array([])])
            case "block_sender":
                return .object(["ok": .bool(true), "sender": .string("spam@co.com"), "ruleId": .string("rule-1"),
                                "archived": .number(4), "failed": .number(0), "operationId": .string("op-b")])
            default:
                return .object([:])
            }
        }
        let model = UnsubscribeFlowModel(client: SenderToolsClient(tools: tools))
        await model.begin(SenderTarget(accountID: "a1", threadID: "t1"))
        let outcome = try await model.confirm()
        #expect(outcome == .blocked(BlockSenderResult(sender: "spam@co.com", archived: 4, failed: 0, operationID: "op-b")))
        #expect(await tools.arguments(of: "block_sender") == [["account": .string("a1"), "threadId": .string("t1")]])
        #expect(await tools.arguments(of: "unsubscribe_sender").isEmpty)
    }

    @Test
    func blockResultsReadAsOneUndoableChange() {
        let one = BlockSenderResult(sender: "news@acme.com", archived: 1, failed: 0, operationID: "op-1")
        let two = BlockSenderResult(sender: "deals@shop.com", archived: 3, failed: 1, operationID: "op-2")
        #expect(BlockSenderResult.summary([one]) == "Blocked news@acme.com. 1 thread left the inbox")
        #expect(BlockSenderResult.summary([one, two]) == "Blocked 2 senders. 4 threads left the inbox")
        #expect(BlockSenderResult.summary([BlockSenderResult(sender: "x@y.com", archived: 0, failed: 0, operationID: nil)])
            == "Blocked x@y.com")

        let store = ProductStore(tools: RecordingTools(), backend: BackendClient(baseURL: nil))
        store.noteMailOperations([one.operationID, nil, two.operationID], summary: "Blocked 2 senders")
        #expect(store.undoNotice?.operationIDs == ["op-1", "op-2"])
        #expect(store.undoNotice?.kind == .mail)
        store.noteMailOperations([nil], summary: "Nothing")
        #expect(store.undoNotice?.summary == "Blocked 2 senders")
    }

    @Test
    func senderCleanupDecodesAndBatchBlocksShareOneBatch() async throws {
        let tools = RecordingTools { name, arguments in
            switch name {
            case "list_sender_cleanup":
                return .object(["senders": .array([
                    .object([
                        "sender": .string("news@acme.com"), "name": .string("Acme News"), "threads": .number(12),
                        "unread": .number(11), "inInbox": .number(3), "lowValue": .number(9),
                        "lastDate": .number(1_788_400_000_000), "accounts": .array([.string("a1")]),
                        "latest": .object(["accountId": .string("a1"), "threadId": .string("t9"), "subject": .string("Deals")]),
                        "reason": .string("12 threads, 11 unread"),
                    ]),
                    .object(["name": .string("No sender")]),
                ]), "scanned": .number(400)])
            case "block_sender":
                return .object(["sender": arguments["sender"] ?? .null, "archived": .number(2), "failed": .number(0), "operationId": .string("op")])
            default:
                return .object([:])
            }
        }
        let client = SenderToolsClient(tools: tools)
        let result = try await client.cleanup(limit: 500)
        #expect(result.scanned == 400)
        #expect(result.senders.count == 1)
        let row = try #require(result.senders.first)
        #expect(row.name == "Acme News")
        #expect(row.unsubscribeTarget == SenderTarget(accountID: "a1", threadID: "t9", sender: "Acme News"))
        #expect(await tools.arguments(of: "list_sender_cleanup") == [["limit": .number(100)]])

        let batch = SenderToolsClient.newBatchID()
        #expect(batch.hasPrefix("batch_"))
        _ = try await client.block(sender: "news@acme.com", batchID: batch)
        #expect(await tools.arguments(of: "block_sender") == [[
            "sender": .string("news@acme.com"), "operationBatchId": .string(batch),
        ]])
    }
}
