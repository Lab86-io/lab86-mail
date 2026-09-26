import SwiftUI
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#endif

/// Settings, Standing orders (round 2, FEATURES item 14): everything
/// Albatross does without a new request, each with a pause switch. The
/// switch moves only when the server confirms the change.
struct StandingOrdersView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var orders: [StandingOrder] = []
    @State private var didLoad = false
    @State private var loadError: String?
    @State private var busyID: String?
    @State private var errorMessage: String?

    var body: some View {
        Form {
            if let loadError, !didLoad {
                Section {
                    Text(loadError).foregroundStyle(.secondary)
                    Button("Try Again") { Task { await load() } }
                }
            } else if !didLoad {
                Section { ProgressView("Loading your standing orders…") }
            } else {
                Section {
                    Text("Everything Albatross does without a new request from you. Pause any of them here; nothing is deleted.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    LabeledContent("Now", value: StandingOrder.summary(orders))
                }
                ForEach(StandingOrderGroup.allCases, id: \.self) { group in
                    let rows = orders.filter { $0.group == group }
                    if !rows.isEmpty {
                        Section(group.title) {
                            ForEach(rows) { order in
                                orderRow(order)
                            }
                        }
                    }
                }
                Section {
                    Text("Albatross always asks before it reaches another person or makes a change that cannot be undone. Every other change shows in Activity, where you can undo it. A paused order stays paused on every device.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            if let errorMessage {
                Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Standing orders")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    @ViewBuilder private func orderRow(_ order: StandingOrder) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if order.locked {
                LabeledContent(order.title, value: order.hint)
            } else {
                Toggle(isOn: Binding(
                    get: { !order.paused },
                    set: { on in Task { await toggle(order, paused: !on) } }
                )) {
                    Text(order.title)
                }
                .disabled(busyID != nil)
                .accessibilityHint(order.paused ? "Resumes \(order.title)" : "Pauses \(order.title)")
            }
            if !order.detail.isEmpty {
                Text(order.detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !order.locked {
                Text(busyID == order.id ? "Saving…" : order.hint)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            if !order.items.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(order.items.prefix(StandingOrder.itemLimit)) { item in
                        Text(item.detail.map { "\(item.label) · \($0)" } ?? item.label)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if order.items.count > StandingOrder.itemLimit {
                        Text("and \(order.items.count - StandingOrder.itemLimit) more")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
                .padding(.leading, 10)
                .overlay(alignment: .leading) {
                    Rectangle().fill(environment.theme.hairlineColor).frame(width: 1)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func load() async {
        do {
            let json = try await environment.backend.get(path: StandingOrder.path)
            orders = StandingOrder.list(from: json)
            didLoad = true
            loadError = nil
        } catch {
            loadError = "Could not load your standing orders."
        }
    }

    private func toggle(_ order: StandingOrder, paused: Bool) async {
        busyID = order.id
        defer { busyID = nil }
        do {
            let json = try await environment.backend.post(
                path: StandingOrder.path,
                body: StandingOrder.toggleBody(id: order.id, paused: paused)
            )
            guard let saved = json["order"].flatMap(StandingOrder.init(json:)) else {
                throw BackendError.invalidResponse
            }
            if let index = orders.firstIndex(where: { $0.id == saved.id }) { orders[index] = saved }
            errorMessage = nil
            PlatformAccessibility.announce(saved.paused ? "\(saved.title) is paused" : "\(saved.title) is on")
        } catch {
            errorMessage = error.localizedDescription.nilIfBlank ?? "Could not change the standing order."
        }
    }
}

/// The plan and its trial, read from `GET /api/billing/plan`. The note says
/// when the trial ends; nothing here sells.
struct PlanSettingsRows: View {
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        if let plan = environment.trust.plan {
            LabeledContent("Plan", value: plan.planName)
            if let note = plan.trialNote {
                Text(note).font(.footnote).foregroundStyle(.secondary)
            } else if let detail = plan.detailLine {
                Text(detail).font(.footnote).foregroundStyle(.secondary)
            }
        } else {
            LabeledContent("Plan", value: "Checking…")
        }
    }
}

/// The Files switch of Settings, Advanced (FEATURES item 17). The sidebar
/// changes only after the server stores the choice.
struct FilesSurfaceToggle: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        Toggle("Show Files", isOn: Binding(
            get: { environment.trust.showsFiles },
            set: { on in Task { await save(on) } }
        ))
        .disabled(isSaving)
        if let errorMessage {
            Text(errorMessage).font(.footnote).foregroundStyle(.red)
        }
    }

    private func save(_ on: Bool) async {
        isSaving = true
        defer { isSaving = false }
        do {
            try await environment.trust.setFilesSurface(on)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription.nilIfBlank ?? "Could not change Files."
        }
    }
}

/// Export my data (FEATURES item 15): the server streams a ZIP; the phone
/// offers it in the share sheet and the Mac in a save panel. Success reads
/// only when the whole file arrived.
struct DataExportButton: View {
    @Environment(AppEnvironment.self) private var environment
    var label = "Export my data"
    @State private var isExporting = false
    @State private var exported: ExportedFile?
    @State private var errorMessage: String?
    @State private var savedMessage: String?

    var body: some View {
        Button(isExporting ? "Preparing export…" : label) {
            Task { await export() }
        }
        .disabled(isExporting)
        #if os(iOS)
        .sheet(item: $exported) { file in
            ExportShareSheet(items: [file.url])
        }
        #endif
        if let errorMessage {
            Text(errorMessage).font(.footnote).foregroundStyle(.red)
        } else if let savedMessage {
            Text(savedMessage).font(.footnote).foregroundStyle(.secondary)
        }
    }

    private func export() async {
        isExporting = true
        errorMessage = nil
        savedMessage = nil
        defer { isExporting = false }
        do {
            let download = try await environment.backend.download(path: DataExport.path)
            let url = try DataExport.stage(download)
            #if os(macOS)
            savedMessage = try Self.save(url)
            #else
            exported = ExportedFile(url: url)
            #endif
        } catch {
            errorMessage = error.localizedDescription.nilIfBlank ?? "Could not export your data."
        }
    }

    #if os(macOS)
    @MainActor
    private static func save(_ url: URL) throws -> String? {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = url.lastPathComponent
        panel.allowedContentTypes = [.zip]
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let destination = panel.url else { return nil }
        if FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.copyItem(at: url, to: destination)
        return "Your export is saved as \(destination.lastPathComponent)."
    }
    #endif
}

struct ExportedFile: Identifiable, Equatable {
    let url: URL
    var id: URL { url }
}

#if os(iOS)
private struct ExportShareSheet: UIViewControllerRepresentable {
    let items: [URL]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
#endif
