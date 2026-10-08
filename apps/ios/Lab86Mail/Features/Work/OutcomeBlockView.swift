import SwiftUI

// The first item of the Albatross thread (docs/albatross-thread.md, S2): what
// Albatross understood. The outcome, the plan summary, one compact row for
// each step, and "Handle it" on the current step. While the plan is not
// ready, the block says so and the composer still works.
struct OutcomeBlockView: View {
    @Environment(AppEnvironment.self) private var environment
    let detail: WorkDetail?
    let routeTitle: String?
    let threadState: ThreadState
    /// The runs of the thread: a step whose newest run waits says so.
    var runs: [ThreadRunView] = []
    var busy = false
    let onHandle: (WorkDetail.ExecutionStep) -> Void
    let onOpenPlan: () -> Void
    let onOpenDetails: () -> Void

    static let planningLine = "Albatross makes the plan."
    private static let compactStepLimit = 5

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.title3.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if let summary = detail?.plan?.summary {
                Text(summary)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            if let detail {
                shapeLine(detail)
                if detail.execution.guideSteps.isEmpty {
                    planningRow
                } else {
                    steps(detail)
                }
            } else {
                planningRow
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    private var title: String {
        detail?.plan?.outcome ?? detail?.work.title ?? routeTitle ?? "Albatross"
    }

    private var planningRow: some View {
        HStack(spacing: 8) {
            RevealDot()
            Text(Self.planningLine)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.top, 2)
    }

    /// A list, a practice, or a project keeps its body in the details sheet;
    /// the thread shows one line and "Details".
    @ViewBuilder private func shapeLine(_ detail: WorkDetail) -> some View {
        if let line = Self.shapeLine(detail) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(line)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
                Button("Details", action: onOpenDetails)
                    .buttonStyle(.borderless)
                    .font(.subheadline.weight(.medium))
            }
        }
    }

    static func shapeLine(_ detail: WorkDetail) -> String? {
        switch detail.work.resolvedShape.detail {
        case .list:
            let items = detail.work.listItems ?? []
            let done = items.filter(\.done).count
            return "\(items.count) items, \(done) done"
        case .practice:
            return detail.metricSummary.map { "\($0.count) entries so far" } ?? "A practice"
        case .milestones:
            let milestones = detail.work.milestones ?? []
            let done = milestones.filter(\.done).count
            return "\(milestones.count) milestones, \(done) done"
        case .guided, .decision, .monitor, .routine:
            return nil
        }
    }

    private func steps(_ detail: WorkDetail) -> some View {
        let all = detail.execution.guideSteps
        let shown = Array(all.prefix(Self.compactStepLimit))
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { offset, step in
                stepRow(step, number: offset + 1, isCurrent: step.id == detail.execution.currentStep?.id)
                if offset < shown.count - 1 { Divider() }
            }
            if all.count > shown.count {
                Button("\(all.count - shown.count) more steps") { onOpenPlan() }
                    .buttonStyle(.borderless)
                    .font(.subheadline)
                    .padding(.top, 8)
            }
        }
        .padding(.top, 4)
    }

    private func stepRow(_ step: WorkDetail.ExecutionStep, number: Int, isCurrent: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(step.done ? "Done" : "\(number)")
                .font(.caption.monospacedDigit().weight(.medium))
                .foregroundStyle(step.done ? Color.green : (isCurrent ? environment.theme.accentColor : Color.secondary))
                .frame(width: 38, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                Text(step.title)
                    .font(.subheadline)
                    .strikethrough(step.done)
                    .fixedSize(horizontal: false, vertical: true)
                Text(Self.stateWord(step: step, isCurrent: isCurrent, threadState: threadState, runs: runs))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if isCurrent, step.isRunnable, !step.done, threadState.offersHandleIt {
                Button(busy ? RunBlockCopy.handleItBusy : RunBlockCopy.handleIt) { onHandle(step) }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(busy)
                    .help("Albatross works this step and stops at the next action for you.")
            }
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }

    /// The one state word of a step row.
    static func stateWord(
        step: WorkDetail.ExecutionStep,
        isCurrent: Bool,
        threadState: ThreadState,
        runs: [ThreadRunView] = []
    ) -> String {
        if step.done { return step.verificationLabel ?? "Done" }
        // A step whose newest run waits for the user says what waits
        // (docs/albatross-document-handoff.md).
        if let waiting = PlanStepWaiting.label(step: step, runs: runs) { return waiting }
        guard isCurrent else { return "Next" }
        switch threadState {
        case .running: return "Albatross works"
        case .yourTurn: return "Your turn"
        case .needsAnswer: return "Needs your answer"
        case .readyForYou: return "Ready for you"
        case .planning, .ready, .done, .putDown:
            return step.isRunnable ? "Albatross can handle it" : "You"
        }
    }
}

