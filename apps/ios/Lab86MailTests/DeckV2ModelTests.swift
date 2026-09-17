import Foundation
import SwiftUI
import Testing
@testable import Lab86Mail

struct DeckV2ModelTests {
    private func referenceDeck() throws -> AlbatrossDeckV2 {
        let raw = try JSONDecoder().decode(JSONValue.self, from: Data(DeckFixtures.referenceEditorial.utf8))
        return try #require(AlbatrossDeckV2(json: raw))
    }

    @Test func editsPatchOnlyTheTouchedElement() throws {
        let deck = try referenceDeck()
        var edited = deck
        edited.activeSlideID = "metrics"
        edited.updateElement("m-title") {
            guard case .text(var text) = $0.content else { return }
            text.text = "Most of the money is at work."
            text.fontSize = 36
            $0.content = .text(text)
            $0.bounds = DeckGeometry.clamp(DeckGeometry.Bounds(x: 8, y: 18, width: 50, height: 18))
        }
        let before = deck.json
        let after = edited.json
        let slideIndex = try #require(deck.slides.firstIndex { $0.id == "metrics" })
        let beforeElements = try #require(before["slides"]?[slideIndex]?["elements"]?.arrayValue)
        let afterElements = try #require(after["slides"]?[slideIndex]?["elements"]?.arrayValue)
        #expect(beforeElements.count == afterElements.count)
        for (index, element) in beforeElements.enumerated() where element["id"]?.stringValue != "m-title" {
            #expect(afterElements[index] == element)
        }
        let changed = try #require(afterElements.first { $0["id"]?.stringValue == "m-title" })
        #expect(changed["text"]?.stringValue == "Most of the money is at work.")
        #expect(changed["fontSize"] == .number(36))
        #expect(changed["x"] == .number(8))
        // Every other slide is byte-for-byte the same.
        for (index, slide) in (before["slides"]?.arrayValue ?? []).enumerated() where index != slideIndex {
            #expect(after["slides"]?[index] == slide)
        }
        #expect(after["theme"] == before["theme"])
        #expect(after["activeSlideId"] == .string("metrics"))
    }

    @Test func elementOperationsKeepOrderAndIdentity() throws {
        var deck = try referenceDeck()
        deck.activeSlideID = "cover"
        let ids = deck.activeSlide.elements.map(\.id)
        deck.moveElement("cover-rule", by: -1)
        #expect(deck.activeSlide.elements.map(\.id) == ["cover-rule", "cover-image"] + ids.dropFirst(2))
        deck.moveElement("cover-rule", by: -1)
        #expect(deck.activeSlide.elements.first?.id == "cover-rule", "Cannot move past the back")
        deck.removeElement("cover-foot")
        #expect(!deck.activeSlide.elements.contains { $0.id == "cover-foot" })
        let added = AlbatrossDeckElementV2(x: 10, y: 10, width: 20, height: 10, content: .text(.init(text: "New")))
        deck.appendElement(added)
        #expect(deck.activeSlide.elements.last?.id == added.id)
        #expect(deck.slides.first { $0.id == "metrics" }?.elements.count == 10, "Other slides are untouched")
    }

    @Test func slideOperationsKeepOneSlideAndFreshIds() throws {
        var deck = try referenceDeck()
        deck.activeSlideID = "cover"
        deck.duplicateSlide("cover")
        #expect(deck.slides.count == 7)
        #expect(deck.slides[1].title == "The Lakeshore Trail")
        #expect(deck.slides[1].id != "cover")
        #expect(Set(deck.slides[1].elements.map(\.id)).isDisjoint(with: deck.slides[0].elements.map(\.id)))
        #expect(deck.activeSlideID == deck.slides[1].id)
        let copyID = deck.slides[1].id
        deck.moveSlide(copyID, by: 1)
        #expect(deck.slides[2].id == copyID)
        deck.deleteSlide(copyID)
        #expect(deck.slides.count == 6)
        #expect(deck.slides.contains { $0.id == deck.activeSlideID })
        let newID = deck.addSlide(after: "close")
        #expect(deck.slides.last?.id == newID)
        #expect(deck.activeSlideID == newID)
        var single = AlbatrossDeckV2(activeSlideID: "only", theme: .editorial, slides: [AlbatrossDeckSlideV2(id: "only", title: "Only")])
        single.deleteSlide("only")
        #expect(single.slides.count == 1)
    }

    @Test func themePresetsReplaceTokensAndKeepUnknownFields() throws {
        var deck = try referenceDeck()
        deck.theme.extra["futureThemeField"] = .bool(true)
        deck.theme.apply(preset: .signal)
        #expect(deck.theme.name == "Signal")
        #expect(deck.theme.colors.accent == "#2F5BFF")
        #expect(deck.theme.colors.background == "#F7F7F4")
        #expect(deck.theme.fonts.display.family == "Geist")
        #expect(deck.theme.json["futureThemeField"] == .bool(true))
        deck.theme.apply(preset: .editorial)
        #expect(deck.theme.colors == AlbatrossDeckTheme.editorial.colors)
        #expect(deck.theme.fonts.mono?.family == "Geist Mono")
    }

    @Test func textDefaultsFollowTheWebRenderer() {
        #expect(AlbatrossDeckElementContent.Text(text: "", role: "title").resolvedSize == 28)
        #expect(AlbatrossDeckElementContent.Text(text: "", role: "number").resolvedSize == 64)
        #expect(AlbatrossDeckElementContent.Text(text: "", role: "subtitle").resolvedSize == 20)
        #expect(AlbatrossDeckElementContent.Text(text: "", role: "kicker").resolvedSize == 12)
        #expect(AlbatrossDeckElementContent.Text(text: "", role: "caption").resolvedSize == 12)
        #expect(AlbatrossDeckElementContent.Text(text: "", role: "body").resolvedSize == 16)
        #expect(AlbatrossDeckElementContent.Text(text: "", role: "title", fontSize: 68).resolvedSize == 68)
        #expect(AlbatrossDeckElementContent.Text(text: "", role: "title").resolvedSlot == "display")
        #expect(AlbatrossDeckElementContent.Text(text: "", role: "number").resolvedSlot == "display")
        #expect(AlbatrossDeckElementContent.Text(text: "", role: "body").resolvedSlot == "body")
        #expect(AlbatrossDeckElementContent.Text(text: "", role: "title").resolvedWeight == 650)
        #expect(AlbatrossDeckElementContent.Text(text: "", role: "body").resolvedWeight == 400)
        #expect(AlbatrossDeckElementContent.Text(text: "", role: "title").resolvedLineHeight == 1.05)
        #expect(AlbatrossDeckElementContent.Text(text: "", role: "body").resolvedLineHeight == 1.3)
        #expect(DeckPalette.design(for: "Fraunces") == .serif)
        #expect(DeckPalette.design(for: "Instrument Serif") == .serif)
        #expect(DeckPalette.design(for: "Georgia") == .serif)
        #expect(DeckPalette.design(for: "Geist Mono") == .monospaced)
        #expect(DeckPalette.design(for: "Consolas") == .monospaced)
        #expect(DeckPalette.design(for: "Geist") == .default)
    }

    @Test func geometryHelpersConvertAndClampLikeTheWebEditor() {
        #expect(DeckGeometry.scale(slideWidth: 480) == 0.5)
        #expect(DeckGeometry.points(68, slideWidth: 1920) == 136)
        #expect(DeckGeometry.percent(96, of: 960) == 10)
        #expect(DeckGeometry.percent(10, of: 0) == 0)
        let rect = DeckGeometry.rect(for: DeckGeometry.Bounds(x: 25, y: 50, width: 50, height: 25), in: CGSize(width: 800, height: 450))
        #expect(rect == CGRect(x: 200, y: 225, width: 400, height: 112.5))

        let clamped = DeckGeometry.clamp(DeckGeometry.Bounds(x: 90, y: -5, width: 30, height: 0.2))
        #expect(clamped == DeckGeometry.Bounds(x: 70, y: 0, width: 30, height: 1))
        let flat = DeckGeometry.clamp(DeckGeometry.Bounds(x: 6, y: 56, width: 88, height: 0), minimumSize: 0)
        #expect(flat.height == 0)
        let broken = DeckGeometry.clamp(DeckGeometry.Bounds(x: .nan, y: .infinity, width: .nan, height: 200))
        #expect(broken == DeckGeometry.Bounds(x: 0, y: 0, width: 1, height: 100))
        #expect(DeckGeometry.clamp(DeckGeometry.Bounds(x: 10.123456, y: 0, width: 10, height: 10)).x == 10.12)

        let moved = DeckGeometry.moved(
            DeckGeometry.Bounds(x: 10, y: 10, width: 20, height: 20),
            by: CGSize(width: 96, height: -450),
            in: CGSize(width: 960, height: 540)
        )
        #expect(moved == DeckGeometry.Bounds(x: 20, y: 0, width: 20, height: 20))

        let box = DeckGeometry.Bounds(x: 10, y: 10, width: 20, height: 20)
        let size = CGSize(width: 1000, height: 1000)
        let bottomTrailing = DeckGeometry.resized(box, corner: .bottomTrailing, by: CGSize(width: 100, height: 50), in: size)
        #expect(bottomTrailing == DeckGeometry.Bounds(x: 10, y: 10, width: 30, height: 25))
        let topLeading = DeckGeometry.resized(box, corner: .topLeading, by: CGSize(width: 50, height: 50), in: size)
        #expect(topLeading == DeckGeometry.Bounds(x: 15, y: 15, width: 15, height: 15))
        let crossed = DeckGeometry.resized(box, corner: .topTrailing, by: CGSize(width: -900, height: 0), in: size)
        #expect(crossed.width == DeckGeometry.minimumSize)
        #expect(crossed.x == 10)
        let outside = DeckGeometry.resized(box, corner: .bottomLeading, by: CGSize(width: -500, height: 2000), in: size)
        #expect(outside == DeckGeometry.Bounds(x: 0, y: 10, width: 30, height: 90))
        let flatLine = DeckGeometry.resized(DeckGeometry.Bounds(x: 6, y: 56, width: 88, height: 0), corner: .bottomTrailing, by: CGSize(width: -100, height: 0), in: size, minimumSize: 0)
        #expect(flatLine == DeckGeometry.Bounds(x: 6, y: 56, width: 78, height: 0))

        #expect(DeckGeometry.clampFontSize(3) == 8)
        #expect(DeckGeometry.clampFontSize(999) == 240)
        #expect(DeckGeometry.clampFontSize(.nan) == 16)
        #expect(DeckGeometry.clampFontSize(13.6) == 14)
    }

    @Test func colorsAndAssetsResolveTheBoundedSubsets() {
        #expect(DeckColor.normalized("#ae4b2b") == "#AE4B2B")
        #expect(DeckColor.normalized("AE4B2B") == "#AE4B2B")
        #expect(DeckColor.normalized("#FFF") == nil)
        #expect(DeckColor.normalized("url(evil)") == nil)
        #expect(DeckColor.normalized(nil) == nil)
        let components = DeckColor.components("#FF8000")
        #expect(components?.red == 1)
        #expect(components?.green == 128.0 / 255)
        #expect(components?.blue == 0)
        let base = URL(string: "https://mail-staging.lab86.io/api")!
        #expect(DeckAssets.url("/art/fallback-3.jpg", base: base)?.absoluteString == "https://mail-staging.lab86.io/art/fallback-3.jpg")
        #expect(DeckAssets.url("art/x.jpg?v=2", base: base)?.absoluteString == "https://mail-staging.lab86.io/art/x.jpg?v=2")
        #expect(DeckAssets.url("https://cdn.example.com/a.png", base: base)?.absoluteString == "https://cdn.example.com/a.png")
        #expect(DeckAssets.url("/art/x.jpg", base: nil) == nil)
        #expect(DeckAssets.url("", base: base) == nil)
        #expect(DeckImageContent.coverSize(aspect: 2, in: CGSize(width: 100, height: 100)) == CGSize(width: 200, height: 100))
        #expect(DeckImageContent.coverSize(aspect: 0.5, in: CGSize(width: 100, height: 100)) == CGSize(width: 100, height: 200))
    }

    @Test func historyIsBoundedAndRedoClearsOnNewEdit() throws {
        let deck = try referenceDeck()
        var history = DeckHistory()
        #expect(!history.canUndo)
        var edited = deck
        edited.activeSlideID = "close"
        history.record(deck)
        #expect(history.undo(current: edited) == deck)
        #expect(history.canRedo)
        #expect(history.redo(current: deck) == edited)
        history.record(edited)
        #expect(!history.canRedo)
        for _ in 0 ..< (DeckHistory.limit + 20) { history.record(deck) }
        #expect(history.undoStack.count == DeckHistory.limit)
    }

    @Test @MainActor func referenceDeckRendersEverySlide() throws {
        let deck = try referenceDeck()
        // Opt in to PNG output by creating the directory before the run.
        let directory = ["NATIVE_DECK_SNAPSHOT_DIR", "TEST_RUNNER_NATIVE_DECK_SNAPSHOT_DIR"]
            .compactMap { ProcessInfo.processInfo.environment[$0] }
            .first ?? DeckSnapshotOutput.directoryIfPresent("/tmp/native-deck")
        for (index, slide) in deck.slides.enumerated() {
            let view = DeckSlideView(slide: slide, theme: deck.theme, showsPlaceholders: false)
                .frame(width: 1280, height: 720)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 1
            #if canImport(UIKit)
            let image = try #require(renderer.uiImage)
            #expect(image.size.width == 1280)
            let data = image.pngData()
            #else
            let image = try #require(renderer.nsImage)
            #expect(image.size.width == 1280)
            let data = renderer.cgImage.flatMap { cgImage -> Data? in
                let bitmap = NSBitmapImageRep(cgImage: cgImage)
                return bitmap.representation(using: .png, properties: [:])
            }
            #endif
            if let directory, let data {
                let path = "\(directory)/slide-\(index + 1)-\(slide.id).png"
                try data.write(to: URL(fileURLWithPath: path))
            }
        }
    }
}

enum DeckSnapshotOutput {
    static func directoryIfPresent(_ path: String) -> String? {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) && isDirectory.boolValue ? path : nil
    }
}
