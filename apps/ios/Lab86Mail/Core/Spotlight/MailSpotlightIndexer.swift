import CoreSpotlight
import CryptoKit
import Foundation
import OSLog
import UniformTypeIdentifiers

protocol MailSpotlightIndexing: Sendable {
    func replace(owner: String, accounts: [AccountSummary], threads: [MailThreadSummary]) async
    func remove(owner: String) async
}

struct MailSpotlightRecord: Hashable, Sendable {
    private static let identifierPrefix = "albatross-mail-thread"

    let uniqueIdentifier: String
    let domainIdentifier: String
    let title: String
    let sender: String
    let accountEmail: String
    let date: Date
    let routeURL: URL

    var contentDescription: String { "\(sender) · \(accountEmail)" }

    init?(owner: String, account: AccountSummary, thread: MailThreadSummary) {
        guard !owner.isEmpty, !account.id.isEmpty, !thread.accountID.isEmpty, !thread.id.isEmpty else {
            return nil
        }

        let ownerToken = Self.token(owner)
        let reference = MailEntityReference(
            kind: .message,
            accountID: thread.accountID,
            threadID: thread.id
        )
        var route = URLComponents()
        route.scheme = "lab86"
        route.host = "mail"
        route.path = "/thread"
        route.queryItems = [
            URLQueryItem(name: "account", value: thread.accountID),
            URLQueryItem(name: "id", value: thread.id),
        ]
        guard let routeURL = route.url else { return nil }

        uniqueIdentifier = "\(Self.identifierPrefix)|\(ownerToken)|\(reference.identifier)"
        domainIdentifier = "\(Self.ownerDomain(owner)).account.\(Self.token(account.id))"
        title = thread.subject
        sender = thread.sender
        accountEmail = account.email
        date = thread.date
        self.routeURL = routeURL
    }

    static func ownerDomain(_ owner: String) -> String {
        "io.lab86.mail.user.\(token(owner))"
    }

    static func threadRoute(fromUniqueIdentifier identifier: String) -> ThreadRoute? {
        let parts = identifier.split(separator: "|", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3,
              parts[0] == Substring(identifierPrefix),
              !parts[1].isEmpty,
              let reference = MailEntityReference(identifier: String(parts[2])),
              reference.kind == .message,
              let threadID = reference.threadID else { return nil }
        return ThreadRoute(accountID: reference.accountID, threadID: threadID)
    }

    private static func token(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8))
            .prefix(12)
            .map { String(format: "%02x", $0) }
            .joined()
    }
}

actor MailSpotlightIndexer: MailSpotlightIndexing {
    static let shared = MailSpotlightIndexer()

    private let index = CSSearchableIndex(name: "AlbatrossMail", protectionClass: .complete)
    private let logger = Logger(subsystem: "io.lab86.mail", category: "Spotlight")

    func replace(owner: String, accounts: [AccountSummary], threads: [MailThreadSummary]) async {
        let accountsByID = Dictionary(uniqueKeysWithValues: accounts.map { ($0.id, $0) })
        let records = threads.compactMap { thread in
            accountsByID[thread.accountID].flatMap {
                MailSpotlightRecord(owner: owner, account: $0, thread: thread)
            }
        }
        let domain = MailSpotlightRecord.ownerDomain(owner)

        do {
            // Replacing the small, bounded native mailbox snapshot prevents
            // archived or trashed threads from lingering across app launches.
            try await index.deleteSearchableItems(withDomainIdentifiers: [domain])
            guard !records.isEmpty else { return }
            try await index.indexSearchableItems(records.map { searchableItem(from: $0) })
        } catch {
            logger.error("Mail Spotlight refresh failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func remove(owner: String) async {
        do {
            try await index.deleteSearchableItems(
                withDomainIdentifiers: [MailSpotlightRecord.ownerDomain(owner)]
            )
        } catch {
            logger.error("Mail Spotlight deletion failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func searchableItem(from record: MailSpotlightRecord) -> CSSearchableItem {
        let attributes = CSSearchableItemAttributeSet(contentType: .emailMessage)
        attributes.title = record.title
        attributes.contentDescription = record.contentDescription
        attributes.authorNames = [record.sender]
        attributes.containerTitle = record.accountEmail
        attributes.contentCreationDate = record.date
        attributes.lastUsedDate = record.date
        attributes.contentURL = record.routeURL
        attributes.keywords = [record.sender, record.accountEmail]

        let item = CSSearchableItem(
            uniqueIdentifier: record.uniqueIdentifier,
            domainIdentifier: record.domainIdentifier,
            attributeSet: attributes
        )
        item.expirationDate = Date.now.addingTimeInterval(180 * 24 * 60 * 60)
        return item
    }
}
