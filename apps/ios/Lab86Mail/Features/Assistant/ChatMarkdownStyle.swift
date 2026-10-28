import SwiftStreamingMarkdown
import SwiftUI
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

// The reply renderer's style: H1 and H2 in the user's display face, the
// rest of the defaults as they are. The reveal meter owns the motion, so the
// library's own text animation stays off. The headings scale with the text
// size the view reads, so the cache keys on the face and that size.
enum ChatMarkdownStyle {
    private struct Key: Hashable {
        let choice: DisplayTypeChoice
        let size: DynamicTypeSize
    }

    @MainActor private static var cache: [Key: MarkdownRenderConfig] = [:]

    @MainActor
    static func config(for choice: DisplayTypeChoice, dynamicTypeSize: DynamicTypeSize = .large) -> MarkdownRenderConfig {
        let key = Key(choice: choice, size: dynamicTypeSize)
        if let cached = cache[key] { return cached }
        let base = MarkdownRenderConfig.defaultHeadingStyle
        let headings = MarkdownRenderConfig.MarkdownHeadingTextStyle(
            h1Font: fonts(choice, size: 28, lineHeight: 34, dynamicTypeSize: dynamicTypeSize),
            h2Font: fonts(choice, size: 22, lineHeight: 28, dynamicTypeSize: dynamicTypeSize),
            h3Font: base.h3Font,
            h4Font: base.h4Font,
            h5Font: base.h5Font,
            h6Font: base.h6Font,
            textColor: base.textColor
        )
        let config = MarkdownRenderConfig(shouldAnimateText: false, headingStyle: headings)
        cache[key] = config
        return config
    }

    private static func fonts(
        _ choice: DisplayTypeChoice,
        size: CGFloat,
        lineHeight: CGFloat,
        dynamicTypeSize: DynamicTypeSize
    ) -> TextFonts {
        let scale = headingScale(for: dynamicTypeSize, size: size)
        let font = displayFont(choice, size: size * scale)
        return TextFonts(
            normal: font,
            italic: nil,
            bold: font,
            boldItalic: nil,
            preferredLetterSpacing: nil,
            preferredLineHeight: lineHeight * scale
        )
    }

    /// The factor the title style grows by at a text size, 1 at the default.
    static func headingScale(for dynamicTypeSize: DynamicTypeSize, size: CGFloat) -> CGFloat {
        #if canImport(UIKit)
        let traits = UITraitCollection(preferredContentSizeCategory: contentSizeCategory(for: dynamicTypeSize))
        let scaled = UIFontMetrics(forTextStyle: .title2).scaledValue(for: size, compatibleWith: traits)
        return size > 0 ? scaled / size : 1
        #else
        return 1
        #endif
    }

    #if canImport(UIKit)
    static func contentSizeCategory(for size: DynamicTypeSize) -> UIContentSizeCategory {
        switch size {
        case .xSmall: .extraSmall
        case .small: .small
        case .medium: .medium
        case .large: .large
        case .xLarge: .extraLarge
        case .xxLarge: .extraExtraLarge
        case .xxxLarge: .extraExtraExtraLarge
        case .accessibility1: .accessibilityMedium
        case .accessibility2: .accessibilityLarge
        case .accessibility3: .accessibilityExtraLarge
        case .accessibility4: .accessibilityExtraExtraLarge
        case .accessibility5: .accessibilityExtraExtraExtraLarge
        @unknown default: .large
        }
    }

    private static func displayFont(_ choice: DisplayTypeChoice, size: CGFloat) -> UIFont {
        let system = UIFont.systemFont(ofSize: size, weight: .semibold)
        switch choice {
        case .serif:
            return UIFont(name: "Fraunces-SemiBold", size: size) ?? system
        case .sans:
            return UIFont(name: "Geist-SemiBold", size: size) ?? system
        case .rounded:
            guard let descriptor = system.fontDescriptor.withDesign(.rounded) else { return system }
            return UIFont(descriptor: descriptor, size: size)
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
