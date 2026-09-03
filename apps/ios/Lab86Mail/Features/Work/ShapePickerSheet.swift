import SwiftUI

/// Writes shape commands through the durable command outbox, applies each
/// one locally at once, and lets the next `work_home` read settle it.
enum WorkShapeWriter {
    /// A local id for an item the server has not named yet. The settle read
    /// replaces it with the server id.
    static func localID(_ prefix: String, now: Date = .now) -> String {
        "local-\(prefix)-\(Int(now.timeIntervalSince1970 * 1_000))-\(Int.random(in: 0..<10_000))"
    }

    @MainActor
    private static func send(
        _ command: DurableMobileCommand,
        workID: String,
        environment: AppEnvironment,
        apply: () -> Void
    ) async -> Bool {
        guard let ownerID = environment.sessionStore.ownerID else { return false }
        do {
            _ = try await environment.commandOutbox.enqueue(ownerID: ownerID, command: command)
        } catch {
            return false
        }
        apply()
        // A failed flush keeps the command queued. The local state already
        // says what the user chose, so this is still a success.
        _ = await environment.flushCommandOutbox(ownerID: ownerID)
        await environment.store.settleWorkDetail(workID)
        return true
    }

    @MainActor
    static func setShape(_ shape: WorkShape, for workID: String, environment: AppEnvironment) async -> Bool {
        await send(
            .workSetShape(WorkSetShapeCommandPayload(workID: workID, shape: shape)),
            workID: workID,
            environment: environment
        ) {
            environment.store.applyWorkShape(workID, shape: shape)
        }
    }

    @MainActor
    static func addListItem(
        _ text: String,
        to workID: String,
        current: [WorkListEntry],
        environment: AppEnvironment
    ) async -> Bool {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return false }
        let entry = WorkListEntry(id: localID("item"), text: String(clean.prefix(500)), addedAt: .now)
        return await send(
            .workListAdd(WorkListAddCommandPayload(workID: workID, text: entry.text)),
            workID: workID,
            environment: environment
        ) {
            environment.store.applyWorkListItems(workID, items: current + [entry])
        }
    }

    @MainActor
    static func toggleListItem(
        _ itemID: String,
        in workID: String,
        current: [WorkListEntry],
        environment: AppEnvironment
    ) async -> Bool {
        await send(
            .workListToggle(WorkListItemCommandPayload(workID: workID, itemID: itemID)),
            workID: workID,
            environment: environment
        ) {
            environment.store.applyWorkListItems(
                workID,
                items: current.map { $0.id == itemID ? $0.toggled(at: .now) : $0 }
            )
        }
    }

    @MainActor
    static func removeListItem(
        _ itemID: String,
        from workID: String,
        current: [WorkListEntry],
        environment: AppEnvironment
    ) async -> Bool {
        await send(
            .workListRemove(WorkListItemCommandPayload(workID: workID, itemID: itemID)),
            workID: workID,
            environment: environment
        ) {
            environment.store.applyWorkListItems(workID, items: current.filter { $0.id != itemID })
        }
    }

    @MainActor
    static func logMetric(
        _ value: Double,
        note: String?,
        for workID: String,
        environment: AppEnvironment
    ) async -> Bool {
        let now = Date.now
        let cleanNote = note?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
        let entry = WorkMetricEntry(id: localID("log", now: now), at: now, value: value, note: cleanNote)
        return await send(
            .workMetricLog(WorkMetricLogCommandPayload(workID: workID, value: value, at: now, note: cleanNote)),
            workID: workID,
            environment: environment
        ) {
            environment.store.applyWorkMetricEntry(workID, entry: entry, now: now)
        }
    }

    @MainActor
    static func toggleMilestone(
        _ milestoneID: String,
        in workID: String,
        current: [WorkMilestone],
        environment: AppEnvironment
    ) async -> Bool {
        await send(
            .workMilestoneToggle(WorkMilestoneToggleCommandPayload(workID: workID, milestoneID: milestoneID)),
            workID: workID,
            environment: environment
        ) {
            environment.store.applyWorkMilestones(
                workID,
                milestones: current.map { $0.id == milestoneID ? $0.toggled(at: .now) : $0 }
            )
        }
    }
}

/// Seven rows, the shape word and one meaning line each. The tap confirms.
///
/// Mac branch likely: the same rows as a popover from the shape word, no
/// detent. The list body is shared.
struct ShapePickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppEnvironment.self) private var environment
    let current: WorkShape
    let onPick: (WorkShape) async -> Bool

    @State private var selected: WorkShape
    @State private var isSaving = false
    @State private var failed = false
    @State private var picks = 0

    init(current: WorkShape, onPick: @escaping (WorkShape) async -> Bool) {
        self.current = current
        self.onPick = onPick
        _selected = State(initialValue: current)
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(WorkShape.allCases, id: \.self) { shape in
                    Button {
                        Task { await pick(shape) }
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(shape.label)
                                    .font(.body.weight(shape == selected ? .semibold : .regular))
                                    .foregroundStyle(.primary)
                                Text(shape.meaning)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                            if shape == selected {
                                Text(isSaving && shape != current ? "Saving…" : "Chosen")
                                    .font(.caption)
                                    .foregroundStyle(environment.theme.accentColor)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(isSaving)
                    .accessibilityLabel("\(shape.label). \(shape.meaning)")
                    .accessibilityAddTraits(shape == selected ? .isSelected : [])
                    .accessibilityHint(shape == current ? "The current shape" : "Changes the shape")
                }
                if failed {
                    Text("Could not change the shape. Try again.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .listStyle(.plain)
            .navigationTitle("Shape")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .modifier(ShapePickerHaptics(picks: picks))
    }

    private func pick(_ shape: WorkShape) async {
        guard shape != current else {
            dismiss()
            return
        }
        selected = shape
        isSaving = true
        failed = false
        let ok = await onPick(shape)
        isSaving = false
        if ok {
            picks += 1
            dismiss()
        } else {
            selected = current
            failed = true
        }
    }
}

/// `.selection` on a pick. Silent on the Mac.
private struct ShapePickerHaptics: ViewModifier {
    let picks: Int

    func body(content: Content) -> some View {
        #if os(iOS)
        content.sensoryFeedback(.selection, trigger: picks)
        #else
        content
        #endif
    }
}
