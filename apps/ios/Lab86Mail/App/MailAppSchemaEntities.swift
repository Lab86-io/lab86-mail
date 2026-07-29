// Apple Intelligence assistant schemas are not bound here.
//
// The mail schema shape differs between the iOS 26 and iOS 27 SDKs — iOS 27
// adds `.mail.category`, `.mail.openDraft` and `.mail.openMessage`, and its
// `.mail.message` requires a schema-bound category — and the app must build
// against the released iOS 26 SDK for App Store Connect to accept the upload.
// These are therefore plain App Intents entities: still available to Siri and
// Shortcuts, but not bound to the assistant schemas.
//
// Rebinding them is tracked; see the iOS 27 Siri and Intelligence issue.
import AppIntents
import Foundation

enum AlbatrossMailCategory: String, AppEnum {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Mail Category"

    case primary
    case social
    case promotions
    case updates
    case forums

    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .primary: "Primary",
        .social: "Social",
        .promotions: "Promotions",
        .updates: "Updates",
        .forums: "Forums",
    ]
}

struct AlbatrossMailAccountEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Mail Account"

    static let defaultQuery = AccountQuery()

    let id: String
    var name: String
    var emailAddress: String

    init(id: String, name: String, emailAddress: String) {
        self.id = id
        self.name = name
        self.emailAddress = emailAddress
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(emailAddress)")
    }

    struct AccountQuery: EntityStringQuery {
        func entities(for identifiers: [String]) async throws -> [AlbatrossMailAccountEntity] {
            try await MailIntentService.shared.accounts().filter { identifiers.contains($0.id) }
        }

        func entities(matching string: String) async throws -> [AlbatrossMailAccountEntity] {
            let term = string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return try await MailIntentService.shared.accounts().filter {
                term.isEmpty || $0.name.lowercased().contains(term) || $0.emailAddress.lowercased().contains(term)
            }
        }

        func suggestedEntities() async throws -> [AlbatrossMailAccountEntity] {
            try await MailIntentService.shared.accounts()
        }
    }
}

struct AlbatrossMailboxEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Mailbox"

    static let defaultQuery = MailboxQuery()

    let id: String
    var name: String
    var account: AlbatrossMailAccountEntity

    init(id: String, name: String, account: AlbatrossMailAccountEntity) {
        self.id = id
        self.name = name
        self.account = account
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(account.emailAddress)")
    }

    struct MailboxQuery: EntityStringQuery {
        func entities(for identifiers: [String]) async throws -> [AlbatrossMailboxEntity] {
            try await MailIntentService.shared.mailboxes().filter { identifiers.contains($0.id) }
        }

        func entities(matching string: String) async throws -> [AlbatrossMailboxEntity] {
            let term = string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return try await MailIntentService.shared.mailboxes().filter {
                term.isEmpty || $0.name.lowercased().contains(term) || $0.account.emailAddress.lowercased().contains(term)
            }
        }

        func suggestedEntities() async throws -> [AlbatrossMailboxEntity] {
            try await MailIntentService.shared.mailboxes()
        }
    }
}

struct AlbatrossMailDraftEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Mail Draft"

    static let defaultQuery = DraftQuery()

    let id: String
    var to: [IntentPerson]
    var cc: [IntentPerson]
    var bcc: [IntentPerson]
    var subject: String?
    var body: AttributedString?
    var attachments: [IntentFile]
    var account: AlbatrossMailAccountEntity

    init(
        id: String,
        to: [IntentPerson],
        cc: [IntentPerson],
        bcc: [IntentPerson],
        subject: String?,
        body: AttributedString?,
        attachments: [IntentFile],
        account: AlbatrossMailAccountEntity
    ) {
        self.id = id
        self.to = to
        self.cc = cc
        self.bcc = bcc
        self.subject = subject
        self.body = body
        self.attachments = attachments
        self.account = account
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: "\(subject?.albatrossNonBlank ?? "(No subject)")",
            subtitle: "To \(MailIntentAddressCodec.string(from: to).albatrossNonBlank ?? "no recipient")"
        )
    }

    struct DraftQuery: EntityStringQuery {
        func entities(for identifiers: [String]) async throws -> [AlbatrossMailDraftEntity] {
            try await MailIntentService.shared.drafts(identifiers: Set(identifiers))
        }

        func entities(matching string: String) async throws -> [AlbatrossMailDraftEntity] {
            try await MailIntentService.shared.drafts(matching: string)
        }

        func suggestedEntities() async throws -> [AlbatrossMailDraftEntity] {
            try await MailIntentService.shared.drafts()
        }
    }
}

struct AlbatrossMailMessageEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Mail Message"

    static let defaultQuery = MessageQuery()

    let id: String
    var to: [IntentPerson]
    var cc: [IntentPerson]
    var bcc: [IntentPerson]
    var subject: String?
    var body: AttributedString?
    var attachments: [IntentFile]
    var sender: IntentPerson
    var dateSent: Date
    var dateReceived: Date
    var isRead: Bool
    var isJunk: Bool
    var isFlagged: Bool
    var category: AlbatrossMailCategory?
    var account: AlbatrossMailAccountEntity
    var mailbox: AlbatrossMailboxEntity

    init(
        id: String,
        to: [IntentPerson],
        cc: [IntentPerson],
        bcc: [IntentPerson],
        subject: String?,
        body: AttributedString?,
        attachments: [IntentFile],
        sender: IntentPerson,
        dateSent: Date,
        dateReceived: Date,
        isRead: Bool,
        isJunk: Bool,
        isFlagged: Bool,
        category: AlbatrossMailCategory?,
        account: AlbatrossMailAccountEntity,
        mailbox: AlbatrossMailboxEntity
    ) {
        self.id = id
        self.to = to
        self.cc = cc
        self.bcc = bcc
        self.subject = subject
        self.body = body
        self.attachments = attachments
        self.sender = sender
        self.dateSent = dateSent
        self.dateReceived = dateReceived
        self.isRead = isRead
        self.isJunk = isJunk
        self.isFlagged = isFlagged
        self.category = category
        self.account = account
        self.mailbox = mailbox
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: "\(subject?.albatrossNonBlank ?? "(No subject)")",
            subtitle: "\(MailIntentAddressCodec.string(from: [sender]))"
        )
    }

    struct MessageQuery: EntityStringQuery {
        func entities(for identifiers: [String]) async throws -> [AlbatrossMailMessageEntity] {
            try await MailIntentService.shared.messages(identifiers: Set(identifiers))
        }

        func entities(matching string: String) async throws -> [AlbatrossMailMessageEntity] {
            try await MailIntentService.shared.messages(matching: string)
        }

        func suggestedEntities() async throws -> [AlbatrossMailMessageEntity] {
            try await MailIntentService.shared.messages(limit: 30)
        }
    }
}

enum MailIntentAddressCodec {
    static func people(from value: String?) -> [IntentPerson] {
        guard let value else { return [] }
        return value
            .split(separator: ",")
            .compactMap { person(from: String($0)) }
    }

    static func person(from value: String) -> IntentPerson? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let email: String
        let name: String
        if let start = trimmed.lastIndex(of: "<"), let end = trimmed.lastIndex(of: ">"), start < end {
            email = String(trimmed[trimmed.index(after: start)..<end]).trimmingCharacters(in: .whitespaces)
            name = String(trimmed[..<start]).trimmingCharacters(in: CharacterSet(charactersIn: " \""))
        } else {
            email = trimmed
            name = trimmed
        }
        guard email.contains("@") else { return nil }
        return IntentPerson(
            identifier: .applicationDefined(email.lowercased()),
            name: .displayName(name.albatrossNonBlank ?? email),
            handle: .init(emailAddress: email)
        )
    }

    static func string(from people: [IntentPerson]) -> String {
        people.compactMap { person in
            guard let handle = person.handle else { return nil }
            switch handle.value {
            case .emailAddress(let email): return email
            case .applicationDefined(let value): return value
            case .phoneNumber: return nil
            @unknown default: return nil
            }
        }.joined(separator: ", ")
    }
}

extension String {
    var albatrossNonBlank: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}
