import Foundation
import Observation

// Client-side cache of resolved sender photo URLs, keyed by lowercased email.
// Mail surfaces (inbox rows, thread headers) look up cached photos here and
// fall back to InitialsAvatar when nothing is cached — this store never
// implements provider/contact resolution itself, it only calls the existing
// `resolve_photos` tool (already batches provider lookup + company-logo
// fallback + 7-day server cache) and remembers the answer for the session.
@MainActor
@Observable
final class MailIdentityStore {
    private let tools: any ToolInvoking

    private(set) var photoURLs: [String: URL] = [:]
    private var negativeEmails: Set<String> = []

    init(tools: any ToolInvoking) {
        self.tools = tools
    }

    // Resolves photo URLs for a batch of (email, account) pairs, grouping by
    // account so each mailbox's senders are only ever resolved against ITS
    // OWN provider connection (a sender's provider contact photo lives on the
    // account that actually has them as a contact — resolving against the
    // wrong account silently returns nothing). Already-cached emails
    // (positive or negative) are dropped before any call goes out.
    func resolve(entries: [(email: String, account: String)]) async {
        var byAccount: [String: Set<String>] = [:]
        for entry in entries {
            let email = Self.normalize(entry.email)
            guard !email.isEmpty, email.contains("@") else { continue }
            guard photoURLs[email] == nil, !negativeEmails.contains(email) else { continue }
            let account = entry.account.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !account.isEmpty else { continue }
            byAccount[account, default: []].insert(email)
        }
        guard !byAccount.isEmpty else { return }
        // Sequential per-account calls: the account set here is small (the
        // user's connected mailboxes), and staying on MainActor avoids any
        // cross-isolation capture of this store in concurrent closures.
        for (account, emails) in byAccount.sorted(by: { $0.key < $1.key }) {
            await resolveGroup(account: account, emails: emails.sorted())
        }
    }

    func photoURL(for email: String?) -> URL? {
        guard let email else { return nil }
        let key = Self.normalize(email)
        return key.isEmpty ? nil : photoURLs[key]
    }

    private func resolveGroup(account: String, emails: [String]) async {
        guard !emails.isEmpty else { return }
        let result: JSONValue
        do {
            result = try await tools.invoke(
                "resolve_photos",
                arguments: [
                    "account": .string(account),
                    "emails": JSONValue.strings(emails),
                ]
            )
        } catch {
            // Best-effort: leave these emails uncached so a later resolve retries
            // rather than permanently treating a network hiccup as a miss.
            return
        }
        guard let photos = result["photos"]?.objectValue else { return }
        for (rawEmail, value) in photos {
            let email = Self.normalize(rawEmail)
            guard !email.isEmpty else { continue }
            if let urlString = value.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
               !urlString.isEmpty,
               let url = URL(string: urlString), url.scheme != nil {
                photoURLs[email] = url
            } else {
                negativeEmails.insert(email)
            }
        }
    }

    private static func normalize(_ email: String) -> String {
        email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}
