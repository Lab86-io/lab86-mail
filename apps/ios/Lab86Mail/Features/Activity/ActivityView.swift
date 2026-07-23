import SwiftUI

struct ActivityView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State private var checkinText = ""
    @State private var completedCandidateIDs: Set<String> = []
    @State private var isSavingCheckin = false
    @State private var checkinError: String?
    @State private var questionForReview: PendingWorkQuestionSummary?
    @State private var archivedRaw = ""
    @State private var readRaw = ""
    @State private var showsArchived = false

    private var archivedIDs: Set<String> {
        Set(archivedRaw.split(separator: "\n").map(String.init))
    }

    private var readIDs: Set<String> {
        Set(readRaw.split(separator: "\n").map(String.init))
    }

    private var visibleApprovals: [ApprovalSummary] {
        environment.store.approvals.filter {
            archivedIDs.contains("approval:\($0.id)") == showsArchived
        }
    }

    private var visibleSuggestions: [SuggestionSummary] {
        environment.store.suggestions.filter {
            archivedIDs.contains("suggestion:\($0.id)") == showsArchived
        }
    }

    private var visibleQuestions: [PendingWorkQuestionSummary] {
        environment.store.pendingQuestions.filter {
            archivedIDs.contains("question:\($0.id)") == showsArchived
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if visibleApprovals.isEmpty
                    && visibleSuggestions.isEmpty
                    && visibleQuestions.isEmpty
                    && (environment.store.checkin == nil || showsArchived) {
                    ContentUnavailableView(
                        "Nothing needs your approval",
                        systemImage: "checkmark.shield",
                        description: Text("Suggestions, check-ins, and actions that need a decision will appear here.")
                    )
                } else {
                    if !showsArchived, let checkin = environment.store.checkin {
                        Section("What did you actually get done today?") {
                            Text("Tell Albatross what moved. Suggestions are evidence—you decide what is complete.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            TextEditor(text: $checkinText)
                                .frame(minHeight: 110)
                                .accessibilityLabel("What did you get done today")
                            if !checkin.candidates.isEmpty {
                                ForEach(checkin.candidates.prefix(12)) { candidate in
                                    Button {
                                        toggle(candidate.id)
                                    } label: {
                                        HStack {
                                            Image(
                                                systemName: completedCandidateIDs.contains(candidate.id)
                                                    ? "checkmark.circle.fill" : "circle"
                                            )
                                            .foregroundStyle(
                                                completedCandidateIDs.contains(candidate.id) ? Color.accentColor : .secondary
                                            )
                                            VStack(alignment: .leading) {
                                                Text(candidate.title).foregroundStyle(.primary)
                                                Text(candidate.kind.capitalized)
                                                    .font(.caption)
                                                    .foregroundStyle(.secondary)
                                            }
                                        }
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityValue(
                                        completedCandidateIDs.contains(candidate.id) ? "Marked complete" : "Not complete"
                                    )
                                }
                            }
                            if let checkinError { Text(checkinError).font(.footnote).foregroundStyle(.red) }
                            Button {
                                Task { await saveCheckin(checkin) }
                            } label: {
                                if isSavingCheckin { ProgressView() } else { Text("Save Check-In") }
                            }
                            .disabled(
                                isSavingCheckin || (
                                    checkinText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                        && completedCandidateIDs.isEmpty
                                )
                            )
                        }
                    }
                    if !visibleQuestions.isEmpty {
                        Section("Questions") {
                            ForEach(visibleQuestions) { item in
                                VStack(alignment: .leading, spacing: 8) {
                                    activityTitle(item.question.prompt, id: "question:\(item.id)")
                                    Text(item.workTitle)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    HStack {
                                        Button(showsArchived ? "Restore" : "Archive") {
                                            setArchived("question:\(item.id)", archived: !showsArchived)
                                        }
                                        .buttonStyle(.bordered)
                                        if let workID = item.workID {
                                            Button("Open Work") {
                                                dismiss()
                                                environment.navigation.openWork(id: workID, title: item.workTitle)
                                            }
                                            .buttonStyle(.bordered)
                                        }
                                        Spacer()
                                        Button("Answer") { questionForReview = item }
                                            .buttonStyle(.borderedProminent)
                                    }
                                }
                                .contextMenu {
                                    readButton("question:\(item.id)")
                                }
                            }
                        }
                    }
                    if !visibleSuggestions.isEmpty {
                        Section("Found in your mail") {
                            ForEach(visibleSuggestions) { suggestion in
                                VStack(alignment: .leading, spacing: 10) {
                                    activityTitle(suggestion.title, id: "suggestion:\(suggestion.id)")
                                    Text(suggestion.sender)
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                    if let start = suggestion.start {
                                        Text(start.formatted(date: .abbreviated, time: .shortened))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    HStack {
                                        Button(showsArchived ? "Restore" : "Archive") {
                                            setArchived("suggestion:\(suggestion.id)", archived: !showsArchived)
                                        }
                                        .buttonStyle(.bordered)
                                        Button("Dismiss", role: .destructive) {
                                            Task { await environment.store.actOnSuggestion(id: suggestion.id, action: "dismiss") }
                                        }
                                        .buttonStyle(.bordered)
                                        Spacer()
                                        Button("Add to Calendar") {
                                            Task { await environment.store.actOnSuggestion(id: suggestion.id, action: "accept") }
                                        }
                                        .buttonStyle(.borderedProminent)
                                    }
                                }
                                .padding(.vertical, 5)
                                .contextMenu {
                                    readButton("suggestion:\(suggestion.id)")
                                }
                            }
                        }
                    }
                    if !visibleApprovals.isEmpty {
                        Section("Waiting for you") {
                            ForEach(visibleApprovals) { approval in
                            VStack(alignment: .leading, spacing: 10) {
                                activityTitle(approval.title, id: "approval:\(approval.id)")
                                Text(approval.detail).font(.subheadline).foregroundStyle(.secondary)
                                HStack {
                                    Button(showsArchived ? "Restore" : "Archive") {
                                        setArchived("approval:\(approval.id)", archived: !showsArchived)
                                    }
                                    .buttonStyle(.bordered)
                                    Button("Dismiss", role: .destructive) {
                                        Task { await environment.store.reject(approval) }
                                    }
                                    .buttonStyle(.bordered)
                                    Spacer()
                                    Button("Approve") {
                                        Task { await environment.store.approve(approval) }
                                    }
                                    .buttonStyle(.borderedProminent)
                                }
                            }
                            .padding(.vertical, 5)
                            .contextMenu {
                                readButton("approval:\(approval.id)")
                            }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Activity")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Toggle("Show archived only", isOn: $showsArchived)
                        Button("Mark visible read") { markVisibleRead() }
                    } label: {
                        Label("Activity options", systemImage: "ellipsis.circle")
                    }
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .task {
                loadLocalState()
                await environment.store.refreshToday()
            }
            .refreshable { await environment.store.refreshToday() }
            .sheet(item: $questionForReview) { item in
                WorkQuestionReviewSheet(question: item.question, workTitle: item.workTitle) {
                    await environment.store.refreshToday()
                }
            }
        }
    }

    private func setArchived(_ id: String, archived: Bool) {
        var ids = archivedIDs
        if archived { ids.insert(id) } else { ids.remove(id) }
        archivedRaw = ids.sorted().joined(separator: "\n")
        persistLocalState()
    }

    private func setRead(_ id: String, read: Bool) {
        var ids = readIDs
        if read { ids.insert(id) } else { ids.remove(id) }
        readRaw = ids.sorted().joined(separator: "\n")
        persistLocalState()
    }

    private func activityTitle(_ title: String, id: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            if !readIDs.contains(id) {
                Circle()
                    .fill(environment.theme.accentColor)
                    .frame(width: 7, height: 7)
                    .accessibilityLabel("Unread")
            }
            Text(title).font(.headline)
        }
    }

    @ViewBuilder
    private func readButton(_ id: String) -> some View {
        Button(readIDs.contains(id) ? "Mark Unread" : "Mark Read") {
            setRead(id, read: !readIDs.contains(id))
        }
    }

    private func markVisibleRead() {
        var ids = readIDs
        ids.formUnion(visibleApprovals.map { "approval:\($0.id)" })
        ids.formUnion(visibleSuggestions.map { "suggestion:\($0.id)" })
        ids.formUnion(visibleQuestions.map { "question:\($0.id)" })
        readRaw = ids.sorted().joined(separator: "\n")
        persistLocalState()
    }

    private var localStatePrefix: String {
        let owner = environment.sessionStore.ownerID ?? "signed-out"
        return "albatross.activity.\(owner)"
    }

    private func loadLocalState() {
        archivedRaw = UserDefaults.standard.string(forKey: "\(localStatePrefix).archived") ?? ""
        readRaw = UserDefaults.standard.string(forKey: "\(localStatePrefix).read") ?? ""
    }

    private func persistLocalState() {
        UserDefaults.standard.set(archivedRaw, forKey: "\(localStatePrefix).archived")
        UserDefaults.standard.set(readRaw, forKey: "\(localStatePrefix).read")
    }

    private func toggle(_ id: String) {
        if completedCandidateIDs.contains(id) { completedCandidateIDs.remove(id) }
        else { completedCandidateIDs.insert(id) }
    }

    private func saveCheckin(_ checkin: CheckinSummary) async {
        isSavingCheckin = true
        defer { isSavingCheckin = false }
        do {
            try await environment.store.answerCheckin(
                responseText: checkinText.trimmingCharacters(in: .whitespacesAndNewlines),
                completed: checkin.candidates.filter { completedCandidateIDs.contains($0.id) }
            )
            checkinText = ""
            completedCandidateIDs = []
            checkinError = nil
        } catch {
            checkinError = error.localizedDescription
        }
    }
}
