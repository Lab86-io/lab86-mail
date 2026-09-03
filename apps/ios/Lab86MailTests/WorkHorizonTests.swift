import Foundation
import Testing
@testable import Lab86Mail

// The horizon rules. The same fixtures `tests/albatross-horizon.test.ts` pins
// for the web, so the phone and the desktop agree on what sleeps and what a
// phrase means.
struct WorkHorizonTests {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York") ?? .gmt
        calendar.locale = Locale(identifier: "en_US")
        return calendar
    }

    private func day(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour))!
    }

    // Wednesday 2026-09-02, 09:00 local time.
    private var now: Date { day(2026, 9, 2, 9) }
    private let dayLength: TimeInterval = 24 * 3600

    // MARK: isDormant

    @Test func noHorizonIsNotDormant() {
        #expect(WorkHorizon(kind: .now).isDormant(at: now) == false)
    }

    @Test func aFutureNotBeforeSleepsAndAPassedOneDoesNot() {
        #expect(WorkHorizon(kind: .later, notBefore: now + dayLength).isDormant(at: now))
        #expect(WorkHorizon(kind: .later, notBefore: now - 1).isDormant(at: now) == false)
        #expect(WorkHorizon(kind: .now, notBefore: now - dayLength, wokeAt: now - dayLength).isDormant(at: now) == false)
    }

    @Test func somedayAndUndatedLaterBothSleep() {
        #expect(WorkHorizon(kind: .someday).isDormant(at: now))
        #expect(WorkHorizon(kind: .later, label: "after the wedding").isDormant(at: now))
    }

    @Test func nowWithASoftTargetIsAwake() {
        #expect(WorkHorizon(kind: .now, by: now + 3 * dayLength).isDormant(at: now) == false)
    }

    @Test func wakeIsDueOnceNotBeforePassedAndNoWakeFired() {
        #expect(WorkHorizon(kind: .later, notBefore: now - 1).wakeIsDue(at: now))
        #expect(WorkHorizon(kind: .later, notBefore: now + 1).wakeIsDue(at: now) == false)
        #expect(WorkHorizon(kind: .later, notBefore: now - 1, wokeAt: now - 1).wakeIsDue(at: now) == false)
        #expect(WorkHorizon(kind: .someday).wakeIsDue(at: now) == false)
    }

    @Test func theWakeLineIsExact() {
        #expect(WorkHorizon.wakeLine(title: "Passport renewal") == "Passport renewal is back. Ready when you are.")
        #expect(WorkHorizon.wakeLine(title: "   ") == "Something you kept is back. Ready when you are.")
    }

    // MARK: horizonLine

    @Test func saysNothingForPlainWork() {
        #expect(WorkHorizon(kind: .now).line(at: now, calendar: calendar) == nil)
    }

    @Test func namesTheWakeDate() {
        #expect(WorkHorizon(kind: .later, notBefore: day(2026, 11, 1)).line(at: now, calendar: calendar) == "Back on Nov 1")
        #expect(WorkHorizon(kind: .later, notBefore: day(2027, 1, 4)).line(at: now, calendar: calendar) == "Back on Jan 4, 2027")
        #expect(WorkHorizon(kind: .later, notBefore: day(2026, 9, 4)).line(at: now, calendar: calendar) == "Back on Friday")
        #expect(WorkHorizon(kind: .later, notBefore: day(2026, 9, 3)).line(at: now, calendar: calendar) == "Back on tomorrow")
    }

    @Test func somedayLaterAndSoftTargets() {
        #expect(WorkHorizon(kind: .someday).line(at: now, calendar: calendar) == "Someday")
        #expect(WorkHorizon(kind: .later).line(at: now, calendar: calendar) == "Later")
        #expect(WorkHorizon(kind: .later, label: "after the wedding").line(at: now, calendar: calendar) == "After the wedding")
        #expect(WorkHorizon(kind: .later, notBefore: now - dayLength).line(at: now, calendar: calendar) == "Back now")
        #expect(WorkHorizon(kind: .now, by: day(2026, 9, 4)).line(at: now, calendar: calendar) == "By Friday")
    }

    @Test func shortDateCoversTodayAndTomorrow() {
        #expect(WorkHorizon.shortDate(now + 60, now: now, calendar: calendar) == "today")
        #expect(WorkHorizon.shortDate(now + dayLength, now: now, calendar: calendar) == "tomorrow")
    }

    // MARK: JSON

    @Test func decodesTheServerShapeInEpochMilliseconds() throws {
        let json: JSONValue = .object([
            "kind": .string("later"),
            "notBefore": .number(day(2026, 11, 1).timeIntervalSince1970 * 1_000),
            "label": .string("not before November"),
            "wokeAt": .null,
        ])
        let horizon = try #require(WorkHorizon(json: json))
        #expect(horizon.kind == .later)
        #expect(horizon.notBefore == day(2026, 11, 1))
        #expect(horizon.label == "not before November")
        #expect(horizon.wokeAt == nil)
        #expect(WorkHorizon(json: .object(["kind": .string("whenever")])) == nil)
        #expect(WorkHorizon(json: nil) == nil)
    }

    // MARK: laterShelf

    private func item(_ id: String, updatedAt: TimeInterval, horizon: WorkHorizon?, closed: Bool = false) -> WorkListItem {
        var row: [String: JSONValue] = [
            "_id": .string(id),
            "rawText": .string(id),
            "status": .string("ready"),
            "updatedAt": .number(updatedAt * 1_000),
        ]
        if closed { row["workState"] = .string("done") }
        if let horizon {
            var object: [String: JSONValue] = ["kind": .string(horizon.kind.rawValue)]
            if let notBefore = horizon.notBefore { object["notBefore"] = .number(notBefore.timeIntervalSince1970 * 1_000) }
            if let label = horizon.label { object["label"] = .string(label) }
            if let wokeAt = horizon.wokeAt { object["wokeAt"] = .number(wokeAt.timeIntervalSince1970 * 1_000) }
            row["horizon"] = .object(object)
        }
        return WorkListItem(json: .object(row))!
    }

    @Test func ordersDormantWorkByWakeDateAndPutsUndatedWorkAtTheEnd() {
        let rows = [
            item("awake", updatedAt: 9, horizon: WorkHorizon(kind: .now)),
            item("someday", updatedAt: 5, horizon: WorkHorizon(kind: .someday)),
            item("dec", updatedAt: 1, horizon: WorkHorizon(kind: .later, notBefore: day(2026, 12, 1))),
            item("nov", updatedAt: 2, horizon: WorkHorizon(kind: .later, notBefore: day(2026, 11, 1))),
            item("wedding", updatedAt: 7, horizon: WorkHorizon(kind: .later, label: "after the wedding")),
            item("plain", updatedAt: 8, horizon: nil),
        ]
        #expect(WorkHorizonShelf.later(rows, now: now).map(\.id) == ["nov", "dec", "wedding", "someday"])
    }

    @Test func theSplitKeepsClosedWorkOutOfTheShelf() {
        let rows = [
            item("done-later", updatedAt: 1, horizon: WorkHorizon(kind: .someday), closed: true),
            item("open-later", updatedAt: 2, horizon: WorkHorizon(kind: .someday)),
            item("plain", updatedAt: 3, horizon: nil),
        ]
        let split = WorkGrouping.split(rows, now: now)
        #expect(split.later.map(\.id) == ["open-later"])
        #expect(split.awake.map(\.id) == ["done-later", "plain"])
    }

    @Test func theListRowKeepsItsHorizon() {
        let row = item("w", updatedAt: 1, horizon: WorkHorizon(kind: .later, notBefore: day(2026, 11, 1)))
        #expect(row.horizon?.kind == .later)
        #expect(row.isDormant(at: now))
        #expect(row.withHorizon(nil).horizon == nil)
    }

    // MARK: parseHorizonHint

    private func parse(_ text: String) -> WorkHorizon? {
        WorkHorizonHint.parse(text, now: now, calendar: calendar)
    }

    @Test func emptyAndPlainTextCarryNoHorizon() {
        #expect(parse("") == nil)
        #expect(parse("Renew the passport.") == nil)
        #expect(parse("Call the dentist after work today and book a slot") == nil)
        #expect(parse("Get the form from the post office") == nil)
    }

    @Test func inTwoWeeksSleepsUntilThatDay() {
        #expect(parse("Follow up with the landlord in two weeks")
            == WorkHorizon(kind: .later, notBefore: day(2026, 9, 16), label: "in two weeks"))
        #expect(parse("Check in 3 days")?.notBefore == day(2026, 9, 5))
        #expect(parse("Try again in a month")?.notBefore == day(2026, 10, 2))
        #expect(parse("Revisit in a couple of weeks")?.notBefore == day(2026, 9, 16))
    }

    @Test func nextMonthSleepsUntilTheFirstOfNextMonth() {
        #expect(parse("Look at the budget next month")
            == WorkHorizon(kind: .later, notBefore: day(2026, 10, 1), label: "next month"))
        #expect(parse("Plan the trip next year")?.notBefore == day(2027, 1, 1))
        #expect(parse("Reply next week")?.notBefore == day(2026, 9, 7))
    }

    @Test func somedayIsSomeday() {
        #expect(parse("Learn to sail someday") == WorkHorizon(kind: .someday, label: "someday"))
        #expect(parse("Eventually read Proust")?.kind == .someday)
        #expect(parse("No rush, fix the shed door")?.kind == .someday)
    }

    @Test func byFridayIsASoftTargetOnTheNowHorizon() {
        #expect(parse("Send the invoice by Friday")
            == WorkHorizon(kind: .now, by: day(2026, 9, 4), label: "by friday"))
        #expect(parse("File the claim by Nov 15")?.by == day(2026, 11, 15))
        #expect(parse("Finish it by tomorrow")?.by == day(2026, 9, 3))
    }

    @Test func notBeforeNovemberSleepsUntilNovemberFirst() {
        #expect(parse("I need to renew the passport, but not before November")
            == WorkHorizon(kind: .later, notBefore: day(2026, 11, 1), label: "not before november"))
        #expect(parse("Not until March")?.notBefore == day(2027, 3, 1))
        #expect(parse("Get the form from the office, not before November")?.notBefore == day(2026, 11, 1))
        #expect(parse("Start the garden in March")?.notBefore == day(2027, 3, 1))
        #expect(parse("Ask again starting Monday")?.notBefore == day(2026, 9, 7))
    }

    @Test func afterThanksgivingKeepsTheWordsAndNoDate() {
        #expect(parse("Book the cabin after Thanksgiving") == WorkHorizon(kind: .later, label: "after thanksgiving"))
        #expect(parse("Sort the photos after the wedding.") == WorkHorizon(kind: .later, label: "after the wedding"))
        #expect(parse("Not before the move") == WorkHorizon(kind: .later, label: "not before the move"))
    }

    @Test func aSleepAndASoftTargetCombine() {
        let parsed = parse("Renew the passport not before November, by December 10")
        #expect(parsed?.kind == .later)
        #expect(parsed?.notBefore == day(2026, 11, 1))
        #expect(parsed?.by == day(2026, 12, 10))
    }

    @Test func aTargetBeforeTheWakeDateIsDropped() {
        let parsed = parse("Renew the passport not before November, by Friday")
        #expect(parsed?.notBefore == day(2026, 11, 1))
        #expect(parsed?.by == nil)
    }

    @Test func cadenceIsNotAHorizon() {
        #expect(parse("Water the plants once a week") == nil)
    }

    // MARK: The sheet

    @Test func presetsShowTheResolvedDate() {
        let presets = HorizonPresets.make(now: now, calendar: calendar)
        #expect(presets.map(\.title) == ["Next week", "Next month", "In three months"])
        #expect(presets[0].resolved == "Mon, Sep 7")
        #expect(presets[0].date == day(2026, 9, 7))
        #expect(presets[1].resolved == "Oct 1")
        #expect(presets[2].resolved == "Dec 2")
    }

    @Test func theFieldPrintsWhatItUnderstood() {
        #expect(HorizonPresets.hintLine(for: "", now: now, calendar: calendar) == nil)
        #expect(HorizonPresets.hintLine(for: "not before November", now: now, calendar: calendar) == "Back on Nov 1")
        #expect(HorizonPresets.hintLine(for: "after the wedding", now: now, calendar: calendar) == "Kept as your words. No date.")
        #expect(HorizonPresets.hintLine(for: "whenever", now: now, calendar: calendar) == "Someday")
        #expect(HorizonPresets.hintLine(for: "by Friday", now: now, calendar: calendar) == "By Friday")
    }

    @Test func theSheetWritesExactlyOneShape() {
        #expect(HorizonSheetResult.horizon(kind: .now, notBefore: day(2026, 11, 1), by: nil, label: "x") == nil)
        #expect(HorizonSheetResult.horizon(kind: .now, notBefore: nil, by: day(2026, 9, 4), label: nil)
            == WorkHorizon(kind: .now, by: day(2026, 9, 4)))
        #expect(HorizonSheetResult.horizon(kind: .later, notBefore: day(2026, 11, 1), by: nil, label: "  ")
            == WorkHorizon(kind: .later, notBefore: day(2026, 11, 1)))
        #expect(HorizonSheetResult.horizon(kind: .someday, notBefore: day(2026, 11, 1), by: day(2026, 12, 1), label: "one day")
            == WorkHorizon(kind: .someday, label: "one day"))
    }
}
