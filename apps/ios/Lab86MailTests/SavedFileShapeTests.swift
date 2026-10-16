import Foundation
import Testing
@testable import Lab86Mail

// A saved file in a chat tool card (docs/albatross-goal-runs.md, G5): the
// `files` row carries a size, and its `open_document` action names the file
// by its path, so native opens the saved-file viewer, not the document
// editor. An Albatross document still opens by id.
@MainActor
struct SavedFileShapeTests {
    private static func decode<Value: Decodable>(_ type: Value.Type, _ json: String) throws -> Value {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    @Test func aFilesRowReadsItsSize() throws {
        let row = try Self.decode(ShapeFileRow.self, """
        {"connectionId":"","fileId":"file_w9","name":"Form W-9.pdf","kind":"PDF","source":"Saved","size":86016,
         "actions":[{"kind":"open_document","documentId":"file_w9","path":"/?view=files&file=file_w9"}]}
        """)
        #expect(row.size == 86_016)
        #expect(row.sizeText?.contains("KB") == true)
        #expect(row.actions == [.openDocument(documentID: "file_w9", path: "/?view=files&file=file_w9")])
        // A size outside the Int range reads as unknown, not as a crash.
        let huge = try Self.decode(ShapeFileRow.self, """
        {"fileId":"file_3","name":"Huge.pdf","size":1e20,"actions":[]}
        """)
        #expect(huge.size == nil)
        let older = try Self.decode(ShapeFileRow.self, """
        {"fileId":"file_1","name":"Lease.pdf","actions":[]}
        """)
        #expect(older.size == nil)
        #expect(older.sizeText == nil)
        let zero = try Self.decode(ShapeFileRow.self, """
        {"fileId":"file_2","name":"Empty.pdf","size":0,"actions":[]}
        """)
        #expect(zero.sizeText == nil)
    }

    @Test func anOpenDocumentActionNamesASavedFileByItsPath() throws {
        let file = try Self.decode(ShapeAction.self, """
        {"kind":"open_document","documentId":"file_w9","path":"/?view=files&file=file_w9"}
        """)
        #expect(file.savedFileID == "file_w9")
        let document = try Self.decode(ShapeAction.self, """
        {"kind":"open_document","documentId":"doc_1","path":"/?view=files&document=doc_1"}
        """)
        #expect(document.savedFileID == nil)
        let bare = try Self.decode(ShapeAction.self, """
        {"kind":"open_document","documentId":"doc_2"}
        """)
        #expect(bare.savedFileID == nil)
        // A link on another site names nothing.
        #expect(ShapeAction.openDocument(documentID: "x", path: "https://other.example/?view=files&file=f").savedFileID == nil)
    }

    @Test func theSavedFileOpensInASheetWithItsName() {
        let navigation = NavigationModel()
        navigation.openSavedFile(id: "file_w9", title: "Form W-9.pdf")
        guard case .savedFile(let target)? = navigation.sheet else {
            Issue.record("expected the saved file sheet, got \(String(describing: navigation.sheet))")
            return
        }
        #expect(target == SavedFileSheetTarget(fileID: "file_w9", title: "Form W-9.pdf"))
        #expect(navigation.sheet?.id == "savedFile:file_w9")
        // Without a name the sheet reads "File"; without an id nothing opens.
        let unnamed = NavigationModel()
        unnamed.openSavedFile(id: "file_2", title: "  ")
        if case .savedFile(let target)? = unnamed.sheet { #expect(target.title == "File") } else { Issue.record("no sheet") }
        let empty = NavigationModel()
        empty.openSavedFile(id: "", title: "x")
        #expect(empty.sheet?.id == nil)
    }
}
