import SwiftUI

// Native port of the web app's Arc-style theme system: an accent family
// derived from hue + chroma, an independent background hue/tint wash, and
// auto/light/dark appearance. Persisted via UserDefaults like the web app's
// Zustand + localStorage store.
enum AccentPreset: String, CaseIterable, Identifiable {
    case forest, ocean, iris, rose, ember, mono

    var id: String { rawValue }
    var title: String { rawValue.capitalized }

    var hue: Double {
        switch self {
        case .forest: 156
        case .ocean: 235
        case .iris: 290
        case .rose: 15
        case .ember: 60
        case .mono: 250
        }
    }

    var chroma: Double {
        self == .mono ? 0.02 : 0.11
    }
}

enum Appearance: String, CaseIterable, Identifiable {
    case auto, light, dark
    var id: String { rawValue }
    var title: String { rawValue.capitalized }

    var colorScheme: ColorScheme? {
        switch self {
        case .auto: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

@MainActor
@Observable
final class ThemeManager {
    var appearance: Appearance {
        didSet { defaults.set(appearance.rawValue, forKey: "theme.appearance") }
    }
    var accentHue: Double {
        didSet { defaults.set(accentHue, forKey: "theme.accentHue") }
    }
    var accentChroma: Double {
        didSet { defaults.set(accentChroma, forKey: "theme.accentChroma") }
    }
    var backgroundHue: Double {
        didSet { defaults.set(backgroundHue, forKey: "theme.backgroundHue") }
    }
    var backgroundTint: Double {
        didSet { defaults.set(backgroundTint, forKey: "theme.backgroundTint") }
    }

    private let defaults = UserDefaults.standard

    init() {
        let d = UserDefaults.standard
        appearance = Appearance(rawValue: d.string(forKey: "theme.appearance") ?? "") ?? .auto
        accentHue = d.object(forKey: "theme.accentHue") as? Double ?? AccentPreset.forest.hue
        accentChroma = d.object(forKey: "theme.accentChroma") as? Double ?? AccentPreset.forest.chroma
        backgroundHue = d.object(forKey: "theme.backgroundHue") as? Double ?? AccentPreset.forest.hue
        backgroundTint = d.object(forKey: "theme.backgroundTint") as? Double ?? 0.15
    }

    func apply(_ preset: AccentPreset) {
        accentHue = preset.hue
        accentChroma = preset.chroma
    }

    var accent: Color { OKLCH.color(l: 0.64, c: accentChroma, h: accentHue) }
    var accentSoft: Color { OKLCH.color(l: 0.64, c: accentChroma, h: accentHue, alpha: 0.16) }

    func windowWash(dark: Bool) -> Color {
        OKLCH.color(
            l: dark ? 0.18 : 0.97,
            c: 0.03 * backgroundTint,
            h: backgroundHue,
            alpha: 1
        )
    }
}
