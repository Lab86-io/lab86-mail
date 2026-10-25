import SwiftUI

// The chat history sheet: a search field and the conversations in four
// groups, Today, Yesterday, Earlier this week, Older. The grouping is pure.

enum ChatHistoryGroups {
    struct Section: Identifiable {
        let title: String
        let sessions: [AssistantChatSessionSummary]
        var id: String { title }
    }

    static let today = "Today"
    static let yesterday = "Yesterday"
    static let earlierThisWeek = "Earlier this week"
    static let older = "Older"
    static let order = [today, yesterday, earlierThisWeek, older]

    /// The sessions by group, newest first inside each group. Empty groups
    /// are left out.
    static func group(
        _ sessions: [AssistantChatSessionSummary],
        now: Date,
        calendar: Calendar = .autoupdatingCurrent
    ) -> [Section] {
        var buckets: [String: [AssistantChatSessionSummary]] = [:]
        for session in sessions {
            buckets[bucket(session.updatedAt, now: now, calendar: calendar), default: []].append(session)
        }
        return order.compactMap { title in
            guard let items = buckets[title], !items.isEmpty else { return nil }
            return Section(title: title, sessions: items.sorted { $0.updatedAt > $1.updatedAt })
        }
    }

    /// The group one time falls in. A time after now counts as today.
    static func bucket(_ date: Date, now: Date, calendar: Calendar) -> String {
        if date >= now || calendar.isDate(date, inSameDayAs: now) { return today }
        if let dayBefore = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: dayBefore) {
            return yesterday
        }
        if calendar.isDate(date, equalTo: now, toGranularity: .weekOfYear) { return earlierThisWeek }
        return older
    }

    /// The sessions whose title contains the query. An empty query keeps all.
    static func filter(_ sessions: [AssistantChatSessionSummary], query: String) -> [AssistantChatSessionSummary] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return sessions }
        return sessions.filter { $0.title.localizedStandardContains(needle) }
    }

    /// The time of a row: the clock for today, else the date.
    static func timeLabel(_ date: Date, now: Date, calendar: Calendar = .autoupdatingCurrent) -> String {
        let style = Date.FormatStyle(
            locale: calendar.locale ?? .autoupdatingCurrent,
            calendar: calendar,
            timeZone: calendar.timeZone
        )
        if calendar.isDate(date, inSameDayAs: now) {
            return date.formatted(style.hour().minute())
        }
        return date.formatted(style.month(.abbreviated).day())
    }
}

struct AssistantHistorySheet: View {
    @Environment(\.dismiss) private var dismiss
    let model: AssistantChatModel
    let onSelect: (AssistantChatSessionSummary) async -> Void

    private enum Load {
        case loading
        case loaded([AssistantChatSessionSummary])
        case failed(String)
    }

    @State private var load: Load = .loading
    @State private var query = ""

    static let title = "History"
    static let emptyTitle = "No conversations yet"
    static let emptyDetail = "Your conversations appear here after their first message."
    static let failedTitle = "Could not load history"
    static let retry = "Retry"
    static let searchPrompt = "Search conversations"

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(Self.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                    }
                }
        }
        .task { await reload() }
    }

    @ViewBuilder private var content: some View {
        switch load {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ContentUnavailableView {
                Text(Self.failedTitle)
            } description: {
                Text(message)
            } actions: {
                Button(Self.retry) {
                    load = .loading
                    Task { await reload() }
                }
            }
        case .loaded(let sessions):
            if sessions.isEmpty {
                ContentUnavailableView {
                    Text(Self.emptyTitle)
                } description: {
                    Text(Self.emptyDetail)
                }
            } else {
                list(sessions)
            }
        }
    }

    private func list(_ sessions: [AssistantChatSessionSummary]) -> some View {
        let now = Date.now
        let shown = ChatHistoryGroups.filter(sessions, query: query)
        return List {
            ForEach(ChatHistoryGroups.group(shown, now: now)) { section in
                Section(section.title) {
                    ForEach(section.sessions) { session in
                        Button {
                            Task { await onSelect(session) }
                        } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 12) {
                                Text(session.title)
                                    .foregroundStyle(.primary)
                                    .lineLimit(2)
                                Spacer(minLength: 0)
                                Text(ChatHistoryGroups.timeLabel(session.updatedAt, now: now))
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
        .searchable(text: $query, prompt: Self.searchPrompt)
    }

    private func reload() async {
        do {
            let sessions = try await model.loadHistory()
            load = .loaded(sessions)
        } catch {
            guard !error.isCancellation else { return }
            load = .failed(error.localizedDescription)
        }
    }
}
