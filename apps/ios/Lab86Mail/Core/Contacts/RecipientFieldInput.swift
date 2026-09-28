import Foundation

// The key, pointer, and list-size rules of the recipient field. The Mac reads
// keys before the text field editor and the sheet's default and cancel
// buttons (`RecipientKeyInterceptor`), so Return, Tab, Esc, Delete, and the
// arrows act on the chips and the list. These types have no AppKit or UIKit,
// so each rule has a unit test on every platform.

/// The modifier keys of a key press.
struct RecipientKeyModifiers: OptionSet, Hashable, Sendable {
    let rawValue: Int

    static let shift = RecipientKeyModifiers(rawValue: 1 << 0)
    static let control = RecipientKeyModifiers(rawValue: 1 << 1)
    static let option = RecipientKeyModifiers(rawValue: 1 << 2)
    static let command = RecipientKeyModifiers(rawValue: 1 << 3)
}

/// A key that the recipient field can use.
enum RecipientKey: Hashable, Sendable {
    case up
    case down
    case left
    case right
    case returnKey
    case tab
    case escape
    case deleteBackward
    case deleteForward
    case copy
    case cut

    // AppKit virtual key codes (kVK_*). They name physical keys, the same on
    // every keyboard layout.
    enum KeyCode {
        static let returnKey: UInt16 = 36
        static let tab: UInt16 = 48
        static let deleteBackward: UInt16 = 51
        static let escape: UInt16 = 53
        static let keypadEnter: UInt16 = 76
        static let deleteForward: UInt16 = 117
        static let left: UInt16 = 123
        static let right: UInt16 = 124
        static let down: UInt16 = 125
        static let up: UInt16 = 126
    }

    /// The key for an AppKit key press, or nil for a key the field leaves to
    /// the text field. Shift, Option, Control, and Command combinations keep
    /// their text meaning (Shift-Tab goes to the previous field, Shift-arrows
    /// select text), except Command-C and Command-X. Those copy a selected
    /// chip; the characters (not the key code) name them, so every keyboard
    /// layout works.
    init?(keyCode: UInt16, modifiers: RecipientKeyModifiers, characters: String?) {
        if modifiers == .command {
            switch characters?.lowercased() {
            case "c": self = .copy
            case "x": self = .cut
            default: return nil
            }
            return
        }
        guard modifiers.isEmpty else { return nil }
        switch keyCode {
        case KeyCode.up: self = .up
        case KeyCode.down: self = .down
        case KeyCode.left: self = .left
        case KeyCode.right: self = .right
        case KeyCode.returnKey, KeyCode.keypadEnter: self = .returnKey
        case KeyCode.tab: self = .tab
        case KeyCode.escape: self = .escape
        case KeyCode.deleteBackward: self = .deleteBackward
        case KeyCode.deleteForward: self = .deleteForward
        default: return nil
        }
    }
}

/// The state of the field at the time of a key press.
struct RecipientKeyContext: Equatable, Sendable {
    /// The suggestion list is on screen.
    var listVisible: Bool
    /// Return or Tab would pick a row now.
    var canPick: Bool
    /// The text field has no text (the chips are not text).
    var fieldIsEmpty: Bool
    var hasChips: Bool
    var hasSelectedChip: Bool
}

/// What the field does with a key. Nil means the key goes on to the text
/// field and the window as usual.
enum RecipientKeyAction: Equatable, Sendable {
    case moveHighlight(Int)
    /// Return: pick the highlighted person, make a chip of the text, or move
    /// to the next field (`RecipientField.submit`).
    case submit
    /// Tab with a row to pick or with typed text: pick or make a chip, and
    /// stay in the field. Tab with nothing to do goes to the next field.
    case pickOrCommit
    case closeList
    case clearChipSelection
    case selectPreviousChip
    case selectNextChip
    /// Delete on an empty field: select the last chip, then remove it.
    case deleteBackwardOverChips
    case removeSelectedChip
    case copySelectedChip
    case cutSelectedChip

    static func resolve(_ key: RecipientKey, in context: RecipientKeyContext) -> RecipientKeyAction? {
        let onChip = context.fieldIsEmpty && context.hasSelectedChip
        switch key {
        case .down:
            return context.listVisible ? .moveHighlight(1) : nil
        case .up:
            return context.listVisible ? .moveHighlight(-1) : nil
        case .left:
            return context.fieldIsEmpty && context.hasChips ? .selectPreviousChip : nil
        case .right:
            return onChip ? .selectNextChip : nil
        case .returnKey:
            return .submit
        case .tab:
            return context.canPick || !context.fieldIsEmpty ? .pickOrCommit : nil
        case .escape:
            if context.listVisible { return .closeList }
            return context.hasSelectedChip ? .clearChipSelection : nil
        case .deleteBackward:
            return context.fieldIsEmpty && context.hasChips ? .deleteBackwardOverChips : nil
        case .deleteForward:
            return onChip ? .removeSelectedChip : nil
        case .copy:
            return onChip ? .copySelectedChip : nil
        case .cut:
            return onChip ? .cutSelectedChip : nil
        }
    }
}

/// Hover moves the highlight only when the pointer moves. A list that opens
/// or changes under a still pointer does not take the highlight from the
/// keyboard, so Return still picks the row the arrows chose.
struct RecipientHoverFilter: Equatable, Sendable {
    private var lastLocation: CGPoint?

    init() {}

    /// True when the pointer moved since the last event. The first event
    /// after the list appears only records the location.
    mutating func pointerMoved(to location: CGPoint) -> Bool {
        defer { lastLocation = location }
        guard let lastLocation else { return false }
        return lastLocation != location
    }

    /// The pointer left the list.
    mutating func reset() {
        lastLocation = nil
    }
}

/// The size of the Mac suggestion list that opens under the field.
enum RecipientDropdownMetrics {
    /// About eight rows. More rows scroll.
    static let preferredMaxHeight: CGFloat = 340
    /// Three rows: the list does not get smaller than this near the bottom.
    static let minimumHeight: CGFloat = 132
    /// Room kept free under the list, above the bottom of the scroll view
    /// (the compose tool strip sits there).
    static let bottomMargin: CGFloat = 72
    /// Room for a long name and address; not the full row width (Superhuman
    /// and Attio keep the list narrower than the compose field too).
    static let maxWidth: CGFloat = 400
    /// The space between the field's text line and the top of the list.
    static let gap: CGFloat = 4
    static let cornerRadius: CGFloat = 10
    static let inset: CGFloat = 5

    /// The largest list height for the space from the field to the bottom of
    /// the scroll view. Infinite space (no scroll view) gives the preferred
    /// height.
    static func maxHeight(spaceBelow: CGFloat) -> CGFloat {
        guard spaceBelow.isFinite else { return preferredMaxHeight }
        return min(preferredMaxHeight, max(minimumHeight, spaceBelow - bottomMargin))
    }

    /// The space from the bottom of a view to the bottom of the scroll view
    /// that holds it, in whole steps of `step` points (so a scroll does not
    /// redraw the field for each point). `scrollBounds` is the scroll view's
    /// visible rectangle in the view's own coordinates; nil when there is no
    /// scroll view.
    static func spaceBelow(viewHeight: CGFloat, scrollBounds: CGRect?, step: CGFloat = 8) -> CGFloat {
        guard let scrollBounds, !scrollBounds.isNull, !scrollBounds.isInfinite else { return .infinity }
        let space = scrollBounds.maxY - viewHeight
        guard step > 0 else { return space }
        return (space / step).rounded(.down) * step
    }
}
