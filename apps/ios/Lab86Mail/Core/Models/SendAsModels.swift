import Foundation

// Send-as addresses: the addresses one mailbox can send mail from.
//
// GET /api/mobile/v1/accounts/{accountID}/send-as gives the list
// (`MobileSendAsPage` in lib/mobile/v1/contract.ts). A direct Google mailbox
// lists its Gmail "Send mail as" addresses; another mailbox lists only its own
// address. Only a usable address can go in the `fromAddress` field of
// POST /api/compose. The rules here copy lib/shared/send-as.ts, which the web
// composer uses, so web, iOS, and macOS pick the same address.

enum SendAsVerification: String, Hashable, Sendable {
    case accepted
    case pending
    case unknown
}

struct SendAsIdentity: Hashable, Sendable {
    let email: String
    let displayName: String?
    let isPrimary: Bool
    let isDefault: Bool
    let verificationStatus: SendAsVerification
    let replyTo: String?
    /// Gmail has a signature for this address. Albatross uses its own signatures.
    let hasProviderSignature: Bool
    /// Only the primary address and addresses that Gmail verified can send.
    let usable: Bool
}

struct SendAsPage: Hashable, Sendable {
    let accountID: String
    /// False for a mailbox that can send only from its own address.
    let aliasesSupported: Bool
    /// True when the Gmail list did not load: `identities` holds only the mailbox address.
    let partial: Bool
    let identities: [SendAsIdentity]
    /// The address to select first. For a reply or a forward, the address the original was sent to.
    let defaultAddress: String
    let serverTime: Date

    var usableIdentities: [SendAsIdentity] { identities.filter(\.usable) }
}

/// The message that a reply or a forward answers. It sets `defaultAddress`.
struct SendAsAnchor: Hashable, Sendable {
    let messageID: String?
    let threadID: String?

    /// The anchor of a composer, or nil for a new message (web: `anchored`).
    init?(mode: String, messageID: String?, threadID: String?) {
        let message = messageID?.nilIfBlank
        let thread = threadID?.nilIfBlank
        guard mode != "new", message != nil || thread != nil else { return nil }
        self.messageID = message
        self.threadID = thread
    }
}

protocol SendAsFetching: Sendable {
    func fetchSendAs(accountID: String, anchor: SendAsAnchor?) async throws -> SendAsPage
}

// MARK: - Rules (lib/shared/send-as.ts)

/// One row of the composer's From control: an address of one mailbox.
struct FromChoice: Identifiable, Hashable, Sendable {
    let accountID: String
    let email: String
    let name: String?
    let primary: Bool

    var id: String { "\(accountID)\u{1F}\(SendAsRules.normalize(email))" }
}

/// The From rows of one mailbox.
struct FromChoiceGroup: Identifiable, Hashable, Sendable {
    let accountID: String
    let accountEmail: String
    let choices: [FromChoice]

    var id: String { accountID }

    /// The mailbox shows its own address choices only when it has more than
    /// one usable address. Otherwise it is one row, as before send-as.
    var offersAddressChoice: Bool { choices.count > 1 }
}

enum SendAsRules {
    static func normalize(_ value: String?) -> String {
        (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// A bare address: no spaces, no angle brackets, one @ with text on each side.
    static func isBareAddress(_ value: String?) -> Bool {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return false }
        let forbidden = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "<>,;\""))
        guard value.unicodeScalars.allSatisfy({ !forbidden.contains($0) }) else { return false }
        let parts = value.split(separator: "@", omittingEmptySubsequences: false)
        return parts.count == 2 && !parts[0].isEmpty && !parts[1].isEmpty
    }

    /// The From rows of the composer: the usable send-as addresses of each
    /// mailbox, in mailbox order. A mailbox whose list did not load shows
    /// its own address only (web: `composerFromChoices`).
    static func groups(accounts: [AccountSummary], pages: [String: SendAsPage]) -> [FromChoiceGroup] {
        accounts.map { account in
            let usable = pages[account.id]?.usableIdentities ?? []
            let choices: [FromChoice]
            if usable.isEmpty {
                choices = [
                    FromChoice(
                        accountID: account.id,
                        email: account.email.nilIfBlank ?? account.id,
                        name: account.displayName?.nilIfBlank,
                        primary: true
                    ),
                ]
            } else {
                choices = usable.map { identity in
                    FromChoice(
                        accountID: account.id,
                        email: identity.email,
                        name: identity.displayName?.nilIfBlank,
                        primary: identity.isPrimary
                    )
                }
            }
            return FromChoiceGroup(accountID: account.id, accountEmail: account.email, choices: choices)
        }
    }

    /// The row of `address` on mailbox `accountID`, else that mailbox's own
    /// address (web: `selectedFromChoice`).
    static func selected(in groups: [FromChoiceGroup], accountID: String, address: String?) -> FromChoice? {
        let own = groups.first { $0.accountID == accountID }?.choices ?? []
        let wanted = normalize(address)
        if !wanted.isEmpty, let match = own.first(where: { normalize($0.email) == wanted }) {
            return match
        }
        return own.first(where: \.primary) ?? own.first
    }

    /// The address to select: the one the user picked, else the page default.
    static func preferredAddress(userAddress: String?, page: SendAsPage?) -> String? {
        userAddress?.nilIfBlank ?? page?.defaultAddress.nilIfBlank
    }

    /// The `fromAddress` to send. The address that goes out is the one the
    /// control shows. Before the list loads, only an address that the user
    /// selected goes; without one the server picks the same default.
    static func sendAddress(page: SendAsPage?, selected: FromChoice?, userAddress: String?) -> String? {
        let address = page == nil ? userAddress : selected?.email
        guard let address = address?.trimmingCharacters(in: .whitespacesAndNewlines), isBareAddress(address) else {
            return nil
        }
        return address
    }

    /// The address to keep after the user picks a row. A mailbox row without
    /// a known address leaves the choice to the server.
    static func userAddress(after choice: FromChoice) -> String? {
        isBareAddress(choice.email) ? choice.email : nil
    }
}

// MARK: - Refused From address

/// Why POST /api/compose refused a From address (HTTP 400 `code`).
enum ComposeFromErrorCode: String, CaseIterable, Sendable {
    case unknown = "from_unknown"
    case unverified = "from_unverified"
    case unsupported = "from_unsupported"

    var message: String {
        switch self {
        case .unknown:
            "This mailbox cannot send from this address. Select a different From address."
        case .unverified:
            "Gmail did not verify this address. Complete its steps in Gmail settings, or select a different From address."
        case .unsupported:
            "This mailbox can send only from its own address."
        }
    }
}

/// The server refused the From address. Nothing went out; the draft stays open.
struct ComposeFromRefusal: LocalizedError, Equatable, Sendable {
    let code: ComposeFromErrorCode

    init(code: ComposeFromErrorCode) {
        self.code = code
    }

    /// A refusal from the JSON of a failed compose request, or nil.
    init?(status: Int, body: JSONValue?) {
        guard status == 400,
              let raw = body?["code"]?.stringValue,
              let code = ComposeFromErrorCode(rawValue: raw) else { return nil }
        self.code = code
    }

    var errorDescription: String? { code.message }
}

// MARK: - Cache

/// The send-as pages, kept for a short time for each mailbox and anchor,
/// like the web composer (five minutes).
@MainActor
final class SendAsDirectory {
    static let freshness: TimeInterval = 5 * 60

    private struct Key: Hashable {
        let accountID: String
        let anchor: SendAsAnchor?
    }

    private struct Entry {
        let page: SendAsPage
        let loadedAt: Date
    }

    private let fetcher: (any SendAsFetching)?
    private let now: @MainActor () -> Date
    private var entries: [Key: Entry] = [:]
    private var inFlight: [Key: Task<SendAsPage?, Never>] = [:]

    init(fetcher: (any SendAsFetching)?, now: @escaping @MainActor () -> Date = { .now }) {
        self.fetcher = fetcher
        self.now = now
    }

    /// The page of one mailbox, from the cache when it is fresh. Nil when the
    /// list is not available; the composer then shows the mailbox address.
    func page(accountID: String, anchor: SendAsAnchor?) async -> SendAsPage? {
        guard let fetcher, !accountID.isEmpty else { return nil }
        let key = Key(accountID: accountID, anchor: anchor)
        if let entry = entries[key], now().timeIntervalSince(entry.loadedAt) < Self.freshness {
            return entry.page
        }
        if let running = inFlight[key] { return await running.value }
        let task = Task<SendAsPage?, Never> {
            try? await fetcher.fetchSendAs(accountID: accountID, anchor: anchor)
        }
        inFlight[key] = task
        let page = await task.value
        // A read that started before `invalidate` does not write its old
        // list into the cache.
        if inFlight[key] == task {
            inFlight[key] = nil
            if let page { entries[key] = Entry(page: page, loadedAt: now()) }
        }
        return page
    }

    /// Drops every page of one mailbox, so the next read asks the server.
    func invalidate(accountID: String) {
        entries = entries.filter { $0.key.accountID != accountID }
        inFlight = inFlight.filter { $0.key.accountID != accountID }
    }

    func removeAll() {
        entries.removeAll()
        inFlight.removeAll()
    }
}
