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
    // Set when the message came from an inline Albatross draft. Undo then
    // returns to that artifact instead of opening the global composer.
    var assistantDraftKey: String? = nil

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
    /// The server answered 2xx without a `pending`, `scheduled`, or `sent`
    /// object. Nothing may call that sent.
    case unconfirmed

    /// Maps the `/api/compose` envelope. Only an explicit `sent` object is a
    /// confirmed send; anything else stays unconfirmed for the caller to
    /// surface without retrying.
    static func parse(
        _ result: JSONValue,
        accountID: String,
        threadID: String?,
        undoSeconds: Int
    ) -> ComposeSubmission {
        if let pending = result["pending"],
           let id = pending["id"]?.stringValue,
           let fireAt = pending["fireAt"]?.doubleValue {
            return .pending(
                PendingSendReceipt(
                    id: id,
                    fireAt: Date(timeIntervalSince1970: fireAt / 1_000),
                    undoSeconds: Int(pending["undoSeconds"]?.doubleValue ?? Double(undoSeconds)),
                    accountID: pending["account"]?.stringValue ?? accountID,
                    threadID: pending["threadId"]?.stringValue
                )
            )
        }
        if let scheduled = result["scheduled"],
           let scheduledAt = scheduled["sendAt"]?.doubleValue {
            return .scheduled(sendAt: Date(timeIntervalSince1970: scheduledAt / 1_000))
        }
        guard result["ok"]?.boolValue != false, let sent = result["sent"], sent.objectValue != nil else {
            return .unconfirmed
        }
        return .sent(
            accountID: sent["account"]?.stringValue ?? accountID,
            threadID: sent["threadId"]?.stringValue ?? threadID,
            messageID: sent["messageId"]?.stringValue
        )
    }
}

/// How a failed `/api/compose` call reads. Only a failure that happened
/// before the request could reach the server is definitive; anything after
/// that may still have delivered the message, so nothing may call it sent or
/// failed, and nothing may retry it on its own.
enum ComposeTransportFailure: Equatable, Sendable {
    /// The client or server refused before anything went out. The draft
    /// stays editable with the reason.
    case rejected(String)
    /// The request may have reached the server: a timeout, a dropped
    /// connection, an unreadable answer, or a server-side error.
    case ambiguous(String)

    var message: String {
        switch self {
        case .rejected(let message), .ambiguous(let message): message
        }
    }

    init(_ error: Error) {
        let message = error.localizedDescription
        switch error {
        case let backend as BackendError:
            switch backend {
            case .configuration, .unauthorized:
                self = .rejected(message)
            case .server(let status, _):
                // 4xx is the server refusing the request; 5xx may have
                // happened after the message was handed on.
                self = (400..<500).contains(status) ? .rejected(message) : .ambiguous(message)
            case .invalidResponse:
                self = .ambiguous(message)
            }
        case is SessionAuthenticationError:
            self = .rejected(message)
        case let url as URLError:
            switch url.code {
            case .notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed,
                 .badURL, .unsupportedURL, .secureConnectionFailed, .serverCertificateUntrusted,
                 .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot,
                 .serverCertificateNotYetValid, .clientCertificateRejected, .clientCertificateRequired,
                 .appTransportSecurityRequiresSecureConnection, .internationalRoamingOff,
                 .callIsActive, .dataNotAllowed:
                self = .rejected(message)
            default:
                self = .ambiguous(message)
            }
        default:
            self = .ambiguous(message)
        }
    }
}

/// How a held message ended, as the server or the person reported it.
enum PendingSendResolution: String, Sendable {
    case sent
    case failed
    case cancelled
    case undone
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
    // Outcomes of held messages this process learned about, so an artifact
    // that referenced a receipt can read how it ended after the toast is gone.
    private(set) var resolutions: [String: PendingSendResolution] = [:]

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
            resolutions[record.id] = .undone
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
            let status: PendingSendResolution?
            do {
                status = try await fetchStatus(pendingID: record.id)
            } catch {
                // The server owns the deadline. A connectivity error never
                // converts a held message into a local success or cancellation.
                errorMessage = "Couldn’t confirm a pending message. Albatross will check again."
                continue
            }
            switch status {
            case .sent:
                resolutions[record.id] = .sent
                await finish(record, removeAttachments: true)
            case .failed:
                records.removeAll { $0.id == record.id }
                resolutions[record.id] = .failed
                persist()
                errorMessage = "A held message failed to send. Its draft is still available to restore."
            case .cancelled:
                // A different foreground scene or client may have completed
                // cancellation. Keep the exact draft available in this scene.
                records.removeAll { $0.id == record.id }
                resolutions[record.id] = .cancelled
                persist()
                errorMessage = "A held message was cancelled. Reopen it from the restored draft."
            case .undone, nil:
                break
            }
        }
    }

    /// Asks the server how one held message ended. A read only: an
    /// unreachable server answers nil, never a guessed outcome.
    func confirm(pendingID: String) async -> PendingSendResolution? {
        if let known = resolutions[pendingID] { return known }
        guard let status = try? await fetchStatus(pendingID: pendingID) else { return nil }
        resolutions[pendingID] = status
        return status
    }

    private func fetchStatus(pendingID: String) async throws -> PendingSendResolution? {
        let encoded = pendingID.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? pendingID
        let result = try await backend.get(path: "/api/compose/status?pendingId=\(encoded)")
        switch result["status"]?.stringValue {
        case "sent": return .sent
        case "failed": return .failed
        case "cancelled": return .cancelled
        default: return nil
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
