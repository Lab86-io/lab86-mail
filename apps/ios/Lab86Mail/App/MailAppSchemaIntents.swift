#if compiler(>=6.4)
import AppIntents
import Foundation

private enum MailIntentDefaults {
    static func openComposer(
        mode: String,
        accountID: String,
        threadID: String? = nil,
        messageID: String? = nil,
        recipient: String,
        cc: String = "",
        bcc: String = "",
        subject: String,
        body: String,
        replyAll: Bool = false,
        attachmentsKey: String? = nil,
        draftID: String? = nil
    ) {
        let defaults = UserDefaults.standard
        defaults.set(mode, forKey: "pendingAlbatrossComposeMode")
        defaults.set(accountID, forKey: "pendingAlbatrossComposeAccount")
        defaults.set(threadID, forKey: "pendingAlbatrossComposeThread")
        defaults.set(messageID, forKey: "pendingAlbatrossComposeMessage")
        defaults.set(recipient, forKey: "pendingAlbatrossComposeRecipient")
        defaults.set(cc, forKey: "pendingAlbatrossComposeCC")
        defaults.set(bcc, forKey: "pendingAlbatrossComposeBCC")
        defaults.set(subject, forKey: "pendingAlbatrossComposeSubject")
        defaults.set(body, forKey: "pendingAlbatrossComposeBody")
        defaults.set(replyAll, forKey: "pendingAlbatrossComposeReplyAll")
        defaults.set(attachmentsKey, forKey: "pendingAlbatrossComposeAttachmentsKey")
        defaults.set(draftID, forKey: "pendingAlbatrossComposeDraftID")
    }

    static func open(_ reference: MailEntityReference) {
        guard let threadID = reference.threadID else { return }
        var components = URLComponents()
        components.scheme = "lab86"
        components.host = "mail"
        components.path = "/thread"
        components.queryItems = [
            URLQueryItem(name: "account", value: reference.accountID),
            URLQueryItem(name: "id", value: threadID),
        ]
        UserDefaults.standard.set(components.string, forKey: "pendingAlbatrossDeepLink")
    }

    static func text(_ value: AttributedString?) -> String {
        value.map { String($0.characters) } ?? ""
    }

    static func stage(_ attachments: [IntentFile], preferredKey: String? = nil) async throws -> String? {
        guard !attachments.isEmpty else { return nil }
        let key = preferredKey ?? UUID().uuidString
        try await MailIntentAttachmentStore.shared.save(attachments, draftID: key)
        return key
    }
}

@AppIntent(schema: .mail.createDraft)
struct AlbatrossCreateDraftIntent {
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let openAppWhenRun = true

    var body: AttributedString?
    var to: [IntentPerson]
    var subject: String?
    var cc: [IntentPerson]
    var bcc: [IntentPerson]
    var account: AlbatrossMailAccountEntity?
    var attachments: [IntentFile]

    func perform() async throws -> some ReturnsValue<AlbatrossMailDraftEntity> {
        let draft = try await MailIntentService.shared.createDraft(
            to: to,
            cc: cc,
            bcc: bcc,
            subject: subject,
            body: body,
            account: account,
            attachments: attachments
        )
        let reference = MailEntityReference(identifier: draft.id)
        MailIntentDefaults.openComposer(
            mode: "new",
            accountID: draft.account.id,
            recipient: MailIntentAddressCodec.string(from: draft.to),
            cc: MailIntentAddressCodec.string(from: draft.cc),
            bcc: MailIntentAddressCodec.string(from: draft.bcc),
            subject: draft.subject ?? "",
            body: MailIntentDefaults.text(draft.body),
            attachmentsKey: reference?.localID,
            draftID: reference?.localID
        )
        return .result(value: draft)
    }
}

@AppIntent(schema: .mail.updateDraft)
struct AlbatrossUpdateDraftIntent {
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    var target: AlbatrossMailDraftEntity
    var to: [IntentPerson]?
    var cc: [IntentPerson]?
    var bcc: [IntentPerson]?
    var subject: String?
    var body: AttributedString?
    var account: AlbatrossMailAccountEntity?
    var attachments: [IntentFile]?

    func perform() async throws -> some IntentResult {
        try await MailIntentService.shared.updateDraft(
            target,
            to: to,
            cc: cc,
            bcc: bcc,
            subject: subject,
            body: body,
            account: account,
            attachments: attachments
        )
        return .result()
    }
}

@AppIntent(schema: .mail.saveDraft)
struct AlbatrossSaveDraftIntent {
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    var target: AlbatrossMailDraftEntity

    func perform() async throws -> some IntentResult {
        try await MailIntentService.shared.updateDraft(
            target,
            to: target.to,
            cc: target.cc,
            bcc: target.bcc,
            subject: target.subject,
            body: target.body,
            account: target.account,
            attachments: target.attachments
        )
        return .result()
    }
}

@AppIntent(schema: .mail.openDraft)
struct AlbatrossOpenDraftIntent: OpenIntent {
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    var target: AlbatrossMailDraftEntity

    func perform() async throws -> some IntentResult {
        let reference = MailEntityReference(identifier: target.id)
        let attachmentsKey = try await MailIntentDefaults.stage(target.attachments, preferredKey: reference?.localID)
        MailIntentDefaults.openComposer(
            mode: "new",
            accountID: target.account.id,
            recipient: MailIntentAddressCodec.string(from: target.to),
            cc: MailIntentAddressCodec.string(from: target.cc),
            bcc: MailIntentAddressCodec.string(from: target.bcc),
            subject: target.subject ?? "",
            body: MailIntentDefaults.text(target.body),
            attachmentsKey: attachmentsKey,
            draftID: reference?.localID
        )
        return .result()
    }
}

@AppIntent(schema: .mail.deleteDraft)
struct AlbatrossDeleteDraftIntent: DeleteIntent {
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    var entities: [AlbatrossMailDraftEntity]

    func perform() async throws -> some IntentResult {
        try await MailIntentService.shared.deleteDrafts(entities)
        return .result()
    }
}

@AppIntent(schema: .mail.sendDraft)
struct AlbatrossSendDraftIntent {
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    var target: AlbatrossMailDraftEntity
    var sendLaterDate: Date?

    func perform() async throws -> some IntentResult {
        try await MailIntentService.shared.sendDraft(target, later: sendLaterDate)
        return .result()
    }
}

@AppIntent(schema: .mail.openMessage)
struct AlbatrossOpenMessageIntent: OpenIntent {
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    var target: AlbatrossMailMessageEntity

    func perform() async throws -> some IntentResult {
        let reference = try await MailIntentService.shared.resolveMessageReference(target)
        MailIntentDefaults.open(reference)
        return .result()
    }
}

@AppIntent(schema: .mail.replyMail)
struct AlbatrossReplyMailIntent {
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let openAppWhenRun = true

    var isReplyAll: Bool
    var target: AlbatrossMailMessageEntity
    var body: AttributedString?
    var subject: String?
    var account: AlbatrossMailAccountEntity?
    var attachments: [IntentFile]
    var to: [IntentPerson]
    var cc: [IntentPerson]
    var bcc: [IntentPerson]

    func perform() async throws -> some IntentResult {
        let reference = try await MailIntentService.shared.resolveMessageReference(target)
        let recipients = to.isEmpty ? [target.sender] : to
        let attachmentsKey = try await MailIntentDefaults.stage(attachments)
        MailIntentDefaults.openComposer(
            mode: "reply",
            accountID: account?.id ?? reference.accountID,
            threadID: reference.threadID,
            messageID: reference.messageID,
            recipient: MailIntentAddressCodec.string(from: recipients),
            cc: MailIntentAddressCodec.string(from: cc),
            bcc: MailIntentAddressCodec.string(from: bcc),
            subject: subject ?? target.subject ?? "",
            body: MailIntentDefaults.text(body),
            replyAll: isReplyAll,
            attachmentsKey: attachmentsKey
        )
        return .result()
    }
}

@AppIntent(schema: .mail.forwardMail)
struct AlbatrossForwardMailIntent {
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let openAppWhenRun = true

    var target: AlbatrossMailMessageEntity
    var to: [IntentPerson]
    var body: AttributedString?
    var cc: [IntentPerson]
    var bcc: [IntentPerson]
    var subject: String?
    var account: AlbatrossMailAccountEntity?
    var attachments: [IntentFile]

    func perform() async throws -> some IntentResult {
        let reference = try await MailIntentService.shared.resolveMessageReference(target)
        let attachmentsKey = try await MailIntentDefaults.stage(attachments)
        MailIntentDefaults.openComposer(
            mode: "forward",
            accountID: account?.id ?? reference.accountID,
            threadID: reference.threadID,
            messageID: reference.messageID,
            recipient: MailIntentAddressCodec.string(from: to),
            cc: MailIntentAddressCodec.string(from: cc),
            bcc: MailIntentAddressCodec.string(from: bcc),
            subject: subject ?? target.subject.map { "Fwd: \($0)" } ?? "",
            body: MailIntentDefaults.text(body),
            attachmentsKey: attachmentsKey
        )
        return .result()
    }
}

@AppIntent(schema: .mail.updateMail)
struct AlbatrossUpdateMailIntent {
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    var target: [AlbatrossMailMessageEntity]
    var isRead: Bool?
    var isFlagged: Bool?
    var isJunk: Bool?
    var mailbox: AlbatrossMailboxEntity?

    func perform() async throws -> some IntentResult {
        try await MailIntentService.shared.update(
            target,
            isRead: isRead,
            isFlagged: isFlagged,
            isJunk: isJunk,
            mailbox: mailbox
        )
        return .result()
    }
}

@AppIntent(schema: .mail.archiveMail)
struct AlbatrossArchiveMailIntent {
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    var entities: [AlbatrossMailMessageEntity]

    func perform() async throws -> some IntentResult {
        try await MailIntentService.shared.archive(entities)
        return .result()
    }
}

@AppIntent(schema: .mail.deleteMail)
struct AlbatrossDeleteMailIntent: DeleteIntent {
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    var entities: [AlbatrossMailMessageEntity]

    func perform() async throws -> some IntentResult {
        try await MailIntentService.shared.delete(entities)
        return .result()
    }
}
#endif
