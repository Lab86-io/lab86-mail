import SwiftUI

// The checklist a goal run keeps (docs/albatross-goal-runs.md, G1): a
// disclosure in the run block with the "Checklist" label and the count in
// the secondary style, and the rows in the plan-row grammar: a state word
// column ("Done", "You"), the live dot for the item the run works on now,
// then the text. No check icons. The same rows serve the Checklist sheet on
// the phone, the popover on the Mac, and the Details. iOS and macOS share
// this file.

struct RunChecklistView: View {
    let items: [ChecklistItem]
    @Binding var expanded: Bool

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            ChecklistRows(items: items)
                .padding(.top, 6)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(GoalRunCopy.checklist)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let count = ChecklistSummary.count(items) {
                    Text(count)
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .accessibilityLabel(ChecklistSummary.accessibilityLine(items))
    }
}

/// The rows alone, for the block, the sheet, the popover, and the Details.
struct ChecklistRows: View {
    @Environment(AppEnvironment.self) private var environment
    let items: [ChecklistItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.offset) { offset, item in
                row(item)
                if offset < items.count - 1 { Divider() }
            }
        }
    }

    private func row(_ item: ChecklistItem) -> some View {
        HStack(alignment: .top, spacing: 12) {
            leading(item)
                .frame(width: 38, alignment: .leading)
            Text(item.text)
                .font(.subheadline)
                .strikethrough(item.state == .done)
                .foregroundStyle(item.state == .done ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.accessibilityLabel(item))
    }

    /// The leading column: the live dot, "Done", "You", or nothing.
    @ViewBuilder private func leading(_ item: ChecklistItem) -> some View {
        switch item.state {
        case .doing:
            RevealDot()
                .padding(.top, 6)
        case .done:
            Text("Done")
                .font(.caption.weight(.medium))
                .foregroundStyle(.green)
        case .yours:
            Text("You")
                .font(.caption.weight(.medium))
                .foregroundStyle(environment.theme.accent3Color)
        case .todo, .unknown:
            Color.clear
                .frame(width: 1, height: 1)
        }
    }

    static func accessibilityLabel(_ item: ChecklistItem) -> String {
        switch item.state {
        case .doing: "Now: \(item.text)."
        case .done: "Done: \(item.text)."
        case .yours: "Yours: \(item.text)."
        case .todo, .unknown: "\(item.text)."
        }
    }
}

/// The checklist of a goal Work in place of the plan (iPhone: a sheet from
/// the line under the title; Mac: the same body in the plan popover).
struct ChecklistBody: View {
    let items: [ChecklistItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if items.isEmpty {
                Text(GoalRunCopy.noChecklist)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ChecklistRows(items: items)
            }
            Text(GoalRunCopy.checklistFooter)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 16)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }
}

struct ChecklistSheet: View {
    @Environment(\.dismiss) private var dismiss
    let items: [ChecklistItem]

    var body: some View {
        NavigationStack {
            ScrollView {
                ChecklistBody(items: items)
            }
            .navigationTitle(GoalRunCopy.checklist)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        #if os(iOS)
        .presentationDetents([.medium, .large])
        #endif
    }
}
