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
        .overlay(alignment: .topTrailing) {
            MacWakeNudgeOverlay()
                .padding(.horizontal, 16)
                .padding(.top, 8)
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
            case .workspace(let destination):
                NativeWorkspaceView(destination: destination)
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

// Which source-list row reads as selected, and what a row asks the mail
// list for. Pure, so the rules are testable.
enum MacSourceSelection {
    // A primary row is selected while its tab is up. An open Area belongs to
    // its own row, and a label view belongs to the label row.
    static func isPrimarySelected(
        _ destination: PrimaryTab,
        selectedTab: PrimaryTab,
        areaID: String?,
        mailLabelID: String?
    ) -> Bool {
        guard selectedTab == destination else { return false }
        switch destination {
        case .work: return areaID == nil
        case .mail: return mailLabelID == nil
        default: return true
        }
    }

    static func isLabelSelected(_ labelID: String, selectedTab: PrimaryTab, mailLabelID: String?) -> Bool {
        selectedTab == .mail && mailLabelID == labelID
    }

    // The Mail row goes back to Main from a label view. Other rows ask the
    // mail list for nothing.
    static func mailCategory(forPrimary destination: PrimaryTab, mailLabelID: String?) -> String? {
        destination == .mail && mailLabelID != nil ? MailCategoryScope.main.rawValue : nil
    }

    // A label row opens Mail on that label (NAT-4).
    static func mailCategory(forLabel label: MailLabelSummary) -> String {
        label.rawCategory
    }
}

// The Mac sidebar: the same destinations as the iOS wheel — product sources,
// the labels shown in the sidebar, then the user's areas — as a conventional
// Mac source list.
struct MacSourceList: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var showsNewArea = false
    @State private var newAreaName = ""
    @State private var isCreatingArea = false

    private var primaries: [PrimaryTab] { PrimaryTab.sourceList }
    private var labels: [MailLabelSummary] { environment.store.mailLabels }
    private var areas: [AreaSummary] { environment.store.areas }

    var body: some View {
        List {
            Section {
                searchRow
            }
            Section {
                ForEach(primaries) { destination in
                    sourceRow(destination)
                }
            }
            // Mail that a label-move rule files leaves Main, so the label
            // view must be reachable from here (NAT-4).
            if !labels.isEmpty {
                Section("Labels") {
                    ForEach(labels) { label in
                        labelRow(label)
                    }
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
                newAreaRow
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

    private var searchRow: some View {
        Button {
            environment.navigation.requestMailSearch()
            NotificationCenter.default.post(name: .albatrossFocusMailSearch, object: nil)
        } label: {
            HStack(spacing: 9) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                Text("Search mail")
                    .foregroundStyle(.primary)
                Spacer(minLength: 8)
                Text("⌘F")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
            .background(environment.theme.paperColor.opacity(0.72), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(environment.theme.hairlineColor, lineWidth: 1)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help("Search mail (Command-F)")
        .accessibilityLabel("Search mail")
        .accessibilityHint("Opens Mail and places keyboard focus in search. Shortcut: Command-F.")
        .accessibilityIdentifier("mac-search-mail")
    }

    private func sourceRow(_ destination: PrimaryTab) -> some View {
        let navigation = environment.navigation
        let selected = MacSourceSelection.isPrimarySelected(
            destination,
            selectedTab: navigation.selectedTab,
            areaID: navigation.areaRoute?.areaID,
            mailLabelID: navigation.mailLabelID
        )
        return Button {
            let category = MacSourceSelection.mailCategory(forPrimary: destination, mailLabelID: navigation.mailLabelID)
            navigation.selectPrimary(destination)
            if let category {
                navigation.pendingMailCategory = category
            }
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

    private func labelRow(_ label: MailLabelSummary) -> some View {
        let navigation = environment.navigation
        let selected = MacSourceSelection.isLabelSelected(
            label.id,
            selectedTab: navigation.selectedTab,
            mailLabelID: navigation.mailLabelID
        )
        return Button {
            navigation.selectPrimary(.mail)
            navigation.pendingMailCategory = MacSourceSelection.mailCategory(forLabel: label)
        } label: {
            Label(label.name, systemImage: selected ? "tag.fill" : "tag")
                .fontWeight(selected ? .semibold : .regular)
                .lineLimit(1)
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
        .accessibilityLabel("\(label.name) label")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    // NAT-9: an Area can be created from the source list, as on the web and
    // the iOS sidebar. Text only, in the secondary color, under the areas.
    private var newAreaRow: some View {
        Button {
            newAreaName = ""
            showsNewArea = true
        } label: {
            Text(isCreatingArea ? "Creating area…" : "New Area")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(isCreatingArea)
        .popover(isPresented: $showsNewArea, arrowEdge: .trailing) {
            MacNewAreaPopover(
                name: $newAreaName,
                onCancel: { showsNewArea = false },
                onCreate: createArea
            )
        }
        .accessibilityHint("Names a new area and opens it")
        .accessibilityIdentifier("mac-new-area")
    }

    private func createArea() {
        guard let name = MacNewArea.cleanName(newAreaName) else { return }
        showsNewArea = false
        isCreatingArea = true
        Task {
            defer { isCreatingArea = false }
            // A failure sets the store error, and the shell's alert shows it.
            if let areaID = await environment.store.createArea(name: name) {
                environment.navigation.openArea(id: areaID, name: name)
            }
        }
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
