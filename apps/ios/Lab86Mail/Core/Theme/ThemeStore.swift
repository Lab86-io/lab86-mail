import Observation
import SwiftUI
#if canImport(UIKit)
import UIKit
typealias PlatformNativeColor = UIColor
#else
import AppKit
typealias PlatformNativeColor = NSColor
#endif

// Native mirror of the desktop ThemePanel: the palette wheel of
// lib/theme/palette-presets.ts, derived with the same lightness rules as
// globals.css (light: L 0.45 text-safe; dark: L 0.73 with chroma × 0.78).
// Like the web, theming is per-client state — persisted in UserDefaults, not
// the server.

/// The web's palette wheel (lib/theme/palette-presets.ts). The palette is one
/// chord seated on a paper tint: the accent at the wheel angle, the second
/// voice 111 degrees before it, the third voice 94 degrees after it, the paper
/// 61 degrees before it. The wheel has 20 stops. Brilliance scales every
/// chroma and the paper tint together. Keep the numbers in step with the web;
/// PaletteWheelTests compares a few stops to the web's output.
enum PaletteWheel {
    static let stopCount = 20
    static let stepDegrees = 360.0 / Double(stopCount)
    static let minBrilliance = 0.25
    static let maxBrilliance = 1.5
    static let minChroma = 0.012
    static let maxChroma = 0.16
    static let maxSurfaceTint = 0.4
    static let minDepth = 0.4
    static let maxDepth = 1.6

    static let defaultHue = 156.0
    static let defaultChroma = 0.09
    static let defaultChroma2 = 0.11
    static let defaultChroma3 = 0.08
    static let defaultSurfaceTint = 0.22
    static let accent2Offset = -111.0
    static let accent3Offset = 94.0
    static let paperOffset = -61.0

    /// The full palette object at one wheel stop.
    struct Stop: Equatable, Sendable {
        let hue: Double
        let chroma: Double
        let hue2: Double
        let chroma2: Double
        let hue3: Double
        let chroma3: Double
        let paperHue: Double
        let surfaceTint: Double
    }

    static func rotate(_ hue: Double, by delta: Double) -> Double {
        let turned = (hue + delta).truncatingRemainder(dividingBy: 360)
        return (turned + 360).truncatingRemainder(dividingBy: 360)
    }

    static func clampBrilliance(_ value: Double) -> Double {
        guard value.isFinite else { return 1 }
        return min(maxBrilliance, max(minBrilliance, value))
    }

    static func clampChroma(_ value: Double) -> Double {
        min(maxChroma, max(minChroma, value))
    }

    /// Stop 0 is the Forest default.
    static func stop(_ index: Int, brilliance: Double = 1) -> Stop {
        let b = clampBrilliance(brilliance)
        let hue = rotate(defaultHue, by: Double(index) * stepDegrees)
        return Stop(
            hue: hue,
            chroma: clampChroma(defaultChroma * b),
            hue2: rotate(hue, by: accent2Offset),
            chroma2: clampChroma(defaultChroma2 * b),
            hue3: rotate(hue, by: accent3Offset),
            chroma3: clampChroma(defaultChroma3 * b),
            paperHue: rotate(hue, by: paperOffset),
            surfaceTint: min(maxSurfaceTint, defaultSurfaceTint * b)
        )
    }

    /// The stop whose accent hue is nearest to the given hue.
    static func nearestStop(hue: Double) -> Int {
        let turns = rotate(hue, by: -defaultHue) / stepDegrees
        return Int(turns.rounded()) % stopCount
    }

    /// The brilliance axis, read back from the applied accent chroma.
    static func brilliance(fromChroma chroma: Double) -> Double {
        clampBrilliance(chroma / defaultChroma)
    }

    /// The readout under the Depth slider, as on the web.
    static func depthLabel(_ depth: Double) -> String {
        if depth < 0.75 { return "Flat" }
        if depth > 1.25 { return "Deep" }
        return "Standard"
    }

    /// The old "Background wash" (0...1, default 0.35) becomes the web's
    /// paper tint, so the default wash lands on the web's default tint.
    static func migratedSurfaceTint(backgroundWash: Double?) -> Double {
        guard let backgroundWash, backgroundWash.isFinite else { return defaultSurfaceTint }
        return min(maxSurfaceTint, max(0, backgroundWash * (defaultSurfaceTint / 0.35)))
    }
}

enum AppearanceChoice: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: "Automatic"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

enum DisplayTypeChoice: String, CaseIterable, Identifiable {
    case serif
    case sans
    case rounded

    var id: String { rawValue }

    var title: String {
        switch self {
        case .serif: "Fraunces"
        case .sans: "Geist"
        case .rounded: "Rounded"
        }
    }

    var design: Font.Design {
        switch self {
        case .serif: .serif
        case .sans: .default
        case .rounded: .rounded
        }
    }

    // The product's real display faces, bundled with the app. Rounded stays a
    // system voice (SF Rounded); Fraunces and Geist are the same fonts the
    // desktop briefs use.
    func displayFont(size: CGFloat, weight: Font.Weight = .semibold) -> Font {
        switch self {
        case .serif:
            Font.custom("Fraunces-SemiBold", size: size)
        case .sans:
            Font.custom(weight == .regular ? "Geist-Regular" : "Geist-SemiBold", size: size)
        case .rounded:
            Font.system(size: size, weight: weight, design: .rounded)
        }
    }
}

@MainActor
@Observable
final class ThemeStore {
    private static let defaultsKey = "albatrossTheme"

    var accentHue: Double { didSet { persist() } }
    var accentChroma: Double { didSet { persist() } }
    var accent2Hue: Double { didSet { persist() } }
    var accent2Chroma: Double { didSet { persist() } }
    var accent3Hue: Double { didSet { persist() } }
    var accent3Chroma: Double { didSet { persist() } }
    /// The paper seat: the hue of every surface in the depth ladder.
    var paperHue: Double { didSet { persist() } }
    /// How much of the paper hue shows in the surfaces (0...0.4).
    var surfaceTint: Double { didSet { persist() } }
    /// The distance between the rungs of the depth ladder (0.4...1.6).
    var depthSpread: Double { didSet { persist() } }
    var appearance: AppearanceChoice { didSet { persist() } }
    var displayType: DisplayTypeChoice { didSet { persist() } }
    var grain: Double { didSet { persist() } }

    private let defaults: UserDefaults
    private var isApplyingStop = false

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let stored = defaults.dictionary(forKey: Self.defaultsKey) ?? [:]
        let hue = stored["accentHue"] as? Double ?? PaletteWheel.defaultHue
        let chroma = stored["accentChroma"] as? Double ?? PaletteWheel.defaultChroma
        accentHue = hue
        accentChroma = chroma
        accent2Hue = stored["accent2Hue"] as? Double ?? PaletteWheel.rotate(hue, by: PaletteWheel.accent2Offset)
        accent2Chroma = stored["accent2Chroma"] as? Double ?? PaletteWheel.defaultChroma2
        // Values the six old presets never stored derive from the chord, so
        // an old palette keeps its look and gains the web's third voice and
        // paper seat.
        let brilliance = PaletteWheel.brilliance(fromChroma: chroma)
        accent3Hue = stored["accent3Hue"] as? Double ?? PaletteWheel.rotate(hue, by: PaletteWheel.accent3Offset)
        accent3Chroma = stored["accent3Chroma"] as? Double
            ?? PaletteWheel.clampChroma(PaletteWheel.defaultChroma3 * brilliance)
        paperHue = stored["paperHue"] as? Double ?? PaletteWheel.rotate(hue, by: PaletteWheel.paperOffset)
        surfaceTint = stored["surfaceTint"] as? Double
            ?? PaletteWheel.migratedSurfaceTint(backgroundWash: stored["backgroundWash"] as? Double)
        depthSpread = stored["depthSpread"] as? Double ?? 1
        appearance = AppearanceChoice(rawValue: stored["appearance"] as? String ?? "") ?? .system
        displayType = DisplayTypeChoice(rawValue: stored["displayType"] as? String ?? "") ?? .serif
        grain = stored["grain"] as? Double ?? 0
    }

    // MARK: - The wheel

    /// The wheel stop nearest to the accent in use.
    var wheelStop: Int { PaletteWheel.nearestStop(hue: accentHue) }

    /// The brilliance axis, read back from the accent chroma.
    var brilliance: Double { PaletteWheel.brilliance(fromChroma: accentChroma) }

    /// A wheel scrub writes the complete palette object: the chord, the paper
    /// seat, and the tint. One write to the defaults at the end.
    func applyWheel(stop index: Int, brilliance: Double) {
        let stop = PaletteWheel.stop(index, brilliance: brilliance)
        isApplyingStop = true
        accentHue = stop.hue
        accentChroma = stop.chroma
        accent2Hue = stop.hue2
        accent2Chroma = stop.chroma2
        accent3Hue = stop.hue3
        accent3Chroma = stop.chroma3
        paperHue = stop.paperHue
        surfaceTint = stop.surfaceTint
        isApplyingStop = false
        persist()
    }

    // MARK: - Colors

    // Trait-adaptive accents using the same light/dark derivation as the web.
    var accentColor: Color { Self.adaptiveColor(hue: accentHue, chroma: accentChroma) }
    var accent2Color: Color { Self.adaptiveColor(hue: accent2Hue, chroma: accent2Chroma) }
    // The highlight voice (--color-accent-3): badges, lanes, blanks for the user.
    var accent3Color: Color { Self.adaptiveColor(hue: accent3Hue, chroma: accent3Chroma) }

    func accentColor(for scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(Self.oklch(l: 0.73, c: accentChroma * 0.78, h: accentHue))
            : Color(Self.oklch(l: 0.45, c: accentChroma, h: accentHue))
    }

    private nonisolated static func adaptiveColor(hue: Double, chroma: Double) -> Color {
        Color(adaptiveUIColor(hue: hue, chroma: chroma))
    }

    // UIKit resolves dynamic provider colors from SwiftUI's render thread, not
    // necessarily the main actor. Keep the provider and its pure color math
    // explicitly nonisolated so strict-concurrency executor checks do not trap
    // while a view is being rendered.
    nonisolated static func adaptiveUIColor(hue: Double, chroma: Double) -> PlatformNativeColor {
        adaptiveNativeColor { isDark in
            isDark
                ? oklch(l: 0.73, c: chroma * 0.78, h: hue)
                : oklch(l: 0.45, c: chroma, h: hue)
        }
    }

    // One appearance-dynamic color for both platforms: UIKit resolves through
    // trait collections, AppKit through the appearance's best match. Every
    // adaptive surface in the product funnels through here.
    nonisolated static func adaptiveNativeColor(
        _ resolve: @Sendable @escaping (_ isDark: Bool) -> PlatformNativeColor
    ) -> PlatformNativeColor {
        #if canImport(UIKit)
        UIColor { traits in resolve(traits.userInterfaceStyle == .dark) }
        #else
        NSColor(name: nil) { appearance in
            resolve(appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua)
        }
        #endif
    }

    nonisolated static func dynamicColor(
        _ resolve: @Sendable @escaping (_ isDark: Bool) -> PlatformNativeColor
    ) -> Color {
        Color(adaptiveNativeColor(resolve))
    }

    private func persist() {
        if isApplyingStop { return }
        defaults.set(
            [
                "accentHue": accentHue,
                "accentChroma": accentChroma,
                "accent2Hue": accent2Hue,
                "accent2Chroma": accent2Chroma,
                "accent3Hue": accent3Hue,
                "accent3Chroma": accent3Chroma,
                "paperHue": paperHue,
                "surfaceTint": surfaceTint,
                "depthSpread": depthSpread,
                "appearance": appearance.rawValue,
                "displayType": displayType.rawValue,
                "grain": grain,
            ],
            forKey: Self.defaultsKey
        )
    }

    // MARK: - Artifact theming

    // The generated-artifact token contract shared with the desktop
    // (lib/theme/brief-theme.ts): AI-composed documents are built on --brief-*
    // variables. The native host injects the accent family and display face
    // from the user's theme; paper/ink stay with the artifact's own light and
    // dark values, which already track prefers-color-scheme.
    var briefThemeCSS: String {
        let accentLight = Self.hex(l: 0.45, c: accentChroma, h: accentHue)
        let accentDark = Self.hex(l: 0.73, c: accentChroma * 0.78, h: accentHue)
        let accent2Light = Self.hex(l: 0.45, c: accent2Chroma, h: accent2Hue)
        let accent2Dark = Self.hex(l: 0.73, c: accent2Chroma * 0.78, h: accent2Hue)
        let display: String
        switch displayType {
        case .serif: display = "'Fraunces', Georgia, serif"
        case .sans: display = "'Geist', system-ui, sans-serif"
        case .rounded: display = "ui-rounded, 'SF Pro Rounded', system-ui, sans-serif"
        }
        return """
        :root {
            --brief-accent: \(accentLight);
            --brief-accent-soft: \(accentLight)24;
            --brief-accent-2: \(accent2Light);
            --brief-font-display: \(display);
        }
        @media (prefers-color-scheme: dark) {
            :root {
                --brief-accent: \(accentDark);
                --brief-accent-soft: \(accentDark)2e;
                --brief-accent-2: \(accent2Dark);
            }
        }
        /* Manual override: editorial bar/glyph elements always take the second
           accent, even in stored editions that hardcode their colors. */
        .range-fill { background: var(--brief-accent-2) !important; }
        .weather-glyph { color: var(--brief-accent-2) !important; }
        """
    }

    static func hex(l: Double, c: Double, h: Double) -> String {
        let color = oklch(l: l, c: c, h: h)
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        #if canImport(UIKit)
        color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        #else
        // AppKit traps on component reads outside an RGB space; the OKLCH
        // conversion above always produces sRGB, so this is a formality.
        (color.usingColorSpace(.sRGB) ?? color).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        #endif
        return String(
            format: "#%02x%02x%02x",
            Int(round(red * 255)),
            Int(round(green * 255)),
            Int(round(blue * 255))
        )
    }

    // MARK: - OKLCH → sRGB

    nonisolated static func oklch(l: Double, c: Double, h: Double) -> PlatformNativeColor {
        let hRad = h * .pi / 180
        let labA = c * cos(hRad)
        let labB = c * sin(hRad)

        let l1 = l + 0.3963377774 * labA + 0.2158037573 * labB
        let m1 = l - 0.1055613458 * labA - 0.0638541728 * labB
        let s1 = l - 0.0894841775 * labA - 1.2914855480 * labB

        let l3 = l1 * l1 * l1
        let m3 = m1 * m1 * m1
        let s3 = s1 * s1 * s1

        let r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3
        let g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3
        let b = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3

        func gamma(_ value: Double) -> CGFloat {
            let clamped = min(max(value, 0), 1)
            return CGFloat(clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * pow(clamped, 1 / 2.4) - 0.055)
        }

        return PlatformNativeColor(red: gamma(r), green: gamma(g), blue: gamma(b), alpha: 1)
    }
}
