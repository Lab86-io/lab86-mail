import SwiftUI

struct SmartLabelsSettingsView: View {
    @Environment(AppEnvironment.self) private var environment

    private struct SmartLabel: Identifiable {
        let id: String
        let name: String
        let description: String
        let positiveExamples: [String]
        let negativeExamples: [String]
        let enabled: Bool
        let sidebarVisible: Bool
    }

    private struct Editor: Identifiable {
        let id: String
        let existingID: String?
        var name: String
        var description: String
        var positive: String
        var negative: String
        var sidebarVisible: Bool
    }

    @State private var labels: [SmartLabel] = []
    @State private var isLoading = true
    @State private var busyID: String?
    @State private var errorMessage: String?
    @State private var editor: Editor?
    @State private var previewSubjects: [String] = []
    @State private var deleteTarget: SmartLabel?

    var body: some View {
        List {
            Section {
                if isLoading, labels.isEmpty {
                    HStack { ProgressView(); Text("Loading labels…") }
                } else if labels.isEmpty {
                    ContentUnavailableView(
                        "No custom labels",
                        systemImage: "tag",
                        description: Text("Describe a useful category and teach it with examples.")
                    )
                } else {
                    ForEach(labels) { label in
                        VStack(alignment: .leading, spacing: 7) {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(label.name).font(.headline)
                                    Text(label.description)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Menu {
                                    Button("Edit", systemImage: "pencil") { edit(label) }
                                    Button(
                                        label.enabled ? "Disable" : "Enable",
                                        systemImage: label.enabled ? "pause.circle" : "play.circle"
                                    ) {
                                        Task {
                                            await update(
                                                label.id,
                                                patch: ["enabled": .bool(!label.enabled)]
                                            )
                                        }
                                    }
                                    Button("Delete label", systemImage: "trash", role: .destructive) {
                                        deleteTarget = label
                                    }
                                } label: {
                                    if busyID == label.id {
                                        ProgressView().controlSize(.small)
                                    } else {
                                        Image(systemName: "ellipsis.circle")
                                    }
                                }
                            }
                            HStack {
                                Label(
                                    label.enabled ? "Enabled" : "Disabled",
                                    systemImage: label.enabled ? "checkmark.circle" : "pause.circle"
                                )
                                if label.sidebarVisible {
                                    Label("In sidebar", systemImage: "sidebar.left")
                                }
                            }
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                    }
                }
            } header: {
                Text("Custom smart labels")
            } footer: {
                Text("Labels organize Albatross’s local classification. They do not create or delete provider labels.")
            }

            Section {
                Button("Create smart label", systemImage: "plus") {
                    editor = Editor(
                        id: UUID().uuidString,
                        existingID: nil,
                        name: "",
                        description: "",
                        positive: "",
                        negative: "",
                        sidebarVisible: true
                    )
                }
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).font(.footnote).foregroundStyle(.red)
                    Button("Try again") { Task { await load() } }
                }
            }
        }
        .navigationTitle("Smart Labels")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $editor) { _ in
            labelEditor
        }
        .confirmationDialog(
            "Delete \(deleteTarget?.name ?? "label")?",
            isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { deleteTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete label", role: .destructive) {
                guard let label = deleteTarget else { return }
                deleteTarget = nil
                Task { await delete(label) }
            }
            Button("Cancel", role: .cancel) { deleteTarget = nil }
        } message: {
            Text("Existing mail is not deleted. The label is disabled and removed from active classification.")
        }
    }

    private var labelEditor: some View {
        NavigationStack {
            Form {
                Section("Definition") {
                    TextField("Name", text: editorBinding(\.name))
                    TextField("What belongs here?", text: editorBinding(\.description), axis: .vertical)
                    Toggle("Show in sidebar", isOn: editorBinding(\.sidebarVisible))
                }
                Section {
                    TextField(
                        "One example per line",
                        text: editorBinding(\.positive),
                        axis: .vertical
                    )
                    .lineLimit(3...7)
                } header: {
                    Text("Positive examples")
                } footer: {
                    Text("Concrete messages that should match.")
                }
                Section {
                    TextField(
                        "One example per line",
                        text: editorBinding(\.negative),
                        axis: .vertical
                    )
                    .lineLimit(3...7)
                } header: {
                    Text("Negative examples")
                } footer: {
                    Text("Similar-looking mail that must not match.")
                }
                Section {
                    Button("Preview matches") { Task { await preview() } }
                        .disabled(!editorIsValid || busyID != nil)
                    ForEach(previewSubjects, id: \.self) { subject in
                        Label(subject, systemImage: "envelope")
                    }
                    if previewSubjects.isEmpty {
                        Text("Preview does not save or reclassify mail.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                if let errorMessage {
                    Text(errorMessage).font(.footnote).foregroundStyle(.red)
                }
            }
            .navigationTitle(editor?.existingID == nil ? "New Smart Label" : "Edit Smart Label")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { editor = nil }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await saveEditor() } }
                        .disabled(!editorIsValid || busyID != nil)
                }
            }
        }
    }

    private func editorBinding<T>(_ keyPath: WritableKeyPath<Editor, T>) -> Binding<T> {
        Binding(
            get: { editor![keyPath: keyPath] },
            set: { editor?[keyPath: keyPath] = $0 }
        )
    }

    private var editorIsValid: Bool {
        guard let editor else { return false }
        return !editor.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !editor.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !lines(editor.positive).isEmpty
            && !lines(editor.negative).isEmpty
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let result = try await environment.tools.invoke(
                "list_smart_labels",
                arguments: ["includeDisabled": .bool(true)]
            )
            labels = (result["custom"]?.arrayValue ?? []).compactMap { row in
                guard let id = row["_id"]?.stringValue,
                      let name = row["name"]?.stringValue else { return nil }
                return SmartLabel(
                    id: id,
                    name: name,
                    description: row["description"]?.stringValue ?? "",
                    positiveExamples: (row["positiveExamples"]?.arrayValue ?? []).compactMap(\.stringValue),
                    negativeExamples: (row["negativeExamples"]?.arrayValue ?? []).compactMap(\.stringValue),
                    enabled: row["enabled"]?.boolValue != false,
                    sidebarVisible: row["sidebarVisible"]?.boolValue != false
                )
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func edit(_ label: SmartLabel) {
        previewSubjects = []
        editor = Editor(
            id: UUID().uuidString,
            existingID: label.id,
            name: label.name,
            description: label.description,
            positive: label.positiveExamples.joined(separator: "\n"),
            negative: label.negativeExamples.joined(separator: "\n"),
            sidebarVisible: label.sidebarVisible
        )
    }

    private func preview() async {
        guard let editor else { return }
        busyID = "preview"
        errorMessage = nil
        defer { busyID = nil }
        do {
            let result = try await environment.tools.invoke(
                "preview_smart_label",
                arguments: definitionArguments(editor)
            )
            previewSubjects = (result["items"]?.arrayValue ?? []).compactMap {
                $0["subject"]?.stringValue ?? $0["snippet"]?.stringValue
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func saveEditor() async {
        guard let editor else { return }
        busyID = editor.existingID ?? "new"
        errorMessage = nil
        defer { busyID = nil }
        do {
            if let id = editor.existingID {
                var arguments = definitionArguments(editor)
                arguments["id"] = .string(id)
                _ = try await environment.tools.invoke("update_smart_label", arguments: arguments)
            } else {
                var arguments = definitionArguments(editor)
                arguments["createdBy"] = .string("user")
                _ = try await environment.tools.invoke("create_smart_label", arguments: arguments)
            }
            self.editor = nil
            previewSubjects = []
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func update(_ id: String, patch: [String: JSONValue]) async {
        busyID = id
        defer { busyID = nil }
        do {
            _ = try await environment.tools.invoke(
                "update_smart_label",
                arguments: patch.merging(["id": .string(id)]) { current, _ in current }
            )
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func delete(_ label: SmartLabel) async {
        busyID = label.id
        defer { busyID = nil }
        do {
            _ = try await environment.tools.invoke(
                "delete_smart_label",
                arguments: ["id": .string(label.id)]
            )
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func definitionArguments(_ editor: Editor) -> [String: JSONValue] {
        [
            "name": .string(editor.name.trimmingCharacters(in: .whitespacesAndNewlines)),
            "description": .string(editor.description.trimmingCharacters(in: .whitespacesAndNewlines)),
            "positiveExamples": .array(lines(editor.positive).map(JSONValue.string)),
            "negativeExamples": .array(lines(editor.negative).map(JSONValue.string)),
            "sidebarVisible": .bool(editor.sidebarVisible),
        ]
    }

    private func lines(_ value: String) -> [String] {
        value.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }
}
