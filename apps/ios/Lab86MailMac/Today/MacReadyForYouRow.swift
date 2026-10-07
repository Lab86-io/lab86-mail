import SwiftUI

// One "Ready for you" row on the Mac Brief: the text at the left, one button
// at the trailing edge, a quiet fill under the pointer, and a context menu
// with the same verbs. A click on the text opens the Work. Design note:
// docs/research/step-runner-macos-design-2026-10-07.md.

struct MacReadyForYouRow: View {
    let item: StepHandoffItem
    let busy: Bool
    let onOpen: () -> Void
    let onAct: () -> Void
    let onDismiss: () -> Void

    private var next: StepRunView.Next? { item.run.isHandoff ? item.run.next : nil }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.workTitle)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if item.run.state.isOpen {
                            ProgressView()
                                .controlSize(.mini)
                        }
                        Text(StepRunCopy.readyRowTitle(item.run))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text(StepRunCopy.readyRowLine(item.run))
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Opens the Work")
            if let next {
                Button(busy ? "Opening…" : next.label, action: onAct)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(busy)
                    .help(next.detail ?? next.label)
            }
        }
        .padding(.vertical, 12)
        .hoverHighlight(cornerRadius: 10, inset: 10)
        .contextMenu {
            Button("Open the Work", action: onOpen)
            if let next {
                Button(next.label, action: onAct)
                Divider()
                Button("Dismiss", action: onDismiss)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Open the Work", onOpen)
    }
}
