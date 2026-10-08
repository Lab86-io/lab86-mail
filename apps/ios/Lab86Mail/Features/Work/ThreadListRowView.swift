import SwiftUI

// One Albatross in the live list (docs/albatross-threads.md, T1 and T2):
// the status dot, the title with weight as the unread mark, "Status word ·
// preview", the time, and the area. The Mac rail mounts the same view.
struct ThreadListRowView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let row: ThreadListRow
    /// The clock the time label counts from. The list ticks it.
    let now: Date
    /// Hidden inside an Area, where the name repeats the title bar.
    var showsArea = true
    /// Two reads in a row failed: a live row says when it was last seen.
    var stale = false

    private var time: String? { ThreadRowPresentation.timeLabel(row, now: now) }

    private var line: String {
        stale ? ThreadRowPresentation.staleLine(row) : ThreadRowPresentation.statusLine(row)
    }

    private var area: String? { showsArea ? row.areaName : nil }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            ThreadStatusDot(kind: stale ? .none : ThreadRowPresentation.dot(row))
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(row.title)
                        .font(.subheadline.weight(row.unread ? .semibold : .regular))
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.leading)
                        .lineLimit(2)
                    Spacer(minLength: 8)
                    if let time {
                        Text(time)
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.tertiary)
                            .fixedSize()
                    }
                }
                if dynamicTypeSize.isAccessibilitySize {
                    Text(line)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let area {
                        Text(area)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                } else {
                    HStack(alignment: .top, spacing: 8) {
                        Text(line)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        if let area {
                            Spacer(minLength: 8)
                            Text(area)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                                .fixedSize()
                        }
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(ThreadRowPresentation.accessibilityLabel(row, time: time, area: area, stale: stale))
    }
}

/// The one indicator of a row (lead decision 2): accent and steady for
/// "needs you", accent-2 with one slow halo while a run or a reply works,
/// hollow accent-2 while a run waits for a slot. The halo is static under
/// Reduce Motion.
struct ThreadStatusDot: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .subheadline) private var size: CGFloat = 7
    let kind: ThreadRowDot
    @State private var halo = false

    var body: some View {
        ZStack {
            switch kind {
            case .none:
                Color.clear
            case .needsYou:
                Circle().fill(environment.theme.accentColor)
            case .startsSoon:
                Circle().strokeBorder(environment.theme.accent2Color, lineWidth: 1.5)
            case .working:
                Circle().fill(environment.theme.accent2Color)
                if !reduceMotion {
                    Circle()
                        .stroke(environment.theme.accent2Color.opacity(halo ? 0 : 0.5), lineWidth: 1)
                        .scaleEffect(halo ? 2.6 : 1)
                        .onAppear {
                            withAnimation(.easeOut(duration: 2.4).repeatForever(autoreverses: false)) {
                                halo = true
                            }
                        }
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
