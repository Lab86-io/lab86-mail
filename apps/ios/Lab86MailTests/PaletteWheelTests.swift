import Foundation
import Testing
@testable import Lab86Mail

// The native palette wheel must give the same palette object as the web's
// lib/theme/palette-presets.ts. The expected numbers below are the web's
// output for the same inputs (bun, 2026-10-24).
struct PaletteWheelTests {
    private func expectStop(
        _ stop: PaletteWheel.Stop,
        hue: Double, chroma: Double,
        hue2: Double, chroma2: Double,
        hue3: Double, chroma3: Double,
        paperHue: Double, surfaceTint: Double
    ) {
        #expect(abs(stop.hue - hue) < 1e-9)
        #expect(abs(stop.chroma - chroma) < 1e-9)
        #expect(abs(stop.hue2 - hue2) < 1e-9)
        #expect(abs(stop.chroma2 - chroma2) < 1e-9)
        #expect(abs(stop.hue3 - hue3) < 1e-9)
        #expect(abs(stop.chroma3 - chroma3) < 1e-9)
        #expect(abs(stop.paperHue - paperHue) < 1e-9)
        #expect(abs(stop.surfaceTint - surfaceTint) < 1e-9)
    }

    @Test
    func stopZeroIsTheForestDefault() {
        expectStop(
            PaletteWheel.stop(0),
            hue: 156, chroma: 0.09, hue2: 45, chroma2: 0.11, hue3: 250, chroma3: 0.08,
            paperHue: 95, surfaceTint: 0.22
        )
    }

    @Test
    func stopsRotateTheWholeChord() {
        expectStop(
            PaletteWheel.stop(5),
            hue: 246, chroma: 0.09, hue2: 135, chroma2: 0.11, hue3: 340, chroma3: 0.08,
            paperHue: 185, surfaceTint: 0.22
        )
        expectStop(
            PaletteWheel.stop(13),
            hue: 30, chroma: 0.09, hue2: 279, chroma2: 0.11, hue3: 124, chroma3: 0.08,
            paperHue: 329, surfaceTint: 0.22
        )
        expectStop(
            PaletteWheel.stop(19),
            hue: 138, chroma: 0.09, hue2: 27, chroma2: 0.11, hue3: 232, chroma3: 0.08,
            paperHue: 77, surfaceTint: 0.22
        )
    }

    @Test
    func brillianceScalesEveryChromaAndTheTint() {
        expectStop(
            PaletteWheel.stop(0, brilliance: 0.25),
            hue: 156, chroma: 0.0225, hue2: 45, chroma2: 0.0275, hue3: 250, chroma3: 0.02,
            paperHue: 95, surfaceTint: 0.055
        )
        // The second voice hits the chroma ceiling at full brilliance.
        expectStop(
            PaletteWheel.stop(7, brilliance: 1.5),
            hue: 282, chroma: 0.135, hue2: 171, chroma2: 0.16, hue3: 16, chroma3: 0.12,
            paperHue: 221, surfaceTint: 0.33
        )
    }

    @Test
    func brillianceClampsLikeTheWeb() {
        #expect(PaletteWheel.clampBrilliance(0) == 0.25)
        #expect(PaletteWheel.clampBrilliance(9) == 1.5)
        #expect(PaletteWheel.clampBrilliance(.nan) == 1)
        #expect(PaletteWheel.brilliance(fromChroma: 0.09) == 1)
        #expect(PaletteWheel.brilliance(fromChroma: 0.015) == 0.25)
        #expect(PaletteWheel.brilliance(fromChroma: 0.16) == 1.5)
    }

    @Test
    func nearestStopMatchesTheWeb() {
        #expect(PaletteWheel.nearestStop(hue: 156) == 0)
        #expect(PaletteWheel.nearestStop(hue: 170) == 1)
        #expect(PaletteWheel.nearestStop(hue: 0) == 11)
        #expect(PaletteWheel.nearestStop(hue: 350) == 11)
        #expect(PaletteWheel.nearestStop(hue: 235) == 4)
        // Half a step before stop 0 rounds up to the wheel's start, not 20.
        #expect(PaletteWheel.nearestStop(hue: 147) == 0)
    }

    @Test
    func depthReadsFlatStandardDeep() {
        #expect(PaletteWheel.depthLabel(0.4) == "Flat")
        #expect(PaletteWheel.depthLabel(1) == "Standard")
        #expect(PaletteWheel.depthLabel(1.6) == "Deep")
    }

    @Test
    func oldBackgroundWashBecomesTheWebTint() {
        #expect(abs(PaletteWheel.migratedSurfaceTint(backgroundWash: 0.35) - 0.22) < 1e-9)
        #expect(PaletteWheel.migratedSurfaceTint(backgroundWash: nil) == 0.22)
        #expect(PaletteWheel.migratedSurfaceTint(backgroundWash: 0) == 0)
        #expect(PaletteWheel.migratedSurfaceTint(backgroundWash: 1) == 0.4)
    }

    @Test
    func wheelGeometryReadsATouchBackToItsStop() {
        for index in 0..<PaletteWheel.stopCount {
            let point = PaletteWheelGeometry.position(of: index)
            let read = PaletteWheelGeometry.read(point: point)
            #expect(read.index == index)
            #expect(abs(read.radius - Double(PaletteWheelGeometry.ringRadius)) < 1e-6)
        }
        // Stop 0 sits at twelve o'clock.
        let top = PaletteWheelGeometry.position(of: 0)
        #expect(abs(top.x - PaletteWheelGeometry.size / 2) < 1e-6)
        #expect(top.y < PaletteWheelGeometry.size / 2)
    }

    @Test
    func pullingOutRaisesBrilliance() {
        let out = PaletteWheelGeometry.brilliance(start: 1, startRadius: 80, radius: 120)
        let inward = PaletteWheelGeometry.brilliance(start: 1, startRadius: 80, radius: 40)
        #expect(abs(out - 1.44) < 1e-9)
        #expect(abs(inward - 0.56) < 1e-9)
        #expect(PaletteWheelGeometry.brilliance(start: 1.4, startRadius: 80, radius: 400) == 1.5)
    }
}

// The surface ladder must follow globals.css for the same tint and depth.
struct SurfaceLadderTests {
    @Test
    func lightLadderFollowsTheWebAtTheDefaultTint() {
        let paper = ThemeStore.ladderComponents(tint: 0.22, depth: 1, rung: .paper, isDark: false)
        #expect(abs(paper.l - (0.977 - 0.22 * 0.012)) < 1e-9)
        #expect(abs(paper.c - (0.005 + 0.22 * 0.022)) < 1e-9)
        let elevated = ThemeStore.ladderComponents(tint: 0.22, depth: 1, rung: .elevated, isDark: false)
        #expect(abs(elevated.l - (0.977 + 0.018 - 0.22 * 0.008)) < 1e-9)
        let subtle = ThemeStore.ladderComponents(tint: 0.22, depth: 1, rung: .subtle, isDark: false)
        #expect(abs(subtle.l - (0.977 - 0.012 - 0.22 * 0.012)) < 1e-9)
        #expect(subtle.l < paper.l)
        #expect(paper.l < elevated.l)
    }

    @Test
    func elevatedNeverPassesTheWebCeiling() {
        let elevated = ThemeStore.ladderComponents(tint: 0, depth: 1.6, rung: .elevated, isDark: false)
        #expect(elevated.l == 0.998)
    }

    @Test
    func darkLadderCompressesDepthOverOne() {
        let standard = ThemeStore.ladderComponents(tint: 0.22, depth: 1, rung: .elevated, isDark: true)
        let deep = ThemeStore.ladderComponents(tint: 0.22, depth: 1.6, rung: .elevated, isDark: true)
        let paper = ThemeStore.ladderComponents(tint: 0.22, depth: 1.6, rung: .paper, isDark: true)
        #expect(abs(standard.l - (0.145 + 0.22 * 0.08 + 0.075)) < 1e-9)
        // 0.6 over the standard spread counts 0.35 of itself in the dark.
        #expect(abs(deep.l - (0.145 + 0.22 * 0.08 + 0.075 * 1.21)) < 1e-9)
        #expect(paper.l < standard.l)
    }
}

// Stored user values keep working: an old palette gains the chord's third
// voice and paper seat, and the old "Background wash" becomes the paper tint.
@MainActor
struct ThemeStoreMigrationTests {
    private func defaults(_ name: String) -> UserDefaults {
        let suite = UserDefaults(suiteName: name)!
        suite.removePersistentDomain(forName: name)
        return suite
    }

    @Test
    func anOldForestPaletteKeepsItsAccentsAndDerivesTheRest() {
        let suite = defaults("theme-migration-forest")
        suite.set(
            [
                "accentHue": 156.0, "accentChroma": 0.09, "accent2Hue": 45.0, "accent2Chroma": 0.11,
                "backgroundWash": 0.35, "railWash": 0.5, "grain": 0.2, "displayType": "sans",
            ],
            forKey: "albatrossTheme"
        )
        let theme = ThemeStore(defaults: suite)
        #expect(theme.accentHue == 156)
        #expect(theme.accent2Hue == 45)
        #expect(theme.accent3Hue == 250)
        #expect(abs(theme.accent3Chroma - 0.08) < 1e-9)
        #expect(theme.paperHue == 95)
        #expect(abs(theme.surfaceTint - 0.22) < 1e-9)
        #expect(theme.depthSpread == 1)
        #expect(theme.grain == 0.2)
        #expect(theme.displayType == .sans)
        #expect(theme.wheelStop == 0)
    }

    @Test
    func anOldOceanPaletteStaysOnItsOwnHue() {
        let suite = defaults("theme-migration-ocean")
        suite.set(
            ["accentHue": 235.0, "accentChroma": 0.11, "accent2Hue": 70.0, "accent2Chroma": 0.12],
            forKey: "albatrossTheme"
        )
        let theme = ThemeStore(defaults: suite)
        #expect(theme.accentHue == 235)
        #expect(theme.accent2Hue == 70)
        #expect(theme.paperHue == 174)
        #expect(theme.accent3Hue == 329)
        #expect(theme.wheelStop == 4)
    }

    @Test
    func aWheelScrubWritesTheWholePaletteOnce() {
        let suite = defaults("theme-migration-scrub")
        let theme = ThemeStore(defaults: suite)
        theme.applyWheel(stop: 5, brilliance: 1)
        let stored = suite.dictionary(forKey: "albatrossTheme") ?? [:]
        #expect(stored["accentHue"] as? Double == 246)
        #expect(stored["accent2Hue"] as? Double == 135)
        #expect(stored["accent3Hue"] as? Double == 340)
        #expect(stored["paperHue"] as? Double == 185)
        #expect(stored["railWash"] == nil)
        #expect(stored["backgroundWash"] == nil)
        let reloaded = ThemeStore(defaults: suite)
        #expect(reloaded.wheelStop == 5)
        #expect(reloaded.brilliance == 1)
    }
}
