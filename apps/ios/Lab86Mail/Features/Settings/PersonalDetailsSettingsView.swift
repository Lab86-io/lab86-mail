import SwiftUI

// Settings, Account, Personal details (docs/albatross-thread.md, S21 to S24):
// the facts Albatross types into forms, each with where it came from. The
// user adds, changes, or deletes each one. Passwords, card numbers, and ID
// numbers never live here; the server refuses them and the editor says so.

/// The words of the page, in one place for the views and the tests.
enum PersonalDetailsCopy {
    static let title = "Personal details"
    static let intro = "Albatross types these into forms when a step needs them. It never keeps passwords, card numbers, or ID numbers here."
    static let footer = "Albatross never saves passwords, card numbers, or ID numbers here. Delete any detail at any time."
    static let otherDetails = "Other details"
    static let addDetail = "Add a detail"
    static let add = "Add"
    static let edit = "Edit"
    static let delete = "Delete"
    // The Mac editor: a bordered button at the trailing edge of its row, with
    // a confirmation. The ellipsis says a confirmation follows.
    static let deleteRow = "Delete this detail"
    static let deleteEllipsis = "Delete…"
    static let deleteTitle = "Delete this detail?"
    static let deleteDetail = "Forms ask you for it again."
    static let useAccountName = "Use the account name"
    static let phoneHelp = "Forms get this number."
    static let deleted = "Deleted."

    static func accountNameLine(_ name: String) -> String {
        "Your account says \(name). Forms use what you save here."
    }
}

struct PersonalDetailsSettingsView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var editing: PersonalDetailEditorView.Target?
    @State private var message: String?

    private var store: PersonalDetailsStore { environment.personalDetails }

    var body: some View {
        Form {
            Section {
                Text(PersonalDetailsCopy.intro)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if !store.loaded {
                    ProgressView("Checking…")
                } else if let loadError = store.loadError, store.details.isEmpty {
                    Text(loadError).foregroundStyle(.secondary)
                    Button("Try again") { Task { await store.load(environment.backend, force: true) } }
                }
                ForEach(PersonalDetailKey.fixed, id: \.wire) { key in
                    fixedRow(key)
                }
            }
            Section {
                ForEach(store.customDetails) { detail in
                    row(detail)
                }
                Button(PersonalDetailsCopy.addDetail) {
                    editing = .newCustom
                }
            } header: {
                Text(PersonalDetailsCopy.otherDetails)
            } footer: {
                Text(PersonalDetailsCopy.footer)
            }
            if let message {
                Section { Text(message).font(.footnote).foregroundStyle(.secondary) }
            }
        }
        .navigationTitle(PersonalDetailsCopy.title)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.load(environment.backend, force: true) }
        .task { await store.load(environment.backend) }
        .sheet(item: $editing) { target in
            PersonalDetailEditorView(target: target) { outcome in
                message = outcome
            }
            #if os(macOS)
            .macFormSheet()
            #endif
        }
    }

    @ViewBuilder private func fixedRow(_ key: PersonalDetailKey) -> some View {
        if let detail = store.detail(key) {
            row(detail)
        } else {
            #if os(macOS)
            // A Mac form puts the action at the trailing edge of its row, as
            // System Settings does.
            LabeledContent(key.fixedLabel ?? "Detail") {
                Button(PersonalDetailsCopy.add) { editing = .new(key) }
                    .buttonStyle(.bordered)
            }
            #else
            Button {
                editing = .new(key)
            } label: {
                LabeledContent(key.fixedLabel ?? "Detail", value: PersonalDetailsCopy.add)
            }
            .foregroundStyle(.primary)
            #endif
        }
    }

    @ViewBuilder private func row(_ detail: PersonalDetailView) -> some View {
        #if os(macOS)
        LabeledContent(detail.label) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(detail.display)
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.leading)
                    Text(detail.sourceLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Button(PersonalDetailsCopy.edit) { editing = .existing(detail) }
                    .buttonStyle(.bordered)
            }
        }
        .accessibilityElement(children: .contain)
        #else
        Button {
            editing = .existing(detail)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(detail.label)
                    .foregroundStyle(.primary)
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(detail.display)
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.trailing)
                    Text(detail.sourceLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the editor")
        #endif
    }
}

/// The editor of one detail: the fields of its shape, Save, and Delete.
struct PersonalDetailEditorView: View {
    enum Target: Identifiable, Hashable {
        case new(PersonalDetailKey)
        case existing(PersonalDetailView)
        case newCustom

        var id: String {
            switch self {
            case .new(let key): "new:\(key.wire)"
            case .existing(let detail): "edit:\(detail.key.wire)"
            case .newCustom: "new:custom"
            }
        }

        var key: PersonalDetailKey? {
            switch self {
            case .new(let key): key
            case .existing(let detail): detail.key
            case .newCustom: nil
            }
        }

        var existing: PersonalDetailView? {
            if case .existing(let detail) = self { return detail }
            return nil
        }
    }

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    let target: Target
    let onFinish: (String?) -> Void

    @State private var value: FormDraftValue
    @State private var customLabel: String
    @State private var isSaving = false
    @State private var errorLine: String?
    @State private var showsDeleteConfirmation = false
    @FocusState private var focus: String?

    init(target: Target, onFinish: @escaping (String?) -> Void) {
        self.target = target
        self.onFinish = onFinish
        let country = Locale.current.region?.identifier ?? "US"
        let kind = Self.kind(for: target.key)
        if let existing = target.existing,
           let draft = FormDraftValue.from(detail: existing.value, kind: kind, country: country) {
            _value = State(initialValue: draft)
        } else {
            _value = State(initialValue: FormDraftValue.empty(for: kind, country: country))
        }
        if case .custom(let custom) = target.existing?.value {
            _customLabel = State(initialValue: custom.label)
        } else {
            _customLabel = State(initialValue: "")
        }
    }

    private var title: String {
        target.key?.fixedLabel ?? target.existing?.label ?? "New detail"
    }

    /// The field shape of a key. A custom detail is one text line.
    static func kind(for key: PersonalDetailKey?) -> FormField.Kind {
        switch key {
        case .name: .name
        case .email: .email
        case .phone: .phone
        case .homeAddress: .address
        case .emergencyContact: .contact
        case .custom, .none: .text
        }
    }

    private var field: FormField {
        FormField(
            id: "value",
            label: title,
            kind: Self.kind(for: target.key),
            help: target.key == .phone ? PersonalDetailsCopy.phoneHelp : nil
        )
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if target.key == nil || target.key?.isCustom == true {
                        // The title is the row label in a grouped Mac form; the
                        // example text goes in the prompt.
                        TextField("Label", text: $customLabel, prompt: Text("Employer"))
                            .focused($focus, equals: "label")
                            .disabled(target.existing != nil)
                    }
                    FormFieldView(
                        field: field,
                        value: $value,
                        error: errorLine,
                        source: nil,
                        focus: $focus,
                        disabled: isSaving
                    )
                } footer: {
                    if case .name = target.key, let existing = target.existing, existing.source == .account {
                        Text(PersonalDetailsCopy.accountNameLine(existing.display))
                    } else if let existing = target.existing {
                        Text(existing.sourceLine)
                    }
                }
                if let existing = target.existing {
                    Section {
                        if existing.key == .name, existing.saved {
                            Button(PersonalDetailsCopy.useAccountName) { Task { await delete() } }
                                .disabled(isSaving)
                        } else if existing.saved {
                            #if os(macOS)
                            LabeledContent(PersonalDetailsCopy.deleteRow) {
                                Button(PersonalDetailsCopy.deleteEllipsis) { showsDeleteConfirmation = true }
                                    .buttonStyle(.bordered)
                                    .disabled(isSaving)
                            }
                            #else
                            Button(PersonalDetailsCopy.delete, role: .destructive) { Task { await delete() } }
                                .disabled(isSaving)
                            #endif
                        }
                    }
                }
            }
            .confirmationDialog(
                PersonalDetailsCopy.deleteTitle,
                isPresented: $showsDeleteConfirmation,
                titleVisibility: .visible
            ) {
                Button(PersonalDetailsCopy.delete, role: .destructive) { Task { await delete() } }
            } message: {
                Text(PersonalDetailsCopy.deleteDetail)
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") { Task { await save() } }
                        .disabled(isSaving || !canSave)
                }
            }
        }
        .interactiveDismissDisabled(isSaving)
    }

    private var canSave: Bool {
        guard !value.isEmpty else { return false }
        if target.key == nil, customLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
        return true
    }

    private func save() async {
        errorLine = nil
        if let line = FormValidation.error(for: field, value: value) {
            errorLine = line
            return
        }
        guard let json = value.json else { return }
        let wireValue: JSONValue
        if target.key == nil || target.key?.isCustom == true {
            wireValue = .object([
                "label": .string(customLabel.trimmingCharacters(in: .whitespacesAndNewlines)),
                "value": json,
            ])
        } else {
            wireValue = json
        }
        isSaving = true
        defer { isSaving = false }
        do {
            try await environment.personalDetails.save(
                key: target.key,
                value: wireValue,
                label: target.key == nil ? customLabel : nil,
                transport: environment.backend
            )
            onFinish(nil)
            dismiss()
        } catch let error as PersonalDetailSaveError {
            errorLine = error.line
        } catch {
            errorLine = error.localizedDescription
        }
    }

    private func delete() async {
        guard let key = target.key else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            try await environment.personalDetails.delete(key: key, transport: environment.backend)
            onFinish(PersonalDetailsCopy.deleted)
            PlatformAccessibility.announce(PersonalDetailsCopy.deleted)
            dismiss()
        } catch {
            errorLine = error.localizedDescription
        }
    }
}
