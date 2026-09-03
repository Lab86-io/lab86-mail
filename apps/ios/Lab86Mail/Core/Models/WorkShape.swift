import Foundation

// The shape of one Work, and the data each shape owns.
//
// A mirror of `lib/albatross/work-shape.ts`, `lib/albatross/shape-policy.ts`
// and `lib/albatross/practice-review.ts`. A list keeps items and is never
// planned. A practice logs a number. A project holds milestones and reads
// its artifacts as proof. The policy table decides which detail body the
// client draws and which plan affordances it hides.

enum WorkShape: String, Codable, Hashable, Sendable, CaseIterable {
    case quick
    case list
    case project
    case practice
    case decision
    case monitor
    case recurring

    /// The shape a row without one is read as. Work from before shapes
    /// existed was planned, watched, and reviewed; `quick` is that contract.
    static let `default`: WorkShape = .quick

    /// Unknown or missing values fall back to the default.
    static func resolve(_ raw: String?) -> WorkShape {
        raw.flatMap(WorkShape.init(rawValue:)) ?? .default
    }

    /// The shape word as the lead prints it.
    var label: String {
        switch self {
        case .quick: "Quick"
        case .list: "List"
        case .project: "Project"
        case .practice: "Practice"
        case .decision: "Decision"
        case .monitor: "Monitor"
        case .recurring: "Recurring"
        }
    }

    /// One short line per shape, for the picker. The same words as the web.
    var meaning: String {
        switch self {
        case .quick: "One thing to finish. Steps and checks."
        case .list: "Items to keep. No steps, no checks."
        case .project: "Milestones and a log."
        case .practice: "Log a number over time."
        case .decision: "Options, then one choice."
        case .monitor: "Watch for a change."
        case .recurring: "A task that comes back."
        }
    }

    /// How the planner treats the shape. `false` means no plan is ever
    /// written, so the detail hides every plan and step affordance.
    var plans: Bool {
        switch self {
        case .quick, .project, .decision: true
        case .list, .practice, .monitor, .recurring: false
        }
    }

    /// Which detail body the client draws.
    enum Detail: String, Sendable {
        case guided, list, milestones, practice, decision, monitor, routine
    }

    var detail: Detail {
        switch self {
        case .quick: .guided
        case .list: .list
        case .project: .milestones
        case .practice: .practice
        case .decision: .decision
        case .monitor: .monitor
        case .recurring: .routine
        }
    }
}

/// One item on a list. `WorkListItem` is the Work row; this is a line in it.
struct WorkListEntry: Identifiable, Hashable, Codable, Sendable {
    let id: String
    var text: String
    var done: Bool
    let addedAt: Date
    var doneAt: Date?

    init(id: String, text: String, done: Bool = false, addedAt: Date, doneAt: Date? = nil) {
        self.id = id
        self.text = text
        self.done = done
        self.addedAt = addedAt
        self.doneAt = doneAt
    }

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue?.nilIfBlank,
              let text = json["text"]?.stringValue?.nilIfBlank else { return nil }
        self.id = id
        self.text = text
        done = json["done"]?.boolValue ?? false
        addedAt = CalendarDateParser.date(json["addedAt"]) ?? .distantPast
        doneAt = CalendarDateParser.date(json["doneAt"])
    }

    /// The same item with the done flag flipped. The optimistic write.
    func toggled(at now: Date) -> WorkListEntry {
        WorkListEntry(id: id, text: text, done: !done, addedAt: addedAt, doneAt: done ? nil : now)
    }
}

enum WorkListOrdering {
    /// Open items in the order they were added, then done items with the
    /// most recent check first. A checked item settles to the bottom.
    static func ordered(_ items: [WorkListEntry]) -> [WorkListEntry] {
        let open = items.filter { !$0.done }.sorted { $0.addedAt < $1.addedAt }
        let done = items.filter(\.done).sorted { ($0.doneAt ?? .distantPast) > ($1.doneAt ?? .distantPast) }
        return open + done
    }

    /// The trailing row text. Nil when nothing is done.
    static func showDoneLabel(count: Int, showing: Bool) -> String? {
        guard count > 0 else { return nil }
        if showing { return "Hide done" }
        return count == 1 ? "Show 1 done" : "Show \(count) done"
    }
}

struct WorkMetric: Hashable, Codable, Sendable {
    enum Direction: String, Codable, Hashable, Sendable {
        case down, up
    }

    let name: String
    let unit: String
    let target: Double?
    let direction: Direction?

    init(name: String, unit: String, target: Double? = nil, direction: Direction? = nil) {
        self.name = name
        self.unit = unit
        self.target = target
        self.direction = direction
    }

    init?(json: JSONValue?) {
        guard let json, json.objectValue != nil,
              let name = json["name"]?.stringValue?.nilIfBlank else { return nil }
        self.name = name
        unit = json["unit"]?.stringValue ?? ""
        target = json["target"]?.doubleValue
        direction = json["direction"]?.stringValue.flatMap(Direction.init(rawValue:))
    }
}

struct WorkMetricEntry: Identifiable, Hashable, Codable, Sendable {
    let id: String
    let at: Date
    let value: Double
    let note: String?

    init(id: String, at: Date, value: Double, note: String? = nil) {
        self.id = id
        self.at = at
        self.value = value
        self.note = note
    }

    init?(json: JSONValue) {
        guard let id = json["_id"]?.stringValue ?? json["id"]?.stringValue,
              let value = json["value"]?.doubleValue,
              let at = CalendarDateParser.date(json["at"]) else { return nil }
        self.id = id
        self.at = at
        self.value = value
        note = json["note"]?.stringValue?.nilIfBlank
    }
}

struct WorkMetricSummary: Hashable, Codable, Sendable {
    let latest: Double?
    let latestAt: Date?
    let count: Int
    /// Distinct weeks with at least one log, over the last 12 weeks.
    let weeksWithEntry: Int

    init(latest: Double?, latestAt: Date?, count: Int, weeksWithEntry: Int) {
        self.latest = latest
        self.latestAt = latestAt
        self.count = count
        self.weeksWithEntry = weeksWithEntry
    }

    init?(json: JSONValue?) {
        guard let json, json.objectValue != nil else { return nil }
        latest = json["latest"]?.doubleValue
        latestAt = CalendarDateParser.date(json["latestAt"])
        count = max(0, Int(json["count"]?.doubleValue ?? 0))
        weeksWithEntry = max(0, Int(json["weeksWithEntry"]?.doubleValue ?? 0))
    }
}

struct WorkMilestone: Identifiable, Hashable, Codable, Sendable {
    let id: String
    var title: String
    var done: Bool
    var doneAt: Date?
    var order: Int

    init(id: String, title: String, done: Bool = false, doneAt: Date? = nil, order: Int) {
        self.id = id
        self.title = title
        self.done = done
        self.doneAt = doneAt
        self.order = order
    }

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue?.nilIfBlank,
              let title = json["title"]?.stringValue?.nilIfBlank else { return nil }
        self.id = id
        self.title = title
        done = json["done"]?.boolValue ?? false
        doneAt = CalendarDateParser.date(json["doneAt"])
        order = max(0, Int(json["order"]?.doubleValue ?? 0))
    }

    func toggled(at now: Date) -> WorkMilestone {
        WorkMilestone(id: id, title: title, done: !done, doneAt: done ? nil : now, order: order)
    }
}

enum WorkMilestoneRail {
    /// Milestones in rail order.
    static func ordered(_ milestones: [WorkMilestone]) -> [WorkMilestone] {
        milestones.sorted { ($0.order, $0.id) < ($1.order, $1.id) }
    }

    /// The first open milestone in rail order: the one drawn with an accent ring.
    static func currentID(_ milestones: [WorkMilestone]) -> String? {
        ordered(milestones).first { !$0.done }?.id
    }
}

// MARK: - Practice review

/// The words a practice writes from its numbers. No model call. A mirror of
/// `lib/albatross/practice-review.ts`; both test suites pin the sentences.
enum PracticeReview {
    static let summaryWeeks = 12
    private static let day: TimeInterval = 24 * 60 * 60
    private static let week: TimeInterval = 7 * day

    private static func sorted(_ entries: [WorkMetricEntry]) -> [WorkMetricEntry] {
        entries.filter { $0.value.isFinite }.sorted { $0.at < $1.at }
    }

    /// Week bucket relative to now: 0 is the current week, 1 the week before.
    static func weekIndex(_ at: Date, now: Date) -> Int {
        Int((max(0, now.timeIntervalSince(at)) / week).rounded(.down))
    }

    /// Distinct weeks with a log inside the last `weeks` weeks.
    static func weeksWithEntry(_ entries: [WorkMetricEntry], now: Date, weeks: Int = summaryWeeks) -> Int {
        var seen = Set<Int>()
        for entry in entries where entry.at <= now {
            let index = weekIndex(entry.at, now: now)
            if index < weeks { seen.insert(index) }
        }
        return seen.count
    }

    static func summary(_ entries: [WorkMetricEntry], now: Date) -> WorkMetricSummary {
        let rows = sorted(entries)
        let latest = rows.last
        return WorkMetricSummary(
            latest: latest?.value,
            latestAt: latest?.at,
            count: rows.count,
            weeksWithEntry: weeksWithEntry(rows, now: now)
        )
    }

    /// A number with at most one decimal, and no trailing zero. The sign is
    /// dropped: the sentence carries the direction.
    static func formatValue(_ value: Double, unit: String = "") -> String {
        let rounded = (abs(value) * 10).rounded() / 10
        let text: String
        if rounded == rounded.rounded(.towardZero) {
            text = String(Int(rounded))
        } else {
            text = String(format: "%.1f", locale: Locale(identifier: "en_US_POSIX"), rounded)
        }
        return unit.isEmpty ? text : "\(text) \(unit)"
    }

    private static func spanWords(from: Date, to: Date) -> String {
        let days = max(1, Int((to.timeIntervalSince(from) / day).rounded()))
        if days < 7 { return days == 1 ? "one day" : "\(days) days" }
        let weeks = Int((Double(days) / 7).rounded())
        return weeks == 1 ? "one week" : "\(weeks) weeks"
    }

    /// The week-strip pills: one flag per week for the last `weeks` weeks,
    /// oldest first, true when that week has a log.
    static func weekStrip(_ entries: [WorkMetricEntry], now: Date, weeks: Int = summaryWeeks) -> [Bool] {
        var logged = Set<Int>()
        for entry in entries where entry.at <= now {
            let index = weekIndex(entry.at, now: now)
            if index < weeks { logged.insert(index) }
        }
        return (0..<weeks).reversed().map { logged.contains($0) }
    }

    /// One sentence on the change, and one on the streak. For example:
    /// "Down 2.4 lb over 3 weeks. 5 of the last 6 weeks have a log."
    static func reviewLine(_ entries: [WorkMetricEntry], metric: WorkMetric?, now: Date) -> String {
        let rows = sorted(entries).filter { $0.at <= now }
        guard let first = rows.first, let last = rows.last else {
            return "Log the first number to start the trend."
        }
        if rows.count == 1 { return "One log so far. Add the next when you want." }
        let unit = metric?.unit ?? ""
        let change = last.value - first.value
        let span = spanWords(from: first.at, to: last.at)
        let trend: String
        if abs(change) < 0.05 {
            trend = "No change over \(span)."
        } else {
            trend = "\(change < 0 ? "Down" : "Up") \(formatValue(change, unit: unit)) over \(span)."
        }

        let windowWeeks = min(summaryWeeks, weekIndex(first.at, now: now) + 1)
        let logged = weeksWithEntry(rows, now: now, weeks: windowWeeks)
        let streak: String
        if windowWeeks <= 1 {
            streak = "\(rows.count) logs this week."
        } else if logged == windowWeeks {
            streak = "Every one of the last \(windowWeeks) weeks has a log."
        } else {
            streak = "\(logged) of the last \(windowWeeks) weeks have a log."
        }

        guard let target = metric?.target else { return "\(trend) \(streak)" }
        let gap = target - last.value
        let reached: Bool
        switch metric?.direction {
        case .down: reached = last.value <= target
        case .up: reached = last.value >= target
        case nil: reached = gap == 0
        }
        let targetLine = reached ? "At the target." : "\(formatValue(gap, unit: unit)) to the target."
        return "\(trend) \(streak) \(targetLine)"
    }

    /// The line under the big number: "Down 2.4 lb since 4 Aug". Nil with
    /// fewer than two logs.
    static func changeLine(
        _ entries: [WorkMetricEntry],
        unit: String,
        now: Date,
        calendar: Calendar = .current
    ) -> String? {
        let rows = sorted(entries).filter { $0.at <= now }
        guard let first = rows.first, let last = rows.last, rows.count > 1 else { return nil }
        let change = last.value - first.value
        let since = first.at.formatted(
            Date.FormatStyle(locale: Locale(identifier: "en_US"), calendar: calendar, timeZone: calendar.timeZone)
                .day().month(.abbreviated)
        )
        if abs(change) < 0.05 { return "No change since \(since)" }
        return "\(change < 0 ? "Down" : "Up") \(formatValue(change, unit: unit)) since \(since)"
    }

    /// "Logged in 4 of the last 5 weeks." Nil before the first log.
    static func stripLine(_ entries: [WorkMetricEntry], now: Date) -> String? {
        let rows = sorted(entries).filter { $0.at <= now }
        guard let first = rows.first else { return nil }
        let windowWeeks = min(summaryWeeks, weekIndex(first.at, now: now) + 1)
        let logged = weeksWithEntry(rows, now: now, weeks: windowWeeks)
        if windowWeeks <= 1 { return "Logged this week." }
        return "Logged in \(logged) of the last \(windowWeeks) weeks."
    }
}

// MARK: - Project log

/// The artifact log under the milestone rail. Evidence rows in time order,
/// each named by its kind.
enum ProjectLog {
    static func kindWord(_ sourceKind: String) -> String {
        switch sourceKind {
        case "github_commit": "Commit"
        case "github_pull_request": "Pull request"
        case "github_issue": "Issue"
        case "github_project", "github_project_item": "Board"
        case "mcp_item": "Doc"
        case "mail_thread": "Email"
        case "calendar_event": "Event"
        case "task": "Task"
        case "chat": "Chat"
        case "question_answer": "Answer"
        case "browser_session": "Page"
        case "manual": "Note"
        default: "Artifact"
        }
    }

    /// Newest first. Rows without a time sit at the end.
    static func ordered(_ evidence: [WorkDetail.Evidence]) -> [WorkDetail.Evidence] {
        evidence.sorted { ($0.occurredAt ?? .distantPast) > ($1.occurredAt ?? .distantPast) }
    }

    /// "Last touched 2 days ago". Reads the user's last touch, then the newest
    /// artifact, then the Work's own change date.
    static func lastTouchedLine(
        lastUserTouchAt: Date?,
        evidence: [WorkDetail.Evidence],
        updatedAt: Date?,
        now: Date
    ) -> String? {
        let candidates = [lastUserTouchAt, ordered(evidence).first?.occurredAt, updatedAt].compactMap { $0 }
        guard let latest = candidates.max() else { return nil }
        return "Last touched \(relative(latest, now: now))"
    }

    static func relative(_ date: Date, now: Date) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        let minutes = Int(seconds / 60)
        if minutes < 1 { return "just now" }
        if minutes < 60 { return minutes == 1 ? "1 minute ago" : "\(minutes) minutes ago" }
        let hours = minutes / 60
        if hours < 24 { return hours == 1 ? "1 hour ago" : "\(hours) hours ago" }
        let days = hours / 24
        if days < 7 { return days == 1 ? "yesterday" : "\(days) days ago" }
        let weeks = days / 7
        if weeks < 5 { return weeks == 1 ? "1 week ago" : "\(weeks) weeks ago" }
        let months = days / 30
        if months < 12 { return months <= 1 ? "1 month ago" : "\(months) months ago" }
        let years = days / 365
        return years <= 1 ? "1 year ago" : "\(years) years ago"
    }
}
