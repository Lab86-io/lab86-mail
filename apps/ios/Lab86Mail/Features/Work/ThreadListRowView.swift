import SwiftUI

// One Albatross in the live list (docs/albatross-threads.md, T1 and T2):
// the status dot, the title with weight as the unread mark, the status word
// and the preview on their own lines, the time, and the area on a last quiet
// line (D13: nothing sits centered on a two-line block, and there is no
// middle dot). A row with an open handoff that names blanks shows the blank
// sentence in place of the status lines (docs/albatross-blank-design.md).
struct ThreadListRowView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let row: ThreadListRow
    /// The clock the time label counts from. The list ticks it.
    let now: Date
    /// Hidden inside an Area, where the name repeats the title bar.
    var showsArea = true
    /// Two reads in a row failed: a live row says when it was last seen.
    var stale = false
    /// The user left words in this thread's composer.
    var hasDraft = false

    private var time: String? { ThreadRowPresentation.timeLabel(row, now: now) }

    private var parts: (word: String?, preview: String?) {
        stale ? ThreadRowPresentation.staleParts(row) : ThreadRowPresentation.statusParts(row)
    }

    private var area: String? { showsArea ? row.areaName : nil }

    /// The blanks of an open handoff. None while the rows are stale.
    private var blanks: [String] { stale ? [] : ThreadRowPresentation.blanks(row) }

    private var isAccessibilitySize: Bool { dynamicTypeSize.isAccessibilitySize }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            ThreadStatusDot(kind: stale ? .none : ThreadRowPresentation.dot(row))
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 3) {
                titleLine
                if !blanks.isEmpty {
                    BlankSentence(blanks: blanks, size: 16)
                        .padding(.top, 2)
                } else {
                    statusLines
                }
                footLine
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    private var titleLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(row.title)
                .font(.subheadline.weight(row.unread ? .semibold : .regular))
                .foregroundStyle(.primary)
                .multilineTextAlignment(.leading)
                .lineLimit(isAccessibilitySize ? 3 : 2)
            Spacer(minLength: 8)
            if let time {
                Text(time)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
                    .fixedSize()
            }
        }
    }

    @ViewBuilder private var statusLines: some View {
        let current = parts
        if let word = current.word {
            Text(word)
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        if let preview = current.preview {
            Text(preview)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.leading)
                .lineLimit(isAccessibilitySize ? nil : 2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The area and the draft mark: one quiet line, or nothing.
    @ViewBuilder private var footLine: some View {
        if area != nil || hasDraft {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                if let area {
                    Text(area)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                if hasDraft {
                    // A quiet mark: the accent stays with the needs-you dot.
                    Text(ThreadRowCopy.draft)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.top, 1)
        }
    }

    private var accessibilityLabel: String {
        var label = ThreadRowPresentation.accessibilityLabel(row, time: time, area: area, stale: stale)
        if hasDraft { label += ". \(ThreadRowCopy.draft)" }
        return label
    }
}

enum ThreadRowCopy {
    /// The draft mark on a row whose composer holds unsent words.
    static let draft = "Draft"
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
