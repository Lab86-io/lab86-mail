import Observation
import SwiftUI

/// The trust record in Activity (round 2, FEATURES item 10): what Albatross
/// and the user changed, why, and what can still be taken back. Undo runs
/// the same inverse the web runs, and the row reads "Undone" only after the
/// server confirms it.
@MainActor
@Observable
final class RecentChangesModel {
    private let client: OperationsClient
    private(set) var rows: [RecentOperation] = []
    private(set) var didLoad = false
    private(set) var isLoading = false
    private(set) var undoingID: String?
    var errorMessage: String?

    init(client: OperationsClient) {
        self.client = client
    }

    func load(limit: Int = 50) async {
        isLoading = true
        defer { isLoading = false }
        do {
            rows = try await client.recent(limit: limit)
            didLoad = true
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Runs the Undo, then reads the log again so the row shows its new state.
    func undo(_ row: RecentOperation) async -> Bool {
        guard row.undoable, undoingID == nil else { return false }
        undoingID = row.id
        defer { undoingID = nil }
        do {
            try await client.undo(row.id)
            errorMessage = nil
            await load()
            return true
        } catch {
            errorMessage = error.localizedDescription.nilIfBlank ?? "This change can no longer be undone."
            return false
        }
    }
}

/// The latest changes inside the Activity sheet, with a link to all of them.
struct RecentChangesSection: View {
    @Environment(AppEnvironment.self) private var environment
    let model: RecentChangesModel
    static let inlineLimit = 6

    var body: some View {
        Section {
            if model.rows.isEmpty {
                Text(model.didLoad
                     ? "When Albatross sends, books, or changes something for you, it is written down here first."
                     : "Loading recent changes…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(model.rows.prefix(Self.inlineLimit)) { row in
                    RecentOperationRow(row: row, model: model) { await afterUndo(row) }
                }
                if model.rows.count > Self.inlineLimit {
                    NavigationLink("See all changes") {
                        RecentChangesView(model: model)
                    }
                }
            }
            if let error = model.errorMessage {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
        } header: {
            Text("Recent changes")
        } footer: {
            Text("Everything Albatross and you have changed, and what can still be taken back.")
        }
    }

    private func afterUndo(_ row: RecentOperation) async {
        if row.surface == "mail" { await environment.store.refreshMail() }
    }
}

/// Every change in the log, newest first.
struct RecentChangesView: View {
    @Environment(AppEnvironment.self) private var environment
    let model: RecentChangesModel

    var body: some View {
        List {
            if let error = model.errorMessage {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
            ForEach(model.rows) { row in
                RecentOperationRow(row: row, model: model) {
                    if row.surface == "mail" { await environment.store.refreshMail() }
                }
            }
        }
        .overlay {
            if model.rows.isEmpty, model.didLoad {
                ContentUnavailableView(
                    "Nothing has happened yet",
                    systemImage: "clock",
                    description: Text("When Albatross sends, books, or changes something for you, it is written down here first.")
                )
            }
        }
        .navigationTitle("Changes")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load(limit: 100) }
        .task { await model.load(limit: 100) }
    }
}

struct RecentOperationRow: View {
    let row: RecentOperation
    let model: RecentChangesModel
    let onUndone: () async -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(row.summary)
                    .font(.subheadline.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
                if let reason = row.reason {
                    Text(reason)
                        .font(.footnote)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(row.metaLine())
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let note = row.statusNote {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(row.status == .undoFailed ? Color.red : Color.secondary)
                }
            }
            Spacer(minLength: 8)
            if row.undoable {
                Button(model.undoingID == row.id ? "Undoing…" : "Undo") {
                    Task {
                        if await model.undo(row) { await onUndone() }
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(model.undoingID != nil)
            }
        }
        .padding(.vertical, 2)
    }
}
