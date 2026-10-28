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
    // The send-as address the message was going out from. Optional so a
    // record saved before send-as still decodes.
    var fromAddress: String? = nil
    // The saved files that went with the draft (docs/albatross-goal-runs.md,
    // G3). Optional so a record saved before them still decodes.
    var fileAttachments: [DraftAttachment]? = nil

    var composePrefill: ComposePrefill {
        var prefill = ComposePrefill(
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
            draftID: draftID,
            fromAddress: fromAddress
        )
        prefill.fileAttachments = fileAttachments ?? []
        return prefill
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
        case is SessionAuthenticationError, is ComposeFromRefusal:
            // A refused From address stops the send before the provider gets it.
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

/// What `/api/compose/status` says about one held message. `unknown` is an
/// end: the server has no row, or the provider gave no answer.
enum PendingSendServerStatus: String, Sendable {
    case pending
    case sending
    case sent
    case failed
    case cancelled
    case unknown

    var resolution: PendingSendResolution? {
        switch self {
        case .sent: .sent
        case .failed: .failed
        case .cancelled: .cancelled
        case .pending, .sending, .unknown: nil
        }
    }

    /// True when the server has settled the message, one way or the other.
    var isEnd: Bool {
        switch self {
        case .sent, .failed, .cancelled, .unknown: true
        case .pending, .sending: false
        }
    }
}

/// The poll after a held message's fire time (K7). The server starts the
/// send at exactly that time, so the first answer is often still `sending`.
/// The toast follows with backoff for about two minutes, then ends with a
/// note; the server still owns the send.
enum PendingSendFollow {
    static let delays: [Duration] = [
        .seconds(2), .seconds(2), .seconds(4), .seconds(8), .seconds(15), .seconds(30), .seconds(60),
    ]

    /// The wait before the next poll, or nil after the last one.
    static func delay(attempt: Int) -> Duration? {
        guard attempt >= 0, attempt < delays.count else { return nil }
        return delays[attempt]
    }
}

/// What the toast shows for one held message. The countdown never sits on
/// "0s": at the fire time the server sends, so the toast says so.
enum PendingSendPhase: Equatable, Sendable {
    case holding(secondsLeft: Int)
    case sending

    static func make(fireAt: Date, now: Date, serverSending: Bool) -> PendingSendPhase {
        let secondsLeft = Int(ceil(fireAt.timeIntervalSince(now)))
        if serverSending || secondsLeft <= 0 { return .sending }
        return .holding(secondsLeft: secondsLeft)
    }

    var title: String {
        switch self {
        case .holding(let secondsLeft): "Sending in \(secondsLeft)s"
        case .sending: "Sending…"
        }
    }
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
    // Held messages the server reported as `sending`.
    private(set) var sendingIDs: Set<String> = []

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
            let status: PendingSendServerStatus?
            do {
                status = try await fetchStatus(pendingID: record.id)
            } catch {
                // The server owns the deadline. A connectivity error never
                // converts a held message into a local success or cancellation.
                errorMessage = "Couldn’t confirm a pending message. Albatross will check again."
                continue
            }
            await apply(status, to: record)
        }
    }

    /// Where one held message is, for the toast (K7).
    func phase(for record: PendingSendRecord, at now: Date = .now) -> PendingSendPhase {
        PendingSendPhase.make(fireAt: record.fireAt, now: now, serverSending: sendingIDs.contains(record.id))
    }

    /// Follows one held message from its fire time until the server settles
    /// it (K7). True when it was sent, so the caller can refresh Mail. A
    /// cancelled follow (the toast left) changes nothing; `reconcile` picks
    /// the message up on the next return.
    func follow(_ record: PendingSendRecord) async -> Bool {
        let wait = record.fireAt.timeIntervalSinceNow
        if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
        var attempt = 0
        while !Task.isCancelled {
            guard records.contains(where: { $0.id == record.id }) else {
                return resolutions[record.id] == .sent
            }
            let status = try? await fetchStatus(pendingID: record.id)
            guard !Task.isCancelled else { return false }
            if let status, status.isEnd {
                await apply(status, to: record)
                return status == .sent
            }
            await apply(status, to: record)
            guard let delay = PendingSendFollow.delay(attempt: attempt) else {
                // No end after the last poll. The toast ends with a note; a
                // later check can still ask the server.
                await apply(.unknown, to: record)
                return false
            }
            attempt += 1
            try? await Task.sleep(for: delay)
        }
        return false
    }

    private func apply(_ status: PendingSendServerStatus?, to record: PendingSendRecord) async {
        switch status {
        case .sent:
            sendingIDs.remove(record.id)
            resolutions[record.id] = .sent
            await finish(record, removeAttachments: true)
        case .failed:
            sendingIDs.remove(record.id)
            records.removeAll { $0.id == record.id }
            resolutions[record.id] = .failed
            persist()
            errorMessage = "A held message failed to send. Its draft is still available to restore."
        case .cancelled:
            // A different foreground scene or client may have completed
            // cancellation. Keep the exact draft available in this scene.
            sendingIDs.remove(record.id)
            records.removeAll { $0.id == record.id }
            resolutions[record.id] = .cancelled
            persist()
            errorMessage = "A held message was cancelled. Reopen it from the restored draft."
        case .unknown:
            // No resolution is recorded, so a later check can still ask.
            sendingIDs.remove(record.id)
            records.removeAll { $0.id == record.id }
            persist()
            errorMessage = "Albatross could not confirm that the message went out. Check Sent in a minute."
        case .sending:
            sendingIDs.insert(record.id)
        case .pending, nil:
            break
        }
    }

    /// Asks the server how one held message ended. A read only: an
    /// unreachable server answers nil, never a guessed outcome.
    func confirm(pendingID: String) async -> PendingSendResolution? {
        if let known = resolutions[pendingID] { return known }
        guard let status = try? await fetchStatus(pendingID: pendingID),
              let resolution = status.resolution else { return nil }
        resolutions[pendingID] = resolution
        return resolution
    }

    private func fetchStatus(pendingID: String) async throws -> PendingSendServerStatus? {
        let encoded = pendingID.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? pendingID
        let result = try await backend.get(path: "/api/compose/status?pendingId=\(encoded)")
        return result["status"]?.stringValue.flatMap(PendingSendServerStatus.init(rawValue:))
    }

    func clear(ownerID: String?) async {
        let removed = records.filter { ownerID == nil || $0.ownerID == ownerID }
        records.removeAll { ownerID == nil || $0.ownerID == ownerID }
        for record in removed { sendingIDs.remove(record.id) }
        persist()
        for record in removed {
            if let key = record.snapshot.attachmentsKey {
                try? await MailIntentAttachmentStore.shared.remove(draftID: key)
            }
        }
    }

    private func finish(_ record: PendingSendRecord, removeAttachments: Bool) async {
        records.removeAll { $0.id == record.id }
        sendingIDs.remove(record.id)
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
