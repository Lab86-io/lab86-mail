import SwiftUI

// The plan at a glance (docs/albatross-thread.md, S3): one row for each step
// with a check, a number, or the live dot; the proof line of a done step; and
// "Handle it" on a runnable step. The sheet opens from the plan line in the
// navigation bar. The Mac wraps the same list in a popover.

struct PlanListView: View {
    @Environment(AppEnvironment.self) private var environment
    let detail: WorkDetail
    let runs: [ThreadRunView]
    let threadState: ThreadState
    var busy = false
    let onHandle: (WorkDetail.ExecutionStep) -> Void
    let onSelect: (WorkDetail.ExecutionStep) -> Void
    let onOpenSite: (URL) -> Void

    static let footer = "Albatross keeps the plan here. Say what changed in the conversation, and the plan follows."

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(detail.execution.guideSteps.enumerated()), id: \.element.id) { offset, step in
                row(step, number: offset + 1)
                if offset < detail.execution.guideSteps.count - 1 { Divider() }
            }
            Text(Self.footer)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 16)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    private func row(_ step: WorkDetail.ExecutionStep, number: Int) -> some View {
        let isCurrent = step.id == detail.execution.currentStep?.id
        let works = isCurrent && threadState == .running
        return HStack(alignment: .top, spacing: 12) {
            Group {
                if works {
                    RevealDot()
                        .padding(.top, 6)
                } else {
                    Text(step.done ? "Done" : "\(number)")
                        .font(.caption.monospacedDigit().weight(.medium))
                        .foregroundStyle(step.done ? Color.green : (isCurrent ? environment.theme.accentColor : Color.secondary))
                }
            }
            .frame(width: 38, alignment: .leading)
            Button {
                onSelect(step)
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(step.title)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .strikethrough(step.done)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail = step.detail, !step.done {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text(Self.proofLine(step: step, isCurrent: isCurrent, threadState: threadState))
                        .font(.caption)
                        .foregroundStyle(step.done ? Color.green : Color.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Shows this step in the conversation")
            if isCurrent, step.isRunnable, !step.done, threadState.offersHandleIt {
                Button(busy ? RunBlockCopy.handleItBusy : RunBlockCopy.handleIt) { onHandle(step) }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(busy)
            }
        }
        .padding(.vertical, 10)
        .contextMenu {
            if let raw = step.url, let url = URL(string: raw), ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
                Button("Open the site") { onOpenSite(url) }
            }
        }
    }

    /// The proof line of a done step ("Verified on the page · Oct 19"), else
    /// the state word.
    static func proofLine(step: WorkDetail.ExecutionStep, isCurrent: Bool, threadState: ThreadState) -> String {
        if step.done {
            let label = step.verificationLabel ?? "Done"
            if let title = step.verificationEvidenceTitle?.nilIfBlank { return "\(label) · \(title)" }
            return label
        }
        return OutcomeBlockView.stateWord(step: step, isCurrent: isCurrent, threadState: threadState)
    }
}

struct PlanSheet: View {
    @Environment(\.dismiss) private var dismiss
    let detail: WorkDetail
    let runs: [ThreadRunView]
    let threadState: ThreadState
    var busy = false
    let onHandle: (WorkDetail.ExecutionStep) -> Void
    let onSelect: (WorkDetail.ExecutionStep) -> Void
    let onOpenSite: (URL) -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                PlanListView(
                    detail: detail,
                    runs: runs,
                    threadState: threadState,
                    busy: busy,
                    onHandle: { step in
                        onHandle(step)
                        dismiss()
                    },
                    onSelect: { step in
                        onSelect(step)
                        dismiss()
                    },
                    onOpenSite: onOpenSite
                )
            }
            .navigationTitle("Plan")
            .navigationBarTitleDisplayMode(.inline)
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
