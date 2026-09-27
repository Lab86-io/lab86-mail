import SwiftUI
import WidgetKit

// The Today widget (round 2, FEATURES item 19): the brief's lead line, the
// next move, and the next meeting. It reads the snapshot the app writes to
// the shared App Group; it never signs in or calls the server.

struct TodayEntry: TimelineEntry {
    let date: Date
    let snapshot: TodayWidgetSnapshot
}

struct TodayProvider: TimelineProvider {
    func placeholder(in context: Context) -> TodayEntry {
        TodayEntry(date: .now, snapshot: .placeholder)
    }

    func getSnapshot(in context: Context, completion: @escaping (TodayEntry) -> Void) {
        completion(TodayEntry(date: .now, snapshot: Self.current()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TodayEntry>) -> Void) {
        let now = Date.now
        let snapshot = Self.current()
        completion(Timeline(entries: TodayTimeline.entries(for: snapshot, now: now), policy: .after(TodayTimeline.nextReload(after: now))))
    }

    static func current() -> TodayWidgetSnapshot {
        TodayWidgetSnapshot.read(from: TodayWidgetSnapshot.containerURL()) ?? .placeholder
    }
}

/// The entries of one timeline: now, and the moment the next meeting ends,
/// so the widget drops a finished meeting without waiting for the app.
enum TodayTimeline {
    static func entries(for snapshot: TodayWidgetSnapshot, now: Date) -> [TodayEntry] {
        var entries = [TodayEntry(date: now, snapshot: snapshot)]
        if let meeting = snapshot.upcomingMeeting(at: now), meeting.endAt > now {
            entries.append(TodayEntry(date: meeting.endAt, snapshot: snapshot))
        }
        return entries
    }

    /// The app reloads the widget when it refreshes; this is the fallback.
    static func nextReload(after now: Date) -> Date { now.addingTimeInterval(30 * 60) }
}

struct TodayWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TodayEntry

    private var snapshot: TodayWidgetSnapshot { entry.snapshot }
    private var meeting: TodayWidgetSnapshot.Meeting? { snapshot.upcomingMeeting(at: entry.date) }

    var body: some View {
        switch family {
        case .accessoryRectangular:
            accessory
        case .systemSmall:
            small
        default:
            medium
        }
    }

    private var heading: some View {
        Text(snapshot.isWeeklyReview ? "Weekly review" : "Today")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 6) {
            heading
            Text(snapshot.leadLine)
                .font(.system(.subheadline, design: .serif))
                .lineLimit(4)
                .minimumScaleFactor(0.85)
            Spacer(minLength: 0)
            if let meeting {
                meetingLine(meeting)
            } else if let attention = snapshot.attentionLine {
                Text(attention).font(.caption2).foregroundStyle(.red).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetURL(TodayWidgetSnapshot.todayLink)
        .containerBackground(.fill.tertiary, for: .widget)
    }

    private var medium: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                heading
                Spacer(minLength: 8)
                if let attention = snapshot.attentionLine {
                    Text(attention).font(.caption2).foregroundStyle(.red).lineLimit(1)
                }
            }
            Text(snapshot.leadLine)
                .font(.system(.subheadline, design: .serif))
                .lineLimit(2)
            Spacer(minLength: 0)
            if let move = snapshot.nextMove {
                linked(TodayWidgetSnapshot.link(for: move)) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Next move").font(.caption2).foregroundStyle(.secondary)
                        Text(move.title).font(.footnote.weight(.semibold)).lineLimit(1)
                    }
                }
            }
            if let meeting {
                linked(TodayWidgetSnapshot.link(for: meeting)) {
                    meetingLine(meeting)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetURL(TodayWidgetSnapshot.todayLink)
        .containerBackground(.fill.tertiary, for: .widget)
    }

    private var accessory: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(snapshot.leadLine)
                .font(.caption)
                .lineLimit(2)
            if let meeting {
                Text("\(meeting.startAt, style: .time) \(meeting.title)")
                    .font(.caption2)
                    .lineLimit(1)
            }
        }
        .widgetURL(TodayWidgetSnapshot.todayLink)
        .containerBackground(.clear, for: .widget)
    }

    // A row opens its own place in the app when it has one.
    @ViewBuilder private func linked<Content: View>(_ url: URL?, @ViewBuilder content: () -> Content) -> some View {
        if let url {
            Link(destination: url) { content() }
        } else {
            content()
        }
    }

    private func meetingLine(_ meeting: TodayWidgetSnapshot.Meeting) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(meeting.startAt, style: .time)
                .font(.caption.weight(.semibold).monospacedDigit())
            Text(meeting.title)
                .font(.caption)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Next meeting, \(meeting.title), at \(meeting.startAt.formatted(date: .omitted, time: .shortened))")
    }
}

@main
struct AlbatrossTodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: TodayWidgetSnapshot.widgetKind, provider: TodayProvider()) { entry in
            TodayWidgetView(entry: entry)
        }
        .configurationDisplayName("Today")
        .description("The brief’s lead line, your next move, and your next meeting.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}
