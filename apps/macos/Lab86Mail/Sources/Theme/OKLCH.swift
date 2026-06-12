import SwiftUI

// OKLCH → sRGB, so the native theme derives accents exactly the way the web
// app's CSS `oklch()` variables do.
enum OKLCH {
    static func color(l: Double, c: Double, h: Double, alpha: Double = 1) -> Color {
        let rgb = srgb(l: l, c: c, h: h)
        return Color(.sRGB, red: rgb.0, green: rgb.1, blue: rgb.2, opacity: alpha)
    }

    static func srgb(l: Double, c: Double, h: Double) -> (Double, Double, Double) {
        let hr = h * .pi / 180
        let a = c * cos(hr)
        let b = c * sin(hr)

        let l_ = l + 0.3963377774 * a + 0.2158037573 * b
        let m_ = l - 0.1055613458 * a - 0.0638541728 * b
        let s_ = l - 0.0894841775 * a - 1.2914855480 * b

        let lc = l_ * l_ * l_
        let mc = m_ * m_ * m_
        let sc = s_ * s_ * s_

        let r = 4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc
        let g = -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc
        let bl = -0.0041960863 * lc - 0.7034186147 * mc + 1.7076147010 * sc

        return (encode(r), encode(g), encode(bl))
    }

    private static func encode(_ linear: Double) -> Double {
        let v = max(0, min(1, linear))
        return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1 / 2.4) - 0.055
    }
}
