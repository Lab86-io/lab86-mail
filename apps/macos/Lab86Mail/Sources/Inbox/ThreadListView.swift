import SwiftUI

struct ThreadListView: View {
    @Environment(MailStore.self) private var store

    var body: some View {
        @Bindable var store = store
        Group {
            if store.threads.isEmpty && store.threadsLoading {
                ProgressView("Loading mail…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.threads.isEmpty {
                ContentUnavailableView(
                    "No mail here",
                    systemImage: "tray",
                    description: Text("Nothing matches this view right now.")
                )
            } else {
                List(selection: $store.selectedThreadKey) {
                    ForEach(groupedThreads, id: \.0) { day, threads in
                        Section(day) {
                            ForEach(threads) { thread in
                                ThreadRowView(thread: thread)
                                    .tag(thread.id)
                                    .swipeActions(edge: .trailing) {
                                        Button {
                                            store.archive(thread)
                                        } label: {
                                            Label("Archive", systemImage: "archivebox")
                                        }
                                        .tint(.accentColor)
                                        Button(role: .destructive) {
                                            store.trash(thread)
                                        } label: {
                                            Label("Trash", systemImage: "trash")
                                        }
                                    }
                                    .contextMenu {
                                        Button("Archive") { store.archive(thread) }
                                        Button("Move to Trash", role: .destructive) { store.trash(thread) }
                                        Button("Mark as Read") { store.markRead(thread) }
                                    }
                            }
                        }
                    }
                    if store.threads.count >= store.pageLimit && store.pageLimit < 200 {
                        Button("Load more") { store.loadMore() }
                            .frame(maxWidth: .infinity)
                            .buttonStyle(.borderless)
                            .padding(.vertical, 6)
                    }
                }
                .listStyle(.inset)
            }
        }
    }

    // Day grouping mirrors the web inbox: Today / Yesterday / weekday / date.
    private var groupedThreads: [(String, [MailThread])] {
        let calendar = Calendar.current
        let formatter = DateFormatter()
        var groups: [(String, [MailThread])] = []
        for thread in store.threads {
            let label: String
            if calendar.isDateInToday(thread.date) {
                label = "Today"
            } else if calendar.isDateInYesterday(thread.date) {
                label = "Yesterday"
            } else if thread.date > calendar.date(byAdding: .day, value: -7, to: Date())! {
                formatter.dateFormat = "EEEE"
                label = formatter.string(from: thread.date)
            } else {
                formatter.dateFormat = "MMMM d"
                label = formatter.string(from: thread.date)
            }
            if groups.last?.0 == label {
                groups[groups.count - 1].1.append(thread)
            } else {
                groups.append((label, [thread]))
            }
        }
        return groups
    }
}

struct ThreadRowView: View {
    @Environment(ThemeManager.self) private var theme
    let thread: MailThread

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(thread.unread ? AnyShapeStyle(theme.accent) : AnyShapeStyle(.clear))
                .frame(width: 7, height: 7)
                .padding(.top, 6)

            ZStack {
                Circle()
                    .fill(theme.accentSoft)
                Text(EmailAddress.initials(from: thread.fromAddress))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(theme.accent)
            }
            .frame(width: 30, height: 30)

            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(thread.fromDisplay)
                        .font(.callout.weight(thread.unread ? .bold : .regular))
                        .lineLimit(1)
                    Spacer()
                    if thread.starred {
                        Image(systemName: "star.fill")
                            .font(.caption2)
                            .foregroundStyle(.yellow)
                    }
                    Text(thread.date, format: relativeFormat)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text(thread.subject)
                    .font(.callout.weight(thread.unread ? .semibold : .regular))
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(thread.snippet)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Spacer()
                    if thread.messageCount > 1 {
                        Text("\(Int(thread.messageCount))")
                            .font(.caption2)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(.quaternary, in: .capsule)
                    }
                }
            }
        }
        .padding(.vertical, 3)
    }

    private var relativeFormat: Date.FormatStyle {
        Calendar.current.isDateInToday(thread.date)
            ? .dateTime.hour().minute()
            : .dateTime.month(.abbreviated).day()
    }
}
