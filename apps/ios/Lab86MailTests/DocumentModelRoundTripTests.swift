import Foundation
import Testing
@testable import Lab86Mail

// Document model fields a save used to drop: run links, block variants and
// list levels; and the Google editability verdict.
struct DocumentModelRoundTripTests {
    @Test
    func aRunKeepsItsLink() throws {
        let json: JSONValue = .object([
            "text": .string("the form"),
            "bold": .bool(true),
            "link": .string("https://example.com/w9.pdf"),
        ])
        let run = try #require(AlbatrossDocRun(json: json))
        #expect(run.link == "https://example.com/w9.pdf")
        #expect(run.json["link"] == .string("https://example.com/w9.pdf"))
        #expect(run.json["bold"] == .bool(true))
        // A blank link is no link.
        let blank = try #require(AlbatrossDocRun(json: .object(["text": .string("x"), "link": .string("  ")])))
        #expect(blank.link == nil)
        #expect(blank.json["link"] == nil)
    }

    @Test
    func aBlockKeepsItsVariantAndListLevel() throws {
        let title: JSONValue = .object([
            "id": .string("b1"),
            "type": .string("heading"),
            "text": .string("Invoice 2211"),
            "level": .number(1),
            "variant": .string("title"),
        ])
        let block = try #require(AlbatrossDocBlock(json: title))
        #expect(block.variant == "title")
        #expect(block.listLevel == nil)
        #expect(block.json["variant"] == .string("title"))
        #expect(block.json["listLevel"] == nil)

        let nested: JSONValue = .object([
            "id": .string("b2"),
            "type": .string("bullet"),
            "text": .string("Sub point"),
            "listLevel": .number(2),
        ])
        let item = try #require(AlbatrossDocBlock(json: nested))
        #expect(item.listLevel == 2)
        #expect(item.json["listLevel"] == .number(2))
        #expect(AlbatrossDocBlock(json: item.json) == item)
    }

    @Test
    func aBlockWithRunsRoundTripsEveryField() throws {
        let json: JSONValue = .object([
            "id": .string("b3"),
            "type": .string("paragraph"),
            "text": .string("See the form"),
            "runs": .array([
                .object(["text": .string("See ")]),
                .object(["text": .string("the form"), "link": .string("mailto:a@example.com")]),
            ]),
        ])
        let block = try #require(AlbatrossDocBlock(json: json))
        #expect(block.runs?.count == 2)
        #expect(block.runs?[1].link == "mailto:a@example.com")
        let again = try #require(AlbatrossDocBlock(json: block.json))
        #expect(again == block)
    }

    @Test
    func theGoogleEditabilityVerdictIsRead() throws {
        let readOnly = try #require(GoogleDocumentEditability(json: .object([
            "editable": .bool(false),
            "reason": .string("This document has open comments."),
        ])))
        #expect(!readOnly.editable)
        #expect(readOnly.reason == "This document has open comments.")
        let editable = try #require(GoogleDocumentEditability(json: .object(["editable": .bool(true)])))
        #expect(editable.editable)
        #expect(editable.reason == nil)
        #expect(GoogleDocumentEditability(json: nil) == nil)
        #expect(GoogleDocumentEditability(json: .object(["reason": .string("x")])) == nil)
    }

    @Test
    func aGoogleDocumentGoesReadOnlyOnlyWhenTheServerSaysSo() throws {
        func document(editability: JSONValue?) -> JSONValue {
            var fields: [String: JSONValue] = [
                "connectionId": .string("conn-1"),
                "fileId": .string("file-1"),
                "mimeType": .string("application/vnd.google-apps.document"),
                "kind": .string("doc"),
                "title": .string("Notes"),
                "model": .object(["kind": .string("doc"), "version": .number(1), "blocks": .array([])]),
            ]
            if let editability { fields["editability"] = editability }
            return .object(fields)
        }
        let preview = try #require(GoogleProviderDocument(json: document(editability: .object([
            "editable": .bool(false), "reason": .string("Preview only."),
        ]))))
        #expect(preview.isReadOnly)
        #expect(preview.editability?.reason == "Preview only.")
        let writable = try #require(GoogleProviderDocument(json: document(editability: .object(["editable": .bool(true)]))))
        #expect(!writable.isReadOnly)
        let unknown = try #require(GoogleProviderDocument(json: document(editability: nil)))
        #expect(!unknown.isReadOnly)
    }
}
