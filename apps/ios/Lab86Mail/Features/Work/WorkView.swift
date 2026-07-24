import SwiftUI

struct WorkView: View {
    @Environment(AppEnvironment.self) private var environment

    private var store: ProductStore { environment.store }

    var body: some View {
        List {
            Section {
                Button {
                    environment.navigation.sheet = .assistant
                } label: {
                    Label("Get something out of your head", systemImage: "plus.bubble")
                }
            }

            Section("Areas") {
                if store.areas.isEmpty {
                    emptyAreasState
                } else {
                    if store.workError != nil {
                        WorkRefreshWarning(retry: retryWork)
                    }
                    ForEach(store.areas) { area in
                        Button {
                            environment.navigation.openArea(id: area.id, name: area.name)
                        } label: {
                            AreaListRow(area: area)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .navigationTitle("Areas")
        .refreshable { await store.refreshWork() }
        .shellToolbar()
    }

    // With no last-good areas to keep readable, distinguish the three honest
    // states: still loading (no cache yet), a failed first load with retry, and a
    // genuine empty result after a successful load.
    @ViewBuilder
    private var emptyAreasState: some View {
        if let error = store.workError {
            ContentUnavailableView {
                Label("Couldn’t load areas", systemImage: "exclamationmark.triangle")
            } description: {
                Text(error)
            } actions: {
                Button("Try Again", action: retryWork)
            }
        } else if store.isLoadingWork || !store.workDidLoad {
            HStack(spacing: 10) {
                ProgressView()
                Text("Loading areas…").foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 12)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Loading areas")
        } else {
            ContentUnavailableView(
                "No active areas",
                systemImage: "square.stack.3d.up",
                description: Text("Capture what you’re trying to move forward and Albatross will help place it.")
            )
        }
    }

    private func retryWork() {
        Task { await store.refreshWork() }
    }
}

// Cached (last-good) areas stay visible when a refresh fails; a compact, quiet
// banner explains the staleness and offers a local retry without blanking the
// list or raising the app-wide alert.
private struct WorkRefreshWarning: View {
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(.orange)
                .accessibilityHidden(true)
            // Keep the message and the Retry control as separate accessibility
            // elements so VoiceOver can still activate the button.
            Text("Showing saved areas — couldn’t refresh.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Button("Retry", action: retry)
                .font(.footnote.weight(.medium))
        }
        .padding(.vertical, 2)
    }
}

private struct AreaListRow: View {
    let area: AreaSummary

    var body: some View {
        HStack(spacing: 12) {
            AreaIdentityMark(
                name: area.name,
                seed: area.id,
                imageURL: area.imageURL,
                faviconURL: area.faviconURL,
                size: 30
            )
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(area.name).font(.headline).lineLimit(1)
                    Spacer(minLength: 4)
                    Text(area.kind.capitalized)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Text(area.overview?.statusLine ?? area.detail ?? "Area")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if area.overview?.needsAttention == true {
                Circle().fill(.orange).frame(width: 8, height: 8).accessibilityHidden(true)
            }
            Image(systemName: "chevron.forward")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .padding(.vertical, 3)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(.isButton)
    }

    private var accessibilityLabel: String {
        var parts = [area.name, area.kind]
        if let status = area.overview?.statusLine { parts.append(status) }
        if area.overview?.needsAttention == true { parts.append("needs attention") }
        return parts.joined(separator: ", ")
    }
}

// A stable per-area colour. `String.hashValue` is randomly seeded each process
// launch, so it cannot give an area the same colour twice, and `abs(Int.min)`
// traps; a fixed FNV-1a hash over the id's UTF-8 bytes reduced with unsigned
// modulo is deterministic across launches and cannot overflow-trap. Shared with
// AreaDetailView's monogram so both surfaces render the same colour for an id.
enum AreaMonogramPalette {
    static let colors: [Color] = [.blue, .purple, .teal, .orange, .pink, .indigo, .green, .red]

    static func index(for seed: String, count: Int) -> Int {
        guard count > 0 else { return 0 }
        var hash: UInt64 = 14_695_981_039_346_656_037 // FNV-1a offset basis
        for byte in seed.utf8 {
            hash = (hash ^ UInt64(byte)) &* 1_099_511_628_211 // FNV-1a prime
        }
        return Int(hash % UInt64(count))
    }

    static func color(for seed: String) -> Color {
        colors[index(for: seed, count: colors.count)]
    }
}
