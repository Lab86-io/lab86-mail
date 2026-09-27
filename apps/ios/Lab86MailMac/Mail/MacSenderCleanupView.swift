import Observation
import SwiftUI

// Sender cleanup on the Mac (round 2, FEATURES item 13). The phone's version
// is a selection list with Block in the bottom bar, which has no Mac place:
// a sheet toolbar has no bottom bar. Desktop products that act on many rows
// (Mobbin: Calendly contacts, Customer.io deliveries) put a checkbox on each
// row and the batch action with the count in a footer. The Mac sheet does the
// same: a checkbox and Unsubscribe on each sender, then Select all, the
// count, Done, and Block in the footer, the way a Mac sheet ends.

/// The state and the batch block of the Mac sheet. The calls are the same
/// tools the phone uses; the view applies the outcome to the shell.
@MainActor
@Observable
final class MacSenderCleanupModel {
    struct BlockOutcome: Equatable {
        let blocked: [BlockSenderResult]
        // Senders the server did not block.
        let failed: [String]
    }

    private let client: SenderToolsClient
    private let limit: Int
    private(set) var rows: [SenderCleanupRow] = []
    private(set) var scanned = 0
    private(set) var didLoad = false
    private(set) var loadError: String?
    private(set) var isBlocking = false
    var selection: Set<String> = []

    init(client: SenderToolsClient, limit: Int = 40) {
        self.client = client
        self.limit = limit
    }

    var allSelected: Bool {
        !rows.isEmpty && rows.allSatisfy { selection.contains($0.sender) }
    }

    var selectAllLabel: String { allSelected ? "Select none" : "Select all" }

    var blockLabel: String {
        if isBlocking { return "Blocking…" }
        return selection.count > 1 ? "Block \(selection.count) senders" : "Block sender"
    }

    var canBlock: Bool { !selection.isEmpty && !isBlocking }

    /// "3 of 12 selected", or nil while nothing is selected.
    var selectionLine: String? {
        guard !selection.isEmpty else { return nil }
        return "\(selection.count) of \(rows.count) selected"
    }

    /// The sentence over the list. It names how much mail was read.
    var headerLine: String {
        let base = "Block sends their mail to Noise and clears it from the inbox, with Undo in Activity. An unsubscribe cannot be undone."
        guard scanned > 0 else { return base }
        return "From your \(scanned) most recent threads. \(base)"
    }

    func isSelected(_ row: SenderCleanupRow) -> Bool { selection.contains(row.sender) }

    func setSelected(_ row: SenderCleanupRow, _ selected: Bool) {
        if selected { selection.insert(row.sender) } else { selection.remove(row.sender) }
    }

    func toggleAll() {
        selection = allSelected ? [] : Set(rows.map(\.sender))
    }

    func load() async {
        do {
            let result = try await client.cleanup(limit: limit)
            rows = result.senders
            scanned = result.scanned
            // A sender that left the list cannot stay selected.
            selection = selection.intersection(Set(rows.map(\.sender)))
            loadError = nil
        } catch {
            loadError = "The sender list could not load. Try again."
        }
        didLoad = true
    }

    /// Blocks every selected sender under one batch id, so Activity reads
    /// the batch as one change and one Undo takes all of it back. A sender
    /// that failed stays selected, so a retry is one click.
    func blockSelected() async -> BlockOutcome? {
        let targets = rows.filter { selection.contains($0.sender) }
        guard !targets.isEmpty, !isBlocking else { return nil }
        isBlocking = true
        defer { isBlocking = false }
        let batchID = SenderToolsClient.newBatchID()
        var blocked: [BlockSenderResult] = []
        var failed: [String] = []
        for row in targets {
            do {
                blocked.append(try await client.block(sender: row.sender, batchID: batchID))
            } catch {
                failed.append(row.sender)
            }
        }
        selection = Set(failed)
        return BlockOutcome(blocked: blocked, failed: failed)
    }

    /// The footer line after a batch: what was blocked, then what did not
    /// work. `isError` is true when any part failed.
    static func outcomeLine(_ outcome: BlockOutcome) -> (text: String, isError: Bool) {
        var parts: [String] = []
        if !outcome.blocked.isEmpty {
            parts.append(BlockSenderResult.summary(outcome.blocked) + ".")
        }
        let unarchived = outcome.blocked.reduce(0) { $0 + $1.failed }
        if unarchived > 0 {
            parts.append("\(unarchived) of their threads could not be archived.")
        }
        switch outcome.failed.count {
        case 0: break
        case 1: parts.append("Could not block \(outcome.failed[0]). Try again.")
        default: parts.append("Could not block \(outcome.failed.count) senders. Try again.")
        }
        return (parts.joined(separator: " "), unarchived > 0 || !outcome.failed.isEmpty)
    }

    /// "news@acme.com · 14 threads, 12 unread · last Sep 3".
    static func detailLine(_ row: SenderCleanupRow) -> String {
        var parts = [row.sender]
        let threads = "\(row.threads) \(row.threads == 1 ? "thread" : "threads")"
        parts.append(row.unread > 0 ? "\(threads), \(row.unread) unread" : threads)
        if let lastDate = row.lastDate {
            parts.append("last \(lastDate.formatted(.dateTime.month(.abbreviated).day()))")
        }
        return parts.joined(separator: " · ")
    }
}

struct MacSenderCleanupView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State private var model: MacSenderCleanupModel?
    @State private var unsubscribe: UnsubscribeFlowModel?
    @State private var outcomeLine: String?
    @State private var outcomeIsError = false
    // The undo notice of the last batch. The footer offers its Undo while
    // the shell still shows the notice.
    @State private var blockNoticeID: String?

    /// A model passed in is used as is; otherwise the sheet makes one with
    /// the shell's tools when it appears.
    init(model: MacSenderCleanupModel? = nil) {
        _model = State(initialValue: model)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            content
            Divider()
            footer
        }
        .macFormSheet(.workList)
        .task {
            if model == nil {
                model = MacSenderCleanupModel(client: SenderToolsClient(tools: environment.tools))
            }
            await model?.load()
        }
        .modifier(OptionalUnsubscribeFlow(model: unsubscribe) { Task { await model?.load() } })
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Sender cleanup")
                .font(.title3.weight(.semibold))
            if let line = model?.headerLine {
                Text(line)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 18)
        .padding(.bottom, 12)
    }

    @ViewBuilder private var content: some View {
        if let model, model.didLoad {
            if let loadError = model.loadError, model.rows.isEmpty {
                ContentUnavailableView {
                    Text("The sender list could not load")
                } description: {
                    Text(loadError)
                } actions: {
                    Button("Try again") { Task { await model.load() } }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.rows.isEmpty {
                ContentUnavailableView(
                    "No sender stands out",
                    systemImage: "tray",
                    description: Text("Recent mail you do not read will show here.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(model.rows) { row in
                        senderRow(row, model: model)
                    }
                }
                .listStyle(.inset)
            }
        } else {
            ProgressView("Reading your recent mail…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func senderRow(_ row: SenderCleanupRow, model: MacSenderCleanupModel) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            // The label is the sender, so a click on the name also selects.
            Toggle(isOn: Binding(
                get: { model.isSelected(row) },
                set: { selected in
                    outcomeLine = nil
                    model.setSelected(row, selected)
                }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.name)
                        .fontWeight(.medium)
                        .lineLimit(1)
                    Text(MacSenderCleanupModel.detailLine(row))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    if !row.reason.isEmpty {
                        Text(row.reason)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .lineLimit(2)
                    }
                }
            }
            .toggleStyle(.checkbox)
            .disabled(model.isBlocking)
            .accessibilityLabel(row.name)
            .accessibilityHint("Selects this sender for Block")
            Spacer(minLength: 8)
            if let target = row.unsubscribeTarget {
                Button("Unsubscribe") {
                    let flow = UnsubscribeFlowModel(client: SenderToolsClient(tools: environment.tools))
                    unsubscribe = flow
                    Task { await flow.begin(target) }
                }
                .controlSize(.small)
                .help("Asks \(row.name) to take you off the list. This cannot be undone.")
            }
        }
        .padding(.vertical, 4)
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Button(model?.selectAllLabel ?? "Select all") {
                outcomeLine = nil
                model?.toggleAll()
            }
            .disabled((model?.rows.isEmpty ?? true) || model?.isBlocking == true)
            statusLine
            Spacer(minLength: 8)
            Button("Done") { dismiss() }
                .keyboardShortcut(.cancelAction)
            // Block is not the default button: Return never blocks.
            Button(model?.blockLabel ?? "Block sender") { Task { await blockSelected() } }
                .disabled(!(model?.canBlock ?? false))
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    @ViewBuilder private var statusLine: some View {
        if let outcomeLine {
            HStack(spacing: 8) {
                Text(outcomeLine)
                    .foregroundStyle(outcomeIsError ? Color.red : Color.secondary)
                    .lineLimit(2)
                if let blockNoticeID, environment.store.undoNotice?.id == blockNoticeID {
                    Button("Undo") { Task { await undoBlock() } }
                        .buttonStyle(.link)
                        .help("Undo (Command-Z)")
                }
            }
            .font(.callout)
        } else if let line = model?.selectionLine {
            Text(line)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private func blockSelected() async {
        guard let model, let outcome = await model.blockSelected() else { return }
        let line = MacSenderCleanupModel.outcomeLine(outcome)
        outcomeLine = line.text
        outcomeIsError = line.isError
        // The shell's undo notice, so Command-Z and the toast take it back.
        environment.store.noteMailOperations(
            outcome.blocked.map(\.operationID),
            summary: BlockSenderResult.summary(outcome.blocked)
        )
        blockNoticeID = outcome.blocked.isEmpty ? nil : environment.store.undoNotice?.id
        PlatformAccessibility.announce(line.text)
        await environment.store.refreshMail()
        await model.load()
    }

    private func undoBlock() async {
        await environment.store.undoLatestOperation()
        blockNoticeID = nil
        outcomeLine = nil
        await model?.load()
    }
}
