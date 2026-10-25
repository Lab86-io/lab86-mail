import Foundation

/// The smart categories the server accepts for "Correct smart category":
/// `SMART_CATEGORY_IDS` in lib/mail/smart-categories.ts, in the server's
/// order, with sentence-case names. The Area inbox menu reads this list, so
/// it can never offer a category the server rejects.
enum SmartCategoryChoice: String, CaseIterable, Identifiable, Sendable {
    case main
    case needsReply = "needs_reply"
    case codes
    case orders
    case financeAdmin = "finance_admin"
    case noise
    case review

    var id: String { rawValue }

    var label: String {
        switch self {
        case .main: "Main"
        case .needsReply: "Needs reply"
        case .codes: "Codes"
        case .orders: "Orders"
        case .financeAdmin: "Finance and admin"
        case .noise: "Noise"
        case .review: "Review"
        }
    }
}

/// When an Area page polls for its brief: while the server says the brief is
/// generating, every few seconds, until it is ready or failed (W3).
enum AreaBriefPolling {
    static let interval: Duration = .seconds(4)

    static func shouldPoll(status: String?) -> Bool {
        status == "generating"
    }
}
