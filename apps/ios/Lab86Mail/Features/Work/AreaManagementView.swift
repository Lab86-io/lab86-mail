import SwiftUI
import UniformTypeIdentifiers

struct AreaManagementView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss

    let detail: AreaDetail
    let onSaved: () -> Void
    let onArchive: () -> Void

    @State private var name: String
    @State private var kind: String
    @State private var primaryDomain: String
    @State private var imageURL: String
    @State private var isSaving = false
    @State private var importsImage = false
    @State private var showsArchiveConfirmation = false
    @State private var errorMessage: String?

    init(
        detail: AreaDetail,
        onSaved: @escaping () -> Void,
        onArchive: @escaping () -> Void
    ) {
        self.detail = detail
        self.onSaved = onSaved
        self.onArchive = onArchive
        _name = State(initialValue: detail.identity.name)
        _kind = State(initialValue: detail.identity.kind)
        _primaryDomain = State(initialValue: detail.identity.primaryDomain ?? "")
        _imageURL = State(initialValue: detail.identity.imageURL ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Identity") {
                    TextField("Name", text: $name)
                    TextField("Kind", text: $kind)
                    TextField("Primary domain", text: $primaryDomain)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                Section {
                    TextField("https://…", text: $imageURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Upload image", systemImage: "photo.badge.plus") {
                        importsImage = true
                    }
                    if !imageURL.isEmpty {
                        Button("Remove custom image", role: .destructive) {
                            Task { await clearImage() }
                        }
                    }
                } header: {
                    Text("Masthead image")
                } footer: {
                    Text("Choose an image file or provide an HTTPS address. Albatross falls back to the domain favicon and initials.")
                }

                Section {
                    Button(refreshTitle, systemImage: "arrow.triangle.2.circlepath") {
                        Task { _ = await environment.store.queueAreaBriefRefresh(areaID: detail.identity.id) }
                    }
                    .disabled(refreshIsRunning)
                    if let state = environment.store.areaRefreshStates[detail.identity.id],
                       let error = state.error {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                } header: {
                    Text("Understanding")
                } footer: {
                    Text("Reindexing observes a durable server job and reports its real queued, running, complete, or error state.")
                }

                Section {
                    Button("Archive Area", role: .destructive) {
                        showsArchiveConfirmation = true
                    }
                } footer: {
                    Text("Archiving keeps the Area’s history but removes it from active work.")
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage).font(.footnote).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Manage \(detail.identity.name)")
            .navigationBarTitleDisplayMode(.inline)
            .disabled(isSaving)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") { Task { await save() } }
                        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .fileImporter(
            isPresented: $importsImage,
            allowedContentTypes: [.image],
            allowsMultipleSelection: false
        ) { result in
            Task { await importImage(result) }
        }
        .confirmationDialog(
            "Archive \(detail.identity.name)?",
            isPresented: $showsArchiveConfirmation,
            titleVisibility: .visible
        ) {
            Button("Archive Area", role: .destructive) { Task { await archive() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Its history remains available to the server, but the Area leaves active navigation.")
        }
        .interactiveDismissDisabled(isSaving)
    }

    private var refreshIsRunning: Bool {
        guard let phase = environment.store.areaRefreshStates[detail.identity.id]?.phase else {
            return false
        }
        return phase == .queued || phase == .running
    }

    private var refreshTitle: String {
        environment.store.areaRefreshStates[detail.identity.id]?.progress ?? "Reindex context and refresh brief"
    }

    private func save() async {
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        if await environment.store.updateArea(
            areaID: detail.identity.id,
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            kind: kind.trimmingCharacters(in: .whitespacesAndNewlines),
            primaryDomain: primaryDomain.trimmingCharacters(in: .whitespacesAndNewlines),
            imageURL: imageURL.trimmingCharacters(in: .whitespacesAndNewlines)
        ) {
            onSaved()
        } else {
            errorMessage = environment.store.errorMessage ?? "Couldn’t update the Area."
        }
    }

    private func importImage(_ result: Result<[URL], Error>) async {
        do {
            guard let url = try result.get().first else { return }
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            let data = try Data(contentsOf: url)
            guard data.count <= 10 * 1024 * 1024 else {
                throw BackendError.server(status: 413, message: "Choose an image smaller than 10 MB.")
            }
            let contentType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "image/jpeg"
            isSaving = true
            defer { isSaving = false }
            if await environment.store.uploadAreaImage(
                areaID: detail.identity.id,
                attachment: ComposeAttachment(
                    filename: url.lastPathComponent,
                    contentType: contentType,
                    data: data
                )
            ) {
                onSaved()
            } else {
                errorMessage = environment.store.errorMessage ?? "Couldn’t upload that image."
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func clearImage() async {
        isSaving = true
        defer { isSaving = false }
        if await environment.store.setAreaImage(areaID: detail.identity.id, imageURL: "") {
            imageURL = ""
            onSaved()
        } else {
            errorMessage = environment.store.errorMessage ?? "Couldn’t remove that image."
        }
    }

    private func archive() async {
        isSaving = true
        defer { isSaving = false }
        if await environment.store.archiveArea(areaID: detail.identity.id) {
            onArchive()
        } else {
            errorMessage = environment.store.errorMessage ?? "Couldn’t archive the Area."
        }
    }
}
