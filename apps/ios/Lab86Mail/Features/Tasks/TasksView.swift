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

    @State private var showsProjects = false
    @State private var showsBoardManagement = false
    @State private var showsColumnManagement = false
    @State private var showsBoardSharing = false
    @State private var openTask: TaskSummary?
    @State private var newCard: NewCardContext?
    @State private var pendingDeleteTask: TaskSummary?
    @AppStorage("albatross.tasks.view-mode") private var viewMode = "board"

    private var store: ProductStore { environment.store }

    private var activeBoardTitle: String {
        store.taskBoards.first { $0.id == store.activeBoardID }?.title ?? "Personal"
    }

    var body: some View {
        Group {
            if !store.tasksDidLoad, store.isLoadingTasks, store.tasks.isEmpty {
                ProgressView("Loading tasks…")
            } else if !store.tasksDidLoad, let taskError = store.taskError, store.tasks.isEmpty {
                ContentUnavailableView {
                    Label("Tasks unavailable", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(taskError)
                } actions: {
                    Button("Try Again") {
                        Task { await store.refreshBoardsAndProjects() }
                    }
                }
            } else if columns.isEmpty {
                ContentUnavailableView(
                    "Nothing on the board",
                    systemImage: "checkmark.circle",
                    description: Text("Hand something to Albatross from the sidebar, or pull to refresh.")
                )
            } else if viewMode == "list" {
                taskList
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
                    Picker("View", selection: $viewMode) {
                        Label("Board", systemImage: "rectangle.split.3x1").tag("board")
                        Label("List", systemImage: "list.bullet").tag("list")
                    }
                    Divider()
                    Button("Projects") { showsProjects = true }
                    Button("Manage Boards") { showsBoardManagement = true }
                    Button("Manage Columns") { showsColumnManagement = true }
                        .disabled(store.activeBoardID == nil || store.taskBoardRole == "viewer")
                    Button("Share Board") { showsBoardSharing = true }
                        .disabled(store.activeBoardID == nil || store.taskBoardRole != "owner")
                } label: {
                    Label("Boards", systemImage: "square.stack")
                }
            }
            .visibilityPriority(.low)
        }
        .sheet(isPresented: $showsProjects) {
            ProjectsSheet()
        }
        .sheet(isPresented: $showsBoardManagement) {
            BoardManagementSheet()
        }
        .sheet(isPresented: $showsColumnManagement) {
            ColumnManagementSheet()
        }
        .sheet(isPresented: $showsBoardSharing) {
            BoardSharingSheet()
        }
        .sheet(item: $openTask) { task in
            TaskDetailView(task: task)
        }
        .sheet(item: $newCard) { context in
            NewTaskSheet(column: context.column)
        }
        .confirmationDialog(
            "Delete this card?",
            isPresented: Binding(
                get: { pendingDeleteTask != nil },
                set: { if !$0 { pendingDeleteTask = nil } }
            ),
            titleVisibility: .visible,
            presenting: pendingDeleteTask
        ) { task in
            Button("Delete “\(task.title)”", role: .destructive) {
                pendingDeleteTask = nil
                Task { await store.deleteTask(task) }
            }
            Button("Cancel", role: .cancel) { pendingDeleteTask = nil }
        } message: { task in
            Text("This removes the card from \(task.column).")
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
        .reorderContainer(
            for: TaskSummary.self,
            in: String.self,
            isEnabled: store.taskBoardRole != "viewer"
        ) { difference in
            guard let taskID = difference.sources.first else { return }
            let destinationID: String? = switch difference.destination.position {
            case .before(let id): id
            case .end: nil
            }
            // One confirmation tick when the drop lands; the lift/placeholder
            // feedback during the drag is the native reorder container's.
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            Task {
                await store.reorderTask(
                    id: taskID,
                    to: difference.destination.collectionID,
                    before: destinationID
                )
            }
        }
    }

    private var taskList: some View {
        List {
            ForEach(columns, id: \.self) { column in
                Section(column) {
                    ForEach(cards(in: column)) { task in
                        HStack(spacing: 10) {
                            Button {
                                Task { await store.setTaskCompleted(task, completed: !task.completed) }
                            } label: {
                                Image(systemName: task.completed ? "checkmark.circle.fill" : "circle")
                            }
                            .buttonStyle(.plain)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(task.title)
                                    .strikethrough(task.completed)
                                    .foregroundStyle(task.completed ? .secondary : .primary)
                                if let due = task.due {
                                    Text(dueLabel(due))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .contentShape(.rect)
                        .onTapGesture { openTask = task }
                        .swipeActions(edge: .trailing) {
                            Button("Delete", role: .destructive) {
                                pendingDeleteTask = task
                            }
                        }
                    }
                    .onMove { offsets, destination in
                        Task { await store.reorderTasks(in: column, from: offsets, to: destination) }
                    }
                }
            }
        }
        .refreshable { await store.refreshBoardsAndProjects() }
    }

    // MARK: - Column

    private func columnView(_ column: String) -> some View {
        let cards = cards(in: column)
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
                    .reorderable(collectionID: column)
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
                    Color.primary.opacity(0.06),
                    lineWidth: 1
                )
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
        // Board mode carries NO swipe actions: horizontal swipes fight the
        // hold-and-drag reorder gesture, which is why cards felt unmovable.
        // Complete/Move/Delete stay reachable through the context menu (and
        // swipes remain in list mode, where nothing competes).
        .contextMenu {
            Button(task.completed ? "Reopen" : "Complete") {
                Task { await store.setTaskCompleted(task, completed: !task.completed) }
            }
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
                pendingDeleteTask = task
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
            .sorted { $0.order < $1.order }
    }

    private func nextColumn(after column: String) -> String? {
        guard let index = columns.firstIndex(of: column), index + 1 < columns.count else { return nil }
        return columns[index + 1]
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
    @State private var isAutofilling = false
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
                    Button(isAutofilling ? "Autofilling…" : "Autofill with Albatross", systemImage: "sparkles") {
                        Task { await autofill() }
                    }
                    .disabled(
                        isAutofilling
                            || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
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

    private func autofill() async {
        isAutofilling = true
        defer { isAutofilling = false }
        let rough = [title, details].filter { !$0.isEmpty }.joined(separator: "\n")
        guard let draft = await environment.store.autofillTask(rough: rough) else { return }
        title = draft.title
        details = draft.details
        priority = draft.priority ?? ""
        if let suggestedDue = draft.due {
            hasDue = true
            due = suggestedDue
        }
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
                            environment.navigation.openProject(project)
                            dismiss()
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
                                Image(systemName: "chevron.forward")
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
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

struct ProjectDetailView: View {
    @Environment(AppEnvironment.self) private var environment
    let project: ProjectSummary
    @State private var openTask: TaskSummary?
    @State private var status: String
    @State private var isWorking = false
    @State private var showsArchiveConfirmation = false

    init(project: ProjectSummary) {
        self.project = project
        _status = State(initialValue: project.status)
    }

    // The pane lives in ProductStore keyed by project id, so task mutations
    // anywhere in the app refresh this surface — no one-shot local snapshot.
    private var pane: ProjectPaneState? {
        environment.store.projectPanes[project.id]
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(project.title)
                        .font(environment.theme.displayType.displayFont(size: 28))
                    Text(status.capitalized)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 6)
            }

            Section("Tasks") {
                if let error = pane?.error {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Couldn’t load this project’s tasks", systemImage: "exclamationmark.triangle")
                            .font(.subheadline.weight(.medium))
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Button("Try Again") {
                            Task { await environment.store.loadProjectPane(projectID: project.id, force: true) }
                        }
                        .buttonStyle(.bordered)
                    }
                    .padding(.vertical, 2)
                } else if pane == nil || (pane?.isLoading == true && pane?.tasks.isEmpty != false) {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Loading linked tasks…")
                            .foregroundStyle(.secondary)
                    }
                } else if pane?.tasks.isEmpty == true {
                    Text("No linked tasks yet.")
                        .foregroundStyle(.secondary)
                }
                ForEach(pane?.tasks ?? []) { task in
                    Button {
                        openTask = task
                    } label: {
                        HStack {
                            Image(systemName: task.completed ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(task.completed ? .secondary : environment.theme.accentColor)
                            VStack(alignment: .leading) {
                                Text(task.title)
                                    .foregroundStyle(.primary)
                                Text(task.column)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }

            if let areaID = project.areaID {
                Section("Context") {
                    Button("Open Area", systemImage: "square.stack.3d.up") {
                        environment.navigation.openArea(id: areaID, name: nil)
                    }
                }
            }
        }
        .navigationTitle("Project")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    environment.navigation.projectRoute = nil
                } label: {
                    Label("Back to Tasks", systemImage: "chevron.backward")
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    if status == "active" {
                        Button("Pause", systemImage: "pause") {
                            Task { await changeStatus("paused") }
                        }
                    } else {
                        Button("Resume", systemImage: "play") {
                            Task { await changeStatus("active") }
                        }
                    }
                    if status != "done" {
                        Button("Mark Done", systemImage: "checkmark.circle") {
                            Task { await changeStatus("done") }
                        }
                    }
                    Divider()
                    Button("Archive", systemImage: "archivebox", role: .destructive) {
                        showsArchiveConfirmation = true
                    }
                } label: {
                    Label("Project actions", systemImage: "ellipsis.circle")
                }
                .disabled(isWorking)
            }
        }
        .task {
            await environment.store.loadProjectPane(projectID: project.id)
        }
        .refreshable {
            await environment.store.loadProjectPane(projectID: project.id, force: true)
        }
        .sheet(item: $openTask) { TaskDetailView(task: $0) }
        .confirmationDialog(
            "Archive this project?",
            isPresented: $showsArchiveConfirmation,
            titleVisibility: .visible
        ) {
            Button("Archive Project", role: .destructive) {
                Task {
                    await changeStatus("archived")
                    environment.navigation.projectRoute = nil
                }
            }
        } message: {
            Text("Its task cards remain available on their boards.")
        }
    }

    private func changeStatus(_ newStatus: String) async {
        isWorking = true
        defer { isWorking = false }
        if await environment.store.updateProject(project, status: newStatus) {
            status = newStatus
        }
    }
}

private struct BoardManagementSheet: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State private var newBoardTitle = ""
    @State private var renameTitle = ""
    @State private var isWorking = false
    @State private var showsDeleteConfirmation = false

    private var selectedBoard: TaskBoardSummary? {
        environment.store.taskBoards.first { $0.id == environment.store.activeBoardID }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Current board") {
                    Picker(
                        "Board",
                        selection: Binding(
                            get: { environment.store.activeBoardID ?? "" },
                            set: { boardID in
                                Task {
                                    await environment.store.switchBoard(to: boardID)
                                    renameTitle = selectedBoard?.title ?? ""
                                }
                            }
                        )
                    ) {
                        ForEach(environment.store.taskBoards) { board in
                            Text(board.title).tag(board.id)
                        }
                    }
                    TextField("Board name", text: $renameTitle)
                    Button("Rename") {
                        Task {
                            isWorking = true
                            _ = await environment.store.renameActiveBoard(title: renameTitle)
                            isWorking = false
                        }
                    }
                    .disabled(
                        isWorking
                            || selectedBoard?.owned != true
                            || renameTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
                }

                Section("New board") {
                    TextField("Board name", text: $newBoardTitle)
                    Button("Create Board") {
                        Task {
                            isWorking = true
                            if await environment.store.createBoard(title: newBoardTitle) {
                                newBoardTitle = ""
                                renameTitle = selectedBoard?.title ?? ""
                            }
                            isWorking = false
                        }
                    }
                    .disabled(isWorking || newBoardTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                if selectedBoard?.owned == true {
                    Section {
                        Button("Delete Board", role: .destructive) {
                            showsDeleteConfirmation = true
                        }
                        .disabled(isWorking)
                    } footer: {
                        Text("Deleting a board permanently removes its columns, cards, and share access.")
                    }
                }
            }
            .navigationTitle("Boards")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear { renameTitle = selectedBoard?.title ?? "" }
            .onChange(of: environment.store.activeBoardID) {
                renameTitle = selectedBoard?.title ?? ""
            }
            .confirmationDialog(
                "Delete “\(selectedBoard?.title ?? "this board")”?",
                isPresented: $showsDeleteConfirmation,
                titleVisibility: .visible
            ) {
                Button("Delete Board and Cards", role: .destructive) {
                    Task {
                        isWorking = true
                        _ = await environment.store.deleteActiveBoard()
                        renameTitle = selectedBoard?.title ?? ""
                        isWorking = false
                    }
                }
            } message: {
                Text("This action cannot be undone.")
            }
        }
    }
}

private struct ColumnManagementSheet: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State private var newColumnName = ""
    @State private var renameColumn: TaskColumnSummary?
    @State private var renameText = ""
    @State private var deleteColumn: TaskColumnSummary?
    @State private var isWorking = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(environment.store.taskColumnRows) { column in
                        HStack {
                            Text(column.name)
                            Spacer()
                            Menu {
                                Button("Rename", systemImage: "pencil") {
                                    renameColumn = column
                                    renameText = column.name
                                }
                                Button("Delete", systemImage: "trash", role: .destructive) {
                                    deleteColumn = column
                                }
                            } label: {
                                Image(systemName: "ellipsis.circle")
                            }
                        }
                    }
                    .onMove { offsets, destination in
                        Task {
                            await environment.store.reorderColumns(from: offsets, to: destination)
                        }
                    }
                } header: {
                    Text("Workflow")
                } footer: {
                    Text("Drag columns into the order used by board and list views.")
                }

                Section("Add column") {
                    TextField("Column name", text: $newColumnName)
                    Button("Add Column") {
                        Task {
                            isWorking = true
                            if await environment.store.createColumn(name: newColumnName) {
                                newColumnName = ""
                            }
                            isWorking = false
                        }
                    }
                    .disabled(isWorking || newColumnName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .environment(\.editMode, .constant(.active))
            .navigationTitle("Columns")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .alert("Rename column", isPresented: Binding(
                get: { renameColumn != nil },
                set: { if !$0 { renameColumn = nil } }
            )) {
                TextField("Column name", text: $renameText)
                Button("Cancel", role: .cancel) { renameColumn = nil }
                Button("Rename") {
                    guard let column = renameColumn else { return }
                    renameColumn = nil
                    Task { _ = await environment.store.renameColumn(column, name: renameText) }
                }
            }
            .confirmationDialog(
                "Delete “\(deleteColumn?.name ?? "this column")”?",
                isPresented: Binding(
                    get: { deleteColumn != nil },
                    set: { if !$0 { deleteColumn = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Delete Column and Cards", role: .destructive) {
                    guard let column = deleteColumn else { return }
                    deleteColumn = nil
                    Task { _ = await environment.store.deleteColumn(column) }
                }
            } message: {
                Text("Every card in this column will be permanently deleted.")
            }
        }
    }
}

private struct BoardSharingSheet: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var role = "member"
    @State private var publicLinkEnabled = false
    @State private var pendingRemove: TaskBoardMember?
    @State private var isWorking = false

    private var publicURL: URL? {
        guard let token = environment.store.taskPublicToken,
              let baseURL = environment.configuration.apiBaseURL else { return nil }
        return URL(string: "/b/\(token)", relativeTo: baseURL)?.absoluteURL
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Invite") {
                    TextField("Email address", text: $email)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.emailAddress)
                    Picker("Access", selection: $role) {
                        Text("Can edit").tag("member")
                        Text("View only").tag("viewer")
                    }
                    Button("Send Invite") {
                        Task {
                            isWorking = true
                            if await environment.store.inviteBoardMember(email: email, role: role) {
                                email = ""
                            }
                            isWorking = false
                        }
                    }
                    .disabled(isWorking || !email.contains("@"))
                }

                Section("People") {
                    if environment.store.taskBoardMembers.isEmpty {
                        Text("Only you have access.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(environment.store.taskBoardMembers) { member in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(member.email)
                                Text("\(member.role == "member" ? "Can edit" : "View only") · \(member.status)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Remove", role: .destructive) { pendingRemove = member }
                                .font(.caption)
                        }
                    }
                }

                Section {
                    Toggle("Public read-only link", isOn: Binding(
                        get: { publicLinkEnabled },
                        set: { enabled in
                            publicLinkEnabled = enabled
                            Task {
                                if !(await environment.store.setBoardPublicLink(enabled: enabled)) {
                                    publicLinkEnabled.toggle()
                                }
                            }
                        }
                    ))
                    if let publicURL {
                        ShareLink(item: publicURL) {
                            Label("Share Public Link", systemImage: "square.and.arrow.up")
                        }
                    }
                } footer: {
                    Text("Anyone with the public link can view this board. They cannot edit cards.")
                }
            }
            .navigationTitle("Share Board")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                publicLinkEnabled = environment.store.taskPublicToken != nil
            }
            .confirmationDialog(
                "Remove access for \(pendingRemove?.email ?? "this person")?",
                isPresented: Binding(
                    get: { pendingRemove != nil },
                    set: { if !$0 { pendingRemove = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Remove Access", role: .destructive) {
                    guard let member = pendingRemove else { return }
                    pendingRemove = nil
                    Task { _ = await environment.store.removeBoardMember(member) }
                }
            }
        }
    }
}
