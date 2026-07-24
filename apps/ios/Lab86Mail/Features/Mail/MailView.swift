import Kingfisher
import SwiftUI

struct MailView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var searchText = ""
    @State private var accountScope: Set<String> = []
    @State private var categoryScope = MailCategoryScope.main
    @State private var mailboxScope = MailboxScope.inbox
    @State private var selectedThreadKeys: Set<String> = []
    @State private var editMode: EditMode = .inactive
    @State private var recentlyRemoved: [MailThreadSummary] = []
    @State private var bulkActionLabel: String?
    @State private var triageVerdicts: [BulkTriageVerdict] = []
    @State private var categoryInfoThread: MailThreadSummary?
    @State private var isBulkTriaging = false
    @State private var isSearchFocused = false

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
            // The category strip is the list's first (non-pinned) row so the
            // inbox starts immediately beneath the navigation bar — no stacked
            // large-title/top-inset blank band. Date groups stay pinned.
            Section {
                categoryPills
                    .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
            if filteredThreads.isEmpty {
                ContentUnavailableView(
                    searchText.isEmpty ? "No mail here" : "No matching mail",
                    systemImage: searchText.isEmpty ? "tray" : "magnifyingglass",
                    description: Text(searchText.isEmpty
                        ? "Try another account or category, or pull to refresh."
                        : "Try a different search.")
                )
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            } else {
                ForEach(groupedThreads) { group in
                    Section {
                        ForEach(group.threads) { thread in
                            threadRow(thread, navigation: navigation)
                        }
                    } header: {
                        MailDateline(label: group.label)
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(environment.theme.paperColor)
        .environment(\.editMode, $editMode)
        .contentMargins(.top, 0, for: .scrollContent)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let bulkActionLabel, !recentlyRemoved.isEmpty, !editMode.isEditing {
                undoBanner(label: bulkActionLabel)
            }
        }
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
                } label: {
                    Label(scopeTitle, systemImage: "line.3.horizontal.decrease.circle")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(editMode.isEditing ? "Done" : "Select") {
                    withAnimation {
                        editMode = editMode.isEditing ? .inactive : .active
                        if !editMode.isEditing { selectedThreadKeys.removeAll() }
                    }
                }
            }
        }
        .searchable(text: $searchText, isPresented: $isSearchFocused, prompt: "Search this inbox")
        .onReceive(NotificationCenter.default.publisher(for: .albatrossFocusMailSearch)) { _ in
            isSearchFocused = true
        }
        .onAppear {
            if let pending = environment.navigation.pendingMailSearch {
                searchText = pending
                environment.navigation.pendingMailSearch = nil
            }
            if let raw = environment.navigation.pendingMailCategory {
                categoryScope = MailCategoryScope.from(raw: raw)
                environment.navigation.pendingMailCategory = nil
            }
        }
        .onChange(of: environment.navigation.pendingMailCategory) { _, raw in
            guard let raw else { return }
            categoryScope = MailCategoryScope.from(raw: raw)
            environment.navigation.pendingMailCategory = nil
        }
        .task(id: effectiveQuery) {
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
        }
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
        .sheet(item: $categoryInfoThread) { thread in
            CategoryExplanationSheet(thread: thread) { category in
                Task {
                    if await environment.store.correctCategory(thread, category: category) {
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
        .refreshable { await environment.store.refreshMail() }
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
        .navigationDestination(
            isPresented: Binding(
                get: { navigation.threadRoute != nil },
                set: { if !$0 { navigation.threadRoute = nil } }
            )
        ) {
            if let route = navigation.threadRoute {
                ThreadView(route: route, summary: environment.store.threads.first {
                    $0.id == route.threadID && $0.accountID == route.accountID
                })
            }
        }
        .shellToolbar()
    }

    @ViewBuilder
    private func threadRow(_ thread: MailThreadSummary, navigation: NavigationModel) -> some View {
        if editMode.isEditing {
            MailThreadRow(thread: thread)
                .tag(threadKey(thread))
                .listRowBackground(Color.clear)
        } else {
            Button {
                navigation.threadRoute = ThreadRoute(accountID: thread.accountID, threadID: thread.id)
            } label: {
                MailThreadRow(thread: thread)
            }
            .buttonStyle(.plain)
            .listRowBackground(Color.clear)
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
                ForEach(MailCategoryScope.feedbackCases) { category in
                    Button(category.title) {
                        Task { _ = await environment.store.correctCategory(thread, category: category.rawValue) }
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

    // Smart categories as a scrolling row of text pills — the desktop rail's
    // category list, surfaced where the thumb is. Selection carries the fill.
    private var categoryPills: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(MailCategoryScope.allCases) { category in
                    let selected = categoryScope == category
                    Button {
                        categoryScope = category
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: selected ? category.selectedSymbol : category.symbol)
                                .font(.footnote)
                            Text(category.title)
                                .font(.subheadline.weight(selected ? .semibold : .regular))
                        }
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
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .background(environment.theme.paperColor.opacity(0.01))
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
                && categoryScope.includes(storedCategory: thread.category)
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
        return mailboxScope == .inbox ? accountLabel : "\(mailboxScope.title) · \(accountLabel)"
    }

    private var effectiveQuery: String {
        [mailboxScope.query, searchText.trimmingCharacters(in: .whitespacesAndNewlines)]
            .compactMap { $0?.isEmpty == false ? $0 : nil }
            .joined(separator: " ")
    }

    private var selectedThreads: [MailThreadSummary] {
        filteredThreads.filter { selectedThreadKeys.contains(threadKey($0)) }
    }

    private func undoBanner(label: String) -> some View {
        HStack {
            Text("\(label) \(recentlyRemoved.count) thread\(recentlyRemoved.count == 1 ? "" : "s")")
                .font(.subheadline)
            Spacer()
            Button("Undo") {
                let threads = recentlyRemoved
                recentlyRemoved = []
                bulkActionLabel = nil
                Task {
                    for thread in threads { await environment.store.restore(thread) }
                }
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(12)
        .background(.regularMaterial)
    }

    private func performBulkRemoval(
        label: String,
        operation: @escaping @MainActor ([MailThreadSummary]) async -> Void
    ) {
        let threads = selectedThreads
        guard !threads.isEmpty else { return }
        recentlyRemoved = threads
        bulkActionLabel = label
        selectedThreadKeys.removeAll()
        editMode = .inactive
        Task { await operation(threads) }
    }

    private func threadKey(_ thread: MailThreadSummary) -> String {
        "\(thread.accountID):\(thread.id)"
    }

    private func accountMenuTitle(_ id: String, fallback: String) -> String {
        guard let account = environment.accountStore.accounts.first(where: { $0.id == id }) else {
            return fallback
        }
        switch account.sync.status {
        case .ready:
            if let date = account.sync.lastSyncedAt {
                return "\(fallback) · \(date.formatted(.relative(presentation: .named)))"
            }
            return "\(fallback) · Up to date"
        case .backfilling: return "\(fallback) · Backfilling"
        case .syncing: return "\(fallback) · Syncing"
        case .error: return "\(fallback) · Needs attention"
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

// The visible mail scopes. The classifier's stored vocabulary is wider —
// needs_reply/review/finance_admin fold into Main at presentation time, and
// noise is suppressed from Main but always reachable through All Mail. Those
// signals stay internal (Brief intelligence, notification triage); they are
// no longer mailboxes. No stored value is migrated or rewritten.
enum MailCategoryScope: String, CaseIterable, Identifiable {
    case main
    case codes
    case orders
    case all

    var id: String { rawValue }

    var title: String {
        switch self {
        case .main: "Main"
        case .codes: "Codes"
        case .orders: "Orders"
        case .all: "All Mail"
        }
    }

    var symbol: String {
        switch self {
        case .main: "person.crop.circle"
        case .codes: "key"
        case .orders: "shippingbox"
        case .all: "tray.full"
        }
    }

    // Filled variants carry the selected state where the symbol has one.
    var selectedSymbol: String {
        switch self {
        case .main: "person.crop.circle.fill"
        case .codes: "key.fill"
        case .orders: "shippingbox.fill"
        case .all: "tray.full.fill"
        }
    }

    // Categories a thread can be corrected INTO. All Mail is a viewing scope,
    // not a classifier destination.
    static var feedbackCases: [MailCategoryScope] {
        [.main, .codes, .orders]
    }

    // Maps any raw category string — including the retired stored labels and
    // deep-link values minted before the cleanup — onto the scope that shows
    // that mail today.
    static func from(raw: String?) -> MailCategoryScope {
        guard let raw, !raw.isEmpty else { return .main }
        if let scope = MailCategoryScope(rawValue: raw) { return scope }
        switch raw {
        case "needs_reply", "review", "finance_admin": return .main
        case "noise": return .all
        default: return .main
        }
    }

    // Whether a stored classification is visible inside this scope. Main is
    // the catch-all for everything that isn't codes/orders/noise (including
    // unclassified mail and the folded-in legacy labels).
    func includes(storedCategory: String?) -> Bool {
        switch self {
        case .all:
            return true
        case .codes:
            return storedCategory == "codes"
        case .orders:
            return storedCategory == "orders"
        case .main:
            return storedCategory != "codes" && storedCategory != "orders" && storedCategory != "noise"
        }
    }
}

enum MailboxScope: String, CaseIterable, Identifiable {
    case inbox, unread, starred, important, attachments, thisWeek, sent, drafts, allMail, snoozed, trash
    var id: Self { self }
    var title: String {
        switch self {
        case .inbox: "Inbox"
        case .unread: "Unread"
        case .starred: "Starred"
        case .important: "Important"
        case .attachments: "Attachments"
        case .thisWeek: "This Week"
        case .sent: "Sent"
        case .drafts: "Drafts"
        case .allMail: "All Mail"
        case .snoozed: "Snoozed"
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
        case .sent: "paperplane"
        case .drafts: "doc"
        case .allMail: "tray.full"
        case .snoozed: "clock"
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
        case .sent: "in:sent"
        case .drafts: "in:drafts"
        case .allMail: "-in:trash"
        case .snoozed: "label:SNOOZED"
        case .trash: "in:trash"
        }
    }
}

private struct CategoryExplanationSheet: View {
    let thread: MailThreadSummary
    let onCorrect: (String) -> Void

    var body: some View {
        NavigationStack {
            List {
                Section("Classification") {
                    LabeledContent("Category", value: thread.category?.replacingOccurrences(of: "_", with: " ").capitalized ?? "Unclassified")
                    if let confidence = thread.categoryConfidence {
                        LabeledContent("Confidence", value: confidence.formatted(.percent.precision(.fractionLength(0))))
                    }
                    Text(thread.categoryReason ?? "Albatross has not stored an explanation for this thread yet.")
                        .foregroundStyle(.secondary)
                }
                Section("Correct category") {
                    ForEach(MailCategoryScope.feedbackCases) { category in
                        Button(category.title) { onCorrect(category.rawValue) }
                    }
                }
            }
            .navigationTitle("Why this category?")
            .navigationBarTitleDisplayMode(.inline)
        }
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
        .padding(.top, 6)
        .textCase(nil)
        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 0, trailing: 16))
        .accessibilityAddTraits(.isHeader)
    }
}

// Desktop row grammar: [unread gutter][avatar][sender/subject/snippet][meta].
// The unread dot lives in a stable gutter so scanning is one vertical
// eye-track; the sender carries the display face.
private struct MailThreadRow: View {
    @Environment(AppEnvironment.self) private var environment
    let thread: MailThreadSummary

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(thread.unread ? environment.theme.accentColor : .clear)
                .frame(width: 7, height: 7)
                .padding(.top, 16)
                .accessibilityHidden(true)
            senderAvatar
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(thread.sender)
                        .font(environment.theme.displayType.displayFont(
                            size: 16,
                            weight: thread.unread ? .semibold : .regular
                        ))
                        .foregroundStyle(thread.unread ? .primary : Color.primary.opacity(0.85))
                        .lineLimit(1)
                    Spacer()
                    Text(thread.date, format: thread.date.isToday ? .dateTime.hour().minute() : .dateTime.month().day())
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 5) {
                    Text(thread.subject)
                        .font(.subheadline.weight(thread.unread ? .medium : .regular))
                        .lineLimit(1)
                    if thread.starred {
                        Image(systemName: "star.fill")
                            .font(.caption2)
                            .foregroundStyle(.yellow)
                            .accessibilityLabel("Starred")
                    }
                }
                Text(thread.snippet)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 6)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityValue(thread.unread ? "Unread" : "Read")
    }

    // Stable 40pt geometry whether it resolves to a cached provider/company
    // photo or the InitialsAvatar fallback, so rows don't reflow as photos
    // stream in.
    @ViewBuilder
    private var senderAvatar: some View {
        if let url = environment.mailIdentity.photoURL(for: thread.senderEmail) {
            KFImage(url)
                .placeholder { InitialsAvatar(name: thread.sender, size: 40) }
                .fade(duration: 0.15)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: 40, height: 40)
                .clipShape(Circle())
        } else {
            InitialsAvatar(name: thread.sender, size: 40)
        }
    }
}

private extension Date {
    var isToday: Bool { Calendar.autoupdatingCurrent.isDateInToday(self) }
}
