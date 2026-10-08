import SwiftUI

/// The Albatrosses page: every unresolved outcome the user is carrying, live
/// (docs/albatross-threads.md, T1, T2, T10).
///
/// The rows read `work_list` for the Work and `GET /api/albatross/threads`
/// for the live state. "Needs you" first, then "In progress", then "Open";
/// the Later shelf and the finished rows after. A row offers Answer, Steer,
/// Stop, and Mark as unread in place. On iPad the list is a column beside
/// the open thread. Areas keep their own place at the foot of the list.
struct WorkView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.scenePhase) private var scenePhase
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    @State private var filter: WorkFilter = .all
    @State private var showsClosed = false
    @State private var horizonTarget: WorkListItem?
    @State private var steerTarget: SteerTarget?
    @State private var answerTarget: ThreadListRow?
    @State private var archiveTarget: ThreadListRow?
    @State private var width: CGFloat = 0
    @State private var clock: Date = .now
    @State private var lastAnnouncedAt: Date = .distantPast

    /// The split needs room for the list column and a readable thread.
    static let splitMinimumWidth: CGFloat = 700
    static let listColumnWidth: CGFloat = 320
    /// The time labels count from a clock that ticks this often.
    static let clockInterval: Duration = .seconds(30)
    /// The list announces at most one attention line in this window.
    static let announcementWindow: TimeInterval = 10

    /// A row the quick-steer sheet is open for.
    struct SteerTarget: Identifiable {
        let row: ThreadListRow
        let redirect: Bool
        var id: String { row.id }
    }

    private var store: ProductStore { environment.store }
    private var threads: ThreadsStore { environment.threads }

    // MARK: - Rows

    private var allRows: [ThreadListRow] {
        ThreadListGrouping.rows(items: store.allWork, live: threads.rows)
    }

    private var filteredRows: [ThreadListRow] {
        ThreadListGrouping.filter(allRows, by: filter, areaID: nil)
    }

    /// Dormant Work leaves the sections for the "Later" shelf.
    private var laterItems: [WorkListItem] {
        WorkGrouping.split(filteredRows.map(\.item), now: .now).later
    }

    private var awakeRows: [ThreadListRow] {
        let laterIDs = Set(laterItems.map(\.id))
        return filteredRows.filter { !laterIDs.contains($0.id) }
    }

    private var openRows: [ThreadListRow] {
        awakeRows.filter { !$0.item.isClosed || $0.item.isUnresolved }
    }

    private var closedRows: [ThreadListRow] {
        ThreadRowPresentation.sorted(awakeRows.filter { $0.item.isClosed && !$0.item.isUnresolved })
    }

    private var openSections: [(section: ThreadListSection, rows: [ThreadListRow])] {
        ThreadListGrouping.sections(openRows)
    }

    private var unhomedCount: Int {
        store.allWork.filter { $0.primaryAreaID == nil }.count
    }

    // MARK: - Body

    var body: some View {
        #if os(iOS)
        if horizontalSizeClass == .regular {
            Group {
                if width >= Self.splitMinimumWidth {
                    split
                } else {
                    stack
                }
            }
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.size.width
            } action: { next in
                width = next
            }
        } else {
            stack
        }
        #else
        stack
        #endif
    }

    /// The iPhone form: the list, with the thread pushed behind Back.
    private var stack: some View {
        @Bindable var navigation = environment.navigation
        return list(showsSelection: false, showsHeader: false)
            // The list is the place you open an Albatross from, so the thread
            // has to be reachable here and not only from inside an Area.
            .navigationDestination(item: $navigation.workRoute) { route in
                #if os(macOS)
                MacWorkThreadView(route: route)
                #else
                WorkThreadView(route: route)
                #endif
            }
            .navigationTitle("Albatrosses")
            .toolbar {
                if !closedRows.isEmpty {
                    ToolbarItem(placement: .primaryAction) {
                        finishedToggle
                    }
                }
            }
            .shellToolbar()
    }

    #if os(iOS)
    /// The iPad form: the list column beside the open thread.
    private var split: some View {
        ThreadsSplitView(route: environment.navigation.workRoute) {
            list(showsSelection: true, showsHeader: true)
        }
    }
    #endif

    private var finishedToggle: some View {
        Button(showsClosed ? "Hide finished" : "Show finished") {
            showsClosed.toggle()
        }
        .font(.footnote)
    }

    // MARK: - The list

    private func list(showsSelection: Bool, showsHeader: Bool) -> some View {
        List {
            if showsHeader {
                headerRow
            }
            filterRow
            if store.workError != nil {
                plainRow {
                    WorkRefreshWarning(retry: retryWork)
                        .padding(.horizontal, 20)
                        .padding(.bottom, 8)
                }
            }
            if let notice = threads.notice {
                plainRow { noticeLine(notice) }
            }
            if openSections.isEmpty, closedRows.isEmpty, laterItems.isEmpty {
                plainRow { emptyState }
            } else if openSections.isEmpty, laterItems.isEmpty, !showsClosed {
                // Everything left is finished and finished is hidden. Saying
                // so beats a page that looks broken.
                plainRow { allFinished }
            } else {
                ForEach(openSections, id: \.section) { group in
                    threadSection(
                        group.section.label,
                        hint: group.section.hint,
                        accent: group.section.asksForYou,
                        rows: group.rows,
                        showsSelection: showsSelection
                    )
                }
                if !laterItems.isEmpty {
                    laterRow
                }
                if showsClosed, !closedRows.isEmpty {
                    threadSection(
                        WorkViewCopy.finished,
                        hint: WorkViewCopy.finishedHint,
                        accent: false,
                        rows: closedRows,
                        showsSelection: showsSelection
                    )
                }
            }
            if !store.areas.isEmpty {
                areasSection
            }
        }
        .threadListStyle()
        .scrollContentBackground(.hidden)
        .background(environment.theme.paperColor)
        .refreshable { await refreshAll() }
        .task {
            while !Task.isCancelled {
                do { try await Task.sleep(for: Self.clockInterval) } catch { return }
                clock = .now
            }
        }
        .onAppear {
            threads.listVisible = true
            threads.beginFollowing(environment.backend)
        }
        .onDisappear {
            threads.listVisible = false
            threads.endFollowing()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                threads.resumeFollowing(environment.backend)
            } else {
                threads.pauseFollowing()
            }
        }
        .onChange(of: threads.attention?.id) { _, _ in
            announceAttention()
        }
        .onChange(of: environment.navigation.pendingWorkFilter) { _, next in
            guard let next else { return }
            filter = next
            environment.navigation.pendingWorkFilter = nil
        }
        .sheet(item: $horizonTarget) { item in
            HorizonSheet(title: item.displayTitle, initial: item.horizon) { horizon in
                await WorkHorizonWriter.set(horizon, for: item.id, environment: environment)
            }
        }
        .sheet(item: $steerTarget) { target in
            QuickSteerSheet(
                row: target.row,
                startsInRedirect: target.redirect,
                onSend: { note, redirect in await steer(target.row, note: note, redirect: redirect) },
                onOpen: { open(target.row) }
            )
        }
        .sheet(item: $answerTarget) { row in
            AnswerSheet(
                row: row,
                onAnswered: { Task { await threads.load(environment.backend) } },
                onOpen: { open(row) }
            )
        }
        .confirmationDialog(
            WorkViewCopy.archiveTitle,
            isPresented: Binding(
                get: { archiveTarget != nil },
                set: { if !$0 { archiveTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Archive", role: .destructive) {
                guard let target = archiveTarget else { return }
                archiveTarget = nil
                Task { await setWorkState(target, "archived") }
            }
        } message: {
            Text(WorkViewCopy.archiveMessage)
        }
    }

    /// A row with no card: the filters, the warnings, the shelf, the empty
    /// states.
    private func plainRow<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
    }

    /// The iPad column draws its own title: the outer bar is hidden there.
    private var headerRow: some View {
        plainRow {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text("Albatrosses")
                    .font(.largeTitle.weight(.bold))
                Spacer(minLength: 8)
                if !closedRows.isEmpty {
                    finishedToggle
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
        }
    }

    /// Filters as a glass capsule row: the material Apple uses for controls that
    /// float over content, so the list reads as the page and these read as the
    /// handles on it.
    private var filterRow: some View {
        plainRow {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    filterPill(.all)
                    filterPill(.needsYou)
                    filterPill(.inProgress)
                    if unhomedCount > 0 { filterPill(.unhomed) }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
            }
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

    private func noticeLine(_ notice: String) -> some View {
        HStack(spacing: 8) {
            Text(notice)
                .font(.footnote)
                .foregroundStyle(.red)
            Spacer(minLength: 8)
            Button("Dismiss") { threads.clearNotice() }
                .font(.footnote.weight(.medium))
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 8)
    }

    /// A section rule, weighted by whether the group is asking for anything.
    /// Needs-you carries the accent; everything else is a hairline.
    private func threadSection(
        _ label: String,
        hint: String,
        accent: Bool,
        rows: [ThreadListRow],
        showsSelection: Bool
    ) -> some View {
        Section {
            ForEach(rows) { row in
                threadRow(row, showsSelection: showsSelection)
            }
        } header: {
            sectionHeader(label, hint: hint, accent: accent)
        }
    }

    private func sectionHeader(_ label: String, hint: String, accent: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Rectangle()
                .fill(accent ? Color.accentColor : Color.secondary.opacity(0.45))
                .frame(width: 18, height: 1)
            Text(label)
                .font(.system(.subheadline, design: .serif).weight(.semibold))
                .foregroundStyle(.primary)
            Text(hint)
                .font(.caption2)
                .foregroundStyle(.tertiary)
            Spacer(minLength: 0)
        }
        // Grouped lists set section headers in capitals. Ours stay sentence case.
        .textCase(nil)
        .padding(.bottom, 2)
    }

    private func threadRow(_ row: ThreadListRow, showsSelection: Bool) -> some View {
        let selected = showsSelection && environment.navigation.workRoute?.workID == row.id
        return Button {
            open(row)
        } label: {
            ThreadListRowView(row: row, now: clock, stale: threads.isStale)
        }
        .buttonStyle(.plain)
        .listRowBackground(selected ? environment.theme.accentSoftColor : environment.theme.elevatedColor)
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            if row.live != nil {
                Button(row.unread ? WorkViewCopy.markRead : WorkViewCopy.markUnread) {
                    Task { await toggleUnread(row) }
                }
                .tint(environment.theme.accentColor)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            ForEach(ThreadRowPresentation.swipeVerbs(row.status)) { verb in
                Button(verb.label) { perform(verb, on: row) }
                    .tint(tint(for: verb))
            }
        }
        .contextMenu { rowMenu(row) }
        .accessibilityActions { rowAccessibilityActions(row) }
    }

    /// The same verbs as the swipe, for a long press (HIG: hide what does not
    /// apply, destructive last).
    @ViewBuilder private func rowMenu(_ row: ThreadListRow) -> some View {
        ForEach(ThreadRowPresentation.menuVerbs(row.status)) { verb in
            Button(verb.menuLabel) { perform(verb, on: row) }
        }
        if row.live != nil {
            Button(row.unread ? WorkViewCopy.markRead : WorkViewCopy.markUnread) {
                Task { await toggleUnread(row) }
            }
        }
        Divider()
        if row.item.workState == "paused" {
            Button("Pick it up") { Task { await setWorkState(row, "active") } }
        } else {
            Button("Put it down") { Task { await setWorkState(row, "paused") } }
        }
        Button("Set horizon…") { horizonTarget = row.item }
        Divider()
        Button("Archive…", role: .destructive) { archiveTarget = row }
    }

    /// VoiceOver reaches every verb without a swipe gesture.
    @ViewBuilder private func rowAccessibilityActions(_ row: ThreadListRow) -> some View {
        ForEach(ThreadRowPresentation.menuVerbs(row.status)) { verb in
            Button(verb.menuLabel) { perform(verb, on: row) }
        }
        if row.live != nil {
            Button(row.unread ? WorkViewCopy.markRead : WorkViewCopy.markUnread) {
                Task { await toggleUnread(row) }
            }
        }
    }

    private func tint(for verb: ThreadRowVerb) -> Color {
        switch verb {
        case .answer, .openPage: environment.theme.accentColor
        case .steer, .stopAndRedirect, .continueRun: environment.theme.accent2Color
        case .stop, .stopReply: Color.gray
        }
    }

    private var laterRow: some View {
        plainRow {
            #if os(macOS)
            // The Mac reads the shelf as an ordinal ruler: equal steps in
            // wake order, with the elapsed time written on the hairline
            // between the cards.
            MacLaterRuler(
                items: laterItems,
                now: .now,
                onOpen: { item in
                    environment.navigation.openWork(id: item.id, title: item.displayTitle)
                },
                onWake: { item in
                    Task { _ = await WorkHorizonWriter.set(nil, for: item.id, environment: environment) }
                },
                onSetHorizon: { item, horizon in
                    await WorkHorizonWriter.set(horizon, for: item.id, environment: environment)
                }
            )
            #else
            LaterShelf(
                items: laterItems,
                now: .now,
                onOpen: { item in
                    environment.navigation.openWork(id: item.id, title: item.displayTitle)
                },
                onWake: { item in
                    Task { _ = await WorkHorizonWriter.set(nil, for: item.id, environment: environment) }
                },
                onChangeHorizon: { item in horizonTarget = item }
            )
            #endif
        }
    }

    private var areasSection: some View {
        Section {
            ForEach(store.areas) { area in
                Button {
                    environment.navigation.openArea(id: area.id, name: area.name)
                } label: {
                    AreaListRow(area: area)
                }
                .buttonStyle(.plain)
                .listRowBackground(environment.theme.elevatedColor)
            }
        } header: {
            sectionHeader("Areas", hint: "The parts of life these belong to.", accent: false)
        }
    }

    private var allFinished: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Nothing open. Everything here is finished.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button("Show finished") { showsClosed = true }
                .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.vertical, 28)
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
                Label(WorkViewCopy.emptyTitle(filter), systemImage: "checkmark.circle")
            } description: {
                Text(WorkViewCopy.emptyDescription(filter))
            } actions: {
                if filter == .all {
                    Button("Get something out of your head") {
                        environment.navigation.sheet = .assistant
                    }
                    .buttonStyle(.borderedProminent)
                } else {
                    Button(WorkFilter.all.label) { filter = .all }
                        .buttonStyle(.bordered)
                }
            }
            .padding(.vertical, 20)
        }
    }

    // MARK: - Actions

    private func open(_ row: ThreadListRow) {
        environment.navigation.openWork(id: row.id, title: row.title)
    }

    private func perform(_ verb: ThreadRowVerb, on row: ThreadListRow) {
        guard let live = row.live else { return }
        switch verb {
        case .answer:
            answerTarget = row
        case .openPage:
            environment.navigation.openWork(id: row.id, title: row.title, intent: .openPage)
        case .steer:
            steerTarget = SteerTarget(row: row, redirect: false)
        case .stopAndRedirect:
            steerTarget = SteerTarget(row: row, redirect: true)
        case .stop, .stopReply:
            Task { await threads.stop(live, transport: environment.backend) }
        case .continueRun:
            Task { await threads.continueRun(live, transport: environment.backend) }
        }
    }

    private func toggleUnread(_ row: ThreadListRow) async {
        if row.unread {
            await threads.markSeen(workID: row.id, transport: environment.backend)
        } else {
            await threads.markUnread(workID: row.id, transport: environment.backend)
        }
    }

    private func steer(_ row: ThreadListRow, note: String, redirect: Bool) async -> ThreadsStore.SteerOutcome {
        guard let live = row.live else { return .runEnded }
        let outcome = await threads.steer(live, note: note, redirect: redirect, transport: environment.backend)
        if outcome == .sent {
            await threads.load(environment.backend)
        }
        return outcome
    }

    private func setWorkState(_ row: ThreadListRow, _ state: String) async {
        if await store.updateWorkState(row.id, state: state) {
            await refreshAll()
        }
    }

    private func refreshAll() async {
        async let work: Void = store.refreshWork()
        async let rows: Void = threads.load(environment.backend)
        _ = await (work, rows)
    }

    private func retryWork() {
        Task { await refreshAll() }
    }

    /// One merged line at most every ten seconds, only while the list is on
    /// screen: "Renew the car registration needs your answer."
    private func announceAttention() {
        guard threads.listVisible, let attention = threads.attention else { return }
        let now = Date()
        guard now.timeIntervalSince(lastAnnouncedAt) >= Self.announcementWindow else { return }
        lastAnnouncedAt = now
        PlatformAccessibility.announce(NeedsYouBannerCopy.announcement(attention.rows))
    }
}

/// The words of the list that are not a row's.
enum WorkViewCopy {
    static let finished = "Finished"
    static let finishedHint = "These reached the outcome you wanted, or you put them down."
    static let markRead = "Mark as read"
    static let markUnread = "Mark as unread"
    static let archiveTitle = "Archive this Albatross?"
    static let archiveMessage = "An archived Albatross leaves its Area. It stays in history."

    static func emptyTitle(_ filter: WorkFilter) -> String {
        switch filter {
        case .all: "Nothing on your mind yet"
        case .needsYou: "Nothing needs you now"
        case .inProgress: "Nothing runs now"
        case .unhomed: "Nothing under this filter"
        }
    }

    static func emptyDescription(_ filter: WorkFilter) -> String {
        switch filter {
        case .all: "Tell Albatross what you are carrying and it starts here."
        case .needsYou: "Albatross has the rest."
        case .inProgress: "Press Handle it in an Albatross to start a run."
        case .unhomed: "Try All to see the rest."
        }
    }
}

private extension View {
    /// The inset grouped look on iOS (the card groups the page had before);
    /// the inset style on the Mac, which has no grouped list.
    @ViewBuilder func threadListStyle() -> some View {
        #if os(macOS)
        listStyle(.inset)
        #else
        listStyle(.insetGrouped)
        #endif
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
