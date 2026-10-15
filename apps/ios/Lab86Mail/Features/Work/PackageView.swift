import SwiftUI

// The package a goal run hands over (docs/albatross-goal-runs.md, G3): one
// card with one row for each item. A row is the title, one verb at the
// trailing edge, and the state: "Ready.", "Check it.", or the blank sentence
// (docs/albatross-blank-design.md), with the item's note on its own line.
// The package card is the one raised surface of the block; the rest stays
// quiet. "Not sure" lists what the user must check. iOS and macOS share
// this file.

struct PackageView: View {
    @Environment(AppEnvironment.self) private var environment
    let items: [HandoffItem]
    var onOpen: (HandoffItem) -> Void = { _ in }

    var body: some View {
        PackageRowsList(items: items, onOpen: onOpen)
            .padding(.horizontal, 12)
            .surfaceCard(theme: environment.theme, cornerRadius: 12)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Package")
    }
}

/// The rows without the card, for a run that is done.
struct PackageRowsList: View {
    let items: [HandoffItem]
    var onOpen: (HandoffItem) -> Void = { _ in }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.offset) { offset, item in
                PackageItemRow(item: item) { onOpen(item) }
                if offset < items.count - 1 { Divider() }
            }
        }
    }
}

struct PackageItemRow: View {
    @Environment(AppEnvironment.self) private var environment
    let item: HandoffItem
    let action: () -> Void

    /// The point size of a blank sentence inside a row.
    static let sentenceSize: CGFloat = 15

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(item.title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Text(PackageRows.verb(item))
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(environment.theme.accentColor)
                        .fixedSize()
                }
                stateLine
                if let note = PackageRows.noteLine(item) {
                    Text(note)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hoverHighlight()
        .pointerMenu {
            Button(PackageRows.verb(item), action: action)
            Button("Copy the title") { PlatformPasteboard.copy(item.title) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(PackageRows.accessibilityLabel(item))
        .accessibilityHint(PackageRows.verb(item))
        .accessibilityAddTraits(.isButton)
    }

    @ViewBuilder private var stateLine: some View {
        switch PackageRows.stateLine(item) {
        case .blanks(let blanks, _):
            BlankSentence(blanks: blanks, size: Self.sentenceSize)
                .padding(.top, 2)
        case .ready, .check:
            if let word = PackageRows.stateWord(item) {
                Text(word)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// "Not sure": the lines the user must check, after the package.
struct UnsureView: View {
    let lines: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(GoalRunCopy.notSure)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
