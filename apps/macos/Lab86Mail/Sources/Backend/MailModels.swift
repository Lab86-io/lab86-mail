import Foundation

// Wire shapes for the Convex `liveMail` module. Field names must match the
// normalize* helpers in convex/liveMail.ts and convex/smart.ts exactly.

struct AccountsResult: Decodable {
    var accounts: [MailAccount]
}

struct MailAccount: Decodable, Identifiable, Hashable {
    var accountId: String
    var email: String
    var provider: String
    var authed: Bool
    var displayName: String?
    var sync: SyncStatus?

    var id: String { accountId }
    var label: String { displayName?.isEmpty == false ? displayName! : email }

    struct SyncStatus: Decodable, Hashable {
        var status: String
        var corpusReady: Bool
        var messagesSynced: Double?
        var error: String?
        var lastSyncAt: Double?
    }
}

struct ThreadListResult: Decodable {
    var items: [MailThread]
    var nextPageToken: String?
}

struct MailThread: Decodable, Identifiable, Hashable {
    var _id: String
    var account: String
    var subject: String
    var fromAddress: String
    var lastDate: Double
    var snippet: String
    var labels: [String]
    var unread: Bool
    var starred: Bool
    var messageCount: Double
    var smartCategory: SmartVerdict?

    var id: String { "\(account):\(_id)" }
    var threadId: String { _id }
    var date: Date { Date(timeIntervalSince1970: lastDate / 1000) }
    var fromDisplay: String { EmailAddress.displayName(from: fromAddress) }
}

struct SmartVerdict: Decodable, Hashable {
    var primary: String?
    var secondary: [String]?
    var customLabels: [String]?
    var needsAttention: Bool?
    var confidence: Double?
    var model: String?
}

struct ThreadDetail: Decodable {
    var threadId: String
    var subject: String
    var messages: [MailMessage]
    var summary: String?
}

struct MailMessage: Decodable, Identifiable, Hashable {
    var _id: String
    var threadId: String
    var account: String
    var subject: String
    var from: String
    var to: String
    var cc: String
    var bcc: String
    var date: Double
    var snippet: String
    var textBody: String
    var htmlBody: String?
    var labels: [String]
    var unread: Bool
    var starred: Bool
    var attachments: [MailAttachment]

    var id: String { _id }
    var receivedAt: Date { Date(timeIntervalSince1970: date / 1000) }
    var fromDisplay: String { EmailAddress.displayName(from: from) }
    var fromEmail: String { EmailAddress.address(from: from) }
}

// Attachment metadata is provider-shaped (`v.any()` in the corpus schema), so
// decode both snake_case and camelCase variants leniently.
struct MailAttachment: Decodable, Identifiable, Hashable {
    var id: String
    var filename: String
    var contentType: String
    var size: Double?
    var isInline: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        func str(_ keys: [String]) -> String? {
            for k in keys {
                if let v = try? c.decodeIfPresent(String.self, forKey: AnyKey(k)) { return v }
            }
            return nil
        }
        id = str(["id", "attachmentId", "attachment_id"]) ?? UUID().uuidString
        filename = str(["filename", "name"]) ?? "attachment"
        contentType = str(["contentType", "content_type", "mime"]) ?? "application/octet-stream"
        size = (try? c.decodeIfPresent(Double.self, forKey: AnyKey("size"))) ?? nil
        isInline = ((try? c.decodeIfPresent(Bool.self, forKey: AnyKey("isInline"))) ?? nil)
            ?? ((try? c.decodeIfPresent(Bool.self, forKey: AnyKey("is_inline"))) ?? nil)
            ?? false
    }

    private struct AnyKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(_ s: String) { stringValue = s }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }
}

struct CategoryCountsResult: Decodable {
    var counts: [String: CategoryCount]
    var cap: Double?

    struct CategoryCount: Decodable {
        var unread: Double?
        var attention: Bool?
    }
}

// Mirrors SMART_CATEGORY_IDS in lib/mail/smart-categories.ts.
enum SmartCategory: String, CaseIterable, Identifiable {
    case main, needsReply = "needs_reply", codes, orders
    case financeAdmin = "finance_admin", noise, review

    var id: String { rawValue }

    var title: String {
        switch self {
        case .main: "Main"
        case .needsReply: "Needs Reply"
        case .codes: "Codes"
        case .orders: "Orders"
        case .financeAdmin: "Finance/Admin"
        case .noise: "Noise"
        case .review: "Review"
        }
    }

    var symbol: String {
        switch self {
        case .main: "tray.full"
        case .needsReply: "bubble.left.and.text.bubble.right"
        case .codes: "key"
        case .orders: "shippingbox"
        case .financeAdmin: "creditcard"
        case .noise: "bell.slash"
        case .review: "person.crop.circle.badge.questionmark"
        }
    }
}

// Mirrors QUICK_SEARCH_QUERIES in lib/mail/search/constants.ts.
enum QuickSearch: String, CaseIterable, Identifiable {
    case unread, starred, important, attachments, thisWeek, sent, drafts, allMail, trash

    var id: String { rawValue }

    var title: String {
        switch self {
        case .unread: "Unread"
        case .starred: "Starred"
        case .important: "Important"
        case .attachments: "Attachments"
        case .thisWeek: "This Week"
        case .sent: "Sent"
        case .drafts: "Drafts"
        case .allMail: "All Mail"
        case .trash: "Trash"
        }
    }

    var symbol: String {
        switch self {
        case .unread: "envelope.badge"
        case .starred: "star"
        case .important: "flame"
        case .attachments: "paperclip"
        case .thisWeek: "calendar"
        case .sent: "paperplane"
        case .drafts: "pencil.line"
        case .allMail: "archivebox"
        case .trash: "trash"
        }
    }

    var query: String {
        switch self {
        case .unread: "is:unread newer_than:30d"
        case .starred: "is:starred newer_than:365d"
        case .important: "is:important newer_than:60d"
        case .attachments: "has:attachment newer_than:90d"
        case .thisWeek: "newer_than:7d"
        case .sent: "in:sent newer_than:365d"
        case .drafts: "in:drafts newer_than:365d"
        case .allMail: "-in:trash newer_than:365d"
        case .trash: "in:trash newer_than:365d"
        }
    }
}

enum EmailAddress {
    // "Jane Doe <jane@x.com>" → "Jane Doe"; bare addresses pass through.
    static func displayName(from raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        if let lt = trimmed.firstIndex(of: "<") {
            let name = trimmed[..<lt]
                .trimmingCharacters(in: .whitespaces)
                .trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            if !name.isEmpty { return name }
        }
        return address(from: trimmed)
    }

    static func address(from raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        if let lt = trimmed.firstIndex(of: "<"), let gt = trimmed.firstIndex(of: ">"), lt < gt {
            return String(trimmed[trimmed.index(after: lt)..<gt])
        }
        return trimmed
    }

    static func initials(from raw: String) -> String {
        let name = displayName(from: raw)
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        if letters.isEmpty { return name.prefix(1).uppercased() }
        return letters.joined().uppercased()
    }
}
