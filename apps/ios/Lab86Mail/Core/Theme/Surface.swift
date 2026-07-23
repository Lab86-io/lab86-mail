import SwiftUI
import UIKit

// Native mirror of the desktop surface system (globals.css): backgrounds are
// never pure white or pure black — the paper carries a whisper of the accent
// hue so texture and shadow register — and elevation is tone-on-tone with one
// soft layered shadow reserved for genuinely raised layers in light mode.
// Dark mode elevates by lightness delta plus a hairline, not by shadow.

extension ThemeStore {
    // The page field. Light ≈ oklch(0.977) / dark ≈ oklch(0.145), same floors
    // as --color-bg on desktop.
    var paperColor: Color {
        Self.adaptiveSurface(
            hue: accentHue,
            lightL: 0.977,
            lightC: 0.002 + 0.008 * backgroundWash,
            darkL: 0.145,
            darkC: 0.003 + 0.009 * backgroundWash
        )
    }

    // One step up: cards, message articles, composer chrome (--color-bg-elevated).
    var elevatedColor: Color {
        Self.adaptiveSurface(hue: accentHue, lightL: 0.995, lightC: 0.002, darkL: 0.205, darkC: 0.006)
    }

    // One step down: wells, inset fields, collapsed rows (--color-bg-subtle).
    var subtleColor: Color {
        Self.adaptiveSurface(hue: accentHue, lightL: 0.958, lightC: 0.004, darkL: 0.175, darkC: 0.006)
    }

    var railColor: Color {
        Self.adaptiveSurface(
            hue: accent2Hue,
            lightL: 0.965,
            lightC: 0.002 + 0.009 * railWash,
            darkL: 0.165,
            darkC: 0.003 + 0.01 * railWash
        )
    }

    // Accent-soft wash for selected/quarantined surfaces (summary cards,
    // selected pills) — the desktop --accent-soft register.
    var accentSoftColor: Color {
        let hue = accentHue
        let chroma = accentChroma
        return Color(UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? Self.oklch(l: 0.73, c: chroma * 0.78, h: hue).withAlphaComponent(0.16)
                : Self.oklch(l: 0.45, c: chroma, h: hue).withAlphaComponent(0.10)
        })
    }

    var hairlineColor: Color { Color.primary.opacity(0.08) }

    private static func adaptiveSurface(
        hue: Double,
        lightL: Double,
        lightC: Double,
        darkL: Double,
        darkC: Double
    ) -> Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? oklch(l: darkL, c: darkC, h: hue)
                : oklch(l: lightL, c: lightC, h: hue)
        })
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
        return Color(UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? Self.oklch(l: 0.68, c: chroma * 0.85, h: hue)
                : Self.oklch(l: 0.58, c: chroma, h: hue)
        })
    }
}

struct GrainOverlay: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let amount: Double

    var body: some View {
        if amount > 0, !reduceTransparency {
            Canvas { context, size in
                let spacing: CGFloat = 5
                let columns = Int(size.width / spacing) + 1
                let rows = Int(size.height / spacing) + 1
                for row in 0..<rows {
                    for column in 0..<columns {
                        let hash = (row &* 73_856_093) ^ (column &* 19_349_663)
                        guard hash % 7 == 0 else { continue }
                        let x = CGFloat(column) * spacing + CGFloat(abs(hash % 3))
                        let y = CGFloat(row) * spacing + CGFloat(abs((hash / 3) % 3))
                        let rect = CGRect(x: x, y: y, width: 0.7, height: 0.7)
                        context.fill(Path(ellipseIn: rect), with: .color(.primary.opacity(0.055 * amount)))
                    }
                }
            }
            .blendMode(.overlay)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
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
        content
            .background(
                environment.theme.elevatedColor,
                in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(environment.theme.hairlineColor, lineWidth: 1)
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
        Circle()
            .fill(environment.theme.avatarColor(seed: seed ?? name).gradient)
            .frame(width: size, height: size)
            .overlay(
                Text(initials)
                    .font(environment.theme.displayType.displayFont(size: size * 0.4))
                    .foregroundStyle(.white)
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
