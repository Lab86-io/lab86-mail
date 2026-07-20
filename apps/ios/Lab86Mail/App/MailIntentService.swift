import AppIntents
import Foundation

enum MailIntentError: LocalizedError {
    case noAccount
    case invalidEntity

    var errorDescription: String? {
        switch self {
        case .noAccount: "Connect a mail account in Albatross first."
        case .invalidEntity: "Albatross could not find that email or draft."
        }
    }
}

struct MailEntityReference: Codable, Hashable, Sendable {
    enum Kind: String, Codable, Sendable {
        case draft
        case message
        case mailbox
    }

    let kind: Kind
    let accountID: String
    let threadID: String?
    let messageID: String?
    let localID: String?
    let mailboxName: String?

    var identifier: String {
        let data = (try? JSONEncoder().encode(self)) ?? Data()
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    init(
        kind: Kind,
        accountID: String,
        threadID: String? = nil,
        messageID: String? = nil,
        localID: String? = nil,
        mailboxName: String? = nil
    ) {
        self.kind = kind
        self.accountID = accountID
        self.threadID = threadID
        self.messageID = messageID
        self.localID = localID
        self.mailboxName = mailboxName
    }

    init?(identifier: String) {
        var base64 = identifier.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let padding = (4 - base64.count % 4) % 4
        base64 += String(repeating: "=", count: padding)
        guard let data = Data(base64Encoded: base64),
              let decoded = try? JSONDecoder().decode(Self.self, from: data) else { return nil }
        self = decoded
    }
}

actor MailIntentService {
    static let shared = MailIntentService()

    private let backend: BackendClient
    private let tools: ToolClient
    private let attachmentStore: MailIntentAttachmentStore

    init(
        configuration: AppConfiguration = .current,
        attachmentStore: MailIntentAttachmentStore = .shared
    ) {
        let backend = BackendClient(baseURL: configuration.apiBaseURL)
        self.backend = backend
        tools = ToolClient(backend: backend)
        self.attachmentStore = attachmentStore
    }

    func accounts() async throws -> [AlbatrossMailAccountEntity] {
        let result = try await tools.invoke("list_accounts")
        return (result["accounts"]?.arrayValue ?? []).compactMap { row -> AlbatrossMailAccountEntity? in
            guard let id = row["accountId"]?.stringValue,
                  let email = row["email"]?.stringValue else { return nil }
            return AlbatrossMailAccountEntity(
                id: id,
                name: row["displayName"]?.stringValue?.albatrossNonBlank ?? email,
                emailAddress: email
            )
        }
    }

    func mailboxes() async throws -> [AlbatrossMailboxEntity] {
        let accounts = try await accounts()
        return accounts.flatMap { account in
            ["Inbox", "Archive", "Trash", "Junk"].map { name in
                let reference = MailEntityReference(kind: .mailbox, accountID: account.id, mailboxName: name)
                return AlbatrossMailboxEntity(id: reference.identifier, name: name, account: account)
            }
        }
    }

    func drafts(identifiers: Set<String>? = nil, matching search: String? = nil) async throws -> [AlbatrossMailDraftEntity] {
        let accountRows = try await accounts()
        let normalizedSearch = search?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var entities: [AlbatrossMailDraftEntity] = []
        for account in accountRows {
            let result = try await tools.invoke("list_drafts", arguments: ["account": .string(account.id)])
            for row in result["drafts"]?.arrayValue ?? [] {
                guard let localID = row["_id"]?.stringValue else { continue }
                let reference = MailEntityReference(kind: .draft, accountID: account.id, localID: localID)
                guard identifiers == nil || identifiers?.contains(reference.identifier) == true else { continue }
                let subject = row["subject"]?.stringValue
                let to = row["to"]?.stringValue
                if let normalizedSearch, !normalizedSearch.isEmpty,
                   !(subject ?? "").lowercased().contains(normalizedSearch),
                   !(to ?? "").lowercased().contains(normalizedSearch) { continue }
                entities.append(
                    AlbatrossMailDraftEntity(
                        id: reference.identifier,
                        to: MailIntentAddressCodec.people(from: to),
                        cc: MailIntentAddressCodec.people(from: row["cc"]?.stringValue),
                        bcc: MailIntentAddressCodec.people(from: row["bcc"]?.stringValue),
                        subject: subject,
                        body: row["body"]?.stringValue.map(AttributedString.init),
                        attachments: (try? await attachmentStore.load(draftID: localID)) ?? [],
                        account: account
                    )
                )
            }
        }
        return entities
    }

    func messages(identifiers: Set<String>? = nil, matching search: String? = nil, limit: Int = 80) async throws -> [AlbatrossMailMessageEntity] {
        let accountRows = try await accounts()
        let normalizedSearch = search?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var entities: [AlbatrossMailMessageEntity] = []
        for account in accountRows {
            let result = try await tools.invoke(
                "list_account_threads",
                arguments: ["account": .string(account.id), "limit": .number(Double(limit))]
            )
            for row in result["threads"]?.arrayValue ?? [] {
                guard let thread = MailThreadSummary(json: row, accountID: account.id) else { continue }
                let reference = MailEntityReference(kind: .message, accountID: account.id, threadID: thread.id)
                guard identifiers == nil || identifiers?.contains(reference.identifier) == true else { continue }
                if let normalizedSearch, !normalizedSearch.isEmpty,
                   !thread.subject.lowercased().contains(normalizedSearch),
                   !thread.sender.lowercased().contains(normalizedSearch),
                   !thread.snippet.lowercased().contains(normalizedSearch) { continue }
                let sender = MailIntentAddressCodec.person(from: thread.sender)
                    ?? IntentPerson(handle: .init(applicationDefined: thread.sender))
                let inbox = AlbatrossMailboxEntity(
                    id: MailEntityReference(kind: .mailbox, accountID: account.id, mailboxName: "Inbox").identifier,
                    name: "Inbox",
                    account: account
                )
                entities.append(
                    AlbatrossMailMessageEntity(
                        id: reference.identifier,
                        to: [] as [IntentPerson],
                        cc: [] as [IntentPerson],
                        bcc: [] as [IntentPerson],
                        subject: thread.subject,
                        body: AttributedString(thread.snippet),
                        attachments: [] as [IntentFile],
                        sender: sender,
                        dateSent: thread.date,
                        dateReceived: thread.date,
                        isRead: !thread.unread,
                        isJunk: false,
                        isFlagged: thread.starred,
                        category: nil,
                        account: account,
                        mailbox: inbox
                    )
                )
            }
        }
        return entities.sorted { $0.dateReceived > $1.dateReceived }
    }

    func createDraft(
        to: [IntentPerson],
        cc: [IntentPerson],
        bcc: [IntentPerson],
        subject: String?,
        body: AttributedString?,
        account preferredAccount: AlbatrossMailAccountEntity?,
        attachments: [IntentFile]
    ) async throws -> AlbatrossMailDraftEntity {
        let account = try await resolveAccount(preferredAccount)
        let result = try await tools.invoke(
            "save_draft",
            arguments: [
                "account": .string(account.id),
                "to": .string(MailIntentAddressCodec.string(from: to)),
                "cc": .string(MailIntentAddressCodec.string(from: cc)),
                "bcc": .string(MailIntentAddressCodec.string(from: bcc)),
                "subject": .string(subject ?? ""),
                "body": .string(body.map(String.init) ?? ""),
            ]
        )
        guard let localID = result["draft"]?["_id"]?.stringValue else { throw MailIntentError.invalidEntity }
        try await attachmentStore.save(attachments, draftID: localID)
        return AlbatrossMailDraftEntity(
            id: MailEntityReference(kind: .draft, accountID: account.id, localID: localID).identifier,
            to: to,
            cc: cc,
            bcc: bcc,
            subject: subject,
            body: body,
            attachments: attachments,
            account: account
        )
    }

    func updateDraft(
        _ target: AlbatrossMailDraftEntity,
        to: [IntentPerson]?,
        cc: [IntentPerson]?,
        bcc: [IntentPerson]?,
        subject: String?,
        body: AttributedString?,
        account: AlbatrossMailAccountEntity?,
        attachments: [IntentFile]?
    ) async throws {
        guard let reference = MailEntityReference(identifier: target.id), let localID = reference.localID else {
            throw MailIntentError.invalidEntity
        }
        var patch: [String: JSONValue] = [:]
        if let to { patch["to"] = .string(MailIntentAddressCodec.string(from: to)) }
        if let cc { patch["cc"] = .string(MailIntentAddressCodec.string(from: cc)) }
        if let bcc { patch["bcc"] = .string(MailIntentAddressCodec.string(from: bcc)) }
        if let subject { patch["subject"] = .string(subject) }
        if let body { patch["body"] = .string(String(body.characters)) }
        _ = try await tools.invoke(
            "update_draft",
            arguments: ["id": .string(localID), "patch": .object(patch)]
        )
        _ = account
        if let attachments { try await attachmentStore.save(attachments, draftID: localID) }
    }

    func deleteDrafts(_ entities: [AlbatrossMailDraftEntity]) async throws {
        for entity in entities {
            guard let reference = MailEntityReference(identifier: entity.id), let localID = reference.localID else {
                throw MailIntentError.invalidEntity
            }
            _ = try await tools.invoke("delete_draft", arguments: ["id": .string(localID)])
            try await attachmentStore.remove(draftID: localID)
        }
    }

    func sendDraft(_ target: AlbatrossMailDraftEntity, later: Date?) async throws {
        var fields = [
            "mode": "new",
            "account": target.account.id,
            "to": MailIntentAddressCodec.string(from: target.to),
            "cc": MailIntentAddressCodec.string(from: target.cc),
            "bcc": MailIntentAddressCodec.string(from: target.bcc),
            "subject": target.subject ?? "",
            "body": target.body.map { String($0.characters) } ?? "",
        ]
        if let later {
            fields["sendAt"] = String(Int(later.timeIntervalSince1970 * 1_000))
        }
        let files = target.attachments.map {
            MultipartFile(
                fieldName: "attachments",
                filename: $0.filename,
                contentType: $0.type?.preferredMIMEType ?? "application/octet-stream",
                data: $0.data
            )
        }
        _ = try await backend.postMultipart(path: "/api/compose", fields: fields, files: files)
        try await deleteDrafts([target])
    }

    func resolveMessageReference(_ entity: AlbatrossMailMessageEntity) async throws -> MailEntityReference {
        guard var reference = MailEntityReference(identifier: entity.id), reference.kind == .message else {
            throw MailIntentError.invalidEntity
        }
        if reference.messageID != nil { return reference }
        guard let threadID = reference.threadID else { throw MailIntentError.invalidEntity }
        let detail = try await tools.invoke(
            "get_thread",
            arguments: ["account": .string(reference.accountID), "threadId": .string(threadID)]
        )
        guard let last = detail["messages"]?.arrayValue?.last,
              let messageID = last["providerMessageId"]?.stringValue
                ?? last["id"]?.stringValue
                ?? last["_id"]?.stringValue else { throw MailIntentError.invalidEntity }
        reference = MailEntityReference(
            kind: .message,
            accountID: reference.accountID,
            threadID: threadID,
            messageID: messageID
        )
        return reference
    }

    func archive(_ entities: [AlbatrossMailMessageEntity]) async throws {
        for entity in entities {
            let reference = try await resolveMessageReference(entity)
            guard let threadID = reference.threadID else { throw MailIntentError.invalidEntity }
            _ = try await tools.invoke(
                "archive_thread",
                arguments: ["account": .string(reference.accountID), "threadId": .string(threadID)]
            )
        }
    }

    func delete(_ entities: [AlbatrossMailMessageEntity]) async throws {
        for entity in entities {
            let reference = try await resolveMessageReference(entity)
            guard let threadID = reference.threadID else { throw MailIntentError.invalidEntity }
            _ = try await tools.invoke(
                "trash_thread",
                arguments: ["account": .string(reference.accountID), "threadId": .string(threadID)]
            )
        }
    }

    func update(
        _ entities: [AlbatrossMailMessageEntity],
        isRead: Bool?,
        isFlagged: Bool?,
        isJunk: Bool?,
        mailbox: AlbatrossMailboxEntity?
    ) async throws {
        for entity in entities {
            let reference = try await resolveMessageReference(entity)
            guard let messageID = reference.messageID else { throw MailIntentError.invalidEntity }
            if let isRead {
                _ = try await tools.invoke(
                    isRead ? "mark_read" : "mark_unread",
                    arguments: ["account": .string(reference.accountID), "messageId": .string(messageID)]
                )
            }
            if let isFlagged {
                _ = try await tools.invoke(
                    isFlagged ? "star" : "unstar",
                    arguments: ["account": .string(reference.accountID), "messageId": .string(messageID)]
                )
            }
            if isJunk == true {
                _ = try await tools.invoke(
                    "add_label",
                    arguments: [
                        "account": .string(reference.accountID),
                        "messageId": .string(messageID),
                        "label": .string("SPAM"),
                    ]
                )
            }
            if let mailbox {
                guard let threadID = reference.threadID else { throw MailIntentError.invalidEntity }
                switch mailbox.name.lowercased() {
                case "trash":
                    _ = try await tools.invoke(
                        "trash_thread",
                        arguments: ["account": .string(reference.accountID), "threadId": .string(threadID)]
                    )
                case "archive":
                    _ = try await tools.invoke(
                        "archive_thread",
                        arguments: ["account": .string(reference.accountID), "threadId": .string(threadID)]
                    )
                case "inbox":
                    _ = try await tools.invoke(
                        "restore_from_trash",
                        arguments: ["account": .string(reference.accountID), "threadId": .string(threadID)]
                    )
                default: break
                }
            }
        }
    }

    private func resolveAccount(_ preferred: AlbatrossMailAccountEntity?) async throws -> AlbatrossMailAccountEntity {
        if let preferred { return preferred }
        guard let account = try await accounts().first else { throw MailIntentError.noAccount }
        return account
    }
}
