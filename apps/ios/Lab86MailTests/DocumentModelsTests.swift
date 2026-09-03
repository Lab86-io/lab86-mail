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

    @Test @MainActor
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
    func spreadsheetNumbersAndDimensionsNeverTrapOnUntrustedMagnitudes() throws {
        #expect(AlbatrossCellValue.number(1e21).display == "1e+21")
        #expect(AlbatrossCellValue.number(.infinity).display == "inf")

        let oversized = AlbatrossSheetTab(
            json: .object([
                "id": .string("oversized"),
                "name": .string("Oversized"),
                "rowCount": .number(1e21),
                "columnCount": .number(-10),
                "cells": .object([:]),
            ])
        )
        #expect(oversized?.rowCount == 100)
        #expect(oversized?.columnCount == 1)
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

    @Test
    func missingBriefDocumentKindFallsBackToDocButMissingTitleCannotBeApplied() {
        let missingKind = ArtifactReviewRequest(
            action: "create_document",
            payload: BriefActionPayload(
                title: "Vendor comparison",
                instructions: "Compare the options."
            ),
            source: "Morning brief"
        )
        let missingTitle = ArtifactReviewRequest(
            action: "create_document",
            payload: BriefActionPayload(
                kind: "doc",
                instructions: "Draft the memo."
            ),
            source: "Morning brief"
        )

        #expect(missingKind.supported)
        #expect(missingKind.title.contains("editable document"))
        #expect(!missingTitle.supported)
    }


    @Test
    func driveChipsFallBackToTheAccountLabelOnlyWhenAProviderRepeats() throws {
        func connection(_ id: String, provider: String, label: String) throws -> CloudFileConnection {
            let json = JSONValue.object([
                "connectionId": .string(id),
                "provider": .string(provider),
                "accountEmail": .string(label),
                "status": .string("connected"),
            ])
            return try #require(CloudFileConnection(json: json))
        }
        let work = try connection("c1", provider: "google_drive", label: "work@example.com")
        let home = try connection("c2", provider: "google_drive", label: "home@example.com")
        let one = try connection("c3", provider: "onedrive", label: "me@outlook.com")

        #expect(FilesView.chipTitle(for: work, among: [work, one]) == "Google Drive")
        #expect(FilesView.chipTitle(for: one, among: [work, one]) == "OneDrive")
        #expect(FilesView.chipTitle(for: work, among: [work, home, one]) == "work@example.com")
        #expect(FilesView.chipTitle(for: home, among: [work, home, one]) == "home@example.com")
        #expect(FilesView.chipTitle(for: one, among: [work, home, one]) == "OneDrive")
    }
}
