import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// Page titles are set in the display face the user chose in Settings,
// Appearance: the same face as the sidebar title and the brief masthead. One
// helper for custom page headers and one for the system navigation bar, so a
// page title looks the same whichever of the two draws it.

/// A page title drawn by the page itself, for pages that build their own
/// header instead of a navigation bar large title.
struct PageTitle: View {
    @Environment(AppEnvironment.self) private var environment
    @ScaledMetric(relativeTo: .largeTitle) private var size: CGFloat = 34
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(environment.theme.displayType.displayFont(size: size))
            .foregroundStyle(.primary)
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }
}

#if os(iOS)
/// The large titles of every navigation bar. A navigation bar reads its
/// appearance when it is made, so a change in Settings shows on the next page
/// that opens.
@MainActor
enum NavigationTitleAppearance {
    static func apply(_ choice: DisplayTypeChoice) {
        let bar = UINavigationBar.appearance()
        var attributes = bar.largeTitleTextAttributes ?? [:]
        attributes[.font] = largeTitleFont(choice)
        bar.largeTitleTextAttributes = attributes
    }

    static func largeTitleFont(_ choice: DisplayTypeChoice) -> UIFont {
        let size: CGFloat = 34
        let face: UIFont = switch choice {
        case .serif:
            UIFont(name: "Fraunces-SemiBold", size: size) ?? .systemFont(ofSize: size, weight: .bold)
        case .sans:
            UIFont(name: "Geist-SemiBold", size: size) ?? .systemFont(ofSize: size, weight: .bold)
        case .rounded:
            roundedFont(size: size)
        }
        return UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: face)
    }

    private static func roundedFont(size: CGFloat) -> UIFont {
        let system = UIFont.systemFont(ofSize: size, weight: .bold)
        guard let rounded = system.fontDescriptor.withDesign(.rounded) else { return system }
        return UIFont(descriptor: rounded, size: size)
    }
}
#endif
