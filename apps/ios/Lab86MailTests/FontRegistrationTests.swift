import Testing
import UIKit
@testable import Lab86Mail

// The bundled display faces must register at launch — a silent Font.custom
// fallback to San Francisco reads as "the fonts didn't install".
struct FontRegistrationTests {
    @Test func bundledDisplayFacesResolve() {
        for name in ["Fraunces-SemiBold", "Fraunces-SemiBoldItalic", "Geist-Regular", "Geist-SemiBold"] {
            #expect(UIFont(name: name, size: 17) != nil, "\(name) is not registered")
        }
    }
}
