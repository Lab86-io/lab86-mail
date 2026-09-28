import Foundation

// Recipient search and contact status, in the app's own shapes. The mobile v1
// contract (`lib/mobile/v1/contract.ts`, "contacts") is the source of the
// wire format; `MobileV1Client` maps the generated types into these, so the
// views never see a generated schema type.

enum RecipientSource: String, Hashable, Sendable {
    case addressBook
    case inbox
    case domain
    case mail
    case typed
}

enum RecipientHighlightField: String, Hashable, Sendable {
    case name
    case email
}

/// A bold range in a suggestion's `name` or `email`, in UTF-16 offsets.
struct RecipientHighlight: Hashable, Sendable {
    let field: RecipientHighlightField
    let start: Int
    let length: Int
}

/// One person the server suggests for a To, Cc, or Bcc field.
struct RecipientSuggestion: Identifiable, Hashable, Sendable {
    let id: String
    let email: String
    let name: String?
    let alternateEmails: [String]
    let savedContact: Bool
    let directory: Bool
    let sources: [RecipientSource]
    let company: String?
    let jobTitle: String?
    let photoURL: URL?
    let lastContactedAt: Date?
    let sentCount: Int
    let receivedCount: Int
    let highlights: [RecipientHighlight]
    let score: Double

    init(
        id: String? = nil,
        email: String,
        name: String? = nil,
        alternateEmails: [String] = [],
        savedContact: Bool = false,
        directory: Bool = false,
        sources: [RecipientSource] = [],
        company: String? = nil,
        jobTitle: String? = nil,
        photoURL: URL? = nil,
        lastContactedAt: Date? = nil,
        sentCount: Int = 0,
        receivedCount: Int = 0,
        highlights: [RecipientHighlight] = [],
        score: Double = 0
    ) {
        self.id = id ?? email.lowercased()
        self.email = email
        self.name = name?.nilIfBlank
        self.alternateEmails = alternateEmails
        self.savedContact = savedContact
        self.directory = directory
        self.sources = sources
        self.company = company?.nilIfBlank
        self.jobTitle = jobTitle?.nilIfBlank
        self.photoURL = photoURL
        self.lastContactedAt = lastContactedAt
        self.sentCount = sentCount
        self.receivedCount = receivedCount
        self.highlights = highlights
        self.score = score
    }

    /// The text for the first line: the name, or the address when no name is known.
    var displayName: String { name ?? email }

    /// The query is a complete address that no index knows.
    var isTypedAddress: Bool { sources.contains(.typed) }

    func highlights(in field: RecipientHighlightField) -> [RecipientHighlight] {
        highlights.filter { $0.field == field }
    }
}

struct RecipientSuggestionPage: Hashable, Sendable {
    /// The query as the server read it (trimmed). Responses for an older query are dropped.
    let query: String
    let items: [RecipientSuggestion]
}

/// The inputs of one recipient search.
struct RecipientSearchRequest: Hashable, Sendable {
    static let maximumQueryLength = 200
    static let maximumExcluded = 50

    let query: String
    let fromAccountID: String?
    let limit: Int
    let exclude: [String]

    init(query: String, fromAccountID: String?, limit: Int = 8, exclude: [String] = []) {
        self.query = String(
            query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.maximumQueryLength)
        )
        self.fromAccountID = fromAccountID?.nilIfBlank
        self.limit = min(max(limit, 1), 10)
        var seen = Set<String>()
        self.exclude = exclude
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
            .prefix(Self.maximumExcluded)
            .map { $0 }
    }
}

// MARK: - Contact status for each mailbox

enum ContactSyncState: String, Hashable, Sendable {
    case ready
    case syncing
    case pending
    case needsReconnect
    case unsupported
    case error
    case paused
}

struct ContactSourceStatus: Hashable, Sendable {
    let source: String
    let state: String
    let count: Int?
}

struct ContactAccountStatus: Identifiable, Hashable, Sendable {
    var id: String { accountID }
    let accountID: String
    let email: String
    let provider: String
    let state: ContactSyncState
    let needsReconnect: Bool
    let contactCount: Int
    let lastSyncedAt: Date?
    let sources: [ContactSourceStatus]
    let message: String?

    /// The line the Mailboxes row shows under the mail status.
    var summary: String {
        if needsReconnect {
            return message ?? "Reconnect this mailbox to add its contacts."
        }
        switch state {
        case .ready:
            return contactCount == 1 ? "Contacts: 1 person" : "Contacts: \(contactCount.formatted()) people"
        case .syncing, .pending:
            return contactCount > 0
                ? "Adding contacts: \(contactCount.formatted()) so far"
                : "Adding contacts"
        case .needsReconnect:
            return message ?? "Reconnect this mailbox to add its contacts."
        case .unsupported:
            return message ?? "This mailbox has no contacts to add."
        case .error:
            return message ?? "Contacts did not sync. Try again later."
        case .paused:
            return message ?? "Contacts stop until this mailbox reconnects."
        }
    }

    var isProblem: Bool {
        needsReconnect || state == .error || state == .paused
    }
}

struct ContactStatusPage: Hashable, Sendable {
    let accounts: [ContactAccountStatus]
}

struct ContactResyncReceipt: Hashable, Sendable {
    let accountID: String
    let started: Bool
}

// MARK: - Transports

protocol RecipientSearching: Sendable {
    func searchRecipients(_ request: RecipientSearchRequest) async throws -> RecipientSuggestionPage
}

protocol ContactStatusServing: Sendable {
    func fetchContactStatus() async throws -> ContactStatusPage
    func resyncContacts(accountID: String) async throws -> ContactResyncReceipt
}

// MARK: - Contract values

extension RecipientSuggestion {
    /// The contract sends `https` photo URLs only; anything else is not a usable hint.
    static func photoURL(from value: String) -> URL? {
        guard let url = URL(string: value), url.scheme?.lowercased() == "https" else { return nil }
        return url
    }
}
