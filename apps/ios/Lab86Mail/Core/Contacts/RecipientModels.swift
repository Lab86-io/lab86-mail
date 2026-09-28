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

    /// The line the Mailboxes row shows under the mail status, in the same
    /// words as the web (components/settings/ContactsStatusLine.tsx). Nil for
    /// a paused mailbox: its row already asks for a mail reconnect.
    func summary(now: Date = .now) -> String? {
        switch state {
        case .ready:
            let count: String
            switch contactCount {
            case 0: count = "No contacts"
            case 1: count = "1 contact"
            default: count = "\(contactCount.formatted()) contacts"
            }
            guard let lastSyncedAt else { return count }
            return "\(count) · synced \(Self.ago(lastSyncedAt, now: now))"
        case .needsReconnect:
            return "Contacts need permission."
        case .syncing:
            return "Contacts are syncing."
        case .pending:
            return "The first contact sync has not finished."
        case .unsupported:
            return "This mailbox has no contacts to sync."
        case .error:
            return "Contact sync failed. It will try again."
        case .paused:
            return nil
        }
    }

    var isProblem: Bool { state == .error }

    /// "just now", "5 mins ago", "3 hours ago", "2 days ago", as on the web.
    static func ago(_ date: Date, now: Date) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "just now" }
        let minutes = Int((seconds / 60).rounded())
        if minutes < 60 { return "\(minutes) min\(minutes == 1 ? "" : "s") ago" }
        let hours = Int((Double(minutes) / 60).rounded())
        if hours < 24 { return "\(hours) hour\(hours == 1 ? "" : "s") ago" }
        let days = Int((Double(hours) / 24).rounded())
        return "\(days) day\(days == 1 ? "" : "s") ago"
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
