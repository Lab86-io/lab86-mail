import SwiftUI

// The `ask_secure_detail` card (docs/albatross-secure-store.md, V12): the chat
// asks for a sign-in, an ID, the date of birth, or a key that is not saved.
// "Add" opens the private sheet; the value goes to the store and never
// through the chat. The answer is the tool output, `{ saved: true, itemId }`
// or `{ skipped: true }`, so the model continues at once and the state
// survives in the saved chat. The card computes "already saved" from the
// client's own list: then it offers "Replace" instead.

enum SecureRequestCopy {
    static let add = "Add"
    static let replace = "Replace"
    static let skip = "Skip"
    static let skipped = "Skipped."
    static let replaced = "Replaced. Albatross tries again."
    static let unavailableTitle = "Albatross asked for a saved detail"
    static let unavailable = "Add it in Settings, Passwords and IDs, or on the web."

    /// "Add your sign-in for springfieldwater.gov", "Replace your OpenAI key".
    static func title(_ input: SecureRequestInput, existing: SecureItemView?) -> String {
        let verb = existing == nil ? "Add" : "Replace"
        switch input.kind {
        case .signIn:
            if let site = input.site { return "\(verb) your sign-in for \(site)" }
            return "\(verb) a sign-in"
        case .apiKey:
            if let label = input.label { return "\(verb) your \(label) key" }
            if let site = input.site { return "\(verb) a key for \(site)" }
            return "\(verb) a key"
        case .idNumber:
            return "\(verb) your \(input.label.map(SecureItemLabel.inSentence) ?? "ID number")"
        case .dateOfBirth:
            return "\(verb) your date of birth"
        }
    }

    /// What Albatross does with it.
    static func note(_ input: SecureRequestInput) -> String {
        switch input.kind {
        case .signIn, .apiKey:
            if let site = input.site { return "Albatross uses it on \(site) and never shows it." }
            return "Albatross uses it only where you allow, and never shows it."
        case .idNumber, .dateOfBirth:
            return "Albatross asks you before it uses it on a new site."
        }
    }

    /// "Saved. Albatross can use it on springfieldwater.gov."
    static func saved(site: String?) -> String {
        if let site { return "Saved. Albatross can use it on \(site)." }
        return "Saved. Albatross can use it where you allow."
    }
}

struct SecureRequestCard: View {
    @Environment(AppEnvironment.self) private var environment
    let question: AssistantQuestionPart
    let onAnswer: (JSONValue) -> Void

    @State private var editing: SecureItemEditorView.Target?
    @State private var replaced = false

    private var store: SecureDetailsStore { environment.secureDetails }

    var body: some View {
        if let input = SecureRequestInput(json: question.input) {
            card(input)
        } else {
            QuestionShell(title: SecureRequestCopy.unavailableTitle) {
                Text(SecureRequestCopy.unavailable)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// An item of the kind that covers the site already, from the client's own list.
    private func existingItem(for input: SecureRequestInput) -> SecureItemView? {
        switch input.kind {
        case .dateOfBirth:
            return store.dateOfBirth
        case .signIn, .apiKey:
            guard let site = input.site else { return nil }
            return store.item(kind: input.kind, covering: site)
        case .idNumber:
            return nil
        }
    }

    private func card(_ input: SecureRequestInput) -> some View {
        let existing = existingItem(for: input)
        return QuestionShell(title: SecureRequestCopy.title(input, existing: existing)) {
            if !input.reason.isEmpty {
                Text(input.reason)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let answer = question.answer {
                receipt(answer, input: input)
            } else {
                Text(SecureRequestCopy.note(input))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(alignment: .center) {
                    Button(SecureRequestCopy.skip) { onAnswer(SecureRequestInput.skippedAnswer) }
                        .buttonStyle(.borderless)
                        .font(.subheadline)
                    Spacer(minLength: 0)
                    SubmitButton(label: existing == nil ? SecureRequestCopy.add : SecureRequestCopy.replace, enabled: true) {
                        editing = Self.target(for: input, existing: existing)
                    }
                }
            }
        }
        .task { await store.load(environment.backend, ownerID: environment.sessionStore.ownerID) }
        .sheet(item: $editing) { target in
            SecureItemEditorView(target: target, siteSource: Self.siteSource(for: input)) { item in
                guard let item else { return }
                replaced = existing != nil
                onAnswer(SecureRequestInput.savedAnswer(itemID: item.id))
            }
            #if os(macOS)
            .macFormSheet()
            #endif
        }
    }

    @ViewBuilder private func receipt(_ answer: JSONValue, input: SecureRequestInput) -> some View {
        if answer["skipped"]?.boolValue == true {
            Text(SecureRequestCopy.skipped)
                .font(.footnote)
                .foregroundStyle(.tertiary)
        } else {
            Text(replaced ? SecureRequestCopy.replaced : SecureRequestCopy.saved(site: input.site))
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    /// A site in the card's input is the model's word, not the user's: the
    /// sheet shows the warning line under it until the user edits it.
    static func siteSource(for input: SecureRequestInput) -> SecureSiteSource {
        guard input.site != nil, input.kind == .signIn || input.kind == .apiKey else { return .user }
        return .suggested
    }

    /// The sheet for the kind asked, or the replace sheet of the item that exists.
    static func target(for input: SecureRequestInput, existing: SecureItemView?) -> SecureItemEditorView.Target {
        if let existing {
            return .replace(item: existing, field: existing.kind.mainField)
        }
        switch input.kind {
        case .signIn: return .newSignIn(site: input.site, label: input.label)
        case .apiKey: return .newKey(site: input.site, label: input.label, key: nil)
        case .idNumber: return .newID(type: IdNumberType.from(input.label) ?? .other, number: nil)
        case .dateOfBirth: return .newDateOfBirth
        }
    }
}
