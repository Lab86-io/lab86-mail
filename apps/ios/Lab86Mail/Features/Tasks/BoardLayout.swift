import Foundation

// The arithmetic behind the board, kept free of SwiftUI so it can be tested:
// how wide a column is for the space it has, and what the quiet line under a
// card title says.

enum BoardLayout {
    struct Plan: Equatable {
        // Every column fits in the space at once; no paging.
        let fits: Bool
        let columnWidth: CGFloat
        let spacing: CGFloat
        let inset: CGFloat
    }

    static let spacing: CGFloat = 12
    static let inset: CGFloat = 16
    // The narrowest column that still reads a card title on one or two lines.
    static let minimumFittedWidth: CGFloat = 220
    // A paged column on a phone: most of the width, with the next one peeking.
    static let pagedFraction: CGFloat = 0.82
    static let maximumPagedWidth: CGFloat = 340

    // Columns share the width when each gets at least the minimum (an iPad);
    // otherwise they page with the next column peeking (a phone). The third
    // column no longer cuts at the right edge of a wide window (D22).
    static func plan(available: CGFloat, count: Int) -> Plan {
        guard count > 0, available > 0 else {
            return Plan(fits: false, columnWidth: 0, spacing: spacing, inset: inset)
        }
        let shared = (available - inset * 2 - spacing * CGFloat(count - 1)) / CGFloat(count)
        if shared >= minimumFittedWidth {
            return Plan(fits: true, columnWidth: shared.rounded(.down), spacing: spacing, inset: inset)
        }
        let paged = min(available * pagedFraction, maximumPagedWidth)
        return Plan(fits: false, columnWidth: paged.rounded(.down), spacing: spacing, inset: inset)
    }
}

// The line under a card title: the priority and the due date as quiet text,
// joined with a comma, never as chips. Only an overdue date is red.
enum TaskMeta {
    struct Line: Equatable {
        let text: String
        let isOverdue: Bool
    }

    static func line(
        priority: String?,
        due: Date?,
        completed: Bool,
        now: Date = .now,
        calendar: Calendar = .autoupdatingCurrent
    ) -> Line? {
        var parts: [String] = []
        if let priority, let word = priorityWord(priority) {
            parts.append(word)
        }
        var overdue = false
        if let due {
            parts.append(dueText(due, now: now, calendar: calendar))
            overdue = !completed && due < now
        }
        guard !parts.isEmpty else { return nil }
        return Line(text: parts.joined(separator: ", "), isOverdue: overdue)
    }

    static func priorityWord(_ priority: String) -> String? {
        switch priority.lowercased() {
        case "high": "High priority"
        case "medium": "Medium priority"
        case "low": "Low priority"
        default: nil
        }
    }

    // "Today, 5:00 PM", "Tomorrow", "Oct 18". A past day keeps its date.
    static func dueText(_ due: Date, now: Date = .now, calendar: Calendar = .autoupdatingCurrent) -> String {
        if calendar.isDate(due, inSameDayAs: now) {
            return "Today, \(due.formatted(date: .omitted, time: .shortened))"
        }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now),
           calendar.isDate(due, inSameDayAs: tomorrow) {
            return "Tomorrow"
        }
        return due.formatted(.dateTime.month(.abbreviated).day())
    }
}
