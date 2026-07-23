import SwiftUI
import UniformTypeIdentifiers

// Full card detail as a sheet — the phone counterpart of the desktop
// CardPanel. View-first: everything reads immediately and edits in place;
// Save writes once through tasks_update_card.
struct TaskDetailView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    let task: TaskSummary
    @State private var loadedTask: TaskSummary

    @State private var title: String
    @State private var details: String
    @State private var priority: String
    @State private var hasDue: Bool
    @State private var due: Date
    @State private var completed: Bool
    @State private var column: String
    @State private var commentDraft = ""
    @State private var commentPosted = false
    @State private var labelText: String
    @State private var assigneeText: String
    @State private var hasWeight: Bool
    @State private var weight: Int
    @State private var linkName = ""
    @State private var linkURL = ""
    @State private var showsFileImporter = false
    @State private var isAttaching = false
    @State private var isSaving = false
    @State private var showsDeleteConfirmation = false
    @State private var showsDiscardConfirmation = false

    init(task: TaskSummary) {
        self.task = task
        _loadedTask = State(initialValue: task)
        _title = State(initialValue: task.title)
        _details = State(initialValue: task.details ?? "")
        _priority = State(initialValue: task.priority ?? "")
        _hasDue = State(initialValue: task.due != nil)
        _due = State(initialValue: task.due ?? Calendar.current.date(
            bySettingHour: 17, minute: 0, second: 0, of: .now
        ) ?? .now)
        _completed = State(initialValue: task.completed)
        _column = State(initialValue: task.column)
        _labelText = State(initialValue: task.labels.joined(separator: ", "))
        _assigneeText = State(initialValue: task.assignees.joined(separator: ", "))
        _hasWeight = State(initialValue: task.weight != nil)
        _weight = State(initialValue: task.weight ?? 1)
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

                Section("Collaboration") {
                    TextField("Labels, comma separated", text: $labelText)
                        .textInputAutocapitalization(.never)
                    TextField("Assignee emails, comma separated", text: $assigneeText)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.emailAddress)
                    Toggle("Effort estimate", isOn: $hasWeight.animation())
                    if hasWeight {
                        Stepper("Weight: \(weight)", value: $weight, in: 0...100)
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

                if !loadedTask.comments.isEmpty {
                    Section("Comments") {
                        ForEach(loadedTask.comments) { comment in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(comment.author)
                                        .font(.caption.weight(.semibold))
                                    Spacer()
                                    if let createdAt = comment.createdAt {
                                        Text(createdAt, style: .relative)
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Text(comment.body)
                            }
                        }
                    }
                }

                if !loadedTask.activity.isEmpty {
                    Section("Activity") {
                        ForEach(loadedTask.activity.reversed()) { entry in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(entry.kind.replacingOccurrences(of: "_", with: " ").capitalized)
                                if let detail = entry.detail {
                                    Text(detail)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

                Section("Attachments & links") {
                    ForEach(loadedTask.attachments) { attachment in
                        attachmentRow(attachment)
                    }
                    TextField("Link name (optional)", text: $linkName)
                    TextField("https://…", text: $linkURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    Button("Attach Link", systemImage: "link") {
                        Task {
                            isAttaching = true
                            if await environment.store.attachLink(
                                to: loadedTask,
                                name: optionalLinkName,
                                url: linkURL
                            ) {
                                linkName = ""
                                linkURL = ""
                                await reload()
                            }
                            isAttaching = false
                        }
                    }
                    .disabled(isAttaching || linkURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Attach File", systemImage: "doc.badge.plus") {
                        showsFileImporter = true
                    }
                    .disabled(isAttaching)
                }

                if let source = loadedTask.source {
                    Section("Source") {
                        Button(source.title ?? "Open source", systemImage: source.kind == "email" ? "envelope" : "calendar") {
                            openSource(source)
                        }
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
                    Button("Cancel") {
                        if isDirty {
                            showsDiscardConfirmation = true
                        } else {
                            dismiss()
                        }
                    }
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
            .confirmationDialog(
                "Discard unsaved card changes?",
                isPresented: $showsDiscardConfirmation,
                titleVisibility: .visible
            ) {
                Button("Discard Changes", role: .destructive) { dismiss() }
                Button("Keep Editing", role: .cancel) {}
            }
            .interactiveDismissDisabled(isDirty)
            .task { await reload() }
            .fileImporter(
                isPresented: $showsFileImporter,
                allowedContentTypes: [.item],
                allowsMultipleSelection: false
            ) { result in
                guard case .success(let urls) = result, let url = urls.first else { return }
                Task { await attachFile(url) }
            }
        }
    }

    private func formattedFileSize(_ size: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)
    }

    private var optionalLinkName: String? {
        let value = linkName.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    @ViewBuilder
    private func attachmentRow(_ attachment: TaskAttachmentSummary) -> some View {
        if let url = attachment.url {
            Link(destination: url) {
                HStack(spacing: 10) {
                    Image(systemName: "paperclip")
                    VStack(alignment: .leading) {
                        Text(attachment.name)
                        if let size = attachment.size {
                            Text(formattedFileSize(size))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        } else {
            Label(attachment.name, systemImage: "paperclip")
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
            completed: completed,
            labels: csvValues(labelText),
            assignees: csvValues(assigneeText),
            weight: .some(hasWeight ? weight : nil)
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
            await reload()
        }
    }

    private var isDirty: Bool {
        title != loadedTask.title
            || details != (loadedTask.details ?? "")
            || priority != (loadedTask.priority ?? "")
            || hasDue != (loadedTask.due != nil)
            || (hasDue && due != loadedTask.due)
            || completed != loadedTask.completed
            || column != loadedTask.column
            || csvValues(labelText) != loadedTask.labels
            || csvValues(assigneeText) != loadedTask.assignees
            || (hasWeight ? weight : nil) != loadedTask.weight
    }

    private func csvValues(_ value: String) -> [String] {
        value.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private func reload() async {
        loadedTask = await environment.store.loadTask(loadedTask)
        title = loadedTask.title
        details = loadedTask.details ?? ""
        priority = loadedTask.priority ?? ""
        hasDue = loadedTask.due != nil
        if let loadedDue = loadedTask.due { due = loadedDue }
        completed = loadedTask.completed
        column = loadedTask.column
        labelText = loadedTask.labels.joined(separator: ", ")
        assigneeText = loadedTask.assignees.joined(separator: ", ")
        hasWeight = loadedTask.weight != nil
        weight = loadedTask.weight ?? 1
    }

    private func attachFile(_ url: URL) async {
        isAttaching = true
        defer { isAttaching = false }
        let secured = url.startAccessingSecurityScopedResource()
        defer { if secured { url.stopAccessingSecurityScopedResource() } }
        do {
            let values = try url.resourceValues(forKeys: [.nameKey, .contentTypeKey])
            let attachment = ComposeAttachment(
                filename: values.name ?? url.lastPathComponent,
                contentType: values.contentType?.preferredMIMEType ?? "application/octet-stream",
                data: try Data(contentsOf: url, options: [.mappedIfSafe])
            )
            if await environment.store.attachFile(to: loadedTask, attachment: attachment) {
                await reload()
            }
        } catch {
            environment.store.taskError = error.localizedDescription
        }
    }

    private func openSource(_ source: TaskSourceSummary) {
        if source.kind == "email", let accountID = source.accountID, let threadID = source.threadID {
            dismiss()
            environment.navigation.openThread(accountID: accountID, threadID: threadID)
        } else if source.kind == "calendar",
                  let accountID = source.accountID,
                  let eventID = source.eventID {
            dismiss()
            environment.navigation.openEvent(
                accountID: accountID,
                eventID: eventID,
                calendarID: source.calendarID,
                preview: nil
            )
        } else if let url = source.url {
            openURL(url)
        }
    }
}
