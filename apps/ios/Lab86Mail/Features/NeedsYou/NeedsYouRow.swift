import SwiftUI

// Needs you (docs/needs-you.md, phase 5): one row of the list. Lead, the
// asker in the display face with the source after it, one line about what
// the user owes, the meta line, and the due word at the trailing edge. A
// code row shows the code itself in large tabular digits: the user does not
// need the detail for a code. The Mac list reuses these rows.

struct NeedsYouObligationRow: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let obligation: ObligationView
    let now: Date
    let timezone: String?

    private var nowMillis: ObligationMillis { NeedsYouClock.millis(now) }
    private var drawsLead: Bool { !dynamicTypeSize.isAccessibilitySize }
    private var stacksDue: Bool { dynamicTypeSize >= .xxxLarge }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if drawsLead {
                NeedsYouLeadView(lead: NeedsYouPresentation.lead(for: obligation))
                    .padding(.top, 2)
            }
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
                if stacksDue { dueColumn }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if !stacksDue {
                dueColumn
                    .padding(.top, 2)
            }
        }
        .padding(.vertical, 6)
        .opacity(obligation.isClosed ? 0.72 : 1)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(NeedsYouPresentation.accessibilityLabel(obligation, now: nowMillis, timezone: timezone))
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

    private var dueColumn: some View {
        NeedsYouDueColumn(label: NeedsYouLabels.dueLabel(obligation, now: nowMillis, timezone: timezone))
    }
}

/// An Albatross question or approval, listed beside the obligations.
struct NeedsYouExtraRow: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let extra: NeedsYouExtra

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if !dynamicTypeSize.isAccessibilitySize {
                NeedsYouLeadView(lead: .glyph(PrimaryTab.work.symbol))
                    .padding(.top, 2)
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(extra.title)
                        .font(environment.theme.displayType.displayFont(size: 15))
                        .lineLimit(1)
                    Text("Albatross")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let line = extra.line {
                    Text(line)
                        .font(.subheadline)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(NeedsYouPresentation.extraKindLabel(extra))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text("Waits for you")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.top, 2)
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// Initials for a person, a glyph in a circle for a system.
struct NeedsYouLeadView: View {
    @Environment(AppEnvironment.self) private var environment
    let lead: NeedsYouLead
    var size: CGFloat = 32

    var body: some View {
        switch lead {
        case .initials(let name, let seed):
            InitialsAvatar(name: name, seed: seed, size: size)
        case .glyph(let symbol):
            Image(systemName: symbol)
                .font(.system(size: size * 0.42, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: size, height: size)
                .background(Circle().fill(environment.theme.subtleColor))
                .overlay(Circle().strokeBorder(environment.theme.hairlineColor, lineWidth: 1))
                .accessibilityHidden(true)
        }
    }
}

/// The code in a row: large tabular digits with room between the groups,
/// and the word "Sign-in code" after it.
struct NeedsYouCodeLine: View {
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(NeedsYouLabels.spacedCode(value))
                .font(.system(size: 22, weight: .medium).monospacedDigit())
                .kerning(1.5)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text("Sign-in code")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

/// The due word at the trailing edge, in the tone the rule gives it: today
/// in the third accent, time-sensitive and expiry in the second, closed
/// reasons quiet.
struct NeedsYouDueColumn: View {
    @Environment(AppEnvironment.self) private var environment
    let label: NeedsYouDueLabel

    var body: some View {
        if !label.text.isEmpty {
            VStack(alignment: .trailing, spacing: 1) {
                Text(label.text)
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(tone)
                    .lineLimit(1)
                if let sub = label.sub {
                    Text(sub)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .fixedSize()
        }
    }

    private var tone: Color {
        switch label.tone {
        case .plain, .done: .secondary
        case .today: environment.theme.accent3Color
        case .hot: environment.theme.accent2Color
        }
    }
}
