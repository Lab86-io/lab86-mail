import SwiftUI

// The Mac shell: a persistent three-pane arrangement — sidebar, then the
// selected product surface with its own navigation — carrying the same
// bootstrap, sheet routing, status overlays, and notification-action loops as
// the iOS shell. Freshness on the Mac comes from Convex live subscriptions,
// foreground activation, and remote-notification wakes; there is no
// BGTaskScheduler here and the process simply stays alive.
struct MacShellView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var columnVisibility = NavigationSplitViewVisibility.all

    var body: some View {
        @Bindable var navigation = environment.navigation
        NavigationSplitView(columnVisibility: $columnVisibility) {
            MacSourceList()
                .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 340)
                .toolbar {
                    // The web rail's create button, in the sidebar's chrome.
                    ToolbarItem(placement: .automatic) {
                        GlobalCreateMenu {
                            Label("Create", systemImage: "plus")
                        }
                    }
                }
        } detail: {
            NavigationStack {
                RootDestinationView()
            }
        }
        .navigationSplitViewStyle(.balanced)
        .overlay(alignment: .bottom) {
            ShellStatusOverlay()
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
        }
        .overlay {
            MacChatOverlay()
        }
        .task {
            let ownerID = environment.sessionStore.ownerID
            _ = await environment.flushCommandOutbox(ownerID: ownerID)
            if let ownerID {
                _ = await environment.refreshAccounts(ownerID: ownerID)
            }
            await environment.store.bootstrap(cacheOwner: ownerID)
            await environment.notifications.refreshAuthorizationStatus()
            await environment.notifications.retryPendingTextResponses()
            environment.navigation.consumeAppIntentRequests()
            await ShellNotificationActions.consumePendingMailAction(environment: environment)
            await environment.pendingSends.reconcile(ownerID: environment.sessionStore.ownerID)
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            environment.navigation.consumeAppIntentRequests()
            Task {
                await environment.notifications.retryPendingTextResponses()
                await ShellNotificationActions.consumePendingMailAction(environment: environment)
                await environment.pendingSends.reconcile(ownerID: environment.sessionStore.ownerID)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .lab86RemoteWake)) { _ in
            Task {
                let ownerID = environment.sessionStore.ownerID
                _ = await environment.flushCommandOutbox(ownerID: ownerID)
                if let ownerID {
                    _ = await environment.refreshAccounts(ownerID: ownerID)
                }
                await environment.store.bootstrap(cacheOwner: ownerID)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .lab86MailNotificationAction)) { _ in
            Task { await ShellNotificationActions.consumePendingMailAction(environment: environment) }
        }
        .sheet(item: $navigation.sheet) { destination in
            switch destination {
            case .assistant:
                AssistantView()
                    .frame(minWidth: 520, minHeight: 560)
            case .activity:
                // Grouped keeps AppKit's legacy columnar Form layout (clipped
                // leading labels) out of every sheet-hosted settings surface.
                ActivityView()
                    .formStyle(.grouped)
                    .frame(minWidth: 520, minHeight: 560)
            case .compose:
                ComposeView()
                    .frame(minWidth: 640, minHeight: 560)
            case .settings:
                SettingsView()
                    .formStyle(.grouped)
                    .frame(minWidth: 620, minHeight: 620)
            }
        }
        .alert(
            "Albatross couldn’t finish that",
            isPresented: Binding(
                get: { environment.store.errorMessage != nil },
                set: { if !$0 { environment.store.clearError() } }
            )
        ) {
            Button("OK") { environment.store.clearError() }
        } message: {
            Text(environment.store.errorMessage ?? "Try again.")
        }
        .alert(
            "Pending message",
            isPresented: Binding(
                get: { environment.pendingSends.errorMessage != nil },
                set: { if !$0 { environment.pendingSends.errorMessage = nil } }
            )
        ) {
            Button("OK") { environment.pendingSends.errorMessage = nil }
        } message: {
            Text(environment.pendingSends.errorMessage ?? "Albatross will check again.")
        }
    }
}

// The Mac sidebar: the same destinations as the iOS wheel — product sources,
// then the user's areas — as a conventional Mac source list.
struct MacSourceList: View {
    @Environment(AppEnvironment.self) private var environment

    private var primaries: [PrimaryTab] { PrimaryTab.sourceList }
    private var areas: [AreaSummary] { environment.store.areas }

    var body: some View {
        List {
            Section {
                ForEach(primaries) { destination in
                    sourceRow(destination)
                }
            }
            Section("Your areas") {
                if areas.isEmpty {
                    areaState
                } else {
                    ForEach(areas) { area in
                        areaRow(area)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 0) {
                Divider()
                Button {
                    environment.navigation.sheet = .settings
                } label: {
                    Label("Settings", systemImage: "gearshape")
                        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                        .contentShape(.rect)
                        .padding(.horizontal, 12)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens account and app settings")
            }
        }
        .navigationTitle("Albatross")
    }

    private func sourceRow(_ destination: PrimaryTab) -> some View {
        let selected = environment.navigation.selectedTab == destination
            && (destination != .work || environment.navigation.areaRoute == nil)
        return Button {
            environment.navigation.selectPrimary(destination)
        } label: {
            Label(destination.title, systemImage: destination.symbol)
                .fontWeight(selected ? .semibold : .regular)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .listRowBackground(
            selected
                ? RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.primary.opacity(0.08))
                : nil
        )
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    private func areaRow(_ area: AreaSummary) -> some View {
        let selected = environment.navigation.selectedTab == .work
            && environment.navigation.areaRoute?.areaID == area.id
        return Button {
            environment.navigation.openArea(id: area.id, name: area.name)
        } label: {
            HStack(spacing: 10) {
                AreaIdentityMark(
                    name: area.name,
                    seed: area.id,
                    imageURL: area.imageURL,
                    faviconURL: area.faviconURL,
                    size: 26
                )
                VStack(alignment: .leading, spacing: 1) {
                    Text(area.name)
                        .fontWeight(selected ? .semibold : .regular)
                        .lineLimit(1)
                    if let line = area.overview?.statusLine ?? area.detail, !line.isEmpty {
                        Text(line)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                if area.overview?.needsAttention == true {
                    Circle()
                        .fill(environment.theme.accent2Color)
                        .frame(width: 7, height: 7)
                        .accessibilityLabel("Needs attention")
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .listRowBackground(
            selected
                ? RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.primary.opacity(0.08))
                : nil
        )
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    @ViewBuilder private var areaState: some View {
        switch AreaListState.resolve(
            isLoading: environment.store.isLoadingWork,
            didLoad: environment.store.workDidLoad,
            hasError: environment.store.workError != nil
        ) {
        case .loading:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Loading areas…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        case .failed:
            Button("Retry loading Areas") {
                Task { await environment.store.refreshWork() }
            }
        case .empty:
            Text("No active areas")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}
