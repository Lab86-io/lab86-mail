import Foundation
import Testing
@testable import Lab86Mail

struct DocumentModelsTests {
    @Test
    func documentModelRoundTripsAllThreeKinds() throws {
        let doc = AlbatrossDocumentModel.doc(
            blocks: [AlbatrossDocBlock(type: "heading", text: "Launch plan", level: 1)]
        )
        let sheetID = "sheet-1"
        let sheet = AlbatrossDocumentModel.sheet(
            activeSheetID: sheetID,
            sheets: [
                AlbatrossSheetTab(
                    id: sheetID,
                    cells: [
                        "A1": AlbatrossSheetCell(value: .text("Revenue")),
                        "B2": AlbatrossSheetCell(formula: "SUM(B3:B8)"),
                    ]
                ),
            ]
        )
        let slideID = "slide-1"
        let deck = AlbatrossDocumentModel.deck(
            activeSlideID: slideID,
            slides: [
                AlbatrossDeckSlide(
                    id: slideID,
                    title: "Decision",
                    elements: [AlbatrossDeckElement(text: "Decision", role: "title")]
                ),
            ]
        )

        for model in [doc, sheet, deck] {
            #expect(AlbatrossDocumentModel(json: model.json) == model)
        }
    }

    @Test
    func documentRouteBecomesARealNestedFilesDestination() {
        let navigation = NavigationModel()
        navigation.openDocument(id: "document-1")

        #expect(navigation.selectedTab == .files)
        #expect(navigation.documentRoute?.documentID == "document-1")
        #expect(navigation.hasNestedDestination)

        navigation.selectPrimary(.today)
        #expect(navigation.documentRoute == nil)
    }

    @Test
    func briefDocumentCreationIsReviewGatedAndSupported() {
        let request = ArtifactReviewRequest(
            action: "create_document",
            payload: BriefActionPayload(
                title: "Vendor comparison",
                kind: "sheet",
                instructions: "Compare scope, cost, timeline, and risk."
            ),
            source: "Morning brief"
        )

        #expect(request.supported)
        #expect(request.title.contains("editable spreadsheet"))
        #expect(!request.destructive)
    }
}
