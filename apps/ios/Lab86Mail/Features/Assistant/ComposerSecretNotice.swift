import SwiftUI

// The composer notice (docs/albatross-secure-store.md, V9): the draft holds a
// value that looks like a Social Security number, a card number, or an API
// key. One sentence and two text actions, inside the glass composer, above
// the field. "Save in Passwords and IDs" opens the add sheet with the value
// and takes it out of the draft. "Send without it" (and Return) sends the
// draft with the marker in place of the value. A card number has no save
// action: Albatross does not keep card numbers yet.

enum ComposerNoticeCopy {
    static let saveAction = "Save in Passwords and IDs"
    static let sendWithout = "Send without it"
    static let savedLine = "Saved to Passwords and IDs."

    static func line(_ kind: SecretShapeKind) -> String {
        switch kind {
        case .ssn: "This looks like a Social Security number. Albatross does not send it."
        case .apiKey: "This looks like an API key. Albatross does not send it."
        case .card: "This looks like a card number. Albatross does not send it, and it does not keep card numbers yet."
        }
    }
}

struct ComposerSecretNotice: View {
    @Environment(AppEnvironment.self) private var environment
    let kind: SecretShapeKind
    /// Nil for a card number: there is nothing to save it as.
    let onSave: (() -> Void)?
    let onSendWithout: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(ComposerNoticeCopy.line(kind))
                .font(.footnote.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 16) {
                if let onSave {
                    Button(ComposerNoticeCopy.saveAction, action: onSave)
                }
                Button(ComposerNoticeCopy.sendWithout, action: onSendWithout)
                Spacer(minLength: 0)
            }
            .buttonStyle(.borderless)
            .font(.footnote.weight(.medium))
            .tint(environment.theme.accentColor)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 2)
        .accessibilityElement(children: .contain)
    }
}
