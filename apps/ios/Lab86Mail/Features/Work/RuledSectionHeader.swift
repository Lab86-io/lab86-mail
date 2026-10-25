import SwiftUI

/// The one section header of the app (docs/research/ios-refresh-design-
/// 2026-10-24.md, "Shared rules"): a short rule, the heading in the user's
/// display face, and a quiet hint. At accessibility text sizes the hint goes
/// under the heading, so it never wraps in a narrow column beside it (D5).
/// Sentence case; a grouped list's capitals are turned off here.
struct RuledSectionHeader: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .subheadline) private var headingSize: CGFloat = 16
    let title: String
    var hint: String?
    /// The rule carries the accent when the section asks for the user.
    var accent = false

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize, let hint {
                VStack(alignment: .leading, spacing: 4) {
                    headingRow
                    Text(hint)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    headingRow
                    if let hint {
                        Text(hint)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .textCase(nil)
        .padding(.bottom, 2)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private var headingRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Rectangle()
                .fill(accent ? environment.theme.accentColor : Color.secondary.opacity(0.45))
                .frame(width: 18, height: 1)
                .accessibilityHidden(true)
            Text(title)
                // Capped: at the largest text sizes an uncapped heading ran
                // to two lines of about 50 pt and pushed the rows away.
                .font(environment.theme.displayType.displayFont(size: min(headingSize, 28)))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
