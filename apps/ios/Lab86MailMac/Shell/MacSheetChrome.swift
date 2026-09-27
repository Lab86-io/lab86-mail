import SwiftUI

// Sheet chrome for shared settings surfaces on the Mac. A Mac sheet takes
// the size of its content, and a form or a list gives it almost none, so each
// sheet names a size. AppKit's default columnar form clips leading labels;
// the grouped style is the one every settings sheet in the shell uses.
struct MacSheetSize: Equatable, Sendable {
    let minWidth: CGFloat
    let minHeight: CGFloat

    // A settings page opened from outside Settings (Daily Brief,
    // Connections).
    static let settingsPage = MacSheetSize(minWidth: 540, minHeight: 560)
    // A short editor or a confirmation form.
    static let editor = MacSheetSize(minWidth: 480, minHeight: 440)
    // A list the user works through, such as sender cleanup.
    static let workList = MacSheetSize(minWidth: 600, minHeight: 560)
}

extension View {
    func macFormSheet(_ size: MacSheetSize = .settingsPage) -> some View {
        formStyle(.grouped)
            .frame(
                minWidth: size.minWidth,
                idealWidth: size.minWidth,
                minHeight: size.minHeight,
                idealHeight: size.minHeight
            )
    }
}
