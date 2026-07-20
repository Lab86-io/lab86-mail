import SwiftUI

// Full card detail as a sheet — the phone counterpart of the desktop
// CardPanel. View-first: everything reads immediately and edits in place;
// Save writes once through tasks_update_card.
struct TaskDetailView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss

    let task: TaskSummary

    @State private var title: String
    @State private var details: String
    @State private var priority: String
    @State private var hasDue: Bool
    @State private var due: Date
    @State private var completed: Bool
    @State private var column: String
    @State private var commentDraft = ""
    @State private var commentPosted = false
    @State private var isSaving = false
    @State private var showsDeleteConfirmation = false

    init(task: TaskSummary) {
        self.task = task
        _title = State(initialValue: task.title)
        _details = State(initialValue: task.details ?? "")
        _priority = State(initialValue: task.priority ?? "")
        _hasDue = State(initialValue: task.due != nil)
        _due = State(initialValue: task.due ?? Calendar.current.date(
            bySettingHour: 17, minute: 0, second: 0, of: .now
        ) ?? .now)
        _completed = State(initialValue: task.completed)
        _column = State(initialValue: task.column)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title, axis: .vertical)
                        .lineLimit(1...3)
                        .font(.body.weight(.medium))
                    Toggle("Completed", isOn: $completed)
                }

                Section("Notes") {
                    TextEditor(text: $details)
                        .frame(minHeight: 110)
                        .accessibilityLabel("Notes")
                }

                Section {
                    Picker("Column", selection: $column) {
                        ForEach(environment.store.taskColumns, id: \.self) { name in
                            Text(name).tag(name)
                        }
                    }
                    Picker("Priority", selection: $priority) {
                        Text("None").tag("")
                        Text("Low").tag("low")
                        Text("Medium").tag("medium")
                        Text("High").tag("high")
                    }
                    Toggle("Due date", isOn: $hasDue.animation())
                    if hasDue {
                        DatePicker("Due", selection: $due, displayedComponents: [.date, .hourAndMinute])
                    }
                }

                if !task.labels.isEmpty {
                    Section("Labels") {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(task.labels, id: \.self) { label in
                                    Text(label)
                                        .font(.caption.weight(.medium))
                                        .padding(.horizontal, 9)
                                        .padding(.vertical, 4)
                                        .background(
                                            environment.theme.accent2Color.opacity(0.14),
                                            in: Capsule()
                                        )
                                }
                            }
                        }
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    }
                }

                Section("Comment") {
                    HStack(spacing: 8) {
                        TextField("Add a comment", text: $commentDraft, axis: .vertical)
                            .lineLimit(1...4)
                        Button("Post") {
                            Task { await postComment() }
                        }
                        .disabled(commentDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    if commentPosted {
                        Text("Comment added.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                Section {
                    Button("Delete card", role: .destructive) {
                        showsDeleteConfirmation = true
                    }
                }
            }
            .navigationTitle("Card")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") {
                        Task { await save() }
                    }
                    .disabled(isSaving || title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .confirmationDialog(
                "Delete this card?",
                isPresented: $showsDeleteConfirmation,
                titleVisibility: .visible
            ) {
                Button("Delete card", role: .destructive) {
                    Task {
                        await environment.store.deleteTask(task)
                        dismiss()
                    }
                }
            }
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        let saved = await environment.store.updateTaskDetails(
            task,
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            details: details.trimmingCharacters(in: .whitespacesAndNewlines),
            priority: priority.isEmpty ? nil : priority,
            due: hasDue ? due : nil,
            completed: completed
        )
        if saved, column != task.column {
            await environment.store.moveTask(task, to: column)
        }
        if saved { dismiss() }
    }

    private func postComment() async {
        let body = commentDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        if await environment.store.addTaskComment(task, body: body) {
            commentDraft = ""
            commentPosted = true
        }
    }
}
