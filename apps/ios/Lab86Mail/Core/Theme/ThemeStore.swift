import Observation
import SwiftUI
import UIKit

// Native mirror of the desktop ThemePanel: the same OKLCH dual-accent seeds and
// curated palette pairs, derived with the same lightness rules as globals.css
// (light: L 0.45 text-safe; dark: L 0.73 with chroma × 0.78). Like the web,
// theming is per-client state — persisted in UserDefaults, not the server.

struct PalettePreset: Identifiable, Equatable, Sendable {
    let name: String
    let hue: Double
    let chroma: Double
    let hue2: Double
    let chroma2: Double

    var id: String { name }

    // Mirrors lib/theme/palette-presets.ts — keep the two in step.
    static let all: [PalettePreset] = [
        PalettePreset(name: "Forest", hue: 156, chroma: 0.09, hue2: 45, chroma2: 0.11),
        PalettePreset(name: "Ocean", hue: 235, chroma: 0.11, hue2: 70, chroma2: 0.12),
        PalettePreset(name: "Iris", hue: 290, chroma: 0.11, hue2: 110, chroma2: 0.10),
        PalettePreset(name: "Rose", hue: 15, chroma: 0.11, hue2: 195, chroma2: 0.09),
        PalettePreset(name: "Ember", hue: 60, chroma: 0.10, hue2: 265, chroma2: 0.10),
        PalettePreset(name: "Mono", hue: 250, chroma: 0.015, hue2: 40, chroma2: 0.06),
    ]
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
    var appearance: AppearanceChoice { didSet { persist() } }
    var displayType: DisplayTypeChoice { didSet { persist() } }
    var backgroundWash: Double { didSet { persist() } }
    var railWash: Double { didSet { persist() } }
    var grain: Double { didSet { persist() } }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let stored = defaults.dictionary(forKey: Self.defaultsKey) ?? [:]
        accentHue = stored["accentHue"] as? Double ?? 156
        accentChroma = stored["accentChroma"] as? Double ?? 0.09
        accent2Hue = stored["accent2Hue"] as? Double ?? 45
        accent2Chroma = stored["accent2Chroma"] as? Double ?? 0.11
        appearance = AppearanceChoice(rawValue: stored["appearance"] as? String ?? "") ?? .system
        displayType = DisplayTypeChoice(rawValue: stored["displayType"] as? String ?? "") ?? .serif
        backgroundWash = stored["backgroundWash"] as? Double ?? 0.35
        railWash = stored["railWash"] as? Double ?? 0.5
        grain = stored["grain"] as? Double ?? 0
    }

    var selectedPreset: PalettePreset? {
        PalettePreset.all.first {
            abs($0.hue - accentHue) < 0.5 && abs($0.chroma - accentChroma) < 0.005
                && abs($0.hue2 - accent2Hue) < 0.5 && abs($0.chroma2 - accent2Chroma) < 0.005
        }
    }

    func apply(_ preset: PalettePreset) {
        accentHue = preset.hue
        accentChroma = preset.chroma
        accent2Hue = preset.hue2
        accent2Chroma = preset.chroma2
    }

    // Trait-adaptive accents using the same light/dark derivation as the web.
    var accentColor: Color { Self.adaptiveColor(hue: accentHue, chroma: accentChroma) }
    var accent2Color: Color { Self.adaptiveColor(hue: accent2Hue, chroma: accent2Chroma) }

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
    nonisolated static func adaptiveUIColor(hue: Double, chroma: Double) -> UIColor {
        UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? oklch(l: 0.73, c: chroma * 0.78, h: hue)
                : oklch(l: 0.45, c: chroma, h: hue)
        }
    }

    private func persist() {
        defaults.set(
            [
                "accentHue": accentHue,
                "accentChroma": accentChroma,
                "accent2Hue": accent2Hue,
                "accent2Chroma": accent2Chroma,
                "appearance": appearance.rawValue,
                "displayType": displayType.rawValue,
                "backgroundWash": backgroundWash,
                "railWash": railWash,
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
        color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return String(
            format: "#%02x%02x%02x",
            Int(round(red * 255)),
            Int(round(green * 255)),
            Int(round(blue * 255))
        )
    }

    // MARK: - OKLCH → sRGB

    nonisolated static func oklch(l: Double, c: Double, h: Double) -> UIColor {
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

        return UIColor(red: gamma(r), green: gamma(g), blue: gamma(b), alpha: 1)
    }
}
