import Foundation
import Testing
@testable import Lab86Mail

// A draft's saved files on the wire (docs/albatross-goal-runs.md, G3, and
// the files builder's shapes of 2026-10-15): the `attachments` rows of the
// draft tools, the `draftAttachments` field of a send, the refusals a send
// can answer, the composer row line, and the prefill that carries the rows
// from a draft, a held send, and back.
struct DraftAttachmentTests {
    private static let invoice = DraftAttachment(
        fileID: "file_inv", provider: .office, format: .pdf, name: "Invoice 2026-10.pdf", size: 86_016, contentType: "application/pdf"
    )
    private static let w9 = DraftAttachment(
        fileID: "file_w9", provider: .upload, format: .native, name: "Form W-9.pdf", sealed: true,
        sealedLine: "The tax ID fills in when you send."
    )

    // MARK: - The wire

    @Test func theToolsFieldReplacesRemovesOrKeeps() throws {
        #expect(DraftAttachmentClient.toolsField(nil) == nil)
        let empty = try #require(DraftAttachmentClient.toolsField([]))
        #expect(empty.arrayValue?.isEmpty == true)
        let rows = try #require(DraftAttachmentClient.toolsField([Self.invoice, Self.w9]))
        #expect(rows.arrayValue?.count == 2)
        #expect(rows[0]?["fileId"]?.stringValue == "file_inv")
        #expect(rows[0]?["source"]?.stringValue == "file")
        #expect(rows[1]?["sealed"]?.boolValue == true)
        #expect(rows[0]?["sealed"] == nil)
        // At most ten rows.
        let many = (0..<14).map { DraftAttachment(fileID: "f\($0)", provider: .upload, format: .native, name: "f\($0).pdf") }
        #expect(DraftAttachmentClient.toolsField(many)?.arrayValue?.count == DraftAttachment.limit)
    }

    @Test func theSendFieldIsAJSONArrayOfFourKeys() throws {
        #expect(DraftAttachmentClient.sendField([]) == nil)
        let field = try #require(DraftAttachmentClient.sendField([Self.invoice, Self.w9]))
        let decoded = try JSONDecoder().decode(JSONValue.self, from: Data(field.utf8))
        let rows = try #require(decoded.arrayValue)
        #expect(rows.count == 2)
        #expect(rows[0]["fileId"]?.stringValue == "file_inv")
        #expect(rows[0]["provider"]?.stringValue == "office")
        #expect(rows[0]["format"]?.stringValue == "pdf")
        #expect(rows[0]["name"]?.stringValue == "Invoice 2026-10.pdf")
        #expect(rows[0]["size"] == nil)
        #expect(rows[0]["sealed"] == nil)
        #expect(rows[1]["provider"]?.stringValue == "upload")
    }

    @Test func theRowsOfADraftReadTheirSealedMark() {
        let draft: JSONValue = .object([
            "_id": .string("draft_7"),
            "attachments": .array([
                .object(["source": .string("file"), "fileId": .string("file_w9"), "provider": .string("upload"), "format": .string("native"), "name": .string("Form W-9.pdf"), "sealed": .bool(true)]),
                .object(["source": .string("file"), "fileId": .string("file_inv"), "provider": .string("office"), "format": .string("pdf"), "name": .string("Invoice.pdf")]),
            ]),
        ])
        let rows = DraftAttachmentClient.rows(of: draft)
        #expect(rows.map(\.fileID) == ["file_w9", "file_inv"])
        #expect(rows[0].sealed)
        #expect(!rows[1].sealed)
        #expect(DraftAttachmentClient.rows(of: .object(["_id": .string("draft_8")])).isEmpty)
        #expect(DraftAttachmentClient.bytesPath(fileID: "file_w9") == "/api/files/saved/file_w9")
    }

    // MARK: - The refusals

    @Test func aSendPermissionRefusalNamesTheItemTheFileAndTheDomain() throws {
        let body: JSONValue = .object([
            "ok": .bool(false),
            "code": .string("needs_allow"),
            "grant": .string("send"),
            "sendId": .string("send_1"),
            "domains": .array([.string("harbordesign.example")]),
            "allow": .array([.object([
                "itemId": .string("sec-tax"),
                "itemLabel": .string("Tax ID"),
                "fieldLabels": .array([.string("Number")]),
                "domains": .array([.string("harbordesign.example")]),
            ])]),
            "error": .string("This file needs a send permission."),
        ])
        let refusal = try #require(DraftAttachmentRefusal(status: 409, body: body))
        #expect(refusal.code == .needsAllow)
        #expect(refusal.code.offersWeb)
        #expect(refusal.allow == [SendAllowRequest(itemID: "sec-tax", itemLabel: "Tax ID", fieldLabels: ["Number"], domains: ["harbordesign.example"])])
        #expect(refusal.domains == ["harbordesign.example"])
        #expect(refusal.line(fileName: "Form W-9.pdf") == "Tax ID goes in Form W-9.pdf for mail to harbordesign.example. Allow it on the web, then send again.")
        #expect(refusal.line(fileName: nil) == "Tax ID goes in a file for mail to harbordesign.example. Allow it on the web, then send again.")
        // Without the allow rows the server's sentence stands.
        let bare = try #require(DraftAttachmentRefusal(status: 409, body: .object(["code": .string("needs_allow"), "error": .string("Needs a permission.")])))
        #expect(bare.line(fileName: "x.pdf") == "Needs a permission.")
        #expect(DraftAttachmentRefusal(status: 409, body: .object(["code": .string("needs_allow")]))?.line(fileName: nil) == GoalRunCopy.sendNeedsAllow)
    }

    @Test func theOtherRefusalsShowTheServerSentence() {
        for (raw, code) in [("allow_ended", DraftAttachmentRefusalCode.allowEnded), ("gone", .gone), ("off", .off), ("invalid", .invalid)] {
            let refusal = DraftAttachmentRefusal(status: 409, body: .object(["code": .string(raw), "error": .string("The server says why.")]))
            #expect(refusal?.code == code)
            #expect(refusal?.line(fileName: "x.pdf") == "The server says why.")
            #expect(refusal?.errorDescription == "The server says why.")
            // No sentence from the server: this build's line.
            #expect(DraftAttachmentRefusal(status: 409, body: .object(["code": .string(raw)]))?.line(fileName: nil) == code.fallbackMessage)
        }
        #expect(DraftAttachmentRefusalCode.allowEnded.offersWeb)
        #expect(DraftAttachmentRefusal(status: 409, body: .object(["code": .string("later")]))?.code == .unknown)
        #expect(DraftAttachmentRefusal(status: 409, body: .object(["error": .string("no code")])) == nil)
        #expect(DraftAttachmentRefusal(status: 413, body: nil)?.code == .tooLarge)
        #expect(DraftAttachmentRefusal(status: 400, body: .object(["error": .string("Invalid draft attachments.")]))?.code == .invalid)
        #expect(DraftAttachmentRefusal(status: 400, body: .object(["error": .string("A sealed file cannot go in a scheduled send.")]))?.code == .tooLarge)
        // A From refusal and a plain 400 are not attachment refusals.
        #expect(DraftAttachmentRefusal(status: 400, body: .object(["code": .string("from_not_allowed")])) == nil)
        #expect(DraftAttachmentRefusal(status: 500, body: .object(["code": .string("needs_allow")])) == nil)
        for code in [DraftAttachmentRefusalCode.gone, .off, .invalid, .tooLarge, .unknown] {
            #expect(!code.offersWeb)
            #expect(!code.fallbackMessage.isEmpty)
        }
    }

    @Test func aSecureItemReadsItsMailDomains() throws {
        let item = try #require(SecureItemView(json: .object([
            "id": .string("sec-tax"), "kind": .string("id_number"), "label": .string("Tax ID"),
            "mailDomains": .array([.string("harbordesign.example"), .string("  ")]),
        ])))
        #expect(item.mailDomains == ["harbordesign.example"])
        let older = try #require(SecureItemView(json: .object(["id": .string("sec-2"), "kind": .string("id_number")])))
        #expect(older.mailDomains.isEmpty)
        #expect(SecureDetailsCopy.mailTo("harbordesign.example") == "Mail to harbordesign.example")
    }

    // MARK: - The composer row

    @Test func theComposerLineSaysTheFormatTheSizeAndTheSource() {
        #expect(Self.invoice.composerLine.hasPrefix("PDF · "))
        #expect(Self.invoice.composerLine.hasSuffix(" · From Albatross"))
        #expect(Self.invoice.composerLine.contains("KB"))
        #expect(Self.w9.composerLine == "File · The tax ID fills in when you send.")
        let sealedNoLine = DraftAttachment(fileID: "f", provider: .upload, format: .pdf, name: "x.pdf", sealed: true)
        #expect(sealedNoLine.composerLine == "PDF · A field fills in when you send.")
        let noSize = DraftAttachment(fileID: "f", provider: .albatross, format: .pdf, name: "x.pdf")
        #expect(noSize.composerLine == "PDF · From Albatross")
        // A sealed line marks the row sealed.
        #expect(Self.w9.sealed)
    }

    // MARK: - The prefill and the held send

    @Test func thePrefillCarriesTheRowsThroughAHeldSend() {
        let snapshot = ComposeDraftSnapshot(
            recipient: "priya@harbordesign.example", cc: "", bcc: "", subject: "Invoice 2026-10", body: "Hi Priya,",
            mode: "new", accountID: "acct_1", threadID: nil, messageID: nil, replyAll: false,
            attachmentsKey: nil, draftID: "draft_7", fileAttachments: [Self.invoice, Self.w9]
        )
        #expect(snapshot.composePrefill.fileAttachments.map(\.fileID) == ["file_inv", "file_w9"])
        let older = ComposeDraftSnapshot(
            recipient: "x", cc: "", bcc: "", subject: "", body: "", mode: "new", accountID: "acct_1",
            threadID: nil, messageID: nil, replyAll: false, attachmentsKey: nil, draftID: nil
        )
        #expect(older.composePrefill.fileAttachments.isEmpty)
    }

    @Test func aHeldSendRecordWithoutRowsStillDecodes() throws {
        let json = """
        {"recipient":"x","cc":"","bcc":"","subject":"s","body":"b","mode":"new","accountID":"acct_1","replyAll":false}
        """
        let snapshot = try JSONDecoder().decode(ComposeDraftSnapshot.self, from: Data(json.utf8))
        #expect(snapshot.fileAttachments == nil)
        #expect(snapshot.composePrefill.fileAttachments.isEmpty)
    }

    @Test func theSecureUseOutcomeKnowsADownloadAndASendPermission() {
        #expect(SecureUseOutcome.from("downloaded") == .downloaded)
        #expect(SecureUseOutcome.from("allowed_send_once") == .allowedSendOnce)
        #expect(SecureUseOutcome.from("allowed_send_always") == .allowedSendAlways)
        #expect(SecureUseOutcome.from("allowed_send_later") == .unknown)
        for (outcome, verb) in [(SecureUseOutcome.downloaded, "Downloaded"), (.allowedSendOnce, "Allowed for one send"), (.allowedSendAlways, "Allowed for mail")] {
            let use = SecureUseView(id: "u1", itemID: "sec-tax", field: nil, site: nil, workID: nil, workTitle: nil, outcome: outcome, at: nil)
            let title = SecureUseRow.rows(from: [use]).first?.title ?? ""
            #expect(title.hasPrefix(verb), "\(outcome)")
        }
    }
}
