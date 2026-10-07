import SwiftUI

// Pointer and keyboard affordances that shared feature code can name without
// per-call conditionals. The Mac gets the key equivalent or the hover fill;
// iOS keeps the touch target. Each helper is deliberate: a key equivalent on
// the phone would answer to a hardware keyboard a text field already owns.

extension View {
    /// Return triggers the one primary action of a card on the Mac: the
    /// handoff button, or "Continue" after a stop. Never put this on a button
    /// that starts a run; a run costs money, and one key press must not start
    /// one.
    func primaryActionShortcut() -> some View {
        #if os(macOS)
        return keyboardShortcut(.defaultAction)
        #else
        return self
        #endif
    }

    /// Command-period stops the run on the Mac, as it stops a page in Safari.
    func stopShortcut() -> some View {
        #if os(macOS)
        return keyboardShortcut(".", modifiers: .command)
        #else
        return self
        #endif
    }

    /// Command-Return does the one action that waits in the Albatross thread
    /// on the Mac: a handoff's button, or a form's submit. Plain Return stays
    /// with the composer. `active` false leaves the button without it, so one
    /// block can give the key to one of two buttons.
    func waitingActionShortcut(_ active: Bool = true) -> some View {
        #if os(macOS)
        return keyboardShortcut(active ? KeyboardShortcut.waitingAction : nil)
        #else
        return self
        #endif
    }

    /// A context menu for a secondary click on the Mac. The phone keeps its
    /// long press for text selection, so it gets no menu here.
    func pointerMenu<Items: View>(@ViewBuilder _ items: () -> Items) -> some View {
        #if os(macOS)
        return contextMenu(menuItems: items)
        #else
        return self
        #endif
    }

    /// A quiet fill under the pointer. The fill reaches `inset` points past
    /// the content on each side, so the text keeps its column.
    func hoverHighlight(cornerRadius: CGFloat = 8, inset: CGFloat = 8) -> some View {
        modifier(HoverHighlightModifier(cornerRadius: cornerRadius, inset: inset))
    }
}

extension KeyboardShortcut {
    /// Command-Return: the one action that waits in the Albatross thread.
    static var waitingAction: KeyboardShortcut {
        KeyboardShortcut(.return, modifiers: .command)
    }
}

private struct HoverHighlightModifier: ViewModifier {
    let cornerRadius: CGFloat
    let inset: CGFloat
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, inset)
            .background(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(Color.primary.opacity(hovering ? 0.05 : 0))
            )
            .padding(.horizontal, -inset)
            .onHover { hovering = $0 }
            .animation(.easeOut(duration: 0.12), value: hovering)
    }
}
