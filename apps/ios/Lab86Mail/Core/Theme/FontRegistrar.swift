import CoreText
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

// UIAppFonts registration is declarative and can silently miss (bundle-path
// quirks, plist merge issues) and does not exist at all on macOS; this
// registers the bundled faces explicitly at launch when they haven't resolved,
// so Font.custom never falls back to San Francisco unnoticed.
enum FontRegistrar {
    static let bundledFaces = [
        "Fraunces-SemiBold",
        "Fraunces-SemiBoldItalic",
        "Geist-Regular",
        "Geist-SemiBold",
    ]

    static func registerBundledFonts() {
        for name in bundledFaces {
            guard !faceIsResolvable(name) else { continue }
            guard let url = Bundle.main.url(forResource: name, withExtension: "ttf") else {
                assertionFailure("Bundled font missing from app bundle: \(name)")
                continue
            }
            var error: Unmanaged<CFError>?
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error)
        }
    }

    private static func faceIsResolvable(_ name: String) -> Bool {
        #if canImport(UIKit)
        UIFont(name: name, size: 12) != nil
        #else
        NSFont(name: name, size: 12) != nil
        #endif
    }
}
