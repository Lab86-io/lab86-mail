import Foundation

// Needs you: the page groups (a port of `lib/obligations/groups.ts`). Pure:
// the server gives the items, this file sorts them into the groups of
// `NeedsYouContract.groupOrder` for one moment in the user's time zone.
// NeedsYouGroupingTests holds it to the web's answers.

/// The day arithmetic of the page in one IANA zone (`horizonClock`). A zone
/// the device does not know falls back to the device zone, as on the web.
struct NeedsYouClock: Sendable {
    let timeZone: TimeZone
    private let calendar: Calendar

    static let dayMillis: ObligationMillis = 24 * 60 * 60 * 1_000
    static let hourMillis: ObligationMillis = 60 * 60 * 1_000
    static let minuteMillis: ObligationMillis = 60 * 1_000

    init(timezone: String?) {
        timeZone = Self.safeTimeZone(timezone) ?? .current
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        self.calendar = calendar
    }

    /// A zone the system accepts, or nil for the device zone (`safeTimeZone`).
    static func safeTimeZone(_ timezone: String?) -> TimeZone? {
        guard let timezone, !timezone.isEmpty else { return nil }
        return TimeZone(identifier: timezone)
    }

    static func date(_ millis: ObligationMillis) -> Date {
        Date(timeIntervalSince1970: millis / 1_000)
    }

    static func millis(_ date: Date) -> ObligationMillis {
        (date.timeIntervalSince1970 * 1_000).rounded()
    }

    /// Midnight of the day that holds `millis`, in the zone.
    func startOfDay(_ millis: ObligationMillis) -> ObligationMillis {
        Self.millis(calendar.startOfDay(for: Self.date(millis)))
    }

    /// Midnight `days` days after the day that holds `millis`. The calendar
    /// adds the days, so a daylight change inside the span keeps midnight.
    func startOfDay(_ millis: ObligationMillis, plusDays days: Int) -> ObligationMillis {
        let start = calendar.startOfDay(for: Self.date(millis))
        let shifted = calendar.date(byAdding: .day, value: days, to: start) ?? start
        return Self.millis(calendar.startOfDay(for: shifted))
    }

    /// The weekday of the day that holds `millis`, with Sunday as 0, as
    /// JavaScript counts it.
    func weekday(_ millis: ObligationMillis) -> Int {
        calendar.component(.weekday, from: Self.date(millis)) - 1
    }

    /// Whole days from the day of `now` to the day of `millis`. A daylight
    /// change makes a day 23 or 25 hours; the rounding keeps the count whole.
    func dayDistance(_ millis: ObligationMillis, from now: ObligationMillis) -> Int {
        Int(((startOfDay(millis) - startOfDay(now)) / Self.dayMillis).rounded())
    }
}

/// The Albatross items the page lists beside the obligations: questions,
/// approvals, and check-ins (`NeedsYouExtraLike`).
struct NeedsYouExtra: Identifiable, Hashable, Sendable {
    enum Kind: String, Hashable, Sendable {
        case question
        case approval
        case checkin
        case update
    }

    let id: String
    var kind: Kind
    var attention: Bool
    var createdAt: ObligationMillis?
    /// The words of the row: the Albatross title and the prompt.
    var title: String
    var line: String?
    var workID: String?

    init(
        id: String,
        kind: Kind,
        attention: Bool = true,
        createdAt: ObligationMillis? = nil,
        title: String = "Albatross",
        line: String? = nil,
        workID: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.attention = attention
        self.createdAt = createdAt
        self.title = title
        self.line = line
        self.workID = workID
    }
}

enum NeedsYouEntry: Identifiable, Hashable, Sendable {
    case obligation(ObligationView)
    case albatross(NeedsYouExtra)

    var id: String {
        switch self {
        case .obligation(let obligation): obligation.id
        case .albatross(let extra): extra.id
        }
    }

    var obligation: ObligationView? {
        if case .obligation(let obligation) = self { return obligation }
        return nil
    }
}

struct NeedsYouGroup: Identifiable, Hashable, Sendable {
    let id: NeedsYouGroupID
    let entries: [NeedsYouEntry]

    var label: String { id.label }
}

struct NeedsYouSummary: Hashable, Sendable {
    let now: Int
    let open: Int
    let closedToday: Int

    /// "3 now · 9 open · 3 closed today", with the zero parts left out.
    var line: String {
        var parts: [String] = []
        if now > 0 { parts.append("\(now) now") }
        parts.append("\(open) open")
        if closedToday > 0 { parts.append("\(closedToday) closed today") }
        return parts.joined(separator: " · ")
    }
}

enum NeedsYouLaterOptionID: String, Hashable, Sendable {
    case laterToday = "later_today"
    case tomorrowMorning = "tomorrow_morning"
    case nextWeek = "next_week"
}

struct NeedsYouLaterOption: Identifiable, Hashable, Sendable {
    let id: NeedsYouLaterOptionID
    let label: String
    let until: ObligationMillis
}

enum NeedsYouGrouping {
    private static let morningHour: ObligationMillis = 9

    private struct DayBounds {
        let startOfToday: ObligationMillis
        let startOfTomorrow: ObligationMillis
        let startOfWeekAfter: ObligationMillis

        init(now: ObligationMillis, clock: NeedsYouClock) {
            startOfToday = clock.startOfDay(now)
            startOfTomorrow = clock.startOfDay(now, plusDays: 1)
            startOfWeekAfter = clock.startOfDay(now, plusDays: 7)
        }
    }

    private static func openCodeExpiry(_ obligation: ObligationView) -> ObligationMillis? {
        guard obligation.kind == .code, !obligation.isClosed else { return nil }
        return obligation.code?.expiresAt
    }

    /// The snapshot does not read again when time passes. An open code past
    /// its expiry reads as expired here, so it leaves Now and loses Copy
    /// code before the server sweep closes the row (`settleExpiredCodes`).
    static func settleExpiredCodes(_ items: [ObligationView], now: ObligationMillis) -> [ObligationView] {
        items.map { obligation in
            guard let expiresAt = openCodeExpiry(obligation), expiresAt <= now else { return obligation }
            var settled = obligation
            settled.state = .expired
            settled.closeReason = .expired
            settled.closedAt = expiresAt
            return settled
        }
    }

    /// The soonest expiry of an open code after `now`, so the page can wake
    /// at that time (`nextCodeExpiry`).
    static func nextCodeExpiry(_ items: [ObligationView], now: ObligationMillis) -> ObligationMillis? {
        var next: ObligationMillis?
        for obligation in items {
            guard let expiresAt = openCodeExpiry(obligation), expiresAt > now else { continue }
            if let current = next, current <= expiresAt { continue }
            next = expiresAt
        }
        return next
    }

    /// The group of one obligation, or nil when the page hides it: closed
    /// before today, or snoozed until a later time (`obligationGroup`).
    static func group(
        of obligation: ObligationView,
        now: ObligationMillis,
        timezone: String?
    ) -> NeedsYouGroupID? {
        group(of: obligation, now: now, bounds: DayBounds(now: now, clock: NeedsYouClock(timezone: timezone)))
    }

    private static func group(
        of obligation: ObligationView,
        now: ObligationMillis,
        bounds: DayBounds
    ) -> NeedsYouGroupID? {
        if obligation.isClosed {
            return (obligation.closedAt ?? obligation.updatedAt) >= bounds.startOfToday ? .closedToday : nil
        }
        if obligation.state == .snoozed, (obligation.snoozedUntil ?? 0) > now { return nil }
        if obligation.kind == .waiting { return .waiting }
        if obligation.kind == .code || obligation.pushLevel == .timeSensitive { return .now }
        if let dueAt = obligation.dueAt {
            if dueAt < now { return .now }
            if dueAt < bounds.startOfTomorrow { return .today }
            if dueAt < bounds.startOfWeekAfter { return .thisWeek }
            return .afterThisWeek
        }
        switch obligation.due {
        case .today: return .today
        case .soon: return .thisWeek
        case .later: return .afterThisWeek
        case .none: return .noDate
        }
    }

    private static func group(of extra: NeedsYouExtra) -> NeedsYouGroupID? {
        guard extra.attention else { return nil }
        switch extra.kind {
        case .question, .approval: return .now
        case .checkin: return .today
        case .update: return nil
        }
    }

    /// A code's expiry is its due time: the soonest to expire comes first.
    private static func due(of entry: NeedsYouEntry) -> ObligationMillis? {
        guard case .obligation(let obligation) = entry else { return nil }
        if obligation.kind == .code, !obligation.isClosed { return obligation.code?.expiresAt }
        return obligation.dueAt
    }

    private static func recency(of entry: NeedsYouEntry) -> ObligationMillis {
        switch entry {
        case .albatross(let extra):
            return extra.createdAt ?? 0
        case .obligation(let obligation):
            if obligation.isClosed { return obligation.closedAt ?? obligation.updatedAt }
            return obligation.createdAt
        }
    }

    /// Dated entries first, by date; then the newest first; ties by id
    /// (`compareEntries`). True when `a` comes before `b`.
    static func comesFirst(_ a: NeedsYouEntry, _ b: NeedsYouEntry) -> Bool {
        let dueA = due(of: a)
        let dueB = due(of: b)
        if let dueA, let dueB, dueA != dueB { return dueA < dueB }
        if dueA != nil, dueB == nil { return true }
        if dueA == nil, dueB != nil { return false }
        let recencyA = recency(of: a)
        let recencyB = recency(of: b)
        if recencyA != recencyB { return recencyA > recencyB }
        return a.id.compare(b.id) == .orderedAscending
    }

    /// The groups of the page, in display order, without the empty ones
    /// (`groupNeedsYou`). Questions and approvals sit in Now, check-ins in
    /// Today.
    static func groups(
        items: [ObligationView],
        extras: [NeedsYouExtra] = [],
        now: ObligationMillis,
        timezone: String?
    ) -> [NeedsYouGroup] {
        let bounds = DayBounds(now: now, clock: NeedsYouClock(timezone: timezone))
        var buckets: [NeedsYouGroupID: [NeedsYouEntry]] = [:]
        for obligation in items {
            guard let id = group(of: obligation, now: now, bounds: bounds) else { continue }
            buckets[id, default: []].append(.obligation(obligation))
        }
        for extra in extras {
            guard let id = group(of: extra) else { continue }
            buckets[id, default: []].append(.albatross(extra))
        }
        var result: [NeedsYouGroup] = []
        for id in NeedsYouContract.groupOrder {
            guard let entries = buckets[id], !entries.isEmpty else { continue }
            result.append(NeedsYouGroup(id: id, entries: entries.sorted(by: comesFirst)))
        }
        return result
    }

    /// "3 now · 9 open · 3 closed today": `open` counts every group but
    /// Closed today (`needsYouSummary`).
    static func summary(of groups: [NeedsYouGroup]) -> NeedsYouSummary {
        var now = 0
        var open = 0
        var closedToday = 0
        for group in groups {
            if group.id == .closedToday {
                closedToday += group.entries.count
            } else {
                open += group.entries.count
                if group.id == .now { now += group.entries.count }
            }
        }
        return NeedsYouSummary(now: now, open: open, closedToday: closedToday)
    }

    /// The Later menu: in three hours (only while that is still today),
    /// tomorrow at 9, and next Monday at 9, in the user's time zone
    /// (`laterOptions`).
    static func laterOptions(now: ObligationMillis, timezone: String?) -> [NeedsYouLaterOption] {
        let clock = NeedsYouClock(timezone: timezone)
        let startOfTomorrow = clock.startOfDay(now, plusDays: 1)
        let weekday = clock.weekday(now)
        var daysToMonday = (1 - weekday + 7) % 7
        if daysToMonday == 0 { daysToMonday = 7 }
        let nextMonday = clock.startOfDay(now, plusDays: daysToMonday)
        var options: [NeedsYouLaterOption] = []
        let laterToday = now + 3 * NeedsYouClock.hourMillis
        if laterToday < startOfTomorrow {
            options.append(NeedsYouLaterOption(id: .laterToday, label: "Later today", until: laterToday))
        }
        options.append(NeedsYouLaterOption(
            id: .tomorrowMorning,
            label: "Tomorrow morning",
            until: startOfTomorrow + morningHour * NeedsYouClock.hourMillis
        ))
        options.append(NeedsYouLaterOption(
            id: .nextWeek,
            label: "Next week",
            until: nextMonday + morningHour * NeedsYouClock.hourMillis
        ))
        return options
    }
}
