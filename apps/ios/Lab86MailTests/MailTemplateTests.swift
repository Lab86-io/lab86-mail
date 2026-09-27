import Foundation
import Testing
@testable import Lab86Mail

// Round 2 signatures and saved replies (FEATURES item 11): the request
// bodies, the decoding, the active signature, and the compose form.
@MainActor
struct MailTemplateTests {
    // MARK: - Signatures and saved replies

    @Test
    func signaturesDecodeAndTheActiveOneNeedsTextAndTheSwitch() throws {
        let rows = [
            MailSignature(json: .object([
                "accountId": .string("a1"), "email": .string("Ann@Example.com"), "enabled": .bool(true),
                "text": .string("Ann\nLab86"), "updatedAt": .number(1_788_400_000_000),
            ])),
            MailSignature(json: .object(["accountId": .string("a2"), "enabled": .bool(false), "text": .string("Off")])),
            MailSignature(json: .object(["accountId": .string("a3"), "enabled": .bool(true), "text": .string("   ")])),
            MailSignature(json: .object(["enabled": .bool(true)])),
        ].compactMap { $0 }
        #expect(rows.map(\.accountID) == ["a1", "a2", "a3"])
        #expect(MailSignature.active(in: rows, account: "a1")?.text == "Ann\nLab86")
        #expect(MailSignature.active(in: rows, account: "ann@example.com")?.accountID == "a1")
        #expect(MailSignature.active(in: rows, account: "a2") == nil)
        #expect(MailSignature.active(in: rows, account: "a3") == nil)
        #expect(MailSignature.active(in: rows, account: "missing") == nil)
        #expect(SignaturesSettingsView.stateLine(rows[0]) == "Ann")
        #expect(SignaturesSettingsView.stateLine(rows[1]) == "Off")

        var edited = rows[0]
        edited.text = String(repeating: "x", count: 2_100)
        edited.html = "<b>Ann</b>"
        let arguments = edited.arguments()
        #expect(arguments["account"] == .string("a1"))
        #expect(arguments["enabled"] == .bool(true))
        #expect(arguments["text"]?.stringValue?.count == MailSignature.textLimit)
        #expect(arguments["html"] == .string("<b>Ann</b>"))
        #expect(rows[1].arguments()["html"] == nil)
    }

    @Test
    func savedRepliesInsertAfterTheTextAndSaveWithOrWithoutAnID() throws {
        let reply = try #require(SavedReply(json: .object([
            "id": .string("r1"), "name": .string("Meeting times"),
            "body": .string("\nTuesday or Thursday afternoon works.\nThanks"),
        ])))
        #expect(reply.preview == "Tuesday or Thursday afternoon works.")
        #expect(SavedReply(json: .object(["id": .string("r2"), "name": .string(" ")])) == nil)
        #expect(SavedReply.insert("Body", into: "") == "Body")
        #expect(SavedReply.insert("Body", into: "Hi Ann,  \n\n") == "Hi Ann,\n\nBody")
        #expect(SavedReply.saveArguments(id: nil, name: "  Times ", body: "Text")
            == ["name": .string("Times"), "body": .string("Text")])
        #expect(SavedReply.saveArguments(id: "r1", name: "Times", body: "Text")["id"] == .string("r1"))
        #expect(SavedReplyDraft(id: nil, name: "Times", body: "Text").canSave)
        #expect(!SavedReplyDraft(id: nil, name: " ", body: "Text").canSave)
        #expect(!SavedReplyDraft(id: nil, name: "Times", body: String(repeating: "x", count: 5_001)).canSave)
    }

    @Test
    func theTemplatesClientCallsItsTools() async throws {
        let tools = RecordingTools { name, arguments in
            switch name {
            case "list_signatures":
                return .object(["signatures": .array([.object(["accountId": .string("a1"), "enabled": .bool(true), "text": .string("Ann")])])])
            case "set_signature":
                return .object(["signature": .object([
                    "accountId": .string("a1"), "enabled": arguments["enabled"] ?? .bool(false), "text": arguments["text"] ?? .string(""),
                ])])
            case "list_saved_replies":
                return .object(["replies": .array([.object(["id": .string("r1"), "name": .string("Times"), "body": .string("Tue")])])])
            case "save_saved_reply":
                return .object(["reply": .object(["id": .string("r9"), "name": arguments["name"] ?? .null, "body": arguments["body"] ?? .null])])
            default:
                return .object(["ok": .bool(true)])
            }
        }
        let client = MailTemplatesClient(tools: tools)
        var signature = try #require(try await client.signatures().first)
        signature.enabled = false
        let saved = try await client.save(signature)
        #expect(!saved.enabled)
        #expect(try await client.savedReplies().map(\.name) == ["Times"])
        let reply = try await client.saveReply(id: nil, name: "New", body: "Hello")
        #expect(reply.id == "r9")
        try await client.deleteReply(id: "r9")
        #expect(await tools.arguments(of: "set_signature") == [[
            "account": .string("a1"), "enabled": .bool(false), "text": .string("Ann"),
        ]])
        #expect(await tools.arguments(of: "delete_saved_reply") == [["id": .string("r9")]])
    }

    @Test
    func theComposeFormLeavesTheSignatureOffOnlyWhenAsked() {
        let on = ProductStore.composeFields(
            mode: "new", accountID: "a1", to: "b@example.com", cc: "", bcc: "",
            subject: "Hi", body: "Body", includeSignature: true
        )
        #expect(on["signature"] == nil)
        #expect(on["account"] == "a1")
        let off = ProductStore.composeFields(
            mode: "reply", accountID: "a1", to: "", cc: "", bcc: "",
            subject: "", body: "Body", includeSignature: false
        )
        #expect(off["signature"] == "0")
        #expect(off["mode"] == "reply")
    }
}
