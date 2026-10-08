import SwiftUI

// One Albatross in the Mac source list (docs/albatross-threads.md, T1, T2,
// T10): the shared status dot, the title with weight as the unread mark,
// the time at the trailing edge, and "Status word · preview" under it. On
// hover the time slot yields to the row's verbs (Answer, Steer, Stop,
// Continue) with no layout shift; "Steer" opens a one-line field inside the
// row. The words, the dot, and the time come from the shared
// ThreadRowPresentation rules. Design note:
// docs/research/albatross-threads-macos-design-2026-10-08.md, section 3.

/// The inline steer field of one row, while it is open.
struct MacThreadSteerField: Equatable {
    let workID: String
    /// Sent with `redirect`: the run stops and starts again with the note.
    let redirect: Bool
    var note = ""
    var sending = false
    var error: String?
}

struct MacThreadRow: View {
    @Environment(AppEnvironment.self) private var environment
    let row: ThreadListRow
    /// The clock the time label counts from. The section ticks it.
    let now: Date
    /// Two reads in a row failed: a live row says when it was last seen.
    var stale = false
    /// The verbs the time slot shows on hover. Empty for a quiet row.
    var verbs: [ThreadRowVerb] = []
    /// The open steer field of this row, or nil.
    var steerField: MacThreadSteerField? = nil
    @Binding var note: String
    /// A line that stands in for the status line for a moment: "Sent to the
    /// run" after a note from the row.
    var sentLine: String? = nil
    var focus: FocusState<String?>.Binding
    let onOpen: () -> Void
    let onVerb: (ThreadRowVerb) -> Void
    let onSteerSend: () -> Void
    let onSteerCancel: () -> Void

    @State private var hovering = false

    /// The time slot keeps this width at rest, so the verbs do not move the
    /// title when they take it.
    static let timeSlotWidth: CGFloat = 36

    private var time: String? { ThreadRowPresentation.timeLabel(row, now: now) }

    private var line: String {
        if let sentLine { return sentLine }
        return stale ? ThreadRowPresentation.staleLine(row) : ThreadRowPresentation.statusLine(row)
    }

    private var showsVerbs: Bool {
        hovering && !verbs.isEmpty && steerField == nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 8) {
                Button(action: onOpen) {
                    HStack(alignment: .top, spacing: 8) {
                        ThreadStatusDot(kind: stale ? .none : ThreadRowPresentation.dot(row))
                            .padding(.top, 5)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.title)
                                .font(.subheadline.weight(row.unread ? .semibold : .regular))
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            Text(line)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.tail)
                                .contentTransition(.opacity)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                trailingSlot
            }
            if let steerField {
                steerFieldView(steerField)
            }
        }
        .padding(.vertical, 2)
        .onHover { hovering = $0 }
        .help(helpText)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(ThreadRowPresentation.accessibilityLabel(row, time: time, area: row.areaName, stale: stale))
    }

    /// The time at rest; the verbs on hover. One slot, one width.
    @ViewBuilder private var trailingSlot: some View {
        if showsVerbs {
            HStack(spacing: 10) {
                ForEach(verbs) { verb in
                    Button(verb.label) { onVerb(verb) }
                        .buttonStyle(.borderless)
                        .font(.caption.weight(.medium))
                }
            }
            .fixedSize()
            .padding(.top, 1)
        } else {
            Text(time ?? "")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .frame(minWidth: Self.timeSlotWidth, alignment: .trailing)
                .padding(.top, 2)
                .accessibilityHidden(true)
        }
    }

    /// The full title and status line, for a row that truncates.
    private var helpText: String {
        var parts = [row.title, line]
        if let area = row.areaName { parts.append(area) }
        return parts.joined(separator: "\n")
    }

    /// One line to the run, inside the row (T10). Return sends. Escape
    /// closes and keeps nothing.
    private func steerFieldView(_ field: MacThreadSteerField) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if field.redirect {
                Text(QuickSteerCopy.redirectLine)
                    .font(.caption2)
                    .foregroundStyle(environment.theme.accent2Color)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 6) {
                TextField(field.redirect ? RunBlockCopy.redirectPlaceholder : QuickSteerCopy.placeholder, text: $note)
                    .textFieldStyle(.plain)
                    .font(.caption)
                    .focused(focus, equals: row.id)
                    .onSubmit(onSteerSend)
                    .onExitCommand(perform: onSteerCancel)
                    .disabled(field.sending)
                    .accessibilityLabel(MacThreadRowsCopy.steerLabel(row.title))
                    .accessibilityHint(MacThreadRowsCopy.steerHint)
                Text(MacThreadRowsCopy.sendHint)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(environment.theme.elevatedColor, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(environment.theme.hairlineColor, lineWidth: 1)
            }
            if let error = field.error {
                Text(error)
                    .font(.caption2)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        // Under the title: the dot and its spacing.
        .padding(.leading, 15)
        .padding(.bottom, 2)
    }
}
