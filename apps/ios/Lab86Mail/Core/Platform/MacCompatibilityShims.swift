#if os(macOS)
import AppKit
import SwiftUI

// iOS-only SwiftUI API, re-declared with the same spelling as no-ops or Mac
// mappings so shared feature code compiles unchanged. Each shim is deliberate:
// phone chrome (title display modes, software-keyboard hints, page dots) has
// no Mac meaning, while toolbar placements and system colors map onto real
// AppKit equivalents.

enum NavigationBarTitleDisplayModeShim {
    case automatic, inline, large
}

extension View {
    func navigationBarTitleDisplayMode(_ mode: NavigationBarTitleDisplayModeShim) -> some View {
        self
    }
}

enum KeyboardTypeShim {
    case `default`, emailAddress, URL, numberPad, decimalPad, numbersAndPunctuation, webSearch
}

extension View {
    func keyboardType(_ type: KeyboardTypeShim) -> some View {
        self
    }
}

enum TextInputAutocapitalizationShim {
    case never, characters, words, sentences
}

extension View {
    func textInputAutocapitalization(_ value: TextInputAutocapitalizationShim?) -> some View {
        self
    }
}

// TabViews styled .page are swipe pagers on the phone; the Mac renders the
// selected page without dots. Callers keep their selection bindings.
struct PageTabViewStyleShim {
    enum IndexDisplayMode {
        case automatic, always, never
    }

    static var page: PageTabViewStyleShim { .init() }

    static func page(indexDisplayMode: IndexDisplayMode) -> PageTabViewStyleShim { .init() }
}

extension View {
    func tabViewStyle(_ shim: PageTabViewStyleShim) -> some View {
        self
    }
}

// WKWebView (and other dual-framework views) are NSViews on the Mac. This
// re-spelling of UIViewRepresentable lets shared wrappers keep their
// makeUIView/updateUIView bodies; the forwarding below adapts them to the
// AppKit representable protocol.
@MainActor
protocol UIViewRepresentable: NSViewRepresentable where NSViewType == UIViewType {
    associatedtype UIViewType: NSView
    func makeUIView(context: Context) -> UIViewType
    func updateUIView(_ view: UIViewType, context: Context)
    static func dismantleUIView(_ view: UIViewType, coordinator: Coordinator)
}

extension UIViewRepresentable {
    func makeNSView(context: Context) -> UIViewType {
        makeUIView(context: context)
    }

    func updateNSView(_ view: UIViewType, context: Context) {
        updateUIView(view, context: context)
    }

    static func dismantleUIView(_ view: UIViewType, coordinator: Coordinator) {}

    static func dismantleNSView(_ view: UIViewType, coordinator: Coordinator) {
        dismantleUIView(view, coordinator: coordinator)
    }
}

// iOS list edit mode. The Mac keeps the same state machine so selection flows
// compile; Mac-native multi-select refinement comes with the shell polish.
enum EditMode: Hashable {
    case inactive
    case transient
    case active

    var isEditing: Bool { self != .inactive }
}

private struct EditModeShimKey: EnvironmentKey {
    static let defaultValue: Binding<EditMode>? = nil
}

extension EnvironmentValues {
    var editMode: Binding<EditMode>? {
        get { self[EditModeShimKey.self] }
        set { self[EditModeShimKey.self] = newValue }
    }
}

// Phone list chrome with no Mac counterpart.
enum ListSectionSpacingShim {
    case `default`, compact, custom(CGFloat)
}

extension View {
    func listSectionSpacing(_ spacing: ListSectionSpacingShim) -> some View {
        self
    }
}

extension ToolbarItemPlacement {
    static var topBarLeading: ToolbarItemPlacement { .navigation }
    static var topBarTrailing: ToolbarItemPlacement { .primaryAction }
    static var bottomBar: ToolbarItemPlacement { .automatic }
}

extension ToolbarPlacement {
    // Hiding the phone's navigation bar has no Mac analogue worth forcing;
    // mapping onto the window toolbar keeps the modifier compiling and inert.
    static var navigationBar: ToolbarPlacement { .windowToolbar }
}

extension NSColor {
    static var systemBackground: NSColor { .windowBackgroundColor }
    static var secondarySystemBackground: NSColor { .underPageBackgroundColor }
    static var systemGroupedBackground: NSColor { .windowBackgroundColor }
    static var secondarySystemGroupedBackground: NSColor { .controlBackgroundColor }
}

extension Color {
    init(uiColor: NSColor) {
        self.init(nsColor: uiColor)
    }
}
#endif
