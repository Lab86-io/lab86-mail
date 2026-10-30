import SwiftUI

// Needs you on the Mac (docs/needs-you.md, phase 5; docs/needs-you-phases-2-5.md,
// M): the list and the detail side by side, the way Mail works here. The
// list shows the web page's groups with the shared rows; the detail is the
// shared ObligationDetailView, read live from the store, so an action in
// either pane changes the other. The list is one focusable view: arrows or
// j and k move, Return opens, e marks Done, l offers Later, and Command-C
// copies a code. After a row leaves, the selection moves to its neighbour
// and the Undo notice sits at the foot of the list. The Needs You menu and
// a push tap come in as requests. Design notes:
// docs/research/needs-you-web-design-2026-10-30.md (the desktop layout) and
// docs/research/needs-you-ios-design-2026-10-30.md (the shared pieces).

struct MacNeedsYouSplitView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    @State private var selectedID: String?
    @State private var clock: Date = .now
    @State private var showsClosed = false
    @State private var pendingTarget: ObligationTarget?
    /// The row whose Later popover is open.
    @State private var laterRowID: String?
    @FocusState private var listFocused: Bool

    /// The time labels count from a clock that ticks this often.
    static let clockInterval: Duration = .seconds(30)

    private var store: NeedsYouStore { environment.needsYou }
    private var requests: MacRequests { MacRequests.shared }

    private var extras: [NeedsYouExtra] {
        NeedsYouPresentation.extras(
            questions: environment.store.pendingQuestions,
            approvals: environment.store.approvals
        )
    }

    private var groups: [NeedsYouGroup] { store.groups(now: clock, extras: extras) }
    private var visibleEntries: [NeedsYouEntry] { MacNeedsYouLayout.visibleEntries(groups, showsClosed: showsClosed) }
    private var visibleIDs: [String] { visibleEntries.map(\.id) }

    /// The selected row, from the list when it is on screen, else from the
    /// store (a closed row named by a link while its group is folded).
    private var selectedEntry: NeedsYouEntry? {
        guard let selectedID else { return nil }
        if let entry = visibleEntries.first(where: { $0.id == selectedID }) { return entry }
        if let obligation = store.item(id: selectedID) { return .obligation(obligation) }
        return nil
    }

    private var laterOptions: [NeedsYouLaterOption] {
        NeedsYouGrouping.laterOptions(now: NeedsYouClock.millis(clock), timezone: store.timezone)
    }

    var body: some View {
        wired(split)
    }

    private var split: some View {
        HSplitView {
            listPane
                .frame(
                    minWidth: MacNeedsYouLayout.listMinWidth,
                    idealWidth: MacNeedsYouLayout.listWidth,
                    maxWidth: MacNeedsYouLayout.listMaxWidth,
                    maxHeight: .infinity
                )
            detailPane
                .frame(minWidth: MacNeedsYouLayout.detailMinWidth, maxWidth: .infinity, maxHeight: .infinity)
        }
        .navigationTitle("Needs you")
        .navigationSubtitle(NeedsYouGrouping.summary(of: groups).line)
    }

    /// The reads, the clock, the pending target, the selection follow-up,
    /// and the menu requests, apart from the layout.
    private func wired<Content: View>(_ content: Content) -> some View {
        content
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
            .onChange(of: visibleIDs) { old, new in moveSelectionIfGone(old: old, new: new) }
            .onChange(of: selectedID, initial: true) { _, id in requests.needsYouSelectedID = id }
            .onChange(of: requests.needsYouActionToken) { _, _ in performRequest(requests.needsYouAction) }
            .onDisappear { requests.needsYouSelectedID = nil }
    }

    // MARK: - The states of the list

    @ViewBuilder private var listPane: some View {
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
                .controlSize(.small)
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

    // MARK: - The list

    private var list: some View {
        ScrollViewReader { proxy in
            keyHandled(rows, proxy: proxy)
        }
        .overlay(alignment: .bottom) { undoNotice }
    }

    private var rows: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if groups.allSatisfy({ $0.id == .closedToday }) {
                    emptyRow
                }
                ForEach(groups) { group in
                    groupSection(group)
                }
            }
            .padding(.vertical, 8)
        }
    }

    /// The list is one focusable view. A click on a row gives it the
    /// keyboard; the keys below move and act on the selected row.
    private func keyHandled<Content: View>(_ content: Content, proxy: ScrollViewProxy) -> some View {
        content
            .focusable()
            .focused($listFocused)
            .focusEffectDisabled()
            .copyable(MacNeedsYouLayout.copyItems(for: selectedEntry))
            .onKeyPress(.downArrow) { move(.down, proxy: proxy) }
            .onKeyPress(.upArrow) { move(.up, proxy: proxy) }
            .onKeyPress(.home) { move(.first, proxy: proxy) }
            .onKeyPress(.end) { move(.last, proxy: proxy) }
            .onKeyPress(.return) { openSelected() }
            .onKeyPress(keys: ["j", "k", "e", "l"]) { press in letter(press, proxy: proxy) }
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
        .padding(.horizontal, 16)
        .padding(.vertical, 18)
    }

    @ViewBuilder private func groupSection(_ group: NeedsYouGroup) -> some View {
        if group.id == .closedToday {
            closedHeader(count: group.entries.count)
            if showsClosed {
                ForEach(group.entries) { entry in
                    entryRow(entry)
                    hairline
                }
            }
        } else {
            RuledSectionHeader(title: group.label, hint: "\(group.entries.count)", accent: group.id == .now)
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 4)
            ForEach(group.entries) { entry in
                entryRow(entry)
                hairline
            }
        }
    }

    private var hairline: some View {
        Rectangle()
            .fill(environment.theme.hairlineColor)
            .frame(height: 1)
            .padding(.leading, 62)
            .padding(.trailing, 16)
            .accessibilityHidden(true)
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
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 4)
        .accessibilityLabel("Closed today, \(count)")
        .accessibilityValue(showsClosed ? "Open" : "Collapsed")
        .accessibilityAddTraits(.isHeader)
    }

    @ViewBuilder private func entryRow(_ entry: NeedsYouEntry) -> some View {
        switch entry {
        case .obligation(let obligation):
            obligationRow(obligation)
        case .albatross(let extra):
            extraRow(extra)
        }
    }

    private func obligationRow(_ obligation: ObligationView) -> some View {
        MacNeedsYouRow(
            obligation: obligation,
            now: clock,
            timezone: store.timezone,
            selected: selectedID == obligation.id,
            focused: listFocused,
            onOpen: { select(obligation.id) },
            onVerb: { verb in performVerb(verb, on: obligation) }
        )
        .padding(.horizontal, 6)
        .id(obligation.id)
        .disabled(store.busyID == obligation.id)
        .contextMenu { rowMenu(obligation) }
        .popover(isPresented: laterBinding(obligation.id), arrowEdge: .trailing) {
            MacNeedsYouLaterPopover(options: laterOptions) { until in
                laterRowID = nil
                Task { await act(.later(until: until), on: obligation.id) }
            }
        }
    }

    private func extraRow(_ extra: NeedsYouExtra) -> some View {
        MacNeedsYouExtraRow(
            extra: extra,
            selected: selectedID == extra.id,
            focused: listFocused,
            onOpen: { select(extra.id) }
        )
        .padding(.horizontal, 6)
        .id(extra.id)
        .contextMenu {
            Button(extra.workID != nil ? "Open thread" : "Open activity") { openExtra(extra) }
        }
    }

    private func laterBinding(_ id: String) -> Binding<Bool> {
        Binding(
            get: { laterRowID == id },
            set: { shown in if !shown, laterRowID == id { laterRowID = nil } }
        )
    }

    /// The same verbs as the detail, then the open link. Sentence case, as
    /// the row menus of the source list are.
    @ViewBuilder private func rowMenu(_ obligation: ObligationView) -> some View {
        if MacNeedsYouLayout.canCopy(obligation), let code = obligation.code {
            Button("Copy code") { copy(code.value) }
        }
        if MacNeedsYouLayout.canMarkDone(obligation) {
            Button("Done") { Task { await act(.done, on: obligation.id) } }
        }
        if MacNeedsYouLayout.canSnooze(obligation) {
            Menu("Later") {
                ForEach(laterOptions) { option in
                    Button(option.label) { Task { await act(.later(until: option.until), on: obligation.id) } }
                }
            }
        }
        if MacNeedsYouLayout.canDismiss(obligation) {
            Button("Not mine") { Task { await act(.notMine, on: obligation.id) } }
        }
        if MacNeedsYouLayout.canStartInAlbatross(obligation) {
            Button("Start in Albatross") { Task { await startInAlbatross(obligation) } }
        }
        if let label = NeedsYouPresentation.openInLabel(obligation) {
            Button(label) { openSource(obligation) }
        }
    }

    // MARK: - The detail

    @ViewBuilder private var detailPane: some View {
        switch selectedEntry {
        case .obligation(let obligation)?:
            ObligationDetailView(id: obligation.id)
                // A new row is a new detail, not the old one re-fed.
                .id(obligation.id)
                .onKeyPress(.escape) {
                    listFocused = true
                    return .handled
                }
        case .albatross(let extra)?:
            MacNeedsYouExtraDetail(extra: extra, onOpen: { openExtra(extra) })
        case nil:
            emptyDetail
        }
    }

    private var emptyDetail: some View {
        let caughtUp = visibleIDs.isEmpty
        return ContentUnavailableView {
            Text(caughtUp ? "You’re caught up." : "No item selected")
        } description: {
            Text(caughtUp
                ? "New items appear here when something needs an answer, a decision, or a code."
                : "Choose an item from the list to read it here.")
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
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityElement(children: .contain)
        }
    }

    // MARK: - The keys

    private func select(_ id: String) {
        selectedID = id
        listFocused = true
    }

    private func move(_ move: MacNeedsYouLayout.Move, proxy: ScrollViewProxy) -> KeyPress.Result {
        guard let target = MacNeedsYouLayout.target(move, from: selectedID, in: visibleIDs) else { return .ignored }
        selectedID = target
        proxy.scrollTo(target)
        return .handled
    }

    /// j and k move; e and l act on the selected row. A letter with a
    /// modifier is a shortcut of the menus, not the list's.
    private func letter(_ press: KeyPress, proxy: ScrollViewProxy) -> KeyPress.Result {
        guard press.modifiers.isDisjoint(with: [.command, .control, .option]) else { return .ignored }
        switch press.characters {
        case "j": return move(.down, proxy: proxy)
        case "k": return move(.up, proxy: proxy)
        default: break
        }
        guard let action = MacNeedsYouLayout.keyAction(press.characters, on: selectedEntry),
              case .obligation(let obligation)? = selectedEntry else { return .ignored }
        switch action {
        case .done:
            Task { await act(.done, on: obligation.id) }
        case .later:
            laterRowID = obligation.id
        }
        return .handled
    }

    /// Return opens the selected row: the detail shows it already, so for an
    /// obligation this is the row itself; an Albatross row opens its thread.
    /// With nothing selected, the first row.
    private func openSelected() -> KeyPress.Result {
        guard let entry = selectedEntry else {
            guard let first = visibleIDs.first else { return .ignored }
            selectedID = first
            return .handled
        }
        if case .albatross(let extra) = entry { openExtra(extra) }
        return .handled
    }

    // MARK: - Actions

    private func performVerb(_ verb: MacNeedsYouLayout.HoverVerb, on obligation: ObligationView) {
        switch verb {
        case .copy:
            if let code = obligation.code { copy(code.value) }
        case .done:
            Task { await act(.done, on: obligation.id) }
        }
    }

    /// The Needs You menu asked for one action on the selected row.
    private func performRequest(_ action: MacNeedsYouAction) {
        guard case .obligation(let obligation)? = selectedEntry else { return }
        switch action {
        case .done:
            Task { await act(.done, on: obligation.id) }
        case .later(let until):
            Task { await act(.later(until: until), on: obligation.id) }
        case .notMine:
            Task { await act(.notMine, on: obligation.id) }
        case .copyCode:
            if let code = obligation.code { copy(code.value) }
        case .startInAlbatross:
            Task { await startInAlbatross(obligation) }
        case .openSource:
            openSource(obligation)
        }
    }

    private func copy(_ value: String) {
        PlatformPasteboard.copy(value)
        PlatformAccessibility.announce("Copied")
    }

    private func act(_ action: ObligationAction, on id: String) async {
        await store.act(action, on: id, transport: environment.backend, now: .now)
    }

    private func startInAlbatross(_ obligation: ObligationView) async {
        guard let result = await store.startAlbatross(id: obligation.id, transport: environment.backend) else { return }
        environment.navigation.openWork(id: result.workID, title: obligation.workTitle)
    }

    private func openSource(_ obligation: ObligationView) {
        if let accountID = obligation.accountID, let threadID = obligation.threadID {
            environment.navigation.openThread(accountID: accountID, threadID: threadID)
        } else if let url = obligation.url {
            openURL(url)
        }
    }

    private func openExtra(_ extra: NeedsYouExtra) {
        if let workID = extra.workID {
            environment.navigation.openWork(id: workID, title: extra.title)
        } else {
            environment.navigation.sheet = .activity
        }
    }

    // MARK: - The selection after a change

    /// The selected row left the list (Done, Later, Not mine, an expired
    /// code, a folded group): the selection goes to its neighbour, so the
    /// detail shows the next thing and the keys keep a place.
    private func moveSelectionIfGone(old: [String], new: [String]) {
        guard let current = selectedID, !new.contains(current) else { return }
        selectedID = MacNeedsYouLayout.afterLeaving(current, old: old, remaining: new)
    }

    // MARK: - Reads

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
            if let item = store.item(id: id) { reveal(item) }
        case .thread(let accountID, let threadID):
            if let item = store.item(accountID: accountID, threadID: threadID) {
                reveal(item)
            } else {
                environment.navigation.openThread(accountID: accountID, threadID: threadID)
            }
        }
    }

    /// Opens one row. A closed row opens its group first.
    private func reveal(_ item: ObligationView) {
        if item.isClosed { showsClosed = true }
        select(item.id)
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
