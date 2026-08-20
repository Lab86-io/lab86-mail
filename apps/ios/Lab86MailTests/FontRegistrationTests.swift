import Testing
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif
@testable import Lab86Mail

// The bundled display faces must register at launch — a silent Font.custom
// fallback to San Francisco reads as "the fonts didn't install".
struct FontRegistrationTests {
    @Test func bundledDisplayFacesResolve() {
        for name in ["Fraunces-SemiBold", "Fraunces-SemiBoldItalic", "Geist-Regular", "Geist-SemiBold"] {
            #if canImport(UIKit)
            #expect(UIFont(name: name, size: 17) != nil, "\(name) is not registered")
            #else
            #expect(NSFont(name: name, size: 17) != nil, "\(name) is not registered")
            #endif
        }
    }
}
