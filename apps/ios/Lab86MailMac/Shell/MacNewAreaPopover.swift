import SwiftUI

// The name rule for a new Area. Pure, so it is testable.
enum MacNewArea {
    // The server keeps 120 characters. Nil means there is nothing to create.
    static let maxLength = 120

    static func cleanName(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return String(trimmed.prefix(maxLength))
    }
}

// The New Area popover on the Mac source list: one name field, one line
// that says what an Area is, then Cancel and Create. Return creates. Esc
// closes the popover.
struct MacNewAreaPopover: View {
    @Binding var name: String
    let onCancel: () -> Void
    let onCreate: () -> Void

    @FocusState private var focused: Bool

    private var canCreate: Bool { MacNewArea.cleanName(name) != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("New Area")
                .font(.headline)
            TextField("Name", text: $name)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit {
                    if canCreate { onCreate() }
                }
            Text("Name one part of your life that Albatross should keep track of.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer(minLength: 0)
                Button("Cancel", action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button("Create", action: onCreate)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canCreate)
            }
        }
        .padding(16)
        .frame(width: 300)
        .task { focused = true }
    }
}
