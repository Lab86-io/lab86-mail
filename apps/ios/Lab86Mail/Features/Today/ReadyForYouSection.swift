import SwiftUI

// "Ready for you" at the top of the newest daily edition: the handoffs that
// wait for the user and the runs at work, one row for each Work. The list is
// live (`GET /api/albatross/handoffs`), not part of the edition document, so
// a handoff that lands after the morning edition still appears. Hidden when
// it is empty. Mirrors the web's `ReadyForYou` list.

/// The transport behind the list, so the store runs against a scripted
/// server in tests. `BackendClient` is the production conformer.
protocol StepHandoffTransport: Sendable {
    func listHandoffs() async throws -> [StepHandoffItem]
}

extension BackendClient: StepHandoffTransport {
    func listHandoffs() async throws -> [StepHandoffItem] {
        let json = try await get(path: StepHandoffItem.path)
        return StepHandoffItem.list(from: json)
    }
}

/// Read-through state for the list. Never cached to disk: a handoff is a
/// live server row that any client can dismiss or resume.
@MainActor
@Observable
final class ReadyForYouStore {
    private(set) var items: [StepHandoffItem] = []
    private(set) var error: String?
    private(set) var loaded = false
    private var revision = 0

    /// Hidden until there is a row. An error never shows on the Brief.
    var isVisible: Bool { !items.isEmpty }

    func clear() {
        revision += 1
        items = []
        error = nil
        loaded = false
    }

    func load(_ transport: any StepHandoffTransport) async {
        revision += 1
        let requestRevision = revision
        do {
            let rows = try await transport.listHandoffs()
            guard revision == requestRevision, !Task.isCancelled else { return }
            items = rows
            error = nil
            loaded = true
        } catch {
            guard revision == requestRevision, !Task.isCancelled else { return }
            loaded = true
            self.error = error.localizedDescription
        }
    }

    /// Take a row out at once (after "Dismiss" elsewhere, or when its Work
    /// opens). The next load puts it back if the server still has it.
    func remove(id: String) {
        items.removeAll { $0.id == id }
    }
}

struct ReadyForYouSection: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @State private var store = ReadyForYouStore()
    @State private var busyID: String?

    static let pollInterval: Duration = .seconds(20)

    var body: some View {
        // The poll lives on a container that always appears, so the first
        // load runs while the store is still empty and hidden.
        VStack(spacing: 0) { content }
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                while !Task.isCancelled {
                    await store.load(environment.backend)
                    do { try await Task.sleep(for: Self.pollInterval) } catch { return }
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        if store.isVisible {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Rectangle()
                        .fill(Color.secondary.opacity(0.45))
                        .frame(width: 18, height: 1)
                    Text("Ready for you")
                        .font(.system(.subheadline, design: .serif).weight(.semibold))
                    Spacer(minLength: 0)
                }
                .padding(.bottom, 4)
                ForEach(store.items) { item in
                    Divider()
                    #if os(macOS)
                    // The Mac row: the text at the left, one button at the
                    // trailing edge, a hover fill, and a context menu.
                    MacReadyForYouRow(
                        item: item,
                        busy: busyID == item.id,
                        onOpen: { openWork(item) },
                        onAct: { Task { await act(item) } },
                        onDismiss: { Task { await dismiss(item) } }
                    )
                    #else
                    row(item)
                    #endif
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 24)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Ready for you")
        }
    }

    private func row(_ item: StepHandoffItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                openWork(item)
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.workTitle)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if item.run.state.isOpen {
                            ProgressView()
                                .controlSize(.mini)
                        }
                        Text(StepRunCopy.readyRowTitle(item.run))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text(StepRunCopy.readyRowLine(item.run))
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if item.run.isHandoff, let next = item.run.next {
                Button(busyID == item.id ? "Opening…" : next.label) {
                    Task { await act(item) }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(busyID != nil)
            }
        }
        .padding(.vertical, 12)
        .accessibilityElement(children: .contain)
    }

    private func openWork(_ item: StepHandoffItem, intent: WorkRoute.Intent? = nil) {
        environment.navigation.openWork(id: item.workID, title: item.workTitle, intent: intent)
    }

    /// The primary button does what it does in the thread. A page handoff
    /// opens the thread with its page; a question opens the thread, where
    /// the form waits.
    private func act(_ item: StepHandoffItem) async {
        busyID = item.id
        defer { busyID = nil }
        let behaviour = StepRunNextBehaviour.from(item.run.next)
        let opened = await StepRunActions.open(behaviour, environment: environment, openURL: openURL)
        if !opened { openWork(item, intent: behaviour == .openBrowser ? .openPage : nil) }
    }

    /// "Dismiss" closes the handoff on the server; the row leaves at once.
    private func dismiss(_ item: StepHandoffItem) async {
        busyID = item.id
        defer { busyID = nil }
        if await environment.store.dismissStepRun(item.workID, run: item.run) {
            store.remove(id: item.id)
        }
    }
}
