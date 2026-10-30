import SwiftUI

// Needs you (docs/needs-you.md, phase 5): the page. One list in the groups
// of the web page (Now, Today, This week, After this week, No due date,
// Waiting on others, Closed today), a row tap opens the detail, a swipe
// marks Done or Not mine, and the Undo offer sits at the foot of the page
// for ten seconds. The list reads again on pull, on return to the app (the
// shell), and after a push (the shell).

struct NeedsYouView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var openedID: String?
    @State private var clock: Date = .now
    @State private var showsClosed = false
    @State private var pendingTarget: ObligationTarget?

    /// The time labels count from a clock that ticks this often.
    static let clockInterval: Duration = .seconds(30)

    private var store: NeedsYouStore { environment.needsYou }

    private var extras: [NeedsYouExtra] {
        NeedsYouPresentation.extras(
            questions: environment.store.pendingQuestions,
            approvals: environment.store.approvals
        )
    }

    private var groups: [NeedsYouGroup] { store.groups(now: clock, extras: extras) }

    var body: some View {
        content
            .navigationTitle("Needs you")
            .navigationDestination(item: $openedID) { id in
                ObligationDetailView(id: id)
            }
            .overlay(alignment: .bottom) { undoNotice }
            .alert(
                "Albatross couldn’t finish that",
                isPresented: Binding(
                    get: { store.actionError != nil },
                    set: { if !$0 { store.clearActionError() } }
                )
            ) {
                Button("OK") { store.clearActionError() }
            } message: {
                Text(store.actionError ?? "Try again.")
            }
            .task { await firstLoad() }
            .task(id: store.nextCodeExpiry(now: clock)) { await wakeAtCodeExpiry() }
            .task { await tick() }
            .onChange(of: environment.navigation.pendingObligation) { _, _ in
                takePendingTarget()
                resolvePendingTarget()
            }
            .onChange(of: store.loaded) { _, _ in resolvePendingTarget() }
    }

    // MARK: - The states of the page

    @ViewBuilder private var content: some View {
        if !store.loaded, store.isLoading {
            loadingState
        } else if !store.loaded, let error = store.loadError {
            errorState(error)
        } else {
            list
        }
    }

    private var loadingState: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Finding what needs you")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorState(_ message: String) -> some View {
        ContentUnavailableView {
            Text("Couldn’t read what needs you")
        } description: {
            Text(message)
        } actions: {
            Button("Try again") {
                Task { await store.load(environment.backend, force: true) }
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private var list: some View {
        List {
            summaryRow
            if groups.allSatisfy({ $0.id == .closedToday }) {
                emptyRow
            }
            ForEach(groups) { group in
                groupSection(group)
            }
        }
        .listStyle(.plain)
        .refreshable { await store.load(environment.backend, force: true) }
    }

    private var summaryRow: some View {
        Text(NeedsYouGrouping.summary(of: groups).line)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .listRowSeparator(.hidden)
            .accessibilityAddTraits(.isStaticText)
    }

    private var emptyRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Nothing needs you right now.")
                .font(environment.theme.displayType.displayFont(size: 19, weight: .regular))
            Text("New items appear here when something needs an answer, a decision, or a code.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 18)
        .listRowSeparator(.hidden)
    }

    // MARK: - Groups

    @ViewBuilder private func groupSection(_ group: NeedsYouGroup) -> some View {
        if group.id == .closedToday {
            Section {
                if showsClosed {
                    ForEach(group.entries) { entry in entryRow(entry) }
                }
            } header: {
                closedHeader(count: group.entries.count)
            }
        } else {
            Section {
                ForEach(group.entries) { entry in entryRow(entry) }
            } header: {
                RuledSectionHeader(title: group.label, hint: "\(group.entries.count)", accent: group.id == .now)
            }
        }
    }

    private func closedHeader(count: Int) -> some View {
        Button {
            withAnimation(.snappy(duration: 0.2)) { showsClosed.toggle() }
        } label: {
            HStack(spacing: 8) {
                RuledSectionHeader(title: NeedsYouGroupID.closedToday.label, hint: "\(count)")
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(showsClosed ? 90 : 0))
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Closed today, \(count)")
        .accessibilityValue(showsClosed ? "Open" : "Collapsed")
        .accessibilityAddTraits(.isHeader)
    }

    @ViewBuilder private func entryRow(_ entry: NeedsYouEntry) -> some View {
        switch entry {
        case .obligation(let obligation):
            obligationRow(obligation)
        case .albatross(let extra):
            Button {
                openExtra(extra)
            } label: {
                NeedsYouExtraRow(extra: extra)
            }
            .buttonStyle(.plain)
        }
    }

    private func obligationRow(_ obligation: ObligationView) -> some View {
        Button {
            openedID = obligation.id
        } label: {
            NeedsYouObligationRow(obligation: obligation, now: clock, timezone: store.timezone)
        }
        .buttonStyle(.plain)
        .disabled(store.busyID == obligation.id)
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if !obligation.isClosed, obligation.kind != .code {
                Button("Done") { Task { await act(.done, on: obligation.id) } }
                    .tint(environment.theme.accentColor)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if !obligation.isClosed {
                Button("Not mine") { Task { await act(.notMine, on: obligation.id) } }
                    .tint(Color.secondary)
            }
        }
        .contextMenu { rowMenu(obligation) }
        .accessibilityHint("Opens the item")
    }

    @ViewBuilder private func rowMenu(_ obligation: ObligationView) -> some View {
        if obligation.kind == .code, let code = obligation.code, !obligation.isClosed {
            Button("Copy code") { PlatformPasteboard.copy(code.value) }
        }
        if !obligation.isClosed, obligation.kind != .code {
            Button("Done") { Task { await act(.done, on: obligation.id) } }
            Menu("Later") {
                ForEach(NeedsYouGrouping.laterOptions(now: NeedsYouClock.millis(clock), timezone: store.timezone)) { option in
                    Button(option.label) { Task { await act(.later(until: option.until), on: obligation.id) } }
                }
            }
        }
        if !obligation.isClosed {
            Button("Not mine") { Task { await act(.notMine, on: obligation.id) } }
        }
        if obligation.hasMailThread, let accountID = obligation.accountID, let threadID = obligation.threadID {
            Button("Open in Mail") { environment.navigation.openThread(accountID: accountID, threadID: threadID) }
        }
    }

    // MARK: - Undo

    @ViewBuilder private var undoNotice: some View {
        if let undo = store.undo {
            HStack(spacing: 12) {
                Text(undo.summary)
                    .font(.subheadline)
                    .lineLimit(2)
                Spacer()
                Button("Undo") {
                    Task { await store.undoLast(transport: environment.backend) }
                }
                .buttonStyle(.borderedProminent)
                .tint(environment.theme.accentColor)
                Button("Dismiss") { store.dismissUndo() }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
            }
            .padding(12)
            .background(.regularMaterial, in: .rect(cornerRadius: 18))
            .frame(maxWidth: 520)
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityElement(children: .contain)
        }
    }

    // MARK: - Wiring

    private func act(_ action: ObligationAction, on id: String) async {
        await store.act(action, on: id, transport: environment.backend, now: .now)
    }

    private func openExtra(_ extra: NeedsYouExtra) {
        if let workID = extra.workID {
            environment.navigation.openWork(id: workID, title: extra.title)
        } else {
            environment.navigation.sheet = .activity
        }
    }

    private func firstLoad() async {
        takePendingTarget()
        await store.load(environment.backend)
        clock = .now
        resolvePendingTarget()
    }

    private func takePendingTarget() {
        if let target = environment.navigation.consumeObligation() {
            pendingTarget = target
        }
    }

    /// A push tap or a link named one item. It opens when the list has it.
    /// A thread with no item on the list opens as the thread, so a push the
    /// list no longer knows still shows its mail.
    private func resolvePendingTarget() {
        guard let target = pendingTarget, store.loaded else { return }
        pendingTarget = nil
        switch target {
        case .id(let id):
            if store.item(id: id) != nil { openedID = id }
        case .thread(let accountID, let threadID):
            if let item = store.item(accountID: accountID, threadID: threadID) {
                openedID = item.id
            } else {
                environment.navigation.openThread(accountID: accountID, threadID: threadID)
            }
        }
    }

    private func tick() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: Self.clockInterval)
            guard !Task.isCancelled else { return }
            clock = .now
        }
    }

    /// The soonest code expiry is a wake: the row leaves Now at that moment.
    private func wakeAtCodeExpiry() async {
        guard let expiry = store.nextCodeExpiry(now: clock) else { return }
        let wait = expiry.timeIntervalSince(.now)
        if wait > 0 {
            try? await Task.sleep(for: .seconds(wait + 0.2))
        }
        guard !Task.isCancelled else { return }
        clock = .now
    }
}
