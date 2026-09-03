import SwiftUI

/// The project shape: milestones on a vertical rail, the done ones filled,
/// the current one ringed in accent, the rest hollow. Under it, the artifact
/// log in time order with "Last touched".
///
/// Mac branch likely: hover reveal for "Remove" on a milestone row.
struct ProjectBody: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let workID: String
    let milestones: [WorkMilestone]
    let evidence: [WorkDetail.Evidence]
    let lastUserTouchAt: Date?
    let updatedAt: Date?

    @State private var reopenTarget: WorkMilestone?
    @State private var renameTarget: WorkMilestone?
    @State private var draftTitle = ""
    @State private var renameTitle = ""
    @State private var showsAdd = false
    @State private var failed = false
    @State private var toggles = 0
    @FocusState private var addFocused: Bool
    private let now = Date.now

    private var ordered: [WorkMilestone] { WorkMilestoneRail.ordered(milestones) }
    private var currentID: String? { WorkMilestoneRail.currentID(milestones) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            rail
            addRow
            if failed {
                Text("Could not save. Try again.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.top, 8)
            }
            log
                .padding(.top, 24)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .confirmationDialog(
            "Reopen this milestone?",
            isPresented: Binding(get: { reopenTarget != nil }, set: { if !$0 { reopenTarget = nil } }),
            titleVisibility: .visible,
            presenting: reopenTarget
        ) { milestone in
            Button("Reopen") { Task { await toggle(milestone, confirmed: true) } }
        } message: { milestone in
            Text(milestone.title)
        }
        .alert(
            "Rename milestone",
            isPresented: Binding(get: { renameTarget != nil }, set: { if !$0 { renameTarget = nil } }),
            presenting: renameTarget
        ) { milestone in
            TextField("Title", text: $renameTitle)
            Button("Rename") { Task { await rename(milestone, to: renameTitle) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("The done state stays as it is.")
        }
        .modifier(ProjectHaptics(toggles: toggles))
    }

    // MARK: Rail

    private var rail: some View {
        VStack(alignment: .leading, spacing: 0) {
            if ordered.isEmpty {
                Text("No milestones yet. Add the first one.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 10)
            }
            ForEach(Array(ordered.enumerated()), id: \.element.id) { offset, milestone in
                milestoneRow(milestone, isFirst: offset == 0, isLast: offset == ordered.count - 1)
            }
        }
        .animation(WorkMotion.settle(reduceMotion: reduceMotion), value: milestones)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Milestones, \(ordered.filter(\.done).count) of \(ordered.count) done")
    }

    private func milestoneRow(_ milestone: WorkMilestone, isFirst: Bool, isLast: Bool) -> some View {
        let isCurrent = milestone.id == currentID
        return HStack(alignment: .top, spacing: 14) {
            ZStack {
                VStack(spacing: 0) {
                    Rectangle()
                        .fill(isFirst ? Color.clear : environment.theme.hairlineColor)
                        .frame(width: 2)
                    Rectangle()
                        .fill(isLast ? Color.clear : environment.theme.hairlineColor)
                        .frame(width: 2)
                }
                MilestoneDot(
                    done: milestone.done,
                    current: isCurrent,
                    accent: environment.theme.accentColor,
                    hairline: environment.theme.hairlineColor
                )
                .padding(.top, 13)
                .frame(maxHeight: .infinity, alignment: .top)
            }
            .frame(width: 24)
            .accessibilityHidden(true)

            Button {
                Task { await toggle(milestone, confirmed: false) }
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(milestone.title)
                        .font(.body.weight(isCurrent ? .medium : .regular))
                        .foregroundStyle(milestone.done ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                        .fixedSize(horizontal: false, vertical: true)
                    if milestone.done, let doneAt = milestone.doneAt {
                        Text("Done \(doneAt.formatted(.dateTime.day().month(.abbreviated)))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if isCurrent {
                        Text("Current")
                            .font(.caption)
                            .foregroundStyle(environment.theme.accentColor)
                    }
                }
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(milestone.title)
            .accessibilityValue(milestone.done ? "Done" : isCurrent ? "Current" : "Open")
            .accessibilityHint(milestone.done ? "Reopens this milestone" : "Marks this milestone done")
            .contextMenu {
                Button("Rename") {
                    renameTitle = milestone.title
                    renameTarget = milestone
                }
                Button("Move up") { Task { await move(milestone, by: -1) } }
                    .disabled(isFirst)
                Button("Move down") { Task { await move(milestone, by: 1) } }
                    .disabled(isLast)
                Button("Remove", role: .destructive) { Task { await remove(milestone) } }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private var addRow: some View {
        Group {
            if showsAdd {
                HStack(alignment: .center, spacing: 14) {
                    Circle()
                        .strokeBorder(environment.theme.hairlineColor, lineWidth: 1.5)
                        .frame(width: 14, height: 14)
                        .frame(width: 24)
                        .accessibilityHidden(true)
                    TextField("Milestone", text: $draftTitle)
                        .textFieldStyle(.plain)
                        .focused($addFocused)
                        .submitLabel(.done)
                        .onSubmit { Task { await add() } }
                        .accessibilityLabel("New milestone")
                }
                .frame(minHeight: 44)
            } else {
                Button("Add milestone") {
                    showsAdd = true
                    addFocused = true
                }
                .buttonStyle(.plain)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.leading, 38)
                .frame(minHeight: 44, alignment: .leading)
            }
        }
    }

    // MARK: Log

    private var log: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Log")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if let line = ProjectLog.lastTouchedLine(
                    lastUserTouchAt: lastUserTouchAt,
                    evidence: evidence,
                    updatedAt: updatedAt,
                    now: now
                ) {
                    Text(line)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .overlay(alignment: .bottom) { Divider().offset(y: 6) }
            .padding(.bottom, 6)

            let rows = ProjectLog.ordered(evidence)
            if rows.isEmpty {
                Text("Nothing logged yet. Commits, pull requests and docs land here.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(rows) { row in
                logRow(row)
            }
        }
    }

    private func logRow(_ row: WorkDetail.Evidence) -> some View {
        let content = HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(ProjectLog.kindWord(row.sourceKind))
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: 76, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(.subheadline)
                    .foregroundStyle(row.isRejected ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.primary))
                    .strikethrough(row.isRejected)
                    .fixedSize(horizontal: false, vertical: true)
                if let occurredAt = row.occurredAt {
                    Text(ProjectLog.relative(occurredAt, now: now))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)

        return Group {
            if let raw = row.url, let url = URL(string: raw) {
                Button { openURL(url) } label: { content }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens the link")
            } else {
                content
            }
        }
    }

    // MARK: Writes

    private func toggle(_ milestone: WorkMilestone, confirmed: Bool) async {
        if milestone.done, !confirmed {
            reopenTarget = milestone
            return
        }
        reopenTarget = nil
        failed = false
        toggles += 1
        let ok = await WorkShapeWriter.toggleMilestone(
            milestone.id, in: workID, current: milestones, environment: environment
        )
        if !ok { failed = true }
    }

    private func add() async {
        let title = draftTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else {
            showsAdd = false
            return
        }
        failed = false
        let next = ordered + [
            WorkMilestone(id: WorkShapeWriter.localID("ms"), title: String(title.prefix(200)), order: ordered.count),
        ]
        let ok = await environment.store.setWorkMilestones(workID, milestones: next)
        if ok {
            draftTitle = ""
            addFocused = true
        } else {
            failed = true
        }
    }

    private func rename(_ milestone: WorkMilestone, to title: String) async {
        let clean = title.trimmingCharacters(in: .whitespacesAndNewlines)
        renameTarget = nil
        guard !clean.isEmpty, clean != milestone.title else { return }
        failed = false
        let next = ordered.map { row -> WorkMilestone in
            guard row.id == milestone.id else { return row }
            var copy = row
            copy.title = String(clean.prefix(200))
            return copy
        }
        if !(await environment.store.setWorkMilestones(workID, milestones: next)) { failed = true }
    }

    private func move(_ milestone: WorkMilestone, by delta: Int) async {
        var rows = ordered
        guard let index = rows.firstIndex(where: { $0.id == milestone.id }) else { return }
        let target = index + delta
        guard rows.indices.contains(target) else { return }
        rows.swapAt(index, target)
        let next = rows.enumerated().map { offset, row -> WorkMilestone in
            var copy = row
            copy.order = offset
            return copy
        }
        failed = false
        if !(await environment.store.setWorkMilestones(workID, milestones: next)) { failed = true }
    }

    private func remove(_ milestone: WorkMilestone) async {
        failed = false
        let next = ordered.filter { $0.id != milestone.id }.enumerated().map { offset, row -> WorkMilestone in
            var copy = row
            copy.order = offset
            return copy
        }
        if !(await environment.store.setWorkMilestones(workID, milestones: next)) { failed = true }
    }
}

/// A 14 pt circle: filled accent when done, an accent ring for the current
/// one, a hairline ring for the rest.
struct MilestoneDot: View {
    let done: Bool
    let current: Bool
    let accent: Color
    let hairline: Color

    var body: some View {
        ZStack {
            Circle()
                .strokeBorder(done || current ? accent : Color.secondary.opacity(0.45), lineWidth: current ? 2 : 1.5)
            if done {
                Circle()
                    .fill(accent)
                    .transition(.scale.combined(with: .opacity))
            }
        }
        .frame(width: 14, height: 14)
    }
}

/// A light tick on each toggle. Silent on the Mac.
private struct ProjectHaptics: ViewModifier {
    let toggles: Int

    func body(content: Content) -> some View {
        #if os(iOS)
        content.sensoryFeedback(.impact(weight: .light), trigger: toggles)
        #else
        content
        #endif
    }
}
