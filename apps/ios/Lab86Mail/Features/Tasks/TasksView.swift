import SwiftUI
import UniformTypeIdentifiers

// The default board as a real mobile kanban, in the shape of the best
// references (Trello/Asana/Jira mobile): full-height columns paged
// horizontally with the next column peeking, per-column quick add, and
// long-press drag to move cards between columns.
struct TasksView: View {
    @Environment(AppEnvironment.self) private var environment
    struct NewCardContext: Identifiable {
        let column: String
        var id: String { column }
    }

    @State private var dropTargetColumn: String?
    @State private var showsProjects = false
    @State private var openTask: TaskSummary?
    @State private var newCard: NewCardContext?

    private var store: ProductStore { environment.store }

    private var activeBoardTitle: String {
        store.taskBoards.first { $0.id == store.activeBoardID }?.title ?? "Personal"
    }

    var body: some View {
        Group {
            if columns.isEmpty {
                ContentUnavailableView(
                    "Nothing on the board",
                    systemImage: "checkmark.circle",
                    description: Text("Hand something to Albatross from the sidebar, or pull to refresh.")
                )
            } else {
                board
            }
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle(activeBoardTitle)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Picker(
                        "Board",
                        selection: Binding(
                            get: { store.activeBoardID ?? "" },
                            set: { newValue in
                                Task { await store.switchBoard(to: newValue.isEmpty ? nil : newValue) }
                            }
                        )
                    ) {
                        if store.taskBoards.isEmpty {
                            Text("Personal").tag("")
                        }
                        ForEach(store.taskBoards) { board in
                            Text(board.title).tag(board.id)
                        }
                    }
                    Divider()
                    Button("Projects") { showsProjects = true }
                } label: {
                    Label("Boards", systemImage: "square.stack")
                }
            }
        }
        .sheet(isPresented: $showsProjects) {
            ProjectsSheet()
        }
        .sheet(item: $openTask) { task in
            TaskDetailView(task: task)
        }
        .sheet(item: $newCard) { context in
            NewTaskSheet(column: context.column)
        }
        .task { await store.refreshBoardsAndProjects() }
        .shellToolbar()
    }

    private var board: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(alignment: .top, spacing: 12) {
                ForEach(columns, id: \.self) { column in
                    columnView(column)
                        .containerRelativeFrame(.horizontal) { length, _ in
                            min(length * 0.82, 340)
                        }
                }
            }
            .scrollTargetLayout()
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
        }
        .scrollTargetBehavior(.viewAligned)
    }

    // MARK: - Column

    private func columnView(_ column: String) -> some View {
        let cards = cards(in: column)
        let isDropTarget = dropTargetColumn == column
        return VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(column)
                    .font(.subheadline.weight(.semibold))
                Text("\(cards.count)")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Color.primary.opacity(0.06), in: Capsule())
                Spacer()
                Button {
                    newCard = NewCardContext(column: column)
                } label: {
                    Image(systemName: "plus")
                        .font(.subheadline.weight(.semibold))
                        .frame(width: 28, height: 28)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Add card to \(column)")
            }
            .padding(.horizontal, 14)
            .padding(.top, 12)
            .padding(.bottom, 8)

            ScrollView {
                VStack(spacing: 8) {
                    ForEach(cards) { task in
                        card(task)
                    }
                    if cards.isEmpty {
                        Button {
                            newCard = NewCardContext(column: column)
                        } label: {
                            Text("Add a card")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .background(
                                    Color.primary.opacity(0.04),
                                    in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                                )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 12)
            }
            .refreshable { await store.refreshToday() }
        }
        .background(
            Color(uiColor: .secondarySystemGroupedBackground).opacity(0.6),
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(
                    isDropTarget ? environment.theme.accentColor : Color.primary.opacity(0.06),
                    lineWidth: isDropTarget ? 2 : 1
                )
        }
        .dropDestination(for: String.self) { ids, _ in
            dropTargetColumn = nil
            let moved = ids.compactMap { id in store.tasks.first { $0.id == id } }
            guard !moved.isEmpty else { return false }
            Task {
                for task in moved { await store.moveTask(task, to: column) }
            }
            return true
        } isTargeted: { targeted in
            dropTargetColumn = targeted ? column : (dropTargetColumn == column ? nil : dropTargetColumn)
        }
    }

    // MARK: - Cards

    private func card(_ task: TaskSummary) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Button {
                    Task { await store.setTaskCompleted(task, completed: !task.completed) }
                } label: {
                    Image(systemName: task.completed ? "checkmark.circle.fill" : "circle")
                        .font(.body)
                        .foregroundStyle(task.completed ? Color.secondary : environment.theme.accentColor)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(task.completed ? "Reopen" : "Complete")

                Text(task.title)
                    .font(.subheadline)
                    .strikethrough(task.completed)
                    .foregroundStyle(task.completed ? .secondary : .primary)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if task.priority != nil || task.due != nil || task.details?.isEmpty == false {
            HStack(spacing: 6) {
                if let priority = task.priority, priority != "none" {
                    Text(priority.capitalized)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(
                            (priority == "high" ? Color.red.opacity(0.14) : environment.theme.accent2Color.opacity(0.14)),
                            in: Capsule()
                        )
                        .foregroundStyle(priority == "high" ? .red : environment.theme.accent2Color)
                }
                if let due = task.due {
                    Text(dueLabel(due))
                        .font(.caption)
                        .foregroundStyle(
                            !task.completed && due < .now ? .red : Color.secondary
                        )
                }
                if task.details?.isEmpty == false {
                    Image(systemName: "text.alignleft")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .accessibilityLabel("Has notes")
                }
            }
            .padding(.leading, 26)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Color(uiColor: .secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .shadow(color: .black.opacity(0.06), radius: 2, y: 1)
        .contentShape(.rect)
        .onTapGesture { openTask = task }
        .draggable(task.id)
        .contextMenu {
            Menu("Move to") {
                ForEach(columns, id: \.self) { column in
                    Button(column) {
                        Task { await store.moveTask(task, to: column) }
                    }
                    .disabled(column == task.column)
                }
            }
            Menu("Due") {
                Button("Today evening") { Task { await store.setTaskDue(task, due: dueDate(0)) } }
                Button("Tomorrow") { Task { await store.setTaskDue(task, due: dueDate(1)) } }
                Button("Next week") { Task { await store.setTaskDue(task, due: dueDate(7)) } }
                if task.due != nil {
                    Button("Clear due date") { Task { await store.setTaskDue(task, due: nil) } }
                }
            }
            Divider()
            Button("Delete", role: .destructive) {
                Task { await store.deleteTask(task) }
            }
        }
    }

    // MARK: - Data

    private var columns: [String] {
        if !store.taskColumns.isEmpty { return store.taskColumns }
        let seen = Array(Set(store.tasks.map(\.column)))
        return seen.sorted()
    }

    private func cards(in column: String) -> [TaskSummary] {
        store.tasks
            .filter { $0.column == column }
            .sorted {
                if $0.completed != $1.completed { return !$0.completed }
                return ($0.due ?? .distantFuture) < ($1.due ?? .distantFuture)
            }
    }

    private func dueDate(_ daysAhead: Int) -> Date {
        let base = Calendar.current.date(bySettingHour: 17, minute: 0, second: 0, of: .now) ?? .now
        return Calendar.current.date(byAdding: .day, value: daysAhead, to: base) ?? base
    }

    private func dueLabel(_ due: Date) -> String {
        let calendar = Calendar.autoupdatingCurrent
        if calendar.isDateInToday(due) { return "Today · \(due.formatted(date: .omitted, time: .shortened))" }
        if calendar.isDateInTomorrow(due) { return "Tomorrow" }
        return due.formatted(.dateTime.month(.abbreviated).day())
    }
}

// Creating a card opens the full metadata form, mirroring the detail sheet.
struct NewTaskSheet: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss

    let column: String

    @State private var title = ""
    @State private var details = ""
    @State private var priority = ""
    @State private var hasDue = false
    @State private var due = Calendar.current.date(
        bySettingHour: 17, minute: 0, second: 0, of: .now
    ) ?? .now
    @State private var targetColumn: String
    @State private var isSaving = false
    @FocusState private var titleFocused: Bool

    init(column: String) {
        self.column = column
        _targetColumn = State(initialValue: column)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("What needs doing?", text: $title, axis: .vertical)
                        .lineLimit(1...3)
                        .focused($titleFocused)
                }
                Section("Notes") {
                    TextEditor(text: $details)
                        .frame(minHeight: 90)
                        .accessibilityLabel("Notes")
                }
                Section {
                    Picker("Column", selection: $targetColumn) {
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
            }
            .navigationTitle("New card")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Adding…" : "Add") {
                        Task { await save() }
                    }
                    .disabled(isSaving || title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear { titleFocused = true }
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        await environment.store.createTask(
            title: title,
            column: targetColumn,
            due: hasDue ? due : nil,
            details: details.trimmingCharacters(in: .whitespacesAndNewlines),
            priority: priority.isEmpty ? nil : priority
        )
        dismiss()
    }
}

// Albatross projects across areas — tap through to the owning area.
struct ProjectsSheet: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if environment.store.projects.isEmpty {
                    ContentUnavailableView(
                        "No active projects",
                        systemImage: "square.stack.3d.up",
                        description: Text("Albatross derives projects from your plans and areas.")
                    )
                } else {
                    ForEach(environment.store.projects) { project in
                        Button {
                            if let areaID = project.areaID {
                                environment.navigation.openArea(id: areaID, name: nil)
                                dismiss()
                            }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(project.title)
                                        .foregroundStyle(.primary)
                                    Text(project.status.capitalized)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if project.areaID != nil {
                                    Image(systemName: "chevron.forward")
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .navigationTitle("Projects")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
