import Foundation
import Observation

struct ComposeDraftSnapshot: Codable, Hashable, Sendable {
    let recipient: String
    let cc: String
    let bcc: String
    let subject: String
    let body: String
    let mode: String
    let accountID: String
    let threadID: String?
    let messageID: String?
    let replyAll: Bool
    let attachmentsKey: String?
    let draftID: String?

    var composePrefill: ComposePrefill {
        ComposePrefill(
            recipient: recipient,
            cc: cc,
            bcc: bcc,
            subject: subject,
            body: body,
            mode: mode,
            accountID: accountID,
            threadID: threadID,
            messageID: messageID,
            replyAll: replyAll,
            attachmentsKey: attachmentsKey,
            draftID: draftID
        )
    }
}

struct PendingSendReceipt: Hashable, Sendable {
    let id: String
    let fireAt: Date
    let undoSeconds: Int
    let accountID: String
    let threadID: String?
}

enum ComposeSubmission: Hashable, Sendable {
    case pending(PendingSendReceipt)
    case scheduled(sendAt: Date)
    case sent(accountID: String, threadID: String?, messageID: String?)
}

struct PendingSendRecord: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let ownerID: String
    let fireAt: Date
    let snapshot: ComposeDraftSnapshot
}

@MainActor
@Observable
final class PendingSendCoordinator {
    private(set) var records: [PendingSendRecord]
    private(set) var isReconciling = false
    var errorMessage: String?

    private let backend: BackendClient
    private let tools: ToolClient
    private let defaults: UserDefaults
    private let persistenceKey = "albatross.pending-sends.v1"

    init(backend: BackendClient, tools: ToolClient, defaults: UserDefaults = .standard) {
        self.backend = backend
        self.tools = tools
        self.defaults = defaults
        if let data = defaults.data(forKey: persistenceKey),
           let decoded = try? JSONDecoder().decode([PendingSendRecord].self, from: data) {
            records = decoded.sorted { $0.fireAt < $1.fireAt }
        } else {
            records = []
        }
    }

    func register(receipt: PendingSendReceipt, ownerID: String, snapshot: ComposeDraftSnapshot) {
        records.removeAll { $0.id == receipt.id }
        records.append(
            PendingSendRecord(
                id: receipt.id,
                ownerID: ownerID,
                fireAt: receipt.fireAt,
                snapshot: snapshot
            )
        )
        records.sort { $0.fireAt < $1.fireAt }
        persist()
    }

    func undo(_ record: PendingSendRecord) async -> ComposePrefill? {
        do {
            let result = try await backend.post(
                path: "/api/compose/undo",
                body: .object(["pendingId": .string(record.id)])
            )
            guard result["undone"]?.boolValue == true else {
                errorMessage = "The undo window elapsed before the server could cancel the message."
                await reconcile(ownerID: record.ownerID)
                return nil
            }
            records.removeAll { $0.id == record.id }
            persist()
            return record.snapshot.composePrefill
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func reconcile(ownerID: String?) async {
        guard let ownerID else { return }
        let owned = records.filter { $0.ownerID == ownerID }
        guard !owned.isEmpty, !isReconciling else { return }
        isReconciling = true
        defer { isReconciling = false }

        for record in owned {
            do {
                let encoded = record.id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? record.id
                let result = try await backend.get(path: "/api/compose/status?pendingId=\(encoded)")
                switch result["status"]?.stringValue {
                case "sent":
                    await finish(record, removeAttachments: true)
                case "failed":
                    records.removeAll { $0.id == record.id }
                    persist()
                    errorMessage = "A held message failed to send. Its draft is still available to restore."
                case "cancelled":
                    // A different foreground scene or client may have completed
                    // cancellation. Keep the exact draft available in this scene.
                    records.removeAll { $0.id == record.id }
                    persist()
                    errorMessage = "A held message was cancelled. Reopen it from the restored draft."
                default:
                    break
                }
            } catch {
                // The server owns the deadline. A connectivity error never
                // converts a held message into a local success or cancellation.
                errorMessage = "Couldn’t confirm a pending message. Albatross will check again."
            }
        }
    }

    func clear(ownerID: String?) async {
        let removed = records.filter { ownerID == nil || $0.ownerID == ownerID }
        records.removeAll { ownerID == nil || $0.ownerID == ownerID }
        persist()
        for record in removed {
            if let key = record.snapshot.attachmentsKey {
                try? await MailIntentAttachmentStore.shared.remove(draftID: key)
            }
        }
    }

    private func finish(_ record: PendingSendRecord, removeAttachments: Bool) async {
        records.removeAll { $0.id == record.id }
        persist()
        if let draftID = record.snapshot.draftID {
            _ = try? await tools.invoke("delete_draft", arguments: ["id": .string(draftID)])
        }
        if removeAttachments, let key = record.snapshot.attachmentsKey {
            try? await MailIntentAttachmentStore.shared.remove(draftID: key)
        }
    }

    private func persist() {
        if records.isEmpty {
            defaults.removeObject(forKey: persistenceKey)
            return
        }
        if let data = try? JSONEncoder().encode(records) {
            defaults.set(data, forKey: persistenceKey)
        }
    }
}
