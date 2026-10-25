import Combine
import ConvexMobile
import Foundation
import Kingfisher
import Observation
import SwiftUI

// Pure helpers behind the mail list: row identity, the three list states,
// the empty copy of each mailbox, the load-more failure rule, the status
// words a row shows, and the live unread counts of the category strip.

extension MailThreadSummary {
    /// The list identity of a row. The store dedupes on account and thread,
    /// so one mailbox connected two ways can hold the same thread id twice;
    /// a `ForEach` on the bare id would then raise a List inconsistency.
    var listKey: String { "\(accountID)|\(id)" }
}

// MARK: - List states

/// What the list shows in place of rows. A list that loads has three states:
/// loading, empty with an invitation to act, and rows. The failed state is
/// the mail alert, which the store raises.
enum MailListPlaceholder: Equatable {
    case loading(String)
    case loadMore
    case empty(MailEmptyCopy)

    static func resolve(
        mailDidLoad: Bool,
        searchPending: Bool,
        query: String,
        showsLoadMore: Bool,
        mailbox: MailboxScope,
        selection: MailScopeSelection = MailScopeSelection(),
        labelName: String? = nil,
        searchText: String
    ) -> MailListPlaceholder {
        if !query.isEmpty, searchPending { return .loading("Searching…") }
        if query.isEmpty, !mailDidLoad { return .loading("Loading mail…") }
        if showsLoadMore { return .loadMore }
        return .empty(MailEmptyCopy.make(mailbox: mailbox, selection: selection, labelName: labelName, searchText: searchText))
    }
}

/// A typed search or a mailbox query waits on the server until the store
/// has answered that query, or until the view saw the request end without
/// an answer (a failure). Before either, an empty list means "not yet".
enum MailSearchPending {
    static func isPending(query: String, completedQuery: String?, answeredQuery: String?) -> Bool {
        guard !query.isEmpty else { return false }
        if completedQuery == query { return false }
        return answeredQuery != query
    }
}

struct MailEmptyCopy: Equatable {
    let title: String
    let detail: String

    /// The empty state names what the view is, and what belongs in it. A
    /// typed search and a mailbox (Unread, Sent) come before the view.
    static func make(
        mailbox: MailboxScope,
        selection: MailScopeSelection = MailScopeSelection(),
        labelName: String? = nil,
        searchText: String
    ) -> MailEmptyCopy {
        if !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return MailEmptyCopy(title: "No matching mail", detail: "Try another word, or a sender's name.")
        }
        if mailbox == .inbox {
            if let labelName = labelName?.nilIfBlank, selection.labelID != nil {
                return MailEmptyCopy(title: "Nothing in \(labelName)", detail: "Mail you file under this label shows here.")
            }
            if let detail = viewDetail(selection.category) {
                return MailEmptyCopy(title: "Nothing in \(selection.category.title)", detail: detail)
            }
        }
        switch mailbox {
        case .inbox:
            return MailEmptyCopy(title: "No mail here", detail: "Pull down to refresh, or choose another account or view.")
        case .unread:
            return MailEmptyCopy(title: "Nothing unread", detail: "You have opened everything.")
        case .starred:
            return MailEmptyCopy(title: "Nothing starred", detail: "Star a thread to keep it here.")
        case .important:
            return MailEmptyCopy(title: "Nothing marked important", detail: "Mail your provider marks important shows here.")
        case .attachments:
            return MailEmptyCopy(title: "No attachments", detail: "Mail with files shows here.")
        case .thisWeek:
            return MailEmptyCopy(title: "No mail this week", detail: "Mail from the last seven days shows here.")
        case .snoozed:
            return MailEmptyCopy(title: "Nothing is snoozed", detail: "Snoozed mail comes back to the inbox at its time.")
        case .sent:
            return MailEmptyCopy(title: "Nothing sent yet", detail: "Mail you send shows here.")
        case .drafts:
            return MailEmptyCopy(title: "No drafts", detail: "A message you leave unsent is kept here.")
        case .allMail:
            return MailEmptyCopy(title: "No mail here", detail: "Pull down to refresh.")
        case .trash:
            return MailEmptyCopy(title: "Trash is empty", detail: "Mail you delete shows here.")
        }
    }

    /// What belongs in each view, for the view's empty state. Main and All
    /// mail are the inbox itself and keep the inbox copy.
    static func viewDetail(_ category: MailCategoryScope) -> String? {
        switch category {
        case .main, .all: nil
        case .needsReply: "Mail that waits on your reply shows here."
        case .noise: "Newsletters and notices that need nothing from you show here."
        case .codes: "Sign-in codes and confirmations show here."
        case .needsAction: "Mail that asks you to do something shows here."
        case .waitingFor: "Mail where you wait on someone else shows here."
        case .importantChanges: "Changes to plans, dates, and amounts show here."
        case .orders: "Orders, shipping, and receipts show here."
        case .financeAdmin: "Bills, statements, and account notices show here."
        case .review: "Mail to read when you have time shows here."
        }
    }
}

// MARK: - Load more

/// Whether an older-page load ended without a result. The cursor token
/// moves on success and `hasMore` turns off at the end, so a token that
/// stays put while the scope still has more, with no load in flight, is a
/// failed page. The row then offers Load more instead of a spinner that
/// never ends.
enum MailLoadMoreOutcome {
    static func failed(tokenBefore: String, tokenAfter: String, hasMore: Bool, isLoading: Bool) -> Bool {
        tokenBefore == tokenAfter && hasMore && !isLoading
    }
}

// MARK: - Row status words

/// The status words under a row: what the thread needs, whether it is
/// starred, and the labels it carries. Words, not glyphs, in the status
/// voice. A word the current view already states is left out.
enum MailRowBadges {
    static let needsReply = "Needs reply"
    static let starred = "Starred"
    static let limit = 3

    static func labels(
        for thread: MailThreadSummary,
        selection: MailScopeSelection,
        labels: [MailLabelSummary]
    ) -> [String] {
        var words: [String] = []
        let needsReply = thread.category == MailCategoryScope.needsReply.rawValue
            || (thread.secondaryCategories ?? []).contains(MailCategoryScope.needsReply.rawValue)
        if needsReply, selection.labelID != nil || selection.category != .needsReply {
            words.append(Self.needsReply)
        }
        if thread.starred { words.append(starred) }
        var labelIDs = thread.labelIDs ?? []
        if let filed = thread.category, MailCategoryScope.isFiled(filed) {
            let id = String(filed.dropFirst("custom:".count))
            if !id.isEmpty, !labelIDs.contains(id) { labelIDs.insert(id, at: 0) }
        }
        for id in labelIDs where id != selection.labelID {
            guard let name = labels.first(where: { $0.id == id })?.name else { continue }
            if !words.contains(name) { words.append(name) }
        }
        return Array(words.prefix(limit))
    }
}

// MARK: - Category counts

/// The count beside a category pill, the web rule (`unreadBadgeLabel`):
/// nothing for zero, nothing at one hundred and above.
enum MailCategoryCountBadge {
    static func label(_ unread: Double?) -> String? {
        guard let unread, unread > 0, unread < 100 else { return nil }
        return String(Int(unread.rounded(.down)))
    }
}

/// The `liveMail:categoryCounts` result: unread counts by category id.
struct MailCategoryCountsPayload: Decodable, Sendable {
    struct Entry: Decodable, Sendable {
        let unread: Double
        let attention: Bool?
    }

    let counts: [String: Entry]
}

/// Live unread counts for the category strip, from the same Convex query
/// the web rail reads. The counts cover every connected mailbox.
@MainActor
@Observable
final class MailCategoryCountsModel {
    private(set) var unread: [String: Double] = [:]

    func apply(_ payload: MailCategoryCountsPayload) {
        unread = payload.counts.mapValues(\.unread)
    }

    func badge(for scope: MailCategoryScope) -> String? {
        MailCategoryCountBadge.label(unread[scope.rawValue])
    }

    func follow(convex: ConvexClientWithAuth<String>?) async {
        guard let convex else { return }
        while !Task.isCancelled {
            do {
                let updates = convex.subscribe(
                    to: "liveMail:categoryCounts",
                    with: [:],
                    yielding: MailCategoryCountsPayload.self
                ).values
                for try await payload in updates {
                    guard !Task.isCancelled else { return }
                    apply(payload)
                }
            } catch {
                if error.isCancellation { return }
                // The counts are a convenience; the strip works without them.
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }
}

// MARK: - Sender avatar

/// A sender's photo when the identity store has one, initials otherwise, in
/// one geometry. The mark scales with the text up to a cap and keeps its
/// initials at the standard size, so large text never shows "…" (D3).
struct SenderAvatar: View {
    @Environment(AppEnvironment.self) private var environment
    @ScaledMetric(relativeTo: .body) private var scaled: CGFloat = 40
    let name: String
    let email: String?
    var baseSize: CGFloat = 40

    static let maximumScale: CGFloat = 1.4

    var size: CGFloat { Self.resolvedSize(scaled: scaled, base: baseSize) }

    static func resolvedSize(scaled: CGFloat, base: CGFloat) -> CGFloat {
        // `scaled` grows from 40 with the text; the mark follows it to 1.4x.
        min(base * scaled / 40, base * maximumScale)
    }

    var body: some View {
        Group {
            if let url = environment.mailIdentity.photoURL(for: email) {
                KFImage(url)
                    .placeholder { initials }
                    .fade(duration: 0.15)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: size, height: size)
                    .clipShape(Circle())
            } else {
                initials
            }
        }
        .accessibilityHidden(true)
    }

    private var initials: some View {
        InitialsAvatar(name: name, size: size)
            .dynamicTypeSize(.large)
            .minimumScaleFactor(0.6)
            .lineLimit(1)
    }
}
