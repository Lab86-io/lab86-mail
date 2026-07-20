import SwiftUI

struct MailView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var searchText = ""
    @State private var accountScope = "all"
    @State private var categoryScope = MailCategoryScope.all

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
        List {
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
        .safeAreaInset(edge: .top, spacing: 0) { categoryPills }
        .navigationTitle("Mail")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Menu {
                    Section("Account") {
                        scopeButton(title: "All Accounts", selected: accountScope == "all") {
                            accountScope = "all"
                        }
                        ForEach(environment.store.accounts) { account in
                            scopeButton(
                                title: account.displayName ?? account.email,
                                selected: accountScope == account.id
                            ) {
                                accountScope = account.id
                            }
                        }
                    }
                } label: {
                    Label(scopeTitle, systemImage: "line.3.horizontal.decrease.circle")
                }
            }
        }
        .searchable(text: $searchText, prompt: "Search this inbox")
        .onAppear {
            if let pending = environment.navigation.pendingMailSearch {
                searchText = pending
                environment.navigation.pendingMailSearch = nil
            }
            if let raw = environment.navigation.pendingMailCategory {
                categoryScope = MailCategoryScope(rawValue: raw) ?? .all
                environment.navigation.pendingMailCategory = nil
            }
        }
        .onChange(of: environment.navigation.pendingMailCategory) { _, raw in
            guard let raw else { return }
            categoryScope = MailCategoryScope(rawValue: raw) ?? .all
            environment.navigation.pendingMailCategory = nil
        }
        .task(id: searchText) {
            let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
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
        .shellToolbar(includesCompose: true)
    }

    private func threadRow(_ thread: MailThreadSummary, navigation: NavigationModel) -> some View {
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
            snoozeMenu(thread)
            Button("Move to Trash", systemImage: "trash", role: .destructive) {
                Task { await environment.store.trash(thread) }
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
                        Text(category.title)
                            .font(.subheadline.weight(selected ? .semibold : .regular))
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
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        if calendar.isDate(date, equalTo: now, toGranularity: .weekOfYear) {
            return date.formatted(.dateTime.weekday(.wide))
        }
        if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            return date.formatted(.dateTime.month(.wide))
        }
        return date.formatted(.dateTime.month(.wide).year())
    }

    private var filteredThreads: [MailThreadSummary] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
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
            (accountScope == "all" || thread.accountID == accountScope)
                && (categoryScope == .all || thread.category == categoryScope.rawValue)
        }
    }

    private var scopeTitle: String {
        accountScope == "all"
            ? "All Accounts"
            : environment.store.accounts.first(where: { $0.id == accountScope })?.displayName
                ?? environment.store.accounts.first(where: { $0.id == accountScope })?.email
                ?? "Account"
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

enum MailCategoryScope: String, CaseIterable, Identifiable {
    case all
    case main
    case needsReply = "needs_reply"
    case review
    case codes
    case orders
    case financeAdmin = "finance_admin"
    case noise

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: "All Mail"
        case .main: "Main"
        case .needsReply: "Needs Reply"
        case .review: "Review"
        case .codes: "Codes"
        case .orders: "Orders"
        case .financeAdmin: "Finance & Admin"
        case .noise: "Noise"
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
            InitialsAvatar(name: thread.sender, size: 40)
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
}

private extension Date {
    var isToday: Bool { Calendar.autoupdatingCurrent.isDateInToday(self) }
}
