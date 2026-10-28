import SwiftUI
import UniformTypeIdentifiers

// The board: columns of flat cards on paper. A phone pages one column at a
// time with the next one peeking; a wide window shows every column at once
// (D22). A card is an insert with quiet text under its title, and a hold on
// a card moves it between columns. The board picker lives in the title.
struct TasksView: View {
    @Environment(AppEnvironment.self) private var environment
    struct NewCardContext: Identifiable {
        let column: String
        var id: String { column }
    }

    @State private var showsProjects = false
    @State private var showsBoardManagement = false
    @State private var showsColumnManagement = false
    @State private var openTask: TaskSummary?
    @State private var newCard: NewCardContext?
    @State private var pendingDeleteTask: TaskSummary?
    @AppStorage("albatross.tasks.view-mode") private var viewMode = "board"
    @ScaledMetric(relativeTo: .body) private var glyphWidth: CGFloat = 22

    private var store: ProductStore { environment.store }

    private var activeBoardTitle: String {
        store.taskBoards.first { $0.id == store.activeBoardID }?.title ?? "Personal"
    }

    private var canEdit: Bool { store.taskBoardRole != "viewer" }

    var body: some View {
        content
            .background(environment.theme.paperColor)
            .navigationTitle(activeBoardTitle)
            .toolbarTitleMenu { boardPicker }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    moreMenu
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

    // MARK: - States

    @ViewBuilder private var content: some View {
        if !store.tasksDidLoad, store.isLoadingTasks, store.tasks.isEmpty {
            ProgressView("Loading tasks…")
        } else if !store.tasksDidLoad, let taskError = store.taskError, store.tasks.isEmpty {
            ContentUnavailableView {
                Label("Could not load the board", systemImage: "exclamationmark.triangle")
            } description: {
                Text(taskError)
            } actions: {
                Button("Try again") {
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

    // MARK: - Title menu and toolbar

    // The board switch belongs to the title: the title names the board, so
    // the title changes the board.
    @ViewBuilder private var boardPicker: some View {
        Picker("Board", selection: boardSelection) {
            if store.taskBoards.isEmpty {
                Text("Personal").tag("")
            }
            ForEach(store.taskBoards) { board in
                Text(board.title).tag(board.id)
            }
        }
        Divider()
        Button("Manage boards") { showsBoardManagement = true }
    }

    private var boardSelection: Binding<String> {
        Binding(
            get: { store.activeBoardID ?? "" },
            set: { newValue in
                Task { await store.switchBoard(to: newValue.isEmpty ? nil : newValue) }
            }
        )
    }

    // The bar menu holds everything about boards; the title menu is the
    // short way to switch.
    private var moreMenu: some View {
        Menu {
            boardPicker
            Divider()
            Picker("View", selection: $viewMode) {
                Text("Board").tag("board")
                Text("List").tag("list")
            }
            Divider()
            Button("Projects") { showsProjects = true }
            Button("Manage columns") { showsColumnManagement = true }
                .disabled(store.activeBoardID == nil || !canEdit)
        } label: {
            Label("Boards", systemImage: "square.stack")
        }
    }

    // MARK: - Board

    private var board: some View {
        GeometryReader { geometry in
            let plan = BoardLayout.plan(available: geometry.size.width, count: columns.count)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: plan.spacing) {
                    ForEach(Array(columns.enumerated()), id: \.element) { position, column in
                        columnView(column, isLast: position == columns.count - 1, spacing: plan.spacing)
                            .frame(width: plan.columnWidth)
                    }
                }
                .scrollTargetLayout()
                .padding(.horizontal, plan.inset)
                .padding(.top, 4)
            }
            .scrollTargetBehavior(.viewAligned)
            .scrollDisabled(plan.fits)
            .reorderContainer(
                for: TaskSummary.self,
                in: String.self,
                isEnabled: canEdit
            ) { difference in
                guard let taskID = difference.sources.first else { return }
                let destinationID: String? = switch difference.destination.position {
                case .before(let id): id
                case .end: nil
                }
                // One confirmation tick when the drop lands; the lift and the
                // placeholder during the drag are the native container's.
                PlatformHaptics.lightImpact()
                Task {
                    await store.reorderTask(
                        id: taskID,
                        to: difference.destination.collectionID,
                        before: destinationID
                    )
                }
            }
        }
    }

    // MARK: - Column

    // A column is a region of the paper, not a box: a header, its cards, and
    // a hairline rule to the next column.
    private func columnView(_ column: String, isLast: Bool, spacing: CGFloat) -> some View {
        let cards = cards(in: column)
        return VStack(spacing: 0) {
            columnHeader(column, count: cards.count)
            ScrollView {
                VStack(spacing: 8) {
                    ForEach(cards) { task in
                        card(task)
                    }
                    .reorderable(collectionID: column)
                    if cards.isEmpty {
                        emptyColumn(column)
                    }
                }
                .padding(.bottom, 12)
            }
            .refreshable { await store.refreshBoardsAndProjects() }
        }
        .overlay(alignment: .trailing) {
            if !isLast {
                Rectangle()
                    .fill(environment.theme.hairlineColor)
                    .frame(width: 0.5)
                    .padding(.trailing, -spacing / 2)
                    .accessibilityHidden(true)
            }
        }
    }

    private func columnHeader(_ column: String, count: Int) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(column)
                .font(.headline)
            Text("\(count)")
                .font(.subheadline)
                .monospacedDigit()
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            if canEdit {
                Button("Add") {
                    newCard = NewCardContext(column: column)
                }
                .font(.subheadline.weight(.medium))
                .buttonStyle(.plain)
                .foregroundStyle(environment.theme.accentColor)
                .accessibilityLabel("Add card to \(column)")
            }
        }
        .padding(.top, 8)
        .padding(.bottom, 10)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private func emptyColumn(_ column: String) -> some View {
        if canEdit {
            Button("Add a card") {
                newCard = NewCardContext(column: column)
            }
            .font(.subheadline)
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: 44)
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(environment.theme.hairlineColor, lineWidth: 1)
            }
        } else {
            Text("No cards")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, minHeight: 44)
        }
    }

    // MARK: - Cards

    private func card(_ task: TaskSummary) -> some View {
        let meta = TaskMeta.line(priority: task.priority, due: task.due, completed: task.completed)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                completeButton(task)
                Text(task.title)
                    .font(.body)
                    .strikethrough(task.completed)
                    .foregroundStyle(task.completed ? .secondary : .primary)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                actionsMenu(task)
            }
            if let meta {
                Text(meta.text)
                    .font(.footnote)
                    .foregroundStyle(meta.isOverdue ? Color.red : Color.secondary)
                    .padding(.leading, glyphWidth + 10)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .insetPanel(cornerRadius: 12)
        .contentShape(.rect)
        .onTapGesture { openTask = task }
        // Board mode carries no swipe actions: horizontal swipes fight the
        // hold-and-drag reorder gesture. Complete, move, and delete stay
        // reachable through the menu and the context menu.
        .contextMenu {
            cardActions(task)
        }
    }

    private func completeButton(_ task: TaskSummary) -> some View {
        Button {
            Task { await store.setTaskCompleted(task, completed: !task.completed) }
        } label: {
            Image(systemName: task.completed ? "checkmark.circle.fill" : "circle")
                .font(.body)
                .foregroundStyle(task.completed ? Color.secondary : environment.theme.accentColor)
                .frame(width: glyphWidth)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(task.completed ? "Reopen" : "Complete")
    }

    private func actionsMenu(_ task: TaskSummary) -> some View {
        Menu {
            cardActions(task)
        } label: {
            Image(systemName: "ellipsis")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 28, height: 28)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Actions for \(task.title)")
    }

    @ViewBuilder
    private func cardActions(_ task: TaskSummary) -> some View {
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

    // MARK: - List

    private var taskList: some View {
        List {
            ForEach(columns, id: \.self) { column in
                Section(column) {
                    ForEach(cards(in: column)) { task in
                        listRow(task)
                    }
                    // A viewer reads the board; only an editor moves rows, as
                    // in board mode. A nil action turns the move off.
                    .onMove(perform: canEdit ? { offsets, destination in
                        Task { await store.reorderTasks(in: column, from: offsets, to: destination) }
                    } : nil)
                }
            }
        }
        .refreshable { await store.refreshBoardsAndProjects() }
    }

    private func listRow(_ task: TaskSummary) -> some View {
        let meta = TaskMeta.line(priority: task.priority, due: task.due, completed: task.completed)
        return HStack(spacing: 10) {
            completeButton(task)
            VStack(alignment: .leading, spacing: 2) {
                Text(task.title)
                    .strikethrough(task.completed)
                    .foregroundStyle(task.completed ? .secondary : .primary)
                if let meta {
                    Text(meta.text)
                        .font(.caption)
                        .foregroundStyle(meta.isOverdue ? Color.red : Color.secondary)
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

    private func dueDate(_ daysAhead: Int) -> Date {
        let base = Calendar.current.date(bySettingHour: 17, minute: 0, second: 0, of: .now) ?? .now
        return Calendar.current.date(byAdding: .day, value: daysAhead, to: base) ?? base
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
                    TextField("What is the task?", text: $title, axis: .vertical)
                        .lineLimit(1...3)
                        .focused($titleFocused)
                    Button(isAutofilling ? "Autofilling…" : "Autofill with Albatross") {
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

// Albatross projects across areas. A tap goes to the project.
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
    // anywhere in the app refresh this surface.
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
                        Text("Could not load the tasks of this project")
                            .font(.subheadline.weight(.medium))
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Button("Try again") {
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
                    Button("Open area") {
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
                        Button("Pause") {
                            Task { await changeStatus("paused") }
                        }
                    } else {
                        Button("Resume") {
                            Task { await changeStatus("active") }
                        }
                    }
                    if status != "done" {
                        Button("Mark done") {
                            Task { await changeStatus("done") }
                        }
                    }
                    Divider()
                    Button("Archive", role: .destructive) {
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
            Button("Archive project", role: .destructive) {
                Task {
                    await changeStatus("archived")
                    environment.navigation.projectRoute = nil
                }
            }
        } message: {
            Text("Its task cards stay on their boards.")
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
                    Button("Create board") {
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
                        Button("Delete board", role: .destructive) {
                            showsDeleteConfirmation = true
                        }
                        .disabled(isWorking)
                    } footer: {
                        Text("This removes the board with its columns and cards.")
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
                Button("Delete board and cards", role: .destructive) {
                    Task {
                        isWorking = true
                        _ = await environment.store.deleteActiveBoard()
                        renameTitle = selectedBoard?.title ?? ""
                        isWorking = false
                    }
                }
            } message: {
                Text("You cannot undo this.")
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
                                Button("Rename") {
                                    renameColumn = column
                                    renameText = column.name
                                }
                                Button("Delete", role: .destructive) {
                                    deleteColumn = column
                                }
                            } label: {
                                Image(systemName: "ellipsis.circle")
                            }
                            .accessibilityLabel("Actions for \(column.name)")
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
                    Text("Drag the columns into the order the board and the list use.")
                }

                Section("Add column") {
                    TextField("Column name", text: $newColumnName)
                    Button("Add column") {
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
                Button("Delete column and cards", role: .destructive) {
                    guard let column = deleteColumn else { return }
                    deleteColumn = nil
                    Task { _ = await environment.store.deleteColumn(column) }
                }
            } message: {
                Text("This deletes every card in this column.")
            }
        }
    }
}
