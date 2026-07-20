import SwiftUI

// Native mirror of desktop Settings → AI: hosted Lab86 AI vs a personal
// OpenRouter key, plus the normal/fast model choices. Persists through the
// same /api/ai/settings contract the web uses.
struct AISettingsView: View {
    @Environment(AppEnvironment.self) private var environment

    private struct ModelOption: Identifiable, Equatable {
        let id: String
        let label: String
        let detail: String
    }

    @State private var isLoaded = false
    @State private var loadError: String?
    @State private var mode = "lab86"
    @State private var model = ""
    @State private var fastModel = ""
    @State private var primaryOptions: [ModelOption] = []
    @State private var fastOptions: [ModelOption] = []
    @State private var maskedKey: String?
    @State private var apiKeyInput = ""
    @State private var planLabel: String?
    @State private var usageLabel: String?
    @State private var isSaving = false
    @State private var saveMessage: String?
    @State private var saveError: String?

    var body: some View {
        Form {
            if !isLoaded {
                if let loadError {
                    Section {
                        Text(loadError).foregroundStyle(.red).font(.footnote)
                        Button("Try again") { Task { await load() } }
                    }
                } else {
                    Section {
                        HStack(spacing: 10) {
                            ProgressView().controlSize(.small)
                            Text("Loading AI settings…").foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                Section {
                    Picker("Mode", selection: $mode) {
                        Text("Lab86 AI").tag("lab86")
                        Text("My own key").tag("byok")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    if let planLabel {
                        LabeledContent("Plan", value: planLabel)
                    }
                    if let usageLabel {
                        LabeledContent("Usage", value: usageLabel)
                    }
                } header: {
                    Text("Intelligence source")
                } footer: {
                    Text(mode == "byok"
                        ? "Bring your own OpenRouter key (starts with sk-or-). Usage bills to your OpenRouter account."
                        : "Hosted models with usage included in your plan.")
                }

                if mode == "byok" {
                    Section("OpenRouter key") {
                        if let maskedKey {
                            LabeledContent("Saved key", value: maskedKey)
                            Button("Remove key", role: .destructive) {
                                Task { await deleteKey() }
                            }
                        }
                        SecureField(maskedKey == nil ? "sk-or-…" : "Replace key", text: $apiKeyInput)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                }

                Section("Models") {
                    modelPicker("Normal", selection: $model, options: primaryOptions)
                    modelPicker("Fast", selection: $fastModel, options: fastOptions)
                    if let detail = primaryOptions.first(where: { $0.id == model })?.detail, !detail.isEmpty {
                        Text(detail).font(.footnote).foregroundStyle(.secondary)
                    }
                }

                Section {
                    Button(isSaving ? "Saving…" : "Save changes") {
                        Task { await save() }
                    }
                    .disabled(isSaving)
                    if let saveMessage {
                        Text(saveMessage).font(.footnote).foregroundStyle(.secondary)
                    }
                    if let saveError {
                        Text(saveError).font(.footnote).foregroundStyle(.red)
                    }
                }
            }
        }
        .navigationTitle("AI")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    @ViewBuilder private func modelPicker(
        _ title: String,
        selection: Binding<String>,
        options: [ModelOption]
    ) -> some View {
        if options.isEmpty {
            LabeledContent(title, value: selection.wrappedValue.isEmpty ? "Default" : selection.wrappedValue)
        } else {
            Picker(title, selection: selection) {
                ForEach(options) { option in
                    Text(option.label).tag(option.id)
                }
            }
        }
    }

    private func load() async {
        loadError = nil
        do {
            let result = try await environment.backend.get(path: "/api/ai/settings")
            let settings = result["settings"]
            mode = settings?["mode"]?.stringValue ?? "lab86"
            model = settings?["model"]?.stringValue ?? ""
            fastModel = settings?["fastModel"]?.stringValue ?? ""
            maskedKey = result["key"]?["masked"]?.stringValue
            primaryOptions = Self.options(result["modelOptions"]?["openrouter"]?["primary"])
            fastOptions = Self.options(result["modelOptions"]?["openrouter"]?["fast"])
            if model.isEmpty, let first = primaryOptions.first { model = first.id }
            if fastModel.isEmpty, let first = fastOptions.first { fastModel = first.id }
            if let plan = result["entitlement"]?["plan"]?.stringValue {
                let status = result["entitlement"]?["status"]?.stringValue
                planLabel = [plan.capitalized, status].compactMap { $0 }.joined(separator: " · ")
            }
            if let status = result["usage"]?["status"]?.stringValue {
                usageLabel = status.replacingOccurrences(of: "_", with: " ").capitalized
            }
            isLoaded = true
        } catch {
            loadError = (error as? BackendError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func save() async {
        isSaving = true
        saveMessage = nil
        saveError = nil
        defer { isSaving = false }
        var body: [String: JSONValue] = [
            "mode": .string(mode),
            "provider": .string("openrouter"),
            "model": .string(model),
            "fastModel": .string(fastModel),
            "enabled": .bool(true),
        ]
        let trimmedKey = apiKeyInput.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedKey.isEmpty { body["apiKey"] = .string(trimmedKey) }
        do {
            _ = try await environment.backend.post(path: "/api/ai/settings", body: .object(body))
            apiKeyInput = ""
            saveMessage = "Saved."
            await load()
        } catch {
            saveError = (error as? BackendError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func deleteKey() async {
        do {
            _ = try await environment.backend.delete(
                path: "/api/ai/settings?provider=openrouter",
                body: .object([:])
            )
            maskedKey = nil
            await load()
        } catch {
            saveError = (error as? BackendError)?.errorDescription ?? error.localizedDescription
        }
    }

    private static func options(_ json: JSONValue?) -> [ModelOption] {
        (json?.arrayValue ?? []).compactMap { row in
            guard let id = row["id"]?.stringValue else { return nil }
            return ModelOption(
                id: id,
                label: row["label"]?.stringValue ?? id,
                detail: row["detail"]?.stringValue ?? ""
            )
        }
    }
}
