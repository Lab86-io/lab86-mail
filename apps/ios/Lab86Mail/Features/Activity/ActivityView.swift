import SwiftUI

struct ActivityView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State private var checkinText = ""
    @State private var completedCandidateIDs: Set<String> = []
    @State private var isSavingCheckin = false
    @State private var checkinError: String?

    var body: some View {
        NavigationStack {
            List {
                if environment.store.approvals.isEmpty && environment.store.suggestions.isEmpty && environment.store.checkin == nil {
                    ContentUnavailableView(
                        "Nothing needs your approval",
                        systemImage: "checkmark.shield",
                        description: Text("Suggestions, check-ins, and actions that need a decision will appear here.")
                    )
                } else {
                    if let checkin = environment.store.checkin {
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
                    if !environment.store.suggestions.isEmpty {
                        Section("Found in your mail") {
                            ForEach(environment.store.suggestions) { suggestion in
                                VStack(alignment: .leading, spacing: 10) {
                                    Label(suggestion.title, systemImage: "calendar.badge.plus")
                                        .font(.headline)
                                    Text(suggestion.sender)
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                    if let start = suggestion.start {
                                        Text(start.formatted(date: .abbreviated, time: .shortened))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    HStack {
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
                            }
                        }
                    }
                    if !environment.store.approvals.isEmpty {
                        Section("Waiting for you") {
                            ForEach(environment.store.approvals) { approval in
                            VStack(alignment: .leading, spacing: 10) {
                                Text(approval.title).font(.headline)
                                Text(approval.detail).font(.subheadline).foregroundStyle(.secondary)
                                HStack {
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
                            }
                        }
                    }
                }
            }
            .navigationTitle("Activity")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .task { await environment.store.refreshToday() }
            .refreshable { await environment.store.refreshToday() }
        }
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
