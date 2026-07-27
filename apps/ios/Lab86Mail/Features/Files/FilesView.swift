import SwiftUI
import UniformTypeIdentifiers

struct FilesView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    @State private var query = ""
    @State private var locationID = "all"
    @State private var cloudItems: [CloudFileItem] = []
    @State private var folderStack: [CloudFolderRoute] = []
    @State private var isImporting = false
    @State private var isConnecting = false
    @State private var showsDriveMenu = false
    @State private var showsFileImporter = false
    @State private var errorMessage: String?

    private var store: DocumentStore { environment.documents }

    var body: some View {
        Group {
            if store.isLoading && store.documents.isEmpty && store.uploads.isEmpty {
                ProgressView("Loading files…")
            } else if visibleDocuments.isEmpty && visibleUploads.isEmpty && visibleCloudItems.isEmpty {
                ContentUnavailableView {
                    Label(emptyTitle, systemImage: "folder")
                } description: {
                    Text(emptyDetail)
                } actions: {
                    Menu("New file", systemImage: "plus") {
                        creationButtons
                    }
                    .buttonStyle(.borderedProminent)
                    Button("Add a drive", systemImage: "externaldrive.badge.plus") {
                        showsDriveMenu = true
                    }
                    .buttonStyle(.bordered)
                }
            } else {
                fileList
            }
        }
        .navigationTitle("Files")
        .searchable(text: $query, prompt: "Search files")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showsDriveMenu = true
                } label: {
                    Label("Drives", systemImage: "externaldrive")
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            locationPicker
        }
        .task {
            await store.loadFiles()
        }
        .task(id: cloudLoadKey) {
            await loadCloudItems(debounceSearch: true)
        }
        .refreshable {
            await store.loadFiles()
            await loadCloudItems()
        }
        .confirmationDialog("Drives", isPresented: $showsDriveMenu, titleVisibility: .visible) {
            Button("Connect Google Drive") {
                Task { await connect(provider: "google_drive") }
            }
            Button("Connect OneDrive") {
                Task { await connect(provider: "onedrive") }
            }
            Button("Choose from iCloud Drive") {
                showsFileImporter = true
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Connected drives stay private to your account. Albatross requests write access so you can publish and sync edits.")
        }
        .fileImporter(
            isPresented: $showsFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            Task { await importLocalFiles(result) }
        }
        .alert("Files", isPresented: Binding(
            get: { errorMessage != nil || store.errorMessage != nil },
            set: {
                if !$0 {
                    errorMessage = nil
                    store.clearError()
                }
            }
        )) {
            Button("OK") {
                errorMessage = nil
                store.clearError()
            }
        } message: {
            Text(errorMessage ?? store.errorMessage ?? "Try again.")
        }
        .overlay {
            if isImporting || isConnecting {
                ZStack {
                    Color.black.opacity(0.08).ignoresSafeArea()
                    ProgressView(isConnecting ? "Connecting…" : "Opening file…")
                        .padding(20)
                        .background(.regularMaterial, in: .rect(cornerRadius: 18))
                }
            }
        }
    }

    private var fileList: some View {
        List {
            if folderStack.count > 1 {
                Button {
                    folderStack.removeLast()
                } label: {
                    Label("Back to \(folderStack.dropLast().last?.name ?? "Drive")", systemImage: "chevron.left")
                }
            }

            if !visibleDocuments.isEmpty {
                Section("Albatross") {
                    ForEach(visibleDocuments) { document in
                        Button {
                            environment.navigation.openDocument(id: document.id)
                        } label: {
                            FileRow(
                                symbol: document.kind.symbol,
                                title: document.title,
                                detail: documentDetail(document),
                                tint: tint(document.kind)
                            )
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Opens the editable \(document.kind.title.lowercased())")
                    }
                }
            }

            if !visibleUploads.isEmpty {
                Section("Uploads") {
                    ForEach(visibleUploads) { item in
                        Button {
                            if let url = item.webURL { openURL(url) }
                        } label: {
                            FileRow(
                                symbol: "doc",
                                title: item.name,
                                detail: fileDetail(item),
                                tint: .secondary
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if !visibleCloudItems.isEmpty {
                Section(locationTitle) {
                    ForEach(visibleCloudItems) { item in
                        Button {
                            Task { await openCloudItem(item) }
                        } label: {
                            FileRow(
                                symbol: item.isFolder ? "folder.fill" : cloudSymbol(item),
                                title: item.name,
                                detail: fileDetail(item),
                                tint: item.provider == "google_drive" ? .blue : .cyan
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private var locationPicker: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                LocationChip(title: "All", symbol: "folder", selected: locationID == "all") {
                    selectLocation("all")
                }
                LocationChip(title: "Albatross", symbol: "bird", selected: locationID == "albatross") {
                    selectLocation("albatross")
                }
                ForEach(store.connections) { connection in
                    LocationChip(
                        title: connection.provider == "google_drive" ? "Google Drive" : "OneDrive",
                        symbol: connection.provider == "google_drive" ? "triangle" : "cloud",
                        selected: locationID == connection.id,
                        warning: connection.status == "error"
                    ) {
                        selectLocation(connection.id)
                    }
                }
                LocationChip(title: "iCloud", symbol: "icloud", selected: false) {
                    showsFileImporter = true
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
        .scrollIndicators(.hidden)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }

    @ViewBuilder private var creationButtons: some View {
        ForEach(AlbatrossDocumentKind.allCases) { kind in
            Button("New \(kind.title.lowercased())", systemImage: kind.symbol) {
                Task { await create(kind) }
            }
        }
    }

    private var selectedConnection: CloudFileConnection? {
        store.connections.first { $0.id == locationID }
    }

    private var cloudLoadKey: String {
        "\(locationID)|\(folderStack.last?.id ?? "root")|\(query)"
    }

    private var visibleDocuments: [AlbatrossDocument] {
        guard locationID == "all" || locationID == "albatross" else { return [] }
        return store.documents.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) }
    }

    private var visibleUploads: [CloudFileItem] {
        guard locationID == "all" || locationID == "albatross" else { return [] }
        return store.uploads.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
    }

    private var visibleCloudItems: [CloudFileItem] {
        cloudItems
            .filter { query.isEmpty || selectedConnection != nil || $0.name.localizedCaseInsensitiveContains(query) }
            .sorted {
                if $0.isFolder != $1.isFolder { return $0.isFolder }
                return $0.name.localizedStandardCompare($1.name) == .orderedAscending
            }
    }

    private var locationTitle: String {
        if locationID == "all" { return "Connected drives" }
        return selectedConnection?.provider == "google_drive" ? "Google Drive" : "OneDrive"
    }

    private var emptyTitle: String {
        query.isEmpty ? "Your files belong here" : "No matching files"
    }

    private var emptyDetail: String {
        if !query.isEmpty { return "Try another name or location." }
        return "Create an AI-editable file, connect a drive, or choose a file from iCloud Drive."
    }

    private func selectLocation(_ id: String) {
        locationID = id
        folderStack = []
        cloudItems = []
    }

    private func create(_ kind: AlbatrossDocumentKind) async {
        do {
            try await environment.createAndOpenDocument(kind: kind)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func connect(provider: String) async {
        isConnecting = true
        defer { isConnecting = false }
        do {
            try await environment.webAuthentication.connectCloudFiles(provider: provider)
            await store.loadFiles()
            if let connection = store.connections.first(where: { $0.provider == provider }) {
                selectLocation(connection.id)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadCloudItems(debounceSearch: Bool = false) async {
        do {
            if debounceSearch, !query.isEmpty {
                try await Task.sleep(for: .milliseconds(350))
                try Task.checkCancellation()
            }
            if let connection = selectedConnection {
                cloudItems = try await store.browse(
                    connectionID: connection.id,
                    query: query,
                    folderID: folderStack.last?.id
                )
                errorMessage = nil
            } else if locationID == "all" {
                let connections = store.connections
                let documentStore = store
                let searchQuery = query
                let outcomes = await withTaskGroup(of: CloudBrowseOutcome.self) { group in
                    for (index, connection) in connections.enumerated() {
                        group.addTask {
                            do {
                                return .success(
                                    index,
                                    try await documentStore.browse(
                                        connectionID: connection.id,
                                        query: searchQuery
                                    )
                                )
                            } catch is CancellationError {
                                return .cancelled
                            } catch {
                                return .failure(connection.label, error.localizedDescription)
                            }
                        }
                    }
                    var collected: [CloudBrowseOutcome] = []
                    for await outcome in group { collected.append(outcome) }
                    return collected
                }
                guard !Task.isCancelled else { return }
                cloudItems = outcomes
                    .compactMap { outcome -> (Int, [CloudFileItem])? in
                        if case .success(let index, let items) = outcome { return (index, items) }
                        return nil
                    }
                    .sorted { $0.0 < $1.0 }
                    .flatMap(\.1)
                let failures = outcomes.compactMap { outcome -> String? in
                    if case .failure(let label, let message) = outcome {
                        return "\(label): \(message)"
                    }
                    return nil
                }
                errorMessage = failures.isEmpty
                    ? nil
                    : "Some drives could not be loaded.\n\(failures.joined(separator: "\n"))"
            } else {
                cloudItems = []
                errorMessage = nil
            }
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func openCloudItem(_ item: CloudFileItem) async {
        if item.isFolder {
            guard selectedConnection != nil else {
                if let connectionID = item.connectionID {
                    locationID = connectionID
                    folderStack = [
                        CloudFolderRoute(id: item.id, name: item.name),
                    ]
                }
                return
            }
            folderStack.append(CloudFolderRoute(id: item.id, name: item.name))
            return
        }
        if item.provider == "google_drive", Self.googleNativeTypes.contains(item.mimeType ?? "") {
            isImporting = true
            defer { isImporting = false }
            do {
                let document = try await store.importGoogle(item)
                environment.navigation.openDocument(id: document.id)
            } catch {
                errorMessage = error.localizedDescription
            }
        } else if let url = item.webURL {
            openURL(url)
        }
    }

    private func importLocalFiles(_ result: Result<[URL], Error>) async {
        do {
            let urls = try result.get()
            let selected = Array(urls.prefix(5))
            var metadata: [(url: URL, size: Int, contentType: String)] = []
            var failures: [String] = []
            for url in selected {
                do {
                    let values = try localFileMetadata(url)
                    metadata.append((url: url, size: values.size, contentType: values.contentType))
                } catch {
                    failures.append("\(url.lastPathComponent): \(error.localizedDescription)")
                }
            }
            let totalBytes = metadata.reduce(0) { $0 + $1.size }
            guard totalBytes <= 25 * 1_024 * 1_024 else {
                throw BackendError.server(
                    status: 413,
                    message: "Choose up to 25 MB of files at a time."
                )
            }
            var uploaded = 0
            for file in metadata {
                do {
                    try await uploadLocalFile(file.url, contentType: file.contentType)
                    uploaded += 1
                } catch {
                    failures.append("\(file.url.lastPathComponent): \(error.localizedDescription)")
                }
            }
            if uploaded > 0 { locationID = "albatross" }
            var notices: [String] = []
            if urls.count > 5 {
                notices.append("Uploaded only the first 5 of \(urls.count) selected files.")
            }
            if !failures.isEmpty {
                notices.append("\(uploaded) uploaded; \(failures.count) failed.\n\(failures.joined(separator: "\n"))")
            }
            errorMessage = notices.isEmpty ? nil : notices.joined(separator: "\n")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func localFileMetadata(_ url: URL) throws -> (size: Int, contentType: String) {
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.contentTypeKey, .fileSizeKey])
        guard let size = values.fileSize, size >= 0 else {
            throw BackendError.server(status: 400, message: "Could not read \(url.lastPathComponent).")
        }
        return (
            size,
            values.contentType?.preferredMIMEType ?? "application/octet-stream"
        )
    }

    private func uploadLocalFile(_ url: URL, contentType: String) async throws {
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        try await store.upload(
            data: data,
            name: url.lastPathComponent,
            contentType: contentType
        )
    }

    private func documentDetail(_ document: AlbatrossDocument) -> String {
        var parts = [
            document.kind.title,
            document.updatedAt.formatted(.relative(presentation: .named)),
        ]
        if document.google != nil { parts.append("Google synced") }
        return parts.joined(separator: " · ")
    }

    private func fileDetail(_ item: CloudFileItem) -> String {
        var parts: [String] = []
        if let size = item.size { parts.append(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)) }
        if let date = item.modifiedAt { parts.append(date.formatted(.relative(presentation: .named))) }
        return parts.isEmpty ? (item.isFolder ? "Folder" : "File") : parts.joined(separator: " · ")
    }

    private func cloudSymbol(_ item: CloudFileItem) -> String {
        switch item.mimeType {
        case "application/vnd.google-apps.document": "doc.text"
        case "application/vnd.google-apps.spreadsheet": "tablecells"
        case "application/vnd.google-apps.presentation": "rectangle.on.rectangle.angled"
        default: "doc"
        }
    }

    private func tint(_ kind: AlbatrossDocumentKind) -> Color {
        switch kind {
        case .doc: .blue
        case .sheet: .green
        case .deck: .orange
        }
    }

    private static let googleNativeTypes: Set<String> = [
        "application/vnd.google-apps.document",
        "application/vnd.google-apps.spreadsheet",
        "application/vnd.google-apps.presentation",
    ]
}

private struct CloudFolderRoute: Hashable {
    let id: String
    let name: String
}

private enum CloudBrowseOutcome: Sendable {
    case success(Int, [CloudFileItem])
    case failure(String, String)
    case cancelled
}

private struct LocationChip: View {
    let title: String
    let symbol: String
    let selected: Bool
    var warning = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: warning ? "exclamationmark.triangle" : symbol)
                .font(.subheadline.weight(selected ? .semibold : .regular))
                .padding(.horizontal, 12)
                .frame(minHeight: 34)
                .background(selected ? Color.accentColor.opacity(0.14) : Color.secondary.opacity(0.08))
                .foregroundStyle(
                    warning ? Color.orange : selected ? Color.accentColor : Color.primary
                )
                .clipShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct FileRow: View {
    let symbol: String
    let title: String
    let detail: String
    let tint: Color

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.title3)
                .foregroundStyle(tint)
                .frame(width: 30)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(.rect)
        .frame(minHeight: 48)
    }
}
