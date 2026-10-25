import SwiftUI

// Native mirror of the desktop surface system (globals.css): backgrounds are
// never pure white or pure black — the paper carries a whisper of the accent
// hue so texture and shadow register — and elevation is tone-on-tone with one
// soft layered shadow reserved for genuinely raised layers in light mode.
// Dark mode elevates by lightness delta plus a hairline, not by shadow.

extension ThemeStore {
    // The depth ladder of globals.css: every rung is a distance from the
    // paper, multiplied by the user's depth spread, in the paper's hue. The
    // paper tint lifts the chroma of every rung together. Dark mode compresses
    // a spread over 1 so raised dark surfaces never turn grey.
    // The page field (--color-bg).
    var paperColor: Color {
        Self.ladderColor(hue: paperHue, tint: surfaceTint, depth: depthSpread, rung: .paper)
    }

    // One step up: sheets and real raised layers (--color-bg-elevated).
    var elevatedColor: Color {
        Self.ladderColor(hue: paperHue, tint: surfaceTint, depth: depthSpread, rung: .elevated)
    }

    // One step down: wells, inserts, inset fields (--color-bg-subtle).
    var subtleColor: Color {
        Self.ladderColor(hue: paperHue, tint: surfaceTint, depth: depthSpread, rung: .subtle)
    }

    // The sidebar field, a quiet tone between the paper and the well.
    var railColor: Color {
        Self.ladderColor(hue: paperHue, tint: surfaceTint, depth: depthSpread, rung: .rail)
    }

    // Accent-soft wash for selected/quarantined surfaces (summary cards,
    // selected pills) — the desktop --accent-soft register.
    var accentSoftColor: Color {
        let hue = accentHue
        let chroma = accentChroma
        return Self.dynamicColor { isDark in
            isDark
                ? Self.oklch(l: 0.73, c: chroma * 0.78, h: hue).withAlphaComponent(0.16)
                : Self.oklch(l: 0.45, c: chroma, h: hue).withAlphaComponent(0.10)
        }
    }

    var hairlineColor: Color { Color.primary.opacity(0.08) }

    enum LadderRung: Sendable {
        case paper
        case elevated
        case subtle
        case rail
    }

    /// The lightness and chroma of one rung, as globals.css computes them.
    /// Pure, so SurfaceLadderTests can hold it to the web's numbers.
    nonisolated static func ladderComponents(
        tint: Double,
        depth: Double,
        rung: LadderRung,
        isDark: Bool
    ) -> (l: Double, c: Double) {
        if isDark {
            let spread = min(1, depth) + max(0, depth - 1) * 0.35
            let paperL = 0.145 + tint * 0.08
            switch rung {
            case .paper: return (paperL, 0.006 + tint * 0.04)
            case .elevated: return (paperL + 0.075 * spread, tint * 0.032)
            case .subtle: return (paperL + 0.033 * spread, tint * 0.034)
            case .rail: return (paperL + 0.016 * spread, 0.004 + tint * 0.036)
            }
        }
        switch rung {
        case .paper: return (0.977 - tint * 0.012, 0.005 + tint * 0.022)
        case .elevated: return (min(0.998, 0.977 + 0.018 * depth - tint * 0.008), tint * 0.014)
        case .subtle: return (0.977 - 0.012 * depth - tint * 0.012, 0.006 + tint * 0.024)
        case .rail: return (0.977 - 0.006 * depth - tint * 0.012, 0.006 + tint * 0.024)
        }
    }

    // The provider closure captures plain numbers, never the store: UIKit
    // resolves it off the main actor while a view renders.
    private nonisolated static func ladderColor(hue: Double, tint: Double, depth: Double, rung: LadderRung) -> Color {
        dynamicColor { isDark in
            let parts = ladderComponents(tint: tint, depth: depth, rung: rung, isDark: isDark)
            return oklch(l: parts.l, c: parts.c, h: hue)
        }
    }

    // MARK: - Avatar palette

    // Five hue-rotated companions of the live accent (--color-avatar-1..5):
    // every identity mark in the product shares one colour family, and the
    // family re-derives when the user changes palettes.
    static let avatarHueRotations: [Double] = [0, 48, 110, 205, 285]

    func avatarColor(seed: String) -> Color {
        let rotation = Self.avatarHueRotations[
            AreaMonogramPalette.index(for: seed, count: Self.avatarHueRotations.count)
        ]
        let hue = (accentHue + rotation).truncatingRemainder(dividingBy: 360)
        let chroma = max(accentChroma, 0.07)
        return Self.dynamicColor { isDark in
            isDark
                ? Self.oklch(l: 0.68, c: chroma * 0.85, h: hue)
                : Self.oklch(l: 0.58, c: chroma, h: hue)
        }
    }
}

struct GrainOverlay: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let amount: Double

    var body: some View {
        if amount > 0, !reduceTransparency {
            Canvas(renderer: Self.renderer(amount: amount))
                .blendMode(.overlay)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }

    // Built outside the main actor. A renderer written inline in this view
    // would inherit main-actor isolation, and Swift traps if SwiftUI ever
    // draws it on its render thread, which is how a colour provider once
    // crashed the app.
    nonisolated private static func renderer(amount: Double) -> (inout GraphicsContext, CGSize) -> Void {
        { context, size in
            let spacing: CGFloat = 5
            let columns = Int(size.width / spacing) + 1
            let rows = Int(size.height / spacing) + 1
            let ink = Color.primary.opacity(0.055 * amount)
            for row in 0..<rows {
                for column in 0..<columns {
                    let hash = (row &* 73_856_093) ^ (column &* 19_349_663)
                    guard hash % 7 == 0 else { continue }
                    let x = CGFloat(column) * spacing + CGFloat(abs(hash % 3))
                    let y = CGFloat(row) * spacing + CGFloat(abs((hash / 3) % 3))
                    let rect = CGRect(x: x, y: y, width: 0.7, height: 0.7)
                    context.fill(Path(ellipseIn: rect), with: .color(ink))
                }
            }
        }
    }
}

extension DisplayTypeChoice {
    // The italic display voice used for datelines and machine-text labels
    // ("Summary") — desktop sets these in the display face's italic.
    func displayItalicFont(size: CGFloat) -> Font {
        switch self {
        case .serif:
            Font.custom("Fraunces-SemiBoldItalic", size: size)
        case .sans:
            Font.custom("Geist-SemiBold", size: size).italic()
        case .rounded:
            Font.system(size: size, weight: .semibold, design: .rounded).italic()
        }
    }
}

// MARK: - Surface card

// One elevation step above the paper: elevated fill, hairline stroke, and — in
// light mode only — a layered key + ambient shadow (--shadow-soft). Never nest
// a second raised card inside one.
private struct SurfaceCardModifier: ViewModifier {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.colorScheme) private var colorScheme
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        content.modifier(ThemedSurfaceCardModifier(theme: environment.theme, cornerRadius: cornerRadius))
    }
}

private struct ThemedSurfaceCardModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    let theme: ThemeStore
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        content
            .background(
                theme.elevatedColor,
                in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(theme.hairlineColor, lineWidth: 1)
            }
            .shadow(
                color: .black.opacity(colorScheme == .dark ? 0 : 0.05),
                radius: 1, y: 1
            )
            .shadow(
                color: .black.opacity(colorScheme == .dark ? 0 : 0.06),
                radius: 14, y: 8
            )
    }
}

extension View {
    func surfaceCard(cornerRadius: CGFloat = 18) -> some View {
        modifier(SurfaceCardModifier(cornerRadius: cornerRadius))
    }

    func surfaceCard(theme: ThemeStore, cornerRadius: CGFloat = 18) -> some View {
        modifier(ThemedSurfaceCardModifier(theme: theme, cornerRadius: cornerRadius))
    }
}

// MARK: - Inset panel

// One step down into the paper: subtle fill and a hairline, no shadow. The
// evidence inserts of a chat transcript (tool cards, questions, approvals)
// use it, so the user's words and the raised sheets keep their own levels.
private struct InsetPanelModifier: ViewModifier {
    @Environment(AppEnvironment.self) private var environment
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        content.modifier(ThemedInsetPanelModifier(theme: environment.theme, cornerRadius: cornerRadius))
    }
}

private struct ThemedInsetPanelModifier: ViewModifier {
    let theme: ThemeStore
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        content
            .background(
                theme.subtleColor,
                in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(theme.hairlineColor, lineWidth: 1)
            }
    }
}

extension View {
    func insetPanel(cornerRadius: CGFloat = 12) -> some View {
        modifier(InsetPanelModifier(cornerRadius: cornerRadius))
    }

    func insetPanel(theme: ThemeStore, cornerRadius: CGFloat = 12) -> some View {
        modifier(ThemedInsetPanelModifier(theme: theme, cornerRadius: cornerRadius))
    }
}

// MARK: - Initials avatar

// The product identity mark for senders and contacts: accent-family colour,
// display-face initials — the same grammar as the desktop avatar primitive.
struct InitialsAvatar: View {
    @Environment(AppEnvironment.self) private var environment
    let name: String
    var seed: String?
    var size: CGFloat = 36

    var body: some View {
        ThemedInitialsAvatar(theme: environment.theme, name: name, seed: seed, size: size)
    }
}

// The same mark for views that take the theme as a dependency (the recipient
// field and the inline draft), so they render without an app environment.
struct ThemedInitialsAvatar: View {
    let theme: ThemeStore
    let name: String
    var seed: String?
    var size: CGFloat = 36

    var body: some View {
        Circle()
            .fill(theme.avatarColor(seed: seed ?? name).gradient)
            .frame(width: size, height: size)
            .overlay(
                // A custom font scales with Dynamic Type, so at the largest
                // sizes the initials outgrow the circle and read "…" (D3).
                // They shrink to fit the circle instead.
                Text(initials)
                    .font(theme.displayType.displayFont(size: size * 0.4))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.3)
                    .padding(size * 0.1)
            )
            .accessibilityHidden(true)
    }

    private var initials: String { SenderInitials.make(from: name) }
}

enum SenderInitials {
    // Senders arrive as "Display Name", "\"Quoted Name\"", or bare addresses;
    // an address's initial is its mailbox letter, never "<" or punctuation.
    static func make(from name: String) -> String {
        let cleaned = name
            .replacingOccurrences(of: "\"", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.contains("@"), !cleaned.contains(" ") {
            let mailbox = cleaned.drop(while: { !$0.isLetter && !$0.isNumber })
            return mailbox.first.map { String($0).uppercased() } ?? "•"
        }
        let words = cleaned.split(separator: " ").prefix(2)
        let letters = words.compactMap { word in
            word.first(where: \.isLetter)
        }.map(String.init).joined()
        return letters.isEmpty ? "•" : letters.uppercased()
    }
}
