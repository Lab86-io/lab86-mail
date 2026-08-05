import SwiftUI

/// The Albatrosses page: every unresolved outcome the user is carrying.
///
/// It used to list Areas, which is how Albatrosses are filed, not what they
/// are. A page named after the thing the product is about has to show that
/// thing. Areas keep their own place at the foot of the list.
struct WorkView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var filter: WorkFilter = .all
    @State private var showsClosed = false

    private var store: ProductStore { environment.store }

    private var groups: [(state: WorkState, items: [WorkListItem])] {
        WorkGrouping.group(WorkGrouping.filter(store.allWork, by: filter, areaID: nil))
    }

    private var openGroups: [(state: WorkState, items: [WorkListItem])] {
        groups.filter { !WorkState.closed.contains($0.state) }
    }

    private var closedGroups: [(state: WorkState, items: [WorkListItem])] {
        groups.filter { WorkState.closed.contains($0.state) }
    }

    private var unhomedCount: Int {
        store.allWork.filter { $0.primaryAreaID == nil }.count
    }

    var body: some View {
        @Bindable var navigation = environment.navigation
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                filters

                if store.workError != nil {
                    WorkRefreshWarning(retry: retryWork)
                        .padding(.horizontal, 20)
                        .padding(.bottom, 12)
                }

                if openGroups.isEmpty && closedGroups.isEmpty {
                    emptyState
                } else {
                    ForEach(openGroups, id: \.state) { group in
                        workGroup(group.state, items: group.items)
                    }
                    if showsClosed {
                        ForEach(closedGroups, id: \.state) { group in
                            workGroup(group.state, items: group.items)
                        }
                    }
                }

                if !store.areas.isEmpty {
                    areasFooter
                }
            }
            .padding(.bottom, 40)
        }
        // The list is now a place you open an Albatross from, so the detail has
        // to be reachable here and not only from inside an Area.
        .navigationDestination(item: $navigation.workRoute) { route in
            WorkDetailView(route: route)
        }
        .navigationTitle("Albatrosses")
        .toolbar {
            if !closedGroups.isEmpty {
                ToolbarItem(placement: .primaryAction) {
                    Button(showsClosed ? "Hide finished" : "Show finished") {
                        showsClosed.toggle()
                    }
                    .font(.footnote)
                }
            }
        }
        .refreshable { await store.refreshWork() }
        .shellToolbar()
    }

    /// Filters as a glass capsule row: the material Apple uses for controls that
    /// float over content, so the list reads as the page and these read as the
    /// handles on it.
    private var filters: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                filterPill(.all)
                filterPill(.needsYou)
                if unhomedCount > 0 { filterPill(.unhomed) }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
        }
    }

    private func filterPill(_ value: WorkFilter) -> some View {
        let active = filter == value
        return Button {
            filter = value
        } label: {
            Text(value.label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? Color.accentColor : Color.secondary)
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .capsule)
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }

    /// A section rule, weighted by whether the group is asking for anything.
    /// Needs-you carries the accent; everything else is a hairline.
    @ViewBuilder
    private func workGroup(_ state: WorkState, items: [WorkListItem]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Rectangle()
                    .fill(state.asksForYou ? Color.accentColor : Color.secondary.opacity(0.45))
                    .frame(width: 18, height: 1)
                Text(state.label).font(.system(.subheadline, design: .serif).weight(.semibold))
                Text(state.hint).font(.caption2).foregroundStyle(.tertiary)
                Spacer(minLength: 0)
            }

            VStack(spacing: 0) {
                ForEach(items) { item in
                    Button {
                        environment.navigation.openWork(id: item.id, title: item.displayTitle)
                    } label: {
                        WorkListRow(item: item)
                    }
                    .buttonStyle(.plain)
                    if item.id != items.last?.id {
                        Divider().padding(.leading, 14)
                    }
                }
            }
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color(.secondarySystemGroupedBackground))
            )
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 24)
    }

    private var areasFooter: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Rectangle().fill(Color.secondary.opacity(0.45)).frame(width: 18, height: 1)
                Text("Areas").font(.system(.subheadline, design: .serif).weight(.semibold))
                Text("The parts of life these belong to.").font(.caption2).foregroundStyle(.tertiary)
                Spacer(minLength: 0)
            }
            VStack(spacing: 0) {
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
        .padding(.horizontal, 20)
    }

    // With no last-good work to keep readable, distinguish the three honest
    // states: still loading (no cache yet), a failed first load with retry, and
    // a genuine empty result after a successful load.
    @ViewBuilder
    private var emptyState: some View {
        if !store.workDidLoad && store.workError == nil {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Loading what you are carrying…").foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40)
        } else if let error = store.workError {
            VStack(alignment: .leading, spacing: 8) {
                Label("Couldn’t load your Albatrosses", systemImage: "exclamationmark.triangle")
                    .font(.subheadline.weight(.medium))
                Text(error).font(.caption).foregroundStyle(.secondary)
                Button("Try Again") { retryWork() }.buttonStyle(.bordered)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 24)
        } else {
            ContentUnavailableView {
                Label(
                    filter == .all ? "Nothing on your mind yet" : "Nothing under this filter",
                    systemImage: "checkmark.circle"
                )
            } description: {
                Text(
                    filter == .all
                        ? "Tell Albatross what you are carrying and it starts here."
                        : "Try Everything to see the rest."
                )
            } actions: {
                if filter == .all {
                    Button("Get something out of your head") {
                        environment.navigation.sheet = .assistant
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            .padding(.vertical, 20)
        }
    }

    private func retryWork() {
        Task { await store.refreshWork() }
    }
}

/// One Albatross: what it is, where it stands, and the area it belongs to.
private struct WorkListRow: View {
    let item: WorkListItem

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(item.displayTitle)
                    .font(item.state.asksForYou ? .system(.subheadline, design: .serif).weight(.semibold) : .subheadline)
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                HStack(spacing: 6) {
                    Text(item.standingLine)
                    if let areaName = item.areaName {
                        Text("·")
                        Text(areaName)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            StateChip(state: item.state)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
    }
}

/// The state, said in words. A chip that asks for you is outlined in a dashed
/// rule, so an unanswered thing never reads as settled.
private struct StateChip: View {
    let state: WorkState

    var body: some View {
        Text(state.label)
            .font(.caption2)
            .foregroundStyle(state.asksForYou ? Color.accentColor : Color.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .overlay(
                Capsule().strokeBorder(
                    state.asksForYou ? Color.accentColor.opacity(0.6) : Color.secondary.opacity(0.3),
                    style: StrokeStyle(lineWidth: 1, dash: state == .unresolved ? [3, 2] : [])
                )
            )
            .fixedSize()
    }
}
private struct WorkRefreshWarning: View {
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(.orange)
                .accessibilityHidden(true)
            // Keep the message and the Retry control as separate accessibility
            // elements so VoiceOver can still activate the button.
            Text("Showing what was saved — couldn’t refresh.")
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
