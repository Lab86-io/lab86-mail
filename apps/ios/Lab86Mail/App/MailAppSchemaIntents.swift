// Apple Intelligence assistant schemas are not bound here — see the note in
// MailAppSchemaEntities.swift. These remain full App Intents, available to Siri
// and Shortcuts; only the `schema:` binding is gone.
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

struct AlbatrossCreateDraftIntent: AppIntent {
    static let title: LocalizedStringResource = "Create Draft"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let openAppWhenRun = true

    @Parameter var body: AttributedString?
    @Parameter var to: [IntentPerson]
    @Parameter var subject: String?
    @Parameter var cc: [IntentPerson]
    @Parameter var bcc: [IntentPerson]
    @Parameter var account: AlbatrossMailAccountEntity?
    @Parameter var attachments: [IntentFile]

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

struct AlbatrossUpdateDraftIntent: AppIntent {
    static let title: LocalizedStringResource = "Update Draft"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter var target: AlbatrossMailDraftEntity
    @Parameter var to: [IntentPerson]?
    @Parameter var cc: [IntentPerson]?
    @Parameter var bcc: [IntentPerson]?
    @Parameter var subject: String?
    @Parameter var body: AttributedString?
    @Parameter var account: AlbatrossMailAccountEntity?
    @Parameter var attachments: [IntentFile]?

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

struct AlbatrossSaveDraftIntent: AppIntent {
    static let title: LocalizedStringResource = "Save Draft"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter var target: AlbatrossMailDraftEntity

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

struct AlbatrossOpenDraftIntent: OpenIntent {
    static let title: LocalizedStringResource = "Open Draft"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @Parameter var target: AlbatrossMailDraftEntity

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

struct AlbatrossDeleteDraftIntent: DeleteIntent {
    static let title: LocalizedStringResource = "Delete Drafts"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @Parameter var entities: [AlbatrossMailDraftEntity]

    func perform() async throws -> some IntentResult {
        try await MailIntentService.shared.deleteDrafts(entities)
        return .result()
    }
}

struct AlbatrossSendDraftIntent: AppIntent {
    static let title: LocalizedStringResource = "Send Draft"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter var target: AlbatrossMailDraftEntity
    @Parameter var sendLaterDate: Date?

    func perform() async throws -> some IntentResult {
        try await MailIntentService.shared.sendDraft(target, later: sendLaterDate)
        return .result()
    }
}

struct AlbatrossOpenMessageIntent: OpenIntent {
    static let title: LocalizedStringResource = "Open Message"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @Parameter var target: AlbatrossMailMessageEntity

    func perform() async throws -> some IntentResult {
        let reference = try await MailIntentService.shared.resolveMessageReference(target)
        MailIntentDefaults.open(reference)
        return .result()
    }
}

struct AlbatrossReplyMailIntent: AppIntent {
    static let title: LocalizedStringResource = "Reply to Mail"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let openAppWhenRun = true

    @Parameter var isReplyAll: Bool
    @Parameter var target: AlbatrossMailMessageEntity
    @Parameter var body: AttributedString?
    @Parameter var subject: String?
    @Parameter var account: AlbatrossMailAccountEntity?
    @Parameter var attachments: [IntentFile]
    @Parameter var to: [IntentPerson]
    @Parameter var cc: [IntentPerson]
    @Parameter var bcc: [IntentPerson]

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

struct AlbatrossForwardMailIntent: AppIntent {
    static let title: LocalizedStringResource = "Forward Mail"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let openAppWhenRun = true

    @Parameter var target: AlbatrossMailMessageEntity
    @Parameter var to: [IntentPerson]
    @Parameter var body: AttributedString?
    @Parameter var cc: [IntentPerson]
    @Parameter var bcc: [IntentPerson]
    @Parameter var subject: String?
    @Parameter var account: AlbatrossMailAccountEntity?
    @Parameter var attachments: [IntentFile]

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

struct AlbatrossUpdateMailIntent: AppIntent {
    static let title: LocalizedStringResource = "Update Mail"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter var target: [AlbatrossMailMessageEntity]
    @Parameter var isRead: Bool?
    @Parameter var isFlagged: Bool?
    @Parameter var isJunk: Bool?
    @Parameter var mailbox: AlbatrossMailboxEntity?

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

struct AlbatrossArchiveMailIntent: AppIntent {
    static let title: LocalizedStringResource = "Archive Mail"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter var entities: [AlbatrossMailMessageEntity]

    func perform() async throws -> some IntentResult {
        try await MailIntentService.shared.archive(entities)
        return .result()
    }
}

struct AlbatrossDeleteMailIntent: DeleteIntent {
    static let title: LocalizedStringResource = "Delete Mail"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter var entities: [AlbatrossMailMessageEntity]

    func perform() async throws -> some IntentResult {
        try await MailIntentService.shared.delete(entities)
        return .result()
    }
}
