import Foundation

/// One snoozed thread from `list_snoozed`: what it is and when it comes back.
/// A snoozed thread is archived now and a server job brings it back, so no
/// search or label finds it. The Snoozed mailbox reads these rows instead.
struct MailSnoozedThread: Identifiable, Hashable, Sendable {
    /// The snooze row id.
    let id: String
    let accountID: String
    let accountEmail: String?
    let threadID: String
    let messageID: String?
    let until: Date
    let snoozedAt: Date?
    let subject: String
    let sender: String
    let snippet: String
    let lastDate: Date?

    init(
        id: String,
        accountID: String,
        accountEmail: String? = nil,
        threadID: String,
        messageID: String? = nil,
        until: Date,
        snoozedAt: Date? = nil,
        subject: String,
        sender: String,
        snippet: String = "",
        lastDate: Date? = nil
    ) {
        self.id = id
        self.accountID = accountID
        self.accountEmail = accountEmail
        self.threadID = threadID
        self.messageID = messageID
        self.until = until
        self.snoozedAt = snoozedAt
        self.subject = EmailTextNormalizer.header(subject).nilIfBlank ?? "(No subject)"
        self.sender = EmailTextNormalizer.header(sender).nilIfBlank ?? "Unknown sender"
        self.snippet = EmailTextNormalizer.preview(snippet)
        self.lastDate = lastDate
    }

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue?.nilIfBlank,
              let accountID = json["account"]?.stringValue?.nilIfBlank,
              let threadID = json["threadId"]?.stringValue?.nilIfBlank,
              let until = json["untilTs"]?.doubleValue.flatMap(CalendarDateParser.date(fromNumber:))
                ?? json["untilIso"]?.stringValue.flatMap(CalendarDateParser.date(fromString:)) else {
            return nil
        }
        self.init(
            id: id,
            accountID: accountID,
            accountEmail: json["accountEmail"]?.stringValue?.nilIfBlank,
            threadID: threadID,
            messageID: json["messageId"]?.stringValue?.nilIfBlank,
            until: until,
            snoozedAt: json["snoozedAt"]?.doubleValue.flatMap(CalendarDateParser.date(fromNumber:)),
            subject: json["subject"]?.stringValue ?? "",
            sender: json["fromAddress"]?.stringValue ?? "",
            snippet: json["snippet"]?.stringValue ?? "",
            lastDate: json["lastDate"]?.doubleValue.flatMap(CalendarDateParser.date(fromNumber:))
        )
    }

    /// The rows the Snoozed mailbox shows for an account scope and a search.
    /// No accounts means every account. The search matches the subject, the
    /// sender, and the snippet.
    static func filter(_ rows: [MailSnoozedThread], accounts: Set<String>, query: String) -> [MailSnoozedThread] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return rows.filter { row in
            (accounts.isEmpty || accounts.contains(row.accountID))
                && (text.isEmpty
                    || row.subject.localizedCaseInsensitiveContains(text)
                    || row.sender.localizedCaseInsensitiveContains(text)
                    || row.snippet.localizedCaseInsensitiveContains(text))
        }
    }

    /// The key the mail lists use for this thread.
    var threadKey: String { "\(accountID):\(threadID)" }

    var senderDisplayName: String {
        EmailTextNormalizer.displayName(from: sender) ?? sender
    }

    /// The inbox row this thread becomes when it comes back.
    var summary: MailThreadSummary {
        MailThreadSummary(
            id: threadID,
            accountID: accountID,
            subject: subject,
            sender: sender,
            snippet: snippet,
            date: lastDate ?? snoozedAt ?? until,
            unread: false,
            starred: false
        )
    }

    /// When the thread comes back, the way the web list says it:
    /// "Back today at 5:00 PM", "Back tomorrow at 9:00 AM",
    /// "Back Fri, Oct 2 at 9:00 AM", or "Due back now".
    func returnLabel(now: Date = .now, calendar: Calendar = .autoupdatingCurrent) -> String {
        guard until > now else { return "Due back now" }
        let locale = calendar.locale ?? .autoupdatingCurrent
        let time = until.formatted(
            Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        )
        if calendar.isDate(until, inSameDayAs: now) { return "Back today at \(time)" }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now),
           calendar.isDate(until, inSameDayAs: tomorrow) {
            return "Back tomorrow at \(time)"
        }
        var style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
            .weekday(.abbreviated)
            .month(.abbreviated)
            .day()
        if calendar.component(.year, from: until) != calendar.component(.year, from: now) {
            style = style.year()
        }
        return "Back \(until.formatted(style)) at \(time)"
    }
}
