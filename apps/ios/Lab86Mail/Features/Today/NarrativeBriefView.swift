import SwiftUI

/// The same source-backed account as the web Brief, with native typography and
/// a read-only evidence sheet. No external action is inferred from its prose.
struct NarrativeBriefView: View {
    let memory: NarrativeBriefStore
    let backend: BackendClient
    @State private var showsSources = false

    var body: some View {
        if let entry = memory.entry {
            VStack(alignment: .leading, spacing: 12) {
                Text(entry.text)
                    .font(.system(.body, design: .serif))
                    .lineSpacing(5)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Button {
                    showsSources = true
                } label: {
                    Label("^[Read the \(entry.sourceIDs.count) supporting observation](inflect: true)", systemImage: "text.book.closed")
                        .font(.subheadline)
                        .frame(minHeight: 44)
                }
                .accessibilityIdentifier("narrative.sources")
                if !entry.modelWritten {
                    Text("Source-backed account. The narrative writer has not finished this edition.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let error = memory.error { Text(error).font(.caption).foregroundStyle(.secondary) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
            .sheet(isPresented: $showsSources) {
                NarrativeSourcesSheet(id: entry.id, backend: backend)
            }
        } else if memory.enabled {
            Text(memory.error ?? (memory.running ? "Your narrative is being prepared." : "No narrative account is ready for this edition."))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 20)
        }
    }
}

private struct NarrativeSourcesSheet: View {
    let id: String
    let backend: BackendClient
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var memory = NarrativeBriefStore()

    var body: some View {
        NavigationStack {
            List {
                if let error = memory.error {
                    Text(error).foregroundStyle(.secondary)
                    Button("Try Again") { Task { await reload() } }
                } else if memory.isLoading && memory.entry == nil {
                    ProgressView("Loading supporting observations…")
                } else if memory.entry == nil {
                    Text("This account is no longer available. Its sources may have changed or been removed.")
                        .foregroundStyle(.secondary)
                } else {
                    Section {
                        Text("These are linked observations, not independent confirmation. Verify time-sensitive details at their original source.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    ForEach(memory.sources) { source in
                        Section(source.title) {
                            Text(source.text).textSelection(.enabled)
                        }
                    }
                }
            }
            .navigationTitle("Supporting observations")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .refreshable { await reload() }
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { memory.clear(); return }
            while !Task.isCancelled {
                await reload()
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
            }
        }
        .onDisappear { memory.clear() }
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 420)
        #endif
    }

    private func reload() async {
        await memory.load(.sources(id)) { try await backend.get(path: $0) }
    }
}
