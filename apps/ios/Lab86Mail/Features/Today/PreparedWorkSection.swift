import MobileAPI
import QuickLook
import SwiftUI

// "Prepared for you" under the letter: research and draft files the server
// prepared in the background. One card per preparation with the SBAR read,
// the questions to settle, the files, the sources, and the Adopt, Dismiss
// and Refresh actions. Copy mirrors `components/report/PreparedWork.tsx`.
// Mounted only under the latest edition, the same as the web's `!selectedId`.
struct PreparedWorkSection: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.scenePhase) private var scenePhase
    @State private var store = PreparedWorkStore()

    var body: some View {
        if let client = environment.preparedWork {
            // The poll lives on a container that always appears, so the
            // first load runs while the store is still empty and hidden.
            VStack(spacing: 0) { content(client) }
                .task(id: scenePhase) {
                    guard scenePhase == .active else { return }
                    while !Task.isCancelled {
                        await store.load(client)
                        do { try await Task.sleep(for: .seconds(30)) } catch { return }
                    }
                }
                .onDisappear { store.clear() }
        }
    }

    @ViewBuilder
    private func content(_ client: PreparedWorkClient) -> some View {
        if store.isVisible {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Rectangle()
                        .fill(Color.secondary.opacity(0.45))
                        .frame(width: 18, height: 1)
                    Text("Prepared for you")
                        .font(.system(.subheadline, design: .serif).weight(.semibold))
                    Spacer(minLength: 0)
                }
                Text("Research and draft files, updated as sources change. These stay in your Brief until you adopt them.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 4)
                    .padding(.bottom, 12)
                if let error = store.error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, 12)
                }
                ForEach(store.items) { item in
                    Divider()
                    PreparedWorkCard(item: item, busy: store.busy) { action in
                        await perform(action, for: item, client: client)
                    }
                }
                if let message = store.message, store.error == nil {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.top, 8)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 24)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Prepared for you")
        }
    }

    /// Adopt creates the work (or extends existing work) and opens it, the
    /// way the web's "Saved to your work. Open Albatross." link does.
    /// Returns whether the write succeeded.
    private func perform(_ action: PreparedWorkAction, for item: PreparedItem, client: PreparedWorkClient) async -> Bool {
        guard let result = await store.perform(action, transport: client) else { return false }
        if action.operation == .adopt, let workID = result.workID {
            await environment.store.refreshWork()
            environment.navigation.openWork(id: workID, title: item.draft?.title)
        }
        return true
    }
}

struct PreparedWorkCard: View {
    let item: PreparedItem
    let busy: Bool
    let onAction: @MainActor (PreparedWorkAction) async -> Bool

    @Environment(\.openURL) private var openURL
    @State private var open = false
    @State private var notes = ""
    @State private var dirty = false
    @State private var previewURL: URL?
    @State private var stagedFiles: [String: URL] = [:]

    private var draft: PreparedDraft? { item.draft }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(draft?.title ?? "Researching a useful next step…")
                    .font(.subheadline.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if let label = PreparedWorkPolicy.shapeLabel(item) {
                    Text(label)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            if let draft, !draft.situation.isEmpty {
                Text(draft.situation)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(PreparedWorkPolicy.statusLine(item))
                .font(.caption)
                .foregroundStyle(.secondary)
            if let error = item.error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            actions
            if open, let draft {
                review(draft)
            }
        }
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { if !dirty { notes = item.userNotes } }
        .onChange(of: item.userNotes) { _, newValue in
            if !dirty { notes = newValue }
        }
        .onChange(of: open) { _, isOpen in
            if isOpen { stageFiles() }
        }
        .onChange(of: item.files) { _, _ in
            if open { stageFiles() }
        }
        .quickLookPreview($previewURL)
    }

    private var actions: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Button(open ? "Close review" : "Review draft") {
                    withAnimation(.snappy(duration: 0.2)) { open.toggle() }
                }
                .buttonStyle(.bordered)
                .disabled(draft == nil)
                Button(PreparedWorkPolicy.adoptLabel(item)) {
                    Task { _ = await onAction(.adopt(item)) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!PreparedWorkPolicy.canAdopt(item, busy: busy, dirty: dirty))
                Button("Dismiss") {
                    Task { _ = await onAction(.dismiss(item)) }
                }
                .buttonStyle(.borderless)
                .disabled(busy)
            }
            if PreparedWorkPolicy.showsRefresh(item) {
                Button("Refresh preparation") {
                    Task { _ = await onAction(.refresh(item)) }
                }
                .buttonStyle(.borderless)
                .disabled(busy || dirty)
            }
        }
        .controlSize(.small)
        .padding(.top, 4)
    }

    @ViewBuilder
    private func review(_ draft: PreparedDraft) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            readBlock("Relevant trail", draft.background)
            readBlock("My read", draft.assessment)
            readBlock("Your move", draft.recommendation)
            if !draft.questions.isEmpty {
                reviewBlock("Questions to settle") { bullets(draft.questions) }
            }
            if !draft.steps.isEmpty {
                reviewBlock("Steps") { bullets(draft.steps) }
            }
            reviewBlock("Your answers and notes") {
                TextEditor(text: $notes)
                    .font(.subheadline)
                    .frame(minHeight: 96)
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
                    }
                    .onChange(of: notes) { _, newValue in
                        dirty = newValue != item.userNotes
                    }
                    .accessibilityLabel("Your answers and notes")
                HStack(spacing: 12) {
                    Button("Save edits") {
                        Task {
                            if await onAction(.edit(item, notes: notes)) { dirty = false }
                        }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(busy || !dirty)
                    if dirty {
                        Text("Save your edits before adopting or refreshing.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            if !item.files.isEmpty {
                reviewBlock("Files") {
                    ForEach(item.files, id: \.name) { file in
                        fileRow(file)
                    }
                }
            }
            if !draft.evidence.isEmpty {
                reviewBlock("Sources") {
                    ForEach(Array(draft.evidence.enumerated()), id: \.offset) { _, evidence in
                        sourceRow(evidence)
                    }
                }
            }
        }
        .padding(.top, 8)
        .transition(.opacity)
    }

    @ViewBuilder
    private func readBlock(_ label: String, _ text: String) -> some View {
        if !text.isEmpty {
            reviewBlock(label) {
                Text(text)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func reviewBlock<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.subheadline.weight(.medium))
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func bullets(_ lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("•").foregroundStyle(.secondary)
                    Text(line)
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// A file row: name, kind and size. Tap to preview; Download hands the
    /// staged temp file to the share sheet.
    private func fileRow(_ file: PreparedFile) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Button {
                previewURL = stagedURL(for: file)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(file.name)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                    Text("\(file.kind) · \(PreparedWorkPolicy.sizeLabel(byteCount: file.byteCount))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(file.name), \(file.kind), \(PreparedWorkPolicy.sizeLabel(byteCount: file.byteCount))")
            .accessibilityHint("Opens a preview")
            if let url = stagedFiles[file.name] {
                ShareLink(item: url) {
                    Text("Download")
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
            }
        }
        .padding(.vertical, 4)
    }

    private func sourceRow(_ evidence: PreparedEvidence) -> some View {
        let source = item.source(for: evidence)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                if let source, let url = source.url {
                    Button {
                        openURL(url)
                    } label: {
                        Text(source.title)
                            .font(.caption)
                            .underline()
                            .foregroundStyle(.primary)
                    }
                    .buttonStyle(.plain)
                } else {
                    Text(source?.title ?? "Source")
                        .font(.caption)
                }
                if let version = source?.version, !version.isEmpty {
                    Text("· version \(version)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if source?.partial == true {
                    Text("· partial content")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Text(evidence.quote)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, 10)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(Color.primary.opacity(0.12))
                        .frame(width: 2)
                }
        }
        .padding(.vertical, 2)
    }

    // MARK: - Files on disk

    /// Writes every draft file to a per-preparation temp directory so the
    /// preview and the share sheet read a real file.
    private func stageFiles() {
        var staged: [String: URL] = [:]
        for file in item.files {
            if let url = write(file) { staged[file.name] = url }
        }
        stagedFiles = staged
    }

    private func stagedURL(for file: PreparedFile) -> URL? {
        stagedFiles[file.name] ?? write(file)
    }

    private func write(_ file: PreparedFile) -> URL? {
        try? PreparedWorkPolicy.stageFile(file, itemID: item.id)
    }
}
