import Foundation

// Pure helpers behind the thread reader: the reading width, the italic lead
// line under the subject, and the names a message header prints.

enum ThreadReaderMetrics {
    /// The reading column. Wider screens center it (D23).
    static let maxWidth: CGFloat = 680
}

/// The one line under the subject, in the machine's italic voice: how many
/// messages, and when the newest arrived. No middle dots; one sentence.
enum ThreadLeadCopy {
    static func line(
        messageCount: Int,
        lastDate: Date?,
        now: Date = .now,
        calendar: Calendar = .autoupdatingCurrent,
        locale: Locale = .autoupdatingCurrent
    ) -> String {
        let count = messageCount == 1 ? "1 message" : "\(messageCount) messages"
        guard let lastDate else { return count }
        let time = lastDate.formatted(
            Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        )
        let day = dayPhrase(for: lastDate, now: now, calendar: calendar, locale: locale)
        if messageCount == 1 {
            return "\(count), \(day.plain) at \(time)"
        }
        return "\(count), newest \(day.withPreposition) at \(time)"
    }

    struct DayPhrase: Equatable {
        let plain: String
        let withPreposition: String
    }

    static func dayPhrase(for date: Date, now: Date, calendar: Calendar, locale: Locale) -> DayPhrase {
        if calendar.isDate(date, inSameDayAs: now) {
            return DayPhrase(plain: "today", withPreposition: "today")
        }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) {
            return DayPhrase(plain: "yesterday", withPreposition: "yesterday")
        }
        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        let text: String
        if calendar.isDate(date, equalTo: now, toGranularity: .weekOfYear) {
            text = date.formatted(style.weekday(.wide))
        } else if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            text = date.formatted(style.month(.abbreviated).day())
        } else {
            text = date.formatted(style.month(.abbreviated).day().year())
        }
        return DayPhrase(plain: text, withPreposition: "on \(text)")
    }
}

/// The names in a recipients header ("Casey Morgan <casey@…>, priya@…"),
/// without the addresses. A long list ends with how many more.
enum RecipientNames {
    static func line(from header: String, limit: Int = 3) -> String {
        let names = mailboxes(in: header)
            .map { EmailTextNormalizer.displayName(from: $0) ?? $0 }
        guard !names.isEmpty else { return "" }
        if names.count <= limit { return names.joined(separator: ", ") }
        let rest = names.count - limit
        return names.prefix(limit).joined(separator: ", ") + ", and \(rest) more"
    }

    /// The mailboxes of a header, split at the commas between them. A comma
    /// inside a quoted name ("Doe, Jane" <jane@…>) or inside <…> stays.
    static func mailboxes(in header: String) -> [String] {
        var parts: [String] = []
        var current = ""
        var inQuotes = false
        var escaped = false
        var angleDepth = 0
        for character in header {
            if escaped {
                escaped = false
            } else if character == "\\", inQuotes {
                escaped = true
            } else if character == "\"" {
                inQuotes.toggle()
            } else if !inQuotes, character == "<" {
                angleDepth += 1
            } else if !inQuotes, character == ">" {
                angleDepth = max(angleDepth - 1, 0)
            } else if !inQuotes, angleDepth == 0, character == "," {
                parts.append(current)
                current = ""
                continue
            }
            current.append(character)
        }
        parts.append(current)
        return parts
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }
}
