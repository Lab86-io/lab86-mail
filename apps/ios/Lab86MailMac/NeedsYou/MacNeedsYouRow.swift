import SwiftUI

// One row of the Needs you list on the Mac (docs/needs-you.md, phase 5):
// the lead, the asker in the display face with the source after it, one
// line about what the user owes, the meta line, and the due word at the
// trailing edge. On hover the due slot yields to the row's verb ("Copy" on
// a code, "Done" on the rest) with no layout shift, as the Albatross rows
// do. The lead, the code line, and the due column are the shared iOS
// pieces; the words are the shared rules. The selected row carries a soft
// accent fill while the list has the keyboard, a quiet fill otherwise.

struct MacNeedsYouRow: View {
    @Environment(AppEnvironment.self) private var environment
    let obligation: ObligationView
    /// The clock the time labels count from. The page ticks it.
    let now: Date
    let timezone: String?
    let selected: Bool
    /// True while the list has keyboard focus.
    let focused: Bool
    let onOpen: () -> Void
    let onVerb: (MacNeedsYouLayout.HoverVerb) -> Void

    @State private var hovering = false

    private var nowMillis: ObligationMillis { NeedsYouClock.millis(now) }
    private var verbs: [MacNeedsYouLayout.HoverVerb] { MacNeedsYouLayout.hoverVerbs(obligation) }
    private var showsVerbs: Bool { hovering && !verbs.isEmpty }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button(action: onOpen) {
                content
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            trailingSlot
                .padding(.top, 2)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background { MacNeedsYouRowFill(selected: selected, focused: focused, hovering: hovering) }
        .opacity(obligation.isClosed ? 0.72 : 1)
        .onHover { hovering = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(NeedsYouPresentation.accessibilityLabel(obligation, now: nowMillis, timezone: timezone))
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private var content: some View {
        HStack(alignment: .top, spacing: 12) {
            NeedsYouLeadView(lead: NeedsYouPresentation.lead(for: obligation))
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                nameLine
                if obligation.kind == .code, let code = obligation.code {
                    NeedsYouCodeLine(value: code.value)
                } else {
                    Text(obligation.title)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(NeedsYouPresentation.metaLine(obligation, now: nowMillis, timezone: timezone))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var nameLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(obligation.asker)
                .font(environment.theme.displayType.displayFont(size: 15))
                .foregroundStyle(.primary)
                .lineLimit(1)
            Text(NeedsYouPresentation.sourceLine(obligation))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    /// The due word at rest; the verb on hover. One slot.
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
        } else {
            NeedsYouDueColumn(label: NeedsYouLabels.dueLabel(obligation, now: nowMillis, timezone: timezone))
        }
    }
}

/// The fill under a row: the accent, soft, while the row is selected and
/// the list has the keyboard; the quiet primary fill while it is selected
/// without it; a hint of it under the pointer.
struct MacNeedsYouRowFill: View {
    @Environment(AppEnvironment.self) private var environment
    let selected: Bool
    let focused: Bool
    let hovering: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(color)
    }

    private var color: Color {
        if selected {
            return focused ? environment.theme.accentColor.opacity(0.14) : Color.primary.opacity(0.08)
        }
        return hovering ? Color.primary.opacity(0.04) : .clear
    }
}

/// An Albatross question or approval in the list, with the same fill rules.
struct MacNeedsYouExtraRow: View {
    let extra: NeedsYouExtra
    let selected: Bool
    let focused: Bool
    let onOpen: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: onOpen) {
            NeedsYouExtraRow(extra: extra)
                .padding(.horizontal, 12)
                .padding(.vertical, 2)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .background { MacNeedsYouRowFill(selected: selected, focused: focused, hovering: hovering) }
        .onHover { hovering = $0 }
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

/// The Later choices beside a row, for the l key: three times, one per
/// line. Escape closes the popover and changes nothing.
struct MacNeedsYouLaterPopover: View {
    let options: [NeedsYouLaterOption]
    let onPick: (ObligationMillis) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Later")
                .font(.headline)
            Text("The item leaves its group and comes back at this time.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(options) { option in
                Button {
                    onPick(option.until)
                } label: {
                    Text(option.label)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(16)
        .frame(width: 260)
    }
}

/// An Albatross question or approval in the detail pane: the Albatross
/// title in the display face, the prompt, the kind word, and one button
/// that opens the thread, or Activity for an approval.
struct MacNeedsYouExtraDetail: View {
    @Environment(AppEnvironment.self) private var environment
    let extra: NeedsYouExtra
    let onOpen: () -> Void

    private var opensThread: Bool { extra.workID != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Albatross · \(NeedsYouPresentation.extraKindLabel(extra))")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(extra.title)
                .font(environment.theme.displayType.displayFont(size: 22, weight: .regular))
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let line = extra.line {
                Text(line)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            Button(opensThread ? "Open thread" : "Open activity", action: onOpen)
                .buttonStyle(.borderedProminent)
                .tint(environment.theme.accentColor)
            Text(opensThread ? "The thread shows the question with its choices." : "Activity shows the approval with its choices.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal)
        .padding(.vertical, 12)
        .frame(maxWidth: 680, alignment: .leading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
