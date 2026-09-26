import SwiftUI

/// Settings, Signatures (round 2, FEATURES item 11): one signature for each
/// mailbox, added below the mail it sends when it is on.
struct SignaturesSettingsView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var signatures: [MailSignature] = []
    @State private var didLoad = false
    @State private var errorMessage: String?

    var body: some View {
        Form {
            if !didLoad {
                Section { ProgressView("Loading signatures…") }
            } else if signatures.isEmpty {
                Section {
                    Text("Connect a mailbox to add its signature.")
                        .foregroundStyle(.secondary)
                }
            } else {
                Section {
                    ForEach($signatures) { $signature in
                        NavigationLink {
                            SignatureEditorView(signature: $signature)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(signature.mailboxLabel)
                                Text(Self.stateLine(signature))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                    }
                } footer: {
                    Text("A signature is added below new mail, replies, and forwards from its mailbox. You can leave it off for one message in the composer.")
                }
            }
            if let errorMessage {
                Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Signatures")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    static func stateLine(_ signature: MailSignature) -> String {
        guard signature.enabled, let first = signature.text.nilIfBlank?.split(separator: "\n").first else {
            return "Off"
        }
        return String(first)
    }

    private func load() async {
        do {
            signatures = try await MailTemplatesClient(tools: environment.tools).signatures()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        didLoad = true
    }
}

struct SignatureEditorView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @Binding var signature: MailSignature
    @State private var draft: MailSignature?
    @State private var showsHTML = false
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        let current = draft ?? signature
        Form {
            Section {
                Toggle("Add to outgoing mail", isOn: field(\.enabled))
            } footer: {
                Text(current.enabled
                     ? "Added below mail you send from this mailbox."
                     : "Off. Mail from this mailbox goes out without a signature.")
            }
            Section {
                TextEditor(text: field(\.text))
                    .frame(minHeight: 120)
                    .font(.body)
                    .accessibilityLabel("Signature for \(signature.mailboxLabel)")
            } header: {
                Text("Signature")
            } footer: {
                Text("\(current.text.count) of \(MailSignature.textLimit) characters")
            }
            Section {
                if showsHTML || current.html != nil {
                    TextEditor(text: Binding(
                        get: { (draft ?? signature).html ?? "" },
                        set: { value in
                            var next = draft ?? signature
                            next.html = value
                            draft = next
                        }
                    ))
                    .frame(minHeight: 90)
                    .font(.system(.footnote, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel("Formatted signature for \(signature.mailboxLabel)")
                } else {
                    Button("Add a formatted version") { showsHTML = true }
                }
            } header: {
                Text("Formatted version")
            } footer: {
                Text("Optional simple HTML, such as bold text and a link. Mail clients that show plain text use the signature above.")
            }
            if let errorMessage {
                Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
            }
        }
        .navigationTitle(signature.mailboxLabel)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : "Save") { Task { await save() } }
                    .disabled(isSaving || draft == nil || current.text.count > MailSignature.textLimit)
            }
        }
    }

    private func field<Value>(_ keyPath: WritableKeyPath<MailSignature, Value>) -> Binding<Value> {
        Binding(
            get: { (draft ?? signature)[keyPath: keyPath] },
            set: { value in
                var next = draft ?? signature
                next[keyPath: keyPath] = value
                draft = next
            }
        )
    }

    private func save() async {
        guard let draft else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            signature = try await MailTemplatesClient(tools: environment.tools).save(draft)
            self.draft = nil
            errorMessage = nil
            PlatformAccessibility.announce("Signature saved")
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// Settings, Saved replies: named snippets the composer inserts, and the
/// assistant can use when a reply fits.
struct SavedRepliesSettingsView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var replies: [SavedReply] = []
    @State private var didLoad = false
    @State private var errorMessage: String?
    @State private var editing: SavedReplyDraft?

    var body: some View {
        List {
            if didLoad, replies.isEmpty {
                Text("No saved replies yet. Add one for text you send often, such as your meeting times.")
                    .foregroundStyle(.secondary)
            }
            ForEach(replies) { reply in
                Button {
                    editing = SavedReplyDraft(id: reply.id, name: reply.name, body: reply.body)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(reply.name).foregroundStyle(.primary)
                        Text(reply.preview)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .swipeActions {
                    Button("Delete", role: .destructive) { Task { await delete(reply) } }
                }
                .contextMenu {
                    Button("Delete", role: .destructive) { Task { await delete(reply) } }
                }
            }
            if let errorMessage {
                Text(errorMessage).font(.footnote).foregroundStyle(.red)
            }
        }
        .overlay { if !didLoad { ProgressView("Loading saved replies…") } }
        .navigationTitle("Saved replies")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Add") { editing = SavedReplyDraft(id: nil, name: "", body: "") }
            }
        }
        .sheet(item: $editing) { draft in
            SavedReplyEditor(draft: draft) { saved in
                if let index = replies.firstIndex(where: { $0.id == saved.id }) {
                    replies[index] = saved
                } else {
                    replies.insert(saved, at: 0)
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        do {
            replies = try await MailTemplatesClient(tools: environment.tools).savedReplies()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        didLoad = true
    }

    private func delete(_ reply: SavedReply) async {
        do {
            try await MailTemplatesClient(tools: environment.tools).deleteReply(id: reply.id)
            replies.removeAll { $0.id == reply.id }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct SavedReplyDraft: Identifiable, Equatable {
    let id: String?
    var name: String
    var body: String

}

extension SavedReplyDraft {
    var canSave: Bool {
        name.nilIfBlank != nil && body.nilIfBlank != nil
            && name.count <= SavedReply.nameLimit && body.count <= SavedReply.bodyLimit
    }
}

private struct SavedReplyEditor: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State var draft: SavedReplyDraft
    let onSaved: (SavedReply) -> Void
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name, for example: Meeting times", text: $draft.name)
                        .accessibilityLabel("Saved reply name")
                } footer: {
                    Text("\(draft.name.count) of \(SavedReply.nameLimit) characters")
                }
                Section {
                    TextEditor(text: $draft.body)
                        .frame(minHeight: 160)
                        .accessibilityLabel("Saved reply text")
                } header: {
                    Text("Text")
                } footer: {
                    Text("\(draft.body.count) of \(SavedReply.bodyLimit) characters")
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle(draft.id == nil ? "New saved reply" : "Saved reply")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") { Task { await save() } }
                        .disabled(isSaving || !draft.canSave)
                }
            }
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        do {
            let saved = try await MailTemplatesClient(tools: environment.tools)
                .saveReply(id: draft.id, name: draft.name, body: draft.body)
            onSaved(saved)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
