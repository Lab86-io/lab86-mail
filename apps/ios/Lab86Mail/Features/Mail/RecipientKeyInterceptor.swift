#if os(macOS)
import AppKit
import SwiftUI

/// Reads the recipient field's keys on the Mac before the field editor and
/// the window do. An NSTextField gives Return to the sheet's default button,
/// Esc to its cancel button, and Tab to the key view loop, and SwiftUI's
/// `onKeyPress` does not always see those keys first. A local key monitor
/// does: AppKit calls it before it sends the event to the window.
///
/// The monitor runs only while the field has focus, only for the key window
/// that holds this view, and only when the field editor edits the text field
/// that this view sits behind. Keys for marked text (an input method that
/// composes characters) always go to the field editor.
struct RecipientKeyInterceptor: NSViewRepresentable {
    var isActive: Bool
    /// Returns true when the field used the key. The string is the text in
    /// the field editor at the time of the key press.
    var onKey: @MainActor (RecipientKey, String) -> Bool

    func makeNSView(context: Context) -> RecipientKeyInterceptorView {
        let view = RecipientKeyInterceptorView()
        view.onKey = onKey
        view.isActive = isActive
        return view
    }

    func updateNSView(_ view: RecipientKeyInterceptorView, context: Context) {
        view.onKey = onKey
        view.isActive = isActive
    }

    static func dismantleNSView(_ view: RecipientKeyInterceptorView, coordinator: ()) {
        view.stop()
    }
}

final class RecipientKeyInterceptorView: NSView {
    var onKey: (@MainActor (RecipientKey, String) -> Bool)?
    var isActive = false {
        didSet {
            if isActive != oldValue { updateMonitor() }
        }
    }

    private var monitor: Any?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        updateMonitor()
    }

    // A background view: it draws nothing and takes no clicks.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }

    private func updateMonitor() {
        guard isActive, window != nil else {
            stop()
            return
        }
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            // NSEvent is not Sendable, so read the values here and let the
            // isolated block work with plain values.
            let keyCode = event.keyCode
            let flags = event.modifierFlags
            let characters = event.charactersIgnoringModifiers
            let windowNumber = event.windowNumber
            let used = MainActor.assumeIsolated { () -> Bool in
                guard let self else { return false }
                return self.handle(keyCode: keyCode, flags: flags, characters: characters, windowNumber: windowNumber)
            }
            return used ? nil : event
        }
    }

    private func handle(keyCode: UInt16, flags: NSEvent.ModifierFlags, characters: String?, windowNumber: Int) -> Bool {
        guard isActive, let onKey, let window, window.isKeyWindow,
              window.windowNumber == windowNumber,
              let editor = window.firstResponder as? NSTextView, editor.isFieldEditor,
              !editor.hasMarkedText(),
              edits(editor)
        else { return false }
        guard let key = RecipientKey(keyCode: keyCode, modifiers: Self.modifiers(flags), characters: characters) else {
            return false
        }
        return onKey(key, editor.string)
    }

    /// The field editor edits the text field that this view sits behind.
    /// The other recipient fields and the subject have their own frames.
    private func edits(_ editor: NSTextView) -> Bool {
        guard let field = editor.delegate as? NSView, field.window === window else { return false }
        let fieldFrame = field.convert(field.bounds, to: nil)
        let ownFrame = convert(bounds, to: nil)
        return !fieldFrame.intersection(ownFrame).isEmpty
    }

    private static func modifiers(_ flags: NSEvent.ModifierFlags) -> RecipientKeyModifiers {
        var result: RecipientKeyModifiers = []
        if flags.contains(.shift) { result.insert(.shift) }
        if flags.contains(.control) { result.insert(.control) }
        if flags.contains(.option) { result.insert(.option) }
        if flags.contains(.command) { result.insert(.command) }
        return result
    }
}

/// The Mac pasteboard for chip Copy and Cut.
enum RecipientPasteboard {
    @MainActor
    static func copy(_ text: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }
}

enum RecipientMouse {
    /// The primary mouse button is down: a click is under way.
    @MainActor
    static var primaryButtonIsDown: Bool { NSEvent.pressedMouseButtons & 1 == 1 }
}
#endif
