import SwiftUI

/// Shared passed-block recovery. Today, Calendar, and Work detail all render
/// the same authoritative move and write through the same recovery endpoint.
struct MissedMoveRecoveryView: View {
    @Environment(AppEnvironment.self) private var environment
    let move: WorkExecutionMove

    @State private var isRecovering = false
    @State private var recoveryError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(move.workTitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(move.stepTitle)
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                if let start = move.scheduledStartAt {
                    Text("Was planned for \(start.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { recoveryButtons }
                VStack(alignment: .leading, spacing: 8) { recoveryButtons }
            }
            if let recoveryError {
                Text(recoveryError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
        .disabled(isRecovering)
        .overlay {
            if isRecovering {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color(.systemBackground).opacity(0.86))
                ProgressView("Updating the plan…")
                    .font(.caption)
            }
        }
    }

    @ViewBuilder private var recoveryButtons: some View {
        recoveryButton("Find another time", recovery: "move")
        recoveryButton("Make it smaller", recovery: "shrink")
        recoveryButton("Rebuild", recovery: "rebuild")
        recoveryButton("It happened", recovery: "done")
    }

    private func recoveryButton(_ title: String, recovery: String) -> some View {
        Button(title) {
            isRecovering = true
            recoveryError = nil
            Task {
                recoveryError = await environment.store.recoverWork(move, recovery: recovery)
                isRecovering = false
            }
        }
        .buttonStyle(.bordered)
        .frame(minHeight: 44)
    }
}
