import Observation
import SwiftUI

/// The unsubscribe flow (round 2, FEATURES item 13). It reads how the sender
/// takes requests, says where the request goes, and runs only after the user
/// confirms. A sender with no unsubscribe option offers Block instead.
@MainActor
@Observable
final class UnsubscribeFlowModel {
    enum Phase: Equatable {
        case idle
        case loading(SenderTarget)
        case confirm(SenderTarget, UnsubscribeOptions, UnsubscribeConfirmCopy)
        // The user confirmed; the request is on its way.
        case running(SenderTarget, UnsubscribeOptions, UnsubscribeConfirmCopy)
        case failed(String)
    }

    enum Outcome: Equatable {
        case unsubscribed(UnsubscribeResult, SenderTarget)
        case openLink(URL?)
        case blocked(BlockSenderResult)
    }

    private let client: SenderToolsClient
    private(set) var phase: Phase = .idle
    private(set) var isRunning = false

    init(client: SenderToolsClient) {
        self.client = client
    }

    func begin(_ target: SenderTarget) async {
        phase = .loading(target)
        do {
            let options = try await client.unsubscribeOptions(target)
            // A newer request may have replaced this one.
            guard case .loading(let current) = phase, current == target else { return }
            phase = .confirm(target, options, UnsubscribeConfirmCopy.make(options, mailbox: target.mailbox))
        } catch {
            phase = .failed(error.localizedDescription.nilIfBlank ?? "Could not read the unsubscribe details for this sender.")
        }
    }

    /// Takes the user's confirmation at once, so the alert can close before
    /// the request runs. False when nothing waits for a confirmation.
    @discardableResult
    func accept() -> Bool {
        guard case .confirm(let target, let options, let copy) = phase else { return false }
        phase = .running(target, options, copy)
        return true
    }

    /// Runs the confirmed choice. Nil when nothing was confirmed.
    func confirm() async throws -> Outcome? {
        accept()
        guard case .running(let target, let options, let copy) = phase else { return nil }
        isRunning = true
        defer {
            isRunning = false
            phase = .idle
        }
        switch copy.action {
        case .unsubscribe:
            return .unsubscribed(try await client.unsubscribe(target, method: options.method), target)
        case .openLink:
            return .openLink(options.url)
        case .block:
            return .blocked(try await client.block(target))
        }
    }

    func cancel() { phase = .idle }
}

/// Presents the unsubscribe confirmation, then the result, and applies a
/// block through the store so it offers Undo.
struct UnsubscribeFlowModifier: ViewModifier {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    let model: UnsubscribeFlowModel
    let onDone: () -> Void

    @State private var result: UnsubscribeResultNotice?
    @State private var failure: String?

    func body(content: Content) -> some View {
        content
            .alert(
                confirmTitle,
                isPresented: Binding(
                    get: { if case .confirm = model.phase { return true } else { return false } },
                    // Closing the alert without a choice cancels; a choice
                    // has already moved the flow on.
                    set: { if !$0, case .confirm = model.phase { model.cancel() } }
                ),
                presenting: confirmCopy
            ) { copy in
                Button("Cancel", role: .cancel) { model.cancel() }
                Button(copy.confirmLabel, role: copy.action == .unsubscribe ? .destructive : nil) {
                    if model.accept() { Task { await run() } }
                }
            } message: { copy in
                Text(copy.message)
            }
            .alert(
                result?.title ?? "",
                isPresented: Binding(get: { result != nil }, set: { if !$0 { result = nil } }),
                presenting: result
            ) { notice in
                Button("Block sender") {
                    Task { await SenderBlocking.block(notice.target, environment: environment) }
                }
                Button("OK", role: .cancel) {}
            } message: { _ in
                Text("Mail already sent can still arrive for a few days.")
            }
            .alert(
                "The unsubscribe did not go through",
                isPresented: Binding(
                    get: {
                        if failure != nil { return true }
                        if case .failed = model.phase { return true }
                        return false
                    },
                    set: {
                        if !$0 {
                            failure = nil
                            if case .failed = model.phase { model.cancel() }
                        }
                    }
                )
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                if case .failed(let message) = model.phase {
                    Text(message)
                } else {
                    Text(failure ?? "Try again.")
                }
            }
    }

    private var confirmCopy: UnsubscribeConfirmCopy? {
        if case .confirm(_, _, let copy) = model.phase { return copy }
        return nil
    }

    private var confirmTitle: String { confirmCopy?.title ?? "Unsubscribe" }

    private func run() async {
        do {
            switch try await model.confirm() {
            case .unsubscribed(let outcome, let target):
                result = UnsubscribeResultNotice(title: outcome.message, target: target)
                onDone()
            case .openLink(let url):
                if let url { openURL(url) }
            case .blocked(let outcome):
                SenderBlocking.noteBlocked([outcome], environment: environment)
                await environment.store.refreshMail()
                onDone()
            case nil:
                break
            }
        } catch {
            failure = error.localizedDescription
        }
    }
}

struct UnsubscribeResultNotice: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let target: SenderTarget
}

extension View {
    func unsubscribeFlow(_ model: UnsubscribeFlowModel, onDone: @escaping () -> Void = {}) -> some View {
        modifier(UnsubscribeFlowModifier(model: model, onDone: onDone))
    }
}

/// Block sender with Undo, shared by the reader, the unsubscribe flow, and
/// sender cleanup.
@MainActor
enum SenderBlocking {
    @discardableResult
    static func block(_ target: SenderTarget, environment: AppEnvironment) async -> BlockSenderResult? {
        do {
            let result = try await SenderToolsClient(tools: environment.tools).block(target)
            noteBlocked([result], environment: environment)
            await environment.store.refreshMail()
            return result
        } catch {
            environment.store.mailErrorMessage = error.localizedDescription
            return nil
        }
    }

    static func noteBlocked(_ results: [BlockSenderResult], environment: AppEnvironment) {
        guard !results.isEmpty else { return }
        environment.store.noteMailOperations(results.map(\.operationID), summary: BlockSenderResult.summary(results))
        let failed = results.reduce(0) { $0 + $1.failed }
        if failed > 0 {
            environment.store.mailErrorMessage = "\(failed) of their threads could not be archived."
        }
    }
}

/// Sender cleanup: the senders whose recent mail goes unread or lands in
/// Noise, with Unsubscribe on each row and a batch Block. Research: iOS
/// mail and GitHub multi-select lists (Mobbin) — leading selection circles,
/// Select all, and one text action in the bottom bar.
struct SenderCleanupView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State private var rows: [SenderCleanupRow] = []
    @State private var scanned = 0
    @State private var didLoad = false
    @State private var loadError: String?
    @State private var selection: Set<String> = []
    @State private var isBlocking = false
    @State private var unsubscribe: UnsubscribeFlowModel?

    var body: some View {
        NavigationStack {
            List(selection: $selection) {
                if let loadError {
                    Text(loadError).font(.footnote).foregroundStyle(.red)
                } else if !didLoad {
                    Text("Reading your recent mail…").foregroundStyle(.secondary)
                } else if rows.isEmpty {
                    Text("No sender stands out. Recent mail you do not read will show here.")
                        .foregroundStyle(.secondary)
                } else {
                    Section {
                        ForEach(rows) { row in
                            senderRow(row).tag(row.sender)
                        }
                    } header: {
                        Text("Senders")
                    } footer: {
                        Text("From your \(scanned) most recent threads. Block sends their mail to Noise and clears it from the inbox, with Undo in Activity. An unsubscribe cannot be undone.")
                    }
                }
            }
            .environment(\.editMode, .constant(.active))
            .navigationTitle("Sender cleanup")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button(selection.count == rows.count && !rows.isEmpty ? "Select none" : "Select all") {
                        selection = selection.count == rows.count ? [] : Set(rows.map(\.sender))
                    }
                    .disabled(rows.isEmpty)
                }
                ToolbarItem(placement: .bottomBar) {
                    Button(blockLabel) { Task { await blockSelected() } }
                        .disabled(selection.isEmpty || isBlocking)
                }
            }
            .task { await load() }
            .refreshable { await load() }
            .modifier(OptionalUnsubscribeFlow(model: unsubscribe) { Task { await load() } })
        }
    }

    private var blockLabel: String {
        if isBlocking { return "Blocking…" }
        return selection.count > 1 ? "Block \(selection.count) senders" : "Block sender"
    }

    private func senderRow(_ row: SenderCleanupRow) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Text(detailLine(row))
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
            Spacer(minLength: 8)
            if let target = row.unsubscribeTarget {
                Button("Unsubscribe") {
                    let model = UnsubscribeFlowModel(client: SenderToolsClient(tools: environment.tools))
                    unsubscribe = model
                    Task { await model.begin(target) }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
    }

    private func detailLine(_ row: SenderCleanupRow) -> String {
        guard let lastDate = row.lastDate else { return row.sender }
        return "\(row.sender) · last \(lastDate.formatted(.dateTime.month(.abbreviated).day()))"
    }

    private func load() async {
        do {
            let result = try await SenderToolsClient(tools: environment.tools).cleanup(limit: 40)
            rows = result.senders
            scanned = result.scanned
            selection = selection.intersection(Set(rows.map(\.sender)))
            loadError = nil
        } catch {
            loadError = "The sender list could not load. Try again."
        }
        didLoad = true
    }

    // One batch id, so the blocks read as one change in Activity and one
    // Undo takes back the whole batch.
    private func blockSelected() async {
        let targets = rows.filter { selection.contains($0.sender) }
        guard !targets.isEmpty else { return }
        isBlocking = true
        defer { isBlocking = false }
        let batchID = SenderToolsClient.newBatchID()
        let client = SenderToolsClient(tools: environment.tools)
        var blocked: [BlockSenderResult] = []
        var failed: [String] = []
        for row in targets {
            do {
                blocked.append(try await client.block(sender: row.sender, batchID: batchID))
            } catch {
                failed.append(row.sender)
            }
        }
        selection = []
        SenderBlocking.noteBlocked(blocked, environment: environment)
        if !failed.isEmpty {
            environment.store.mailErrorMessage = failed.count == 1
                ? "Could not block \(failed[0]). Try again."
                : "Could not block \(failed.count) senders. Try again."
        }
        await environment.store.refreshMail()
        await load()
    }
}

/// The unsubscribe flow, once the user asked for it.
struct OptionalUnsubscribeFlow: ViewModifier {
    let model: UnsubscribeFlowModel?
    let onDone: () -> Void

    func body(content: Content) -> some View {
        if let model {
            content.unsubscribeFlow(model, onDone: onDone)
        } else {
            content
        }
    }
}
