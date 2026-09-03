import Foundation
import Testing
@testable import Lab86Mail

// The "Later" shelf as a timeline, and the wake nudge that brings Work back.
struct LaterShelfTests {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York") ?? .gmt
        calendar.locale = Locale(identifier: "en_US")
        return calendar
    }

    private func day(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour))!
    }

    private var now: Date { day(2026, 9, 2, 9) }

    private func item(
        _ id: String,
        title: String? = nil,
        area: String? = "Personal",
        kind: WorkHorizonKind,
        notBefore: Date? = nil,
        wokeAt: Date? = nil,
        closed: Bool = false,
        updatedAt: TimeInterval = 1
    ) -> WorkListItem {
        var horizon: [String: JSONValue] = ["kind": .string(kind.rawValue)]
        if let notBefore { horizon["notBefore"] = .number(notBefore.timeIntervalSince1970 * 1_000) }
        if let wokeAt { horizon["wokeAt"] = .number(wokeAt.timeIntervalSince1970 * 1_000) }
        var row: [String: JSONValue] = [
            "_id": .string(id),
            "rawText": .string(title ?? id),
            "status": .string("ready"),
            "updatedAt": .number(updatedAt * 1_000),
            "horizon": .object(horizon),
        ]
        if let title { row["title"] = .string(title) }
        if let area { row["areaName"] = .string(area) }
        if closed { row["workState"] = .string("done") }
        return WorkListItem(json: .object(row))!
    }

    // MARK: Layout

    @Test func slotsRunMonthByMonthFromTheFirstWakeToTheLastThenSomeday() {
        let items = WorkHorizonShelf.later([
            item("jan", kind: .later, notBefore: day(2027, 1, 4)),
            item("nov-a", kind: .later, notBefore: day(2026, 11, 1)),
            item("nov-b", kind: .later, notBefore: day(2026, 11, 20)),
            item("someday", kind: .someday, updatedAt: 1),
            item("wedding", kind: .later, updatedAt: 2),
        ], now: now)
        let slots = LaterShelfLayout.slots(for: items, now: now, calendar: calendar)

        #expect(slots.map(\.id) == ["2026-11", "2026-12", "2027-01", "someday"])
        #expect(slots.map(\.tick) == ["Nov", "Dec", "Jan 2027", nil])
        #expect(slots[0].items.map(\.id) == ["nov-a", "nov-b"])
        #expect(slots[1].isEmpty)
        #expect(slots[2].items.map(\.id) == ["jan"])
        #expect(slots[3].isSomeday)
        #expect(slots[3].items.map(\.id) == ["wedding", "someday"])
    }

    @Test func anUndatedShelfIsOnlyTheSomedayGroup() {
        let slots = LaterShelfLayout.slots(for: [item("s", kind: .someday)], now: now, calendar: calendar)
        #expect(slots.map(\.id) == ["someday"])
        #expect(LaterShelfLayout.slots(for: [], now: now, calendar: calendar).isEmpty)
    }

    @Test func aStackIsNarrowUntilItFansOpen() {
        let slot = LaterShelfLayout.Slot(id: "m", tick: "Nov", items: [
            item("a", kind: .later, notBefore: day(2026, 11, 1)),
            item("b", kind: .later, notBefore: day(2026, 11, 2)),
            item("c", kind: .later, notBefore: day(2026, 11, 3)),
        ])
        let collapsed: CGFloat = 168 + 2 * 8
        let fanned: CGFloat = 3 * 168 + 2 * 12
        #expect(LaterShelfLayout.slotWidth(slot, expanded: false) == collapsed)
        #expect(LaterShelfLayout.slotWidth(slot, expanded: true) == fanned)
        let empty = LaterShelfLayout.Slot(id: "e", tick: "Dec", items: [])
        #expect(LaterShelfLayout.slotWidth(empty, expanded: true) == LaterShelfLayout.emptySlotWidth)
    }

    @Test func voiceOverReadsTheCardAsOneSentence() {
        let card = item("p", title: "Passport renewal", kind: .later, notBefore: day(2026, 11, 1))
        #expect(LaterShelfLayout.cardLabel(card, now: now, calendar: calendar) == "Passport renewal, back on November 1, Personal")
        let someday = item("s", title: "Learn to sail", area: nil, kind: .someday)
        #expect(LaterShelfLayout.cardLabel(someday, now: now, calendar: calendar) == "Learn to sail, someday")
        #expect(LaterShelfLayout.containerLabel(count: 4) == "Later, 4 items")
        #expect(LaterShelfLayout.containerLabel(count: 1) == "Later, 1 item")
    }

    // MARK: Wake nudge

    @Test func theNewestUnseenWakeWinsAndOldOnesStayQuiet() {
        let work = [
            item("old", title: "Old", kind: .now, wokeAt: now.addingTimeInterval(-10 * 24 * 3600)),
            item("first", title: "Passport renewal", kind: .now, wokeAt: now.addingTimeInterval(-3600)),
            item("second", title: "Garden", kind: .now, wokeAt: now.addingTimeInterval(-60)),
            item("sleeping", title: "Cabin", kind: .later, notBefore: day(2026, 11, 1)),
            item("closed", title: "Done", kind: .now, wokeAt: now.addingTimeInterval(-30), closed: true),
        ]
        let pick = WakeNudgeSelection.pick(from: work, seen: [], now: now)
        #expect(pick?.workID == "second")
        #expect(pick?.line == "Garden is back. Ready when you are.")

        let next = WakeNudgeSelection.pick(from: work, seen: [pick!.id], now: now)
        #expect(next?.workID == "first")

        let quiet = WakeNudgeSelection.pick(from: work, seen: [pick!.id, next!.id], now: now)
        #expect(quiet == nil)
    }

    @Test func aWakeIsKeyedOnTheWorkAndItsWakeTime() {
        let wokeAt = day(2026, 11, 1)
        let nudge = WakeNudge(workID: "w", title: "Passport renewal", wokeAt: wokeAt)
        #expect(nudge.id == "w:\(Int(wokeAt.timeIntervalSince1970 * 1_000))")
    }

    @Test func theLedgerRemembersAndStaysBounded() {
        let defaults = UserDefaults(suiteName: "LaterShelfTests.\(UUID().uuidString)")!
        let ledger = WakeNudgeLedger(defaults: defaults)
        #expect(ledger.seen.isEmpty)
        for index in 0..<(WakeNudgeLedger.capacity + 5) {
            ledger.markSeen("w:\(index)")
        }
        #expect(ledger.seen.count == WakeNudgeLedger.capacity)
        #expect(!ledger.seen.contains("w:0"))
        #expect(ledger.seen.contains("w:\(WakeNudgeLedger.capacity + 4)"))
    }

    @Test @MainActor func theModelShowsOneWakeAndMarksItSeenOnDismiss() {
        let defaults = UserDefaults(suiteName: "LaterShelfTests.\(UUID().uuidString)")!
        let model = WakeNudgeModel(ledger: WakeNudgeLedger(defaults: defaults))
        let work = [item("w", title: "Passport renewal", kind: .now, wokeAt: now.addingTimeInterval(-60))]
        model.consider(work, now: now)
        #expect(model.current?.workID == "w")
        model.dismiss()
        #expect(model.current == nil)
        model.consider(work, now: now)
        #expect(model.current == nil)
    }
}
