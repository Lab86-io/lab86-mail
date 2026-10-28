import SwiftUI

struct MailView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var searchText = ""
    @State private var accountScope: Set<String> = []
    @State private var selection = MailScopeSelection()
    @State private var reconnectingID: String?
    @State private var mailboxScope = MailboxScope.inbox
    @State private var selectedThreadKeys: Set<String> = []
    @State private var editMode: EditMode = .inactive
    @State private var showsSenderCleanup = false
    @State private var triageVerdicts: [BulkTriageVerdict] = []
    @State private var categoryInfoThread: MailThreadSummary?
    @State private var isBulkTriaging = false
    @State private var isSearchFocused = false
    @State private var showsScheduledSends = false
    // The cursor token of an older-page load that ended without a result;
    // that row shows Load more instead of a spinner (M8).
    @State private var failedLoadMoreToken: String?
    // The last query whose search request ended in this view, with or
    // without an answer. Until then an empty result means "searching" (M4).
    @State private var answeredSearchQuery: String?
    @State private var categoryCounts = MailCategoryCountsModel()

    static var tomorrowMorning: Date {
        let calendar = Calendar.autoupdatingCurrent
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: .now) ?? .now
        return calendar.date(bySettingHour: 8, minute: 0, second: 0, of: tomorrow) ?? tomorrow
    }

    static var laterToday: Date {
        Calendar.autoupdatingCurrent.date(byAdding: .hour, value: 3, to: .now) ?? .now
    }

    static var nextWeekMorning: Date {
        let calendar = Calendar.autoupdatingCurrent
        let next = calendar.date(byAdding: .day, value: 7, to: .now) ?? .now
        return calendar.date(bySettingHour: 8, minute: 0, second: 0, of: next) ?? next
    }

    @ViewBuilder private func snoozeMenu(_ thread: MailThreadSummary) -> some View {
        Menu("Snooze") {
            Button("Later today") {
                Task { await environment.store.snooze(thread, until: Self.laterToday) }
            }
            Button("Tomorrow morning") {
                Task { await environment.store.snooze(thread, until: Self.tomorrowMorning) }
            }
            Button("Next week") {
                Task { await environment.store.snooze(thread, until: Self.nextWeekMorning) }
            }
        }
    }

    var body: some View {
        @Bindable var navigation = environment.navigation
        List(selection: $selectedThreadKeys) {
            if mailboxScope == .snoozed {
                snoozedSection(navigation: navigation)
            } else {
                // The category strip is the list's first (non-pinned) row so the
                // inbox starts immediately beneath the navigation bar — no stacked
                // large-title/top-inset blank band. Date groups stay pinned.
                Section {
                    categoryPills
                        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                    // A mailbox whose sign-in ended is not a mail scope until it
                    // reconnects. Say so where the mail would be.
                    ForEach(environment.store.reconnectAccounts) { account in
                        reconnectRow(account)
                    }
                }
                if filteredThreads.isEmpty {
                    switch placeholder {
                    case .loading(let label):
                        loadingRow(label)
                    case .loadMore:
                        // Older pages may still hold this scope's mail. Keep
                        // asking instead of calling the view empty.
                        loadMoreRow
                    case .empty(let copy):
                        MailEmptyStateView(copy: copy)
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                    }
                } else {
                    ForEach(groupedThreads) { group in
                        Section {
                            ForEach(group.threads, id: \.listKey) { thread in
                                threadRow(thread, navigation: navigation)
                            }
                        } header: {
                            MailDateline(label: group.label)
                        }
                    }
                    // Older pages stream in beneath the list as this row scrolls
                    // into view; the unified cursor comes from the typed v1 reads.
                    if Self.showsLoadMoreRow(
                        hasMore: environment.store.hasMoreMail(in: listScope),
                        accountScope: accountScope,
                        query: effectiveQuery
                    ) {
                        loadMoreRow
                    }
                }
            }
        }
        .listStyle(.plain)
        .listSectionSpacing(.compact)
        .scrollContentBackground(.hidden)
        .background(environment.theme.paperColor)
        .environment(\.editMode, $editMode)
        .contentMargins(.top, 0, for: .scrollContent)
        #if os(iOS)
        // The search field floats over the foot of the list; the last row
        // scrolls clear of it (D9).
        .contentMargins(.bottom, Self.bottomBarClearance, for: .scrollContent)
        #endif
        .navigationTitle("Mail")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // Mail owns its bottom bar: the system search field beside the
            // global create menu (the iOS 26+ search-plus-action pattern Apple
            // Mail uses). Selection mode swaps in the bulk actions and hands
            // the bar back when selection ends.
            if editMode.isEditing {
                ToolbarItem(placement: .bottomBar) {
                    Button("Archive", systemImage: "archivebox") {
                        performBulkRemoval(label: "Archived") { threads in
                            await environment.store.bulkArchive(threads)
                        }
                    }
                    .disabled(selectedThreads.isEmpty)
                }
                ToolbarItem(placement: .bottomBar) {
                    Button("Trash", systemImage: "trash", role: .destructive) {
                        performBulkRemoval(label: "Moved to Trash") { threads in
                            await environment.store.bulkTrash(threads)
                        }
                    }
                    .disabled(selectedThreads.isEmpty)
                }
                ToolbarSpacer(.flexible, placement: .bottomBar)
                ToolbarItem(placement: .bottomBar) {
                    Button {
                        let threads = selectedThreads
                        isBulkTriaging = true
                        Task {
                            triageVerdicts = await environment.store.bulkTriage(threads)
                            isBulkTriaging = false
                            editMode = .inactive
                            selectedThreadKeys.removeAll()
                        }
                    } label: {
                        if isBulkTriaging { ProgressView() } else { Text("Triage") }
                    }
                    .disabled(selectedThreads.isEmpty || isBulkTriaging)
                }
            } else {
                DefaultToolbarItem(kind: .search, placement: .bottomBar)
                ToolbarSpacer(.flexible, placement: .bottomBar)
                ToolbarItem(placement: .bottomBar) {
                    GlobalCreateMenu {
                        Label("Create", systemImage: "plus")
                    }
                }
            }
            ToolbarItem(placement: .topBarLeading) {
                Menu {
                    Section("Account") {
                        scopeButton(title: "All Accounts", selected: accountScope.isEmpty) {
                            accountScope.removeAll()
                        }
                        ForEach(environment.store.accounts) { account in
                            scopeButton(
                                title: accountMenuTitle(account.id, fallback: account.displayName ?? account.email),
                                selected: accountScope.contains(account.id)
                            ) {
                                if accountScope.contains(account.id) {
                                    accountScope.remove(account.id)
                                } else {
                                    accountScope.insert(account.id)
                                }
                            }
                        }
                    }
                    Section("Mailbox") {
                        Picker("Mailbox", selection: $mailboxScope) {
                            ForEach(MailboxScope.allCases) { mailbox in
                                Label(mailbox.title, systemImage: mailbox.symbol).tag(mailbox)
                            }
                        }
                    }
                    Section {
                        Button("Scheduled") { showsScheduledSends = true }
                        Button("Sender cleanup") { showsSenderCleanup = true }
                    }
                } label: {
                    Label(scopeTitle, systemImage: "line.3.horizontal.decrease.circle")
                }
            }
            if mailboxScope != .snoozed {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(editMode.isEditing ? "Done" : "Select") {
                        withAnimation {
                            editMode = editMode.isEditing ? .inactive : .active
                            if !editMode.isEditing { selectedThreadKeys.removeAll() }
                        }
                    }
                }
            }
            #if os(macOS)
            if isSearchFocused || !searchText.isEmpty {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close Search", systemImage: "xmark") {
                        searchText = ""
                        isSearchFocused = false
                    }
                    .keyboardShortcut(.cancelAction)
                    .help("Clear and close search (Escape)")
                    .accessibilityHint("Clears the query and returns keyboard focus to the inbox.")
                }
            }
            #endif
        }
        .searchable(text: $searchText, isPresented: $isSearchFocused, prompt: "Search this inbox")
        .onReceive(NotificationCenter.default.publisher(for: .albatrossFocusMailSearch)) { _ in
            isSearchFocused = true
        }
        .onAppear {
            if let query = environment.navigation.consumeMailSearch(currentQuery: searchText) {
                searchText = query
                isSearchFocused = true
            }
            if let raw = environment.navigation.pendingMailCategory {
                showCategory(raw)
            }
            if let mailbox = environment.navigation.pendingMailbox {
                showMailbox(mailbox)
            }
        }
        .onChange(of: environment.navigation.pendingMailSearch) { _, _ in
            guard let query = environment.navigation.consumeMailSearch(currentQuery: searchText) else { return }
            searchText = query
            isSearchFocused = true
        }
        .onChange(of: environment.navigation.pendingMailCategory) { _, raw in
            guard let raw else { return }
            showCategory(raw)
        }
        .onChange(of: environment.navigation.pendingMailbox) { _, mailbox in
            guard let mailbox else { return }
            showMailbox(mailbox)
        }
        .onChange(of: selection, initial: true) { _, value in
            environment.navigation.mailLabelID = value.labelID
        }
        .onChange(of: mailboxScope, initial: true) { _, value in
            environment.navigation.mailbox = value
            if value == .snoozed {
                editMode = .inactive
                selectedThreadKeys.removeAll()
            }
        }
        .task(id: mailboxScope) {
            guard mailboxScope == .snoozed else { return }
            await environment.store.refreshSnoozed()
        }
        .task(id: effectiveQuery) {
            // Each new query starts with no answer, also an empty one.
            answeredSearchQuery = nil
            let query = effectiveQuery
            guard !query.isEmpty else {
                await environment.store.searchMail("")
                return
            }
            do {
                try await Task.sleep(for: .milliseconds(300))
            } catch {
                return
            }
            await environment.store.searchMail(query)
            // The request ended, with an answer or without one. An empty
            // list now means no matches, not "still searching".
            guard !Task.isCancelled else { return }
            answeredSearchQuery = query
        }
        .task { await categoryCounts.follow(convex: environment.convex) }
        // Resolve sender photos for whatever's currently visible, grouped by
        // each thread's own account. Re-runs only when the visible set of
        // (account, sender) pairs actually changes — the store itself
        // dedupes against its cache, so this just keeps it fed.
        .task(id: visibleSenderResolutionKey) {
            let entries = filteredThreads.compactMap { thread -> (email: String, account: String)? in
                guard let email = thread.senderEmail else { return nil }
                return (email: email, account: thread.accountID)
            }
            await environment.mailIdentity.resolve(entries: entries)
        }
        .sheet(isPresented: $showsSenderCleanup) {
            #if os(macOS)
            // A checkbox list with the batch action in a footer: a Mac sheet
            // has no bottom bar for the phone's Block.
            MacSenderCleanupView()
            #else
            SenderCleanupView()
            #endif
        }
        .sheet(isPresented: $showsScheduledSends) {
            ScheduledSendsView()
        }
        .sheet(item: $categoryInfoThread) { thread in
            CategoryExplanationSheet(thread: thread) { correction in
                Task {
                    if await environment.store.correctCategory(thread, to: correction) {
                        categoryInfoThread = nil
                    }
                }
            }
            .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: Binding(
            get: { !triageVerdicts.isEmpty },
            set: { if !$0 { triageVerdicts = [] } }
        )) {
            NavigationStack {
                List(triageVerdicts) { verdict in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(verdict.action.capitalized).font(.headline)
                            Spacer()
                            Text("P\(verdict.priority)").font(.caption).foregroundStyle(.secondary)
                        }
                        Text(verdict.reason).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                .navigationTitle("Albatross Triage")
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { triageVerdicts = [] }
                    }
                }
            }
        }
        // Each scope pages from the server with its own cursor (NAT-2).
        .task(id: "\(listScope.key)|\(environment.store.mailScopeGeneration)") {
            await environment.store.loadMailScope(listScope)
        }
        .refreshable {
            if mailboxScope == .snoozed {
                await environment.store.refreshSnoozed()
            } else {
                await environment.store.refreshMail()
            }
        }
        .alert(
            "Mail couldn’t finish that",
            isPresented: Binding(
                get: { environment.store.mailErrorMessage != nil },
                set: { if !$0 { environment.store.clearMailError() } }
            )
        ) {
            Button("Try Again") {
                environment.store.clearMailError()
                Task { await environment.store.refreshMail() }
            }
            Button("Dismiss", role: .cancel) { environment.store.clearMailError() }
        } message: {
            Text(environment.store.mailErrorMessage ?? "Try again.")
        }
        #if !os(macOS)
        // The Mac reads the same route in a pane beside the list
        // (MacMailSplitView); only the phone pushes the thread over it.
        .navigationDestination(
            isPresented: Binding(
                get: { navigation.threadRoute != nil },
                set: { if !$0 { navigation.threadRoute = nil } }
            )
        ) {
            if let route = navigation.threadRoute {
                ThreadView(route: route, summary: environment.store.threads.first { route.matches($0) })
                    // A new route is a new reader, not the old one re-fed:
                    // the second thread must not open on the first one's
                    // messages (M9).
                    .id(route)
            }
        }
        #endif
        .shellToolbar()
    }

    // Room under the list for the floating search field and create menu.
    static let bottomBarClearance: CGFloat = 88

    private var placeholder: MailListPlaceholder {
        MailListPlaceholder.resolve(
            mailDidLoad: environment.store.mailDidLoad,
            searchPending: MailSearchPending.isPending(
                query: effectiveQuery,
                completedQuery: environment.store.completedMailSearchQuery,
                answeredQuery: answeredSearchQuery
            ),
            query: effectiveQuery,
            showsLoadMore: Self.showsLoadMoreRow(
                hasMore: environment.store.hasMoreMail(in: listScope)
                    || environment.store.isLoadingMail(in: listScope),
                accountScope: accountScope,
                query: effectiveQuery
            ),
            mailbox: mailboxScope,
            selection: selection,
            labelName: selection.labelID.flatMap { id in environment.store.mailLabels.first { $0.id == id }?.name },
            searchText: searchText
        )
    }

    private func loadingRow(_ label: String) -> some View {
        HStack {
            Spacer()
            ProgressView(label)
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.vertical, 32)
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    @ViewBuilder
    private func threadRow(_ thread: MailThreadSummary, navigation: NavigationModel) -> some View {
        let badges = MailRowBadges.labels(for: thread, selection: selection, labels: environment.store.mailLabels)
        if editMode.isEditing {
            MailThreadRow(thread: thread, badges: badges)
                .tag(threadKey(thread))
                .listRowBackground(Color.clear)
        } else {
            Button {
                navigation.threadRoute = ThreadRoute(accountID: thread.accountID, threadID: thread.id)
            } label: {
                MailThreadRow(thread: thread, badges: badges)
            }
            .buttonStyle(.plain)
            .listRowBackground(rowBackground(for: thread, navigation: navigation))
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if thread.unread {
                Button("Read", systemImage: "envelope.open") {
                    Task { await environment.store.markRead(thread) }
                }
                .tint(.blue)
            } else {
                Button("Unread", systemImage: "envelope.badge") {
                    Task { await environment.store.markUnread(thread) }
                }
                .tint(.blue)
            }
            Button(thread.starred ? "Unstar" : "Star", systemImage: thread.starred ? "star.slash" : "star") {
                Task { await environment.store.setStarred(!thread.starred, thread: thread) }
            }
            .tint(.yellow)
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Trash", systemImage: "trash", role: .destructive) {
                Task { await environment.store.trash(thread) }
            }
            Button("Archive", systemImage: "archivebox") {
                Task { await environment.store.archive(thread) }
            }
            .tint(.orange)
            Button("Snooze", systemImage: "clock") {
                Task { await environment.store.snooze(thread, until: Self.tomorrowMorning) }
            }
            .tint(.indigo)
            }
            .contextMenu {
            Button(thread.unread ? "Mark Read" : "Mark Unread", systemImage: thread.unread ? "envelope.open" : "envelope.badge") {
                Task {
                    if thread.unread { await environment.store.markRead(thread) }
                    else { await environment.store.markUnread(thread) }
                }
            }
            Button(thread.starred ? "Unstar" : "Star", systemImage: thread.starred ? "star.slash" : "star") {
                Task { await environment.store.setStarred(!thread.starred, thread: thread) }
            }
            Button("Archive", systemImage: "archivebox") {
                Task { await environment.store.archive(thread) }
            }
            Menu("Correct category") {
                ForEach(MailCategoryCorrection.allCases) { correction in
                    Button(correction.title) {
                        Task { _ = await environment.store.correctCategory(thread, to: correction) }
                    }
                }
            }
            Button("Why this category?", systemImage: "info.circle") {
                categoryInfoThread = thread
            }
            snoozeMenu(thread)
            Button("Move to Trash", systemImage: "trash", role: .destructive) {
                Task { await environment.store.trash(thread) }
            }
            }
        }
    }

    // A category or label request from the sidebar leaves the Snoozed mailbox.
    private func showCategory(_ raw: String) {
        selection = MailScopeSelection.from(raw: raw)
        if mailboxScope == .snoozed { mailboxScope = .inbox }
        environment.navigation.pendingMailCategory = nil
    }

    private func showMailbox(_ mailbox: MailboxScope) {
        mailboxScope = mailbox
        environment.navigation.pendingMailbox = nil
    }

    // The Snoozed mailbox: mail that comes back to the inbox later. No search
    // or label finds it, so the rows come from `list_snoozed`.
    @ViewBuilder
    private func snoozedSection(navigation: NavigationModel) -> some View {
        let rows = visibleSnoozedThreads
        if rows.isEmpty {
            if environment.store.isLoadingSnoozed && !environment.store.snoozedDidLoad {
                HStack {
                    Spacer()
                    ProgressView("Loading snoozed mail…")
                    Spacer()
                }
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            } else if let error = environment.store.snoozedError, !environment.store.snoozedDidLoad {
                ContentUnavailableView {
                    Label("Could not load snoozed mail", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try Again") { Task { await environment.store.refreshSnoozed() } }
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            } else {
                ContentUnavailableView(
                    "Nothing is snoozed",
                    systemImage: "clock",
                    description: Text(searchText.isEmpty
                        ? "Snoozed mail comes back to the inbox at its time."
                        : "Try a different search.")
                )
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
        } else {
            Section {
                ForEach(rows) { row in
                    MailSnoozedRow(
                        row: row,
                        showsAccount: environment.store.accounts.count > 1,
                        onOpen: {
                            navigation.threadRoute = ThreadRoute(accountID: row.accountID, threadID: row.threadID)
                        },
                        onUnsnooze: {
                            Task { await environment.store.unsnooze(row) }
                        }
                    )
                    #if os(macOS)
                    // The reading pane shows the open row; the list marks it.
                    .listRowBackground(
                        navigation.threadRoute?.matches(row) == true
                            ? environment.theme.accentSoftColor.opacity(0.6)
                            : Color.clear
                    )
                    #else
                    .listRowBackground(Color.clear)
                    #endif
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        Button("Unsnooze", systemImage: "clock.arrow.circlepath") {
                            Task { await environment.store.unsnooze(row) }
                        }
                        .tint(.indigo)
                    }
                    .contextMenu {
                        Button("Unsnooze", systemImage: "clock.arrow.circlepath") {
                            Task { await environment.store.unsnooze(row) }
                        }
                    }
                }
            }
        }
    }

    private var visibleSnoozedThreads: [MailSnoozedThread] {
        MailSnoozedThread.filter(
            environment.store.snoozedThreads,
            accounts: accountScope,
            query: searchText
        )
    }

    // The web rail's mail views where the thumb is: the four primary views
    // as text pills with their unread counts, then More with the rest of
    // the views and the user's labels. Selection carries the fill.
    private var categoryPills: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(MailCategoryScope.primary) { category in
                    let selected = selection.labelID == nil && selection.category == category
                    categoryPill(
                        title: category.title,
                        count: categoryCounts.badge(for: category),
                        selected: selected
                    ) {
                        selection = MailScopeSelection(category: category)
                    }
                }
                moreViewsMenu
            }
            .padding(.horizontal, 16)
            .padding(.top, 2)
            .padding(.bottom, 6)
        }
        .background(environment.theme.paperColor.opacity(0.01))
    }

    // The More pill names the view it holds when one is selected, as the
    // web's More control does.
    private var moreViewsMenu: some View {
        Menu {
            Section("Views") {
                ForEach(MailCategoryScope.more) { category in
                    let selected = selection.labelID == nil && selection.category == category
                    scopeButton(title: category.title, selected: selected) {
                        selection = MailScopeSelection(category: category)
                    }
                }
            }
            if !environment.store.mailLabels.isEmpty {
                // Custom labels the user shows in the sidebar (NAT-4).
                Section("Labels") {
                    ForEach(environment.store.mailLabels) { label in
                        scopeButton(title: label.name, selected: selection.labelID == label.id) {
                            selection = MailScopeSelection.from(raw: label.rawCategory)
                        }
                    }
                }
            }
        } label: {
            pillLabel(title: moreTitle, count: nil, selected: moreSelected, trailingSymbol: "chevron.down")
        }
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .accessibilityLabel(moreSelected ? "More mail views, \(moreTitle)" : "More mail views")
    }

    private var moreSelected: Bool {
        selection.labelID != nil || MailCategoryScope.more.contains(selection.category)
    }

    private var moreTitle: String {
        if let labelID = selection.labelID,
           let label = environment.store.mailLabels.first(where: { $0.id == labelID }) {
            return label.name
        }
        if MailCategoryScope.more.contains(selection.category) { return selection.category.title }
        return "More"
    }

    private func reconnectRow(_ account: AccountSummary) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Reconnect needed")
                    .font(.subheadline.weight(.semibold))
                Text("\(account.email) stopped syncing. Sign in again to get its mail.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Button(reconnectingID == account.id ? "Reconnecting…" : "Reconnect") {
                Task { await reconnect(account) }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(reconnectingID != nil)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
    }

    private func reconnect(_ account: AccountSummary) async {
        reconnectingID = account.id
        defer { reconnectingID = nil }
        do {
            try await environment.webAuthentication.connectMailbox(provider: account.provider, accountId: account.id)
            await environment.store.refreshMail()
        } catch {
            // The sign-in sheet reports its own failure; the row stays.
        }
    }

    private func categoryPill(
        title: String,
        count: String?,
        selected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            pillLabel(title: title, count: count, selected: selected, trailingSymbol: nil)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(count.map { "\(title), \($0) unread" } ?? title)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    // Text first; the count and the More chevron come after it.
    private func pillLabel(title: String, count: String?, selected: Bool, trailingSymbol: String?) -> some View {
        HStack(spacing: 6) {
            Text(title)
                .font(.subheadline.weight(selected ? .semibold : .regular))
            if let count {
                Text(count)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(selected ? AnyShapeStyle(environment.theme.accentColor.opacity(0.8)) : AnyShapeStyle(.tertiary))
            }
            if let trailingSymbol {
                Image(systemName: trailingSymbol)
                    .font(.caption2.weight(.semibold))
            }
        }
        .lineLimit(1)
        .fixedSize()
        .foregroundStyle(selected ? environment.theme.accentColor : .secondary)
        .padding(.horizontal, 13)
        .padding(.vertical, 7)
        .background(
            Capsule().fill(selected ? environment.theme.accentSoftColor : .clear)
        )
        .overlay {
            if !selected {
                Capsule().strokeBorder(environment.theme.hairlineColor, lineWidth: 1)
            }
        }
        .contentShape(Capsule())
    }

    // The scope this view pages from the server.
    private var listScope: MailListScope {
        selection.listScope(accountScope: accountScope)
    }

    // Older pages stream in beneath the list as this row comes on screen.
    // The task re-runs each time the cursor moves, so a row that stays on
    // screen (an empty scope) keeps asking until the scope has no more. A
    // page that fails leaves the cursor where it was; the row then offers
    // Load more instead of a spinner that never ends (M8).
    private var loadMoreRow: some View {
        let token = environment.store.mailCursorToken(in: listScope)
        return HStack {
            Spacer()
            if failedLoadMoreToken == token {
                Button("Load more") {
                    failedLoadMoreToken = nil
                    Task { await loadOlderPage(token: token) }
                }
                .font(.subheadline.weight(.medium))
                .buttonStyle(.plain)
                .foregroundStyle(environment.theme.accentColor)
                .accessibilityHint("Older mail did not load. Tries again.")
            } else {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Loading older mail")
            }
            Spacer()
        }
        .padding(.vertical, 8)
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .task(id: token) {
            await loadOlderPage(token: token)
        }
    }

    private func loadOlderPage(token: String) async {
        let scope = listScope
        await environment.store.loadMoreMail(in: scope)
        guard !Task.isCancelled else { return }
        if MailLoadMoreOutcome.failed(
            tokenBefore: token,
            tokenAfter: environment.store.mailCursorToken(in: scope),
            hasMore: environment.store.hasMoreMail(in: scope),
            isLoading: environment.store.isLoadingMail(in: scope)
        ) {
            failedLoadMoreToken = token
        }
    }

    private struct ThreadGroup: Identifiable {
        // Positional identity: the store sorts newest-first, but a label can
        // legitimately recur (search results, snoozed returns) and must not
        // collide.
        let id: Int
        let label: String
        var threads: [MailThreadSummary]
    }

    private var groupedThreads: [ThreadGroup] {
        var groups: [ThreadGroup] = []
        for thread in filteredThreads {
            let label = Self.datelineLabel(for: thread.date)
            if let last = groups.indices.last, groups[last].label == label {
                groups[last].threads.append(thread)
            } else {
                groups.append(ThreadGroup(id: groups.count, label: label, threads: [thread]))
            }
        }
        return groups
    }

    // Editorial date buckets, matching the desktop inbox datelines: Today,
    // Yesterday, weekday names inside the current week, then month names.
    static func datelineLabel(for date: Date, now: Date = .now) -> String {
        let calendar = Calendar.autoupdatingCurrent
        if calendar.isDate(date, inSameDayAs: now) { return "Today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) {
            return "Yesterday"
        }
        if calendar.isDate(date, equalTo: now, toGranularity: .weekOfYear) {
            return date.formatted(.dateTime.weekday(.wide))
        }
        if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            return date.formatted(.dateTime.month(.wide))
        }
        return date.formatted(.dateTime.month(.wide).year())
    }

    // Structural key for the `.task(id:)` above: changes whenever the visible
    // (account, sender) pairs change, so photo resolution re-fires exactly
    // when there's something new to look up.
    private var visibleSenderResolutionKey: String {
        filteredThreads.compactMap { thread -> String? in
            guard let email = thread.senderEmail else { return nil }
            return "\(thread.accountID):\(email)"
        }.joined(separator: ",")
    }

    private var filteredThreads: [MailThreadSummary] {
        let query = effectiveQuery
        let candidates: [MailThreadSummary]
        if query.isEmpty {
            candidates = environment.store.threads
        } else if environment.store.completedMailSearchQuery == query {
            candidates = environment.store.searchedThreads
        } else {
            // Keep the inbox responsive during the debounce/network window. Once
            // indexed search completes, its cross-account results replace this subset.
            candidates = environment.store.threads.filter {
                $0.subject.localizedCaseInsensitiveContains(query)
                    || $0.sender.localizedCaseInsensitiveContains(query)
                    || $0.snippet.localizedCaseInsensitiveContains(query)
            }
        }
        return candidates.filter { thread in
            (accountScope.isEmpty || accountScope.contains(thread.accountID))
                && selection.includes(thread)
        }
    }

    private var scopeTitle: String {
        let accountLabel: String
        if accountScope.isEmpty {
            accountLabel = "All Accounts"
        } else if accountScope.count == 1, let id = accountScope.first {
            accountLabel = environment.store.accounts.first(where: { $0.id == id })?.displayName
                ?? environment.store.accounts.first(where: { $0.id == id })?.email
                ?? "Account"
        } else {
            accountLabel = "\(accountScope.count) Accounts"
        }
        return mailboxScope == .inbox ? accountLabel : "\(mailboxScope.title), \(accountLabel)"
    }

    // Each scope has its own server cursor: the unified inbox, one account,
    // a category, or a label. Several accounts at once, or a mailbox query
    // (Unread, Starred, search), narrow the list locally, so a fetched page
    // could add nothing visible; those views stay on what is loaded.
    nonisolated static func showsLoadMoreRow(hasMore: Bool, accountScope: Set<String>, query: String) -> Bool {
        hasMore && accountScope.count <= 1 && query.isEmpty
    }

    private var effectiveQuery: String {
        [mailboxScope.query, searchText.trimmingCharacters(in: .whitespacesAndNewlines)]
            .compactMap { $0?.isEmpty == false ? $0 : nil }
            .joined(separator: " ")
    }

    private var selectedThreads: [MailThreadSummary] {
        filteredThreads.filter { selectedThreadKeys.contains(threadKey($0)) }
    }

    // The Undo for a bulk removal is the shell's undo notice: it takes back
    // the operations the server recorded, so Activity reads them as undone
    // too (round 2, FEATURES item 10).
    private func performBulkRemoval(
        label: String,
        operation: @escaping @MainActor ([MailThreadSummary]) async -> Void
    ) {
        let threads = selectedThreads
        guard !threads.isEmpty else { return }
        selectedThreadKeys.removeAll()
        editMode = .inactive
        PlatformAccessibility.announce(label)
        Task { await operation(threads) }
    }

    private func threadKey(_ thread: MailThreadSummary) -> String {
        "\(thread.accountID):\(thread.id)"
    }

    // The Mac keeps the list on screen while a thread is open, so the open
    // row needs to read as the one being read.
    private func rowBackground(for thread: MailThreadSummary, navigation: NavigationModel) -> Color {
        #if os(macOS)
        if navigation.threadRoute?.matches(thread) == true {
            return environment.theme.accentSoftColor.opacity(0.6)
        }
        #endif
        return .clear
    }

    private func accountMenuTitle(_ id: String, fallback: String) -> String {
        guard let account = environment.accountStore.accounts.first(where: { $0.id == id }) else {
            return fallback
        }
        switch account.sync.status {
        case .ready:
            if let date = account.sync.lastSyncedAt {
                return "\(fallback), \(date.formatted(.relative(presentation: .named)))"
            }
            return "\(fallback), up to date"
        case .backfilling: return "\(fallback), backfilling"
        case .syncing: return "\(fallback), syncing"
        case .error: return "\(fallback), needs attention"
        case .idle: return fallback
        }
    }

    private func scopeButton(
        title: String,
        selected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            if selected {
                Label(title, systemImage: "checkmark")
            } else {
                Text(title)
            }
        }
    }
}

// The mail views, the web's model (lib/mail/navigation.ts): four primary
// views in the strip, the rest under More. The raw values are the web's
// category ids, so a sidebar tap, a deep link, and a stored preference
// name the same view on every platform. `all` stays for links minted
// before this round; it is not in the strip.
enum MailCategoryScope: String, CaseIterable, Identifiable {
    case main
    case needsReply = "needs_reply"
    case noise
    case codes
    case needsAction = "needs_action"
    case waitingFor = "waiting_for"
    case importantChanges = "important_changes"
    case orders
    case financeAdmin = "finance_admin"
    case review
    case all

    var id: String { rawValue }

    /// The strip, in the web's order.
    static let primary: [MailCategoryScope] = [.main, .needsReply, .noise, .codes]

    /// The More menu, in the web's order.
    static let more: [MailCategoryScope] = [.needsAction, .waitingFor, .importantChanges, .orders, .financeAdmin, .review]

    var title: String {
        switch self {
        case .main: "Main"
        case .needsReply: "Needs reply"
        case .noise: "Noise"
        case .codes: "Codes"
        case .needsAction: "Needs action"
        case .waitingFor: "Waiting for"
        case .importantChanges: "Changes"
        case .orders: "Orders"
        case .financeAdmin: "Finance / admin"
        case .review: "Review"
        case .all: "All mail"
        }
    }

    // Symbols for places that list views with a glyph (menus, the sidebar).
    // The strip itself shows text only.
    var symbol: String {
        switch self {
        case .main: "person.crop.circle"
        case .needsReply: "arrowshape.turn.up.left"
        case .noise: "speaker.slash"
        case .codes: "key"
        case .needsAction: "checkmark.circle"
        case .waitingFor: "hourglass"
        case .importantChanges: "arrow.triangle.2.circlepath"
        case .orders: "shippingbox"
        case .financeAdmin: "doc.text"
        case .review: "eye"
        case .all: "tray.full"
        }
    }

    // Filled variants carry the selected state where the symbol has one.
    var selectedSymbol: String {
        switch self {
        case .waitingFor, .importantChanges: symbol
        default: "\(symbol).fill"
        }
    }

    // The server category a scope pages by. Main is the unified list with
    // the local rule below; the other views page by their web id.
    var serverCategory: String? {
        switch self {
        case .main, .all: nil
        default: rawValue
        }
    }

    // Maps any raw category string, including deep-link values minted before
    // this round, onto the view that shows that mail.
    static func from(raw: String?) -> MailCategoryScope {
        guard let raw, !raw.isEmpty else { return .main }
        return MailCategoryScope(rawValue: raw) ?? .main
    }

    // Whether a stored classification is visible inside this view. Main is
    // the web's Main: a `main` verdict or no verdict yet. Mail that a
    // label-move rule filed arrives as `custom:<labelId>` and shows only in
    // All mail and in its label view.
    func includes(storedCategory: String?) -> Bool {
        includes(storedCategory: storedCategory, secondary: nil)
    }

    // Every other view follows the web rule: the primary or a secondary
    // category matches, and the thread is not filed under a label. The
    // attention views (Needs reply, Needs action, Waiting for, Changes) are
    // Jev views on the server; the summary carries only the classifier's
    // categories, so a row the server lists there shows when its category
    // names the view.
    func includes(storedCategory: String?, secondary: [String]?) -> Bool {
        switch self {
        case .all:
            return true
        case .main:
            return (storedCategory == nil || storedCategory == rawValue) && !Self.isFiled(storedCategory)
        default:
            guard !Self.isFiled(storedCategory) else { return false }
            return storedCategory == rawValue || (secondary ?? []).contains(rawValue)
        }
    }

    func includes(_ thread: MailThreadSummary) -> Bool {
        includes(storedCategory: thread.category, secondary: thread.secondaryCategories)
    }

    static func isFiled(_ storedCategory: String?) -> Bool {
        storedCategory?.hasPrefix("custom:") == true
    }

    // Human title for a stored classification in the explanation sheet.
    static func storedTitle(_ storedCategory: String?) -> String {
        guard let storedCategory else { return "Unclassified" }
        if isFiled(storedCategory) { return "Filed under your label" }
        return storedCategory.replacingOccurrences(of: "_", with: " ").capitalized
    }
}

// Where a thread can be corrected TO (CLS-9). All Mail is a viewing scope,
// not a classifier destination; Noise is a destination with no view.
enum MailCategoryCorrection: String, CaseIterable, Identifiable {
    case main
    case codes
    case orders
    case noise

    var id: String { rawValue }

    var title: String {
        switch self {
        case .main: "Main"
        case .codes: "Codes"
        case .orders: "Orders"
        case .noise: "Noise"
        }
    }

    // The `apply_smart_correction` arguments for this choice.
    func arguments(accountID: String, threadID: String) -> [String: JSONValue] {
        var arguments: [String: JSONValue] = [
            "account": .string(accountID),
            "threadId": .string(threadID),
            "scope": .string("sender"),
        ]
        if self == .noise {
            arguments["action"] = .string("always_noise")
        } else {
            arguments["action"] = .string("move_to")
            arguments["category"] = .string(rawValue)
        }
        return arguments
    }
}

// What the mail list shows: a built-in scope, or a custom label (NAT-4).
struct MailScopeSelection: Hashable {
    var category: MailCategoryScope = .main
    var labelID: String? = nil

    static func from(raw: String?) -> MailScopeSelection {
        if let raw, raw.hasPrefix("custom:") {
            let id = String(raw.dropFirst("custom:".count))
            if !id.isEmpty { return MailScopeSelection(category: .all, labelID: id) }
        }
        return MailScopeSelection(category: MailCategoryScope.from(raw: raw))
    }

    func includes(_ thread: MailThreadSummary) -> Bool {
        if let labelID {
            return thread.category == "custom:\(labelID)" || (thread.labelIDs ?? []).contains(labelID)
        }
        return category.includes(thread)
    }

    // The server list this view pages (NAT-2). One account goes to the
    // server; several accounts stay a filter over the unified list.
    func listScope(accountScope: Set<String>) -> MailListScope {
        let accountID = accountScope.count == 1 ? accountScope.first : nil
        let serverCategory = labelID.map { "custom:\($0)" } ?? category.serverCategory
        return MailListScope(accountID: accountID, category: serverCategory)
    }
}

enum MailboxScope: String, CaseIterable, Identifiable {
    // Snoozed has no query: a snoozed thread is archived now and comes back
    // by itself, so no search finds it (audit MUT-1). Its rows come from
    // `list_snoozed` instead.
    case inbox, unread, starred, important, attachments, thisWeek, snoozed, sent, drafts, allMail, trash
    var id: Self { self }
    var title: String {
        switch self {
        case .inbox: "Inbox"
        case .unread: "Unread"
        case .starred: "Starred"
        case .important: "Important"
        case .attachments: "Attachments"
        case .thisWeek: "This Week"
        case .snoozed: "Snoozed"
        case .sent: "Sent"
        case .drafts: "Drafts"
        case .allMail: "All Mail"
        case .trash: "Trash"
        }
    }
    var symbol: String {
        switch self {
        case .inbox: "tray"
        case .unread: "envelope.badge"
        case .starred: "star"
        case .important: "tag"
        case .attachments: "paperclip"
        case .thisWeek: "calendar"
        case .snoozed: "clock"
        case .sent: "paperplane"
        case .drafts: "doc"
        case .allMail: "tray.full"
        case .trash: "trash"
        }
    }
    var query: String? {
        switch self {
        case .inbox: nil
        case .unread: "is:unread"
        case .starred: "is:starred"
        case .important: "label:IMPORTANT"
        case .attachments: "has:attachment"
        case .thisWeek: "newer_than:7d"
        case .snoozed: nil
        case .sent: "in:sent"
        case .drafts: "in:drafts"
        case .allMail: "-in:trash"
        case .trash: "in:trash"
        }
    }
}

private struct CategoryExplanationSheet: View {
    #if os(macOS)
    @Environment(\.dismiss) private var dismiss
    #endif
    let thread: MailThreadSummary
    let onCorrect: (MailCategoryCorrection) -> Void

    var body: some View {
        NavigationStack {
            List {
                Section("Classification") {
                    LabeledContent("Category", value: MailCategoryScope.storedTitle(thread.category))
                    if let confidence = thread.categoryConfidence {
                        LabeledContent("Confidence", value: confidence.formatted(.percent.precision(.fractionLength(0))))
                    }
                    Text(thread.categoryReason ?? "Albatross has not stored an explanation for this thread yet.")
                        .foregroundStyle(.secondary)
                }
                Section("Correct category") {
                    ForEach(MailCategoryCorrection.allCases) { correction in
                        Button(correction.title) { onCorrect(correction) }
                    }
                }
            }
            .navigationTitle("Why this category?")
            .navigationBarTitleDisplayMode(.inline)
            #if os(macOS)
            // A Mac sheet has no swipe to close, and a list gives it no size.
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            #endif
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 440)
        #endif
    }
}

// The dateline: display-italic day buckets over a hairline — the desktop
// inbox's serif date headers.
private struct MailDateline: View {
    @Environment(AppEnvironment.self) private var environment
    let label: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(environment.theme.displayType.displayItalicFont(size: 15))
                .foregroundStyle(.secondary)
            Divider()
        }
        .padding(.top, 2)
        .textCase(nil)
        .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 0, trailing: 16))
        .accessibilityAddTraits(.isHeader)
    }
}

// Desktop row grammar: [unread gutter][avatar][sender/subject/snippet][meta].
// The unread dot lives in a stable gutter so scanning is one vertical
// eye-track; the sender carries the display face. At accessibility text
// sizes the time moves under the sender and the sender gets two lines, so
// a name is never cut to eight letters (D3). Status is words, not glyphs.
private struct MailThreadRow: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var avatarMetric: CGFloat = 40
    let thread: MailThreadSummary
    var badges: [String] = []

    private var avatarSize: CGFloat { SenderAvatar.resolvedSize(scaled: avatarMetric, base: 40) }
    private var stacksMeta: Bool { dynamicTypeSize.isAccessibilitySize }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(thread.unread ? environment.theme.accentColor : .clear)
                .frame(width: 7, height: 7)
                .padding(.top, 2 + avatarSize / 2 - 3.5)
                .accessibilityHidden(true)
            SenderAvatar(name: thread.sender, email: thread.senderEmail)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                headline
                Text(thread.subject)
                    .font(.subheadline.weight(thread.unread ? .medium : .regular))
                    .lineLimit(stacksMeta ? 2 : 1)
                Text(thread.snippet)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                if !badges.isEmpty {
                    badgeLine
                }
            }
        }
        .padding(.vertical, 6)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityValue(thread.unread ? "Unread" : "Read")
    }

    private var senderText: some View {
        Text(thread.senderDisplayName)
            .font(environment.theme.displayType.displayFont(
                size: 16,
                weight: thread.unread ? .semibold : .regular
            ))
            .foregroundStyle(thread.unread ? .primary : Color.primary.opacity(0.85))
    }

    private var timeText: some View {
        Text(thread.date, format: thread.date.isToday ? .dateTime.hour().minute() : .dateTime.month().day())
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    @ViewBuilder private var headline: some View {
        if stacksMeta {
            VStack(alignment: .leading, spacing: 0) {
                senderText.lineLimit(2)
                timeText
            }
        } else {
            HStack(alignment: .firstTextBaseline) {
                senderText.lineLimit(1)
                Spacer()
                timeText
            }
        }
    }

    // The status voice: "Needs reply", "Starred", a label name.
    private var badgeLine: some View {
        HStack(spacing: 10) {
            ForEach(badges, id: \.self) { badge in
                Text(badge)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(environment.theme.accent3Color)
                    .lineLimit(1)
            }
        }
        .padding(.top, 2)
    }
}

// The empty state of a view: what this view is, and the next action.
private struct MailEmptyStateView: View {
    @Environment(AppEnvironment.self) private var environment
    let copy: MailEmptyCopy

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(copy.title)
                .font(environment.theme.displayType.displayFont(size: 22))
            Text(copy.detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.top, 40)
        .padding(.bottom, 24)
        .accessibilityElement(children: .combine)
    }
}

// One snoozed thread: who and what, when it comes back, and Unsnooze.
private struct MailSnoozedRow: View {
    @Environment(AppEnvironment.self) private var environment
    let row: MailSnoozedThread
    let showsAccount: Bool
    let onOpen: () -> Void
    let onUnsnooze: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.senderDisplayName)
                        .font(environment.theme.displayType.displayFont(size: 16, weight: .regular))
                        .lineLimit(1)
                    if showsAccount, let email = row.accountEmail {
                        Text(email)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Text(row.subject)
                        .font(.subheadline)
                        .lineLimit(1)
                    if !row.snippet.isEmpty {
                        Text(row.snippet)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open \(row.subject)")
            VStack(alignment: .trailing, spacing: 6) {
                Text(row.returnLabel())
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing)
                Button("Unsnooze", action: onUnsnooze)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
        .padding(.vertical, 6)
    }
}

private extension Date {
    var isToday: Bool { Calendar.autoupdatingCurrent.isDateInToday(self) }
}
