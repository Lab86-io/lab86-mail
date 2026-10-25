import SwiftStreamingMarkdown
import SwiftUI
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

// The reply renderer's style: H1 and H2 in the user's display face, the
// rest of the defaults as they are. The reveal meter owns the motion, so the
// library's own text animation stays off.
enum ChatMarkdownStyle {
    @MainActor private static var cache: [DisplayTypeChoice: MarkdownRenderConfig] = [:]

    @MainActor
    static func config(for choice: DisplayTypeChoice) -> MarkdownRenderConfig {
        if let cached = cache[choice] { return cached }
        let base = MarkdownRenderConfig.defaultHeadingStyle
        let headings = MarkdownRenderConfig.MarkdownHeadingTextStyle(
            h1Font: fonts(choice, size: 28, lineHeight: 34),
            h2Font: fonts(choice, size: 22, lineHeight: 28),
            h3Font: base.h3Font,
            h4Font: base.h4Font,
            h5Font: base.h5Font,
            h6Font: base.h6Font,
            textColor: base.textColor
        )
        let config = MarkdownRenderConfig(shouldAnimateText: false, headingStyle: headings)
        cache[choice] = config
        return config
    }

    private static func fonts(_ choice: DisplayTypeChoice, size: CGFloat, lineHeight: CGFloat) -> TextFonts {
        let font = displayFont(choice, size: size)
        return TextFonts(
            normal: font,
            italic: nil,
            bold: font,
            boldItalic: nil,
            preferredLetterSpacing: nil,
            preferredLineHeight: lineHeight
        )
    }

    #if canImport(UIKit)
    private static func displayFont(_ choice: DisplayTypeChoice, size: CGFloat) -> UIFont {
        let scaled = UIFontMetrics(forTextStyle: .title2).scaledValue(for: size)
        let system = UIFont.systemFont(ofSize: scaled, weight: .semibold)
        switch choice {
        case .serif:
            return UIFont(name: "Fraunces-SemiBold", size: scaled) ?? system
        case .sans:
            return UIFont(name: "Geist-SemiBold", size: scaled) ?? system
        case .rounded:
            guard let descriptor = system.fontDescriptor.withDesign(.rounded) else { return system }
            return UIFont(descriptor: descriptor, size: scaled)
        }
    }
    #else
    private static func displayFont(_ choice: DisplayTypeChoice, size: CGFloat) -> NSFont {
        let system = NSFont.systemFont(ofSize: size, weight: .semibold)
        switch choice {
        case .serif:
            return NSFont(name: "Fraunces-SemiBold", size: size) ?? system
        case .sans:
            return NSFont(name: "Geist-SemiBold", size: size) ?? system
        case .rounded:
            guard let descriptor = system.fontDescriptor.withDesign(.rounded) else { return system }
            return NSFont(descriptor: descriptor, size: size) ?? system
        }
    }
    #endif
}
