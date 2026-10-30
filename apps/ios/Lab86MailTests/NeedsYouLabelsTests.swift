import Foundation
import Testing
@testable import Lab86Mail

// The words of a row and a detail, held to the web's answers
// (tests/needs-you-labels.test.ts). Wednesday, October 28, 2026, 11:05 AM
// in Los Angeles.
struct NeedsYouLabelsTests {
    private static let tz = "America/Los_Angeles"
    private static let now: ObligationMillis = 1_793_210_700_000
    private static let startOfToday: ObligationMillis = 1_793_170_800_000
    private static let minute: ObligationMillis = 60_000
    private static let hour: ObligationMillis = 3_600_000
    private static let day: ObligationMillis = 86_400_000

    private func item(
        kind: ObligationKind = .reply,
        state: ObligationState = .open,
        due: ObligationDue = .none,
        dueAt: ObligationMillis? = nil,
        pushLevel: ObligationPushLevel = .normal,
        code: ObligationCode? = nil,
        createdAt: ObligationMillis = NeedsYouLabelsTests.now - NeedsYouLabelsTests.hour,
        closeReason: ObligationCloseReason? = nil
    ) -> ObligationView {
        ObligationView(
            id: "ob",
            kind: kind,
            state: state,
            sourceKey: "mail:acct:thread",
            title: "Asks for a reply.",
            asker: "Ada Example",
            due: due,
            dueAt: dueAt,
            pushLevel: pushLevel,
            code: code,
            createdAt: createdAt,
            closeReason: closeReason
        )
    }

    @Test func eachCloseReasonHasItsWord() {
        #expect(NeedsYouLabels.closeReasonLabel(.sentReply) == "Replied")
        #expect(NeedsYouLabels.closeReasonLabel(.userDone) == "Done")
        #expect(NeedsYouLabels.closeReasonLabel(.userDoneNoReply) == "Done, no reply sent")
        #expect(NeedsYouLabels.closeReasonLabel(.evidence) == "Closed by itself")
        #expect(NeedsYouLabels.closeReasonLabel(.agedOut) == "Closed by itself")
        #expect(NeedsYouLabels.closeReasonLabel(.notMine) == "Not mine")
        #expect(NeedsYouLabels.closeReasonLabel(.codeUsed) == "Code used")
        #expect(NeedsYouLabels.closeReasonLabel(.expired) == "Expired")
        #expect(NeedsYouLabels.closeReasonLabel(.eventPassed) == "Event started")
        #expect(NeedsYouLabels.closeReasonLabel(nil) == "Closed")
    }

    @Test func eachKindHasItsWord() {
        #expect(NeedsYouLabels.kindLabel(kind: .reply, pushLevel: .normal) == "Reply")
        #expect(NeedsYouLabels.kindLabel(kind: .action, pushLevel: .normal) == "Action")
        #expect(NeedsYouLabels.kindLabel(kind: .waiting, pushLevel: .none) == "Waiting")
        #expect(NeedsYouLabels.kindLabel(kind: .change, pushLevel: .normal) == "Change")
        #expect(NeedsYouLabels.kindLabel(kind: .change, pushLevel: .timeSensitive) == "Time-sensitive change")
        #expect(NeedsYouLabels.kindLabel(kind: .code, pushLevel: .timeSensitive) == "Code")
        #expect(NeedsYouLabels.kindLabel(kind: .rsvp, pushLevel: .normal) == "Invitation")
        #expect(NeedsYouLabels.kindLabel(kind: .prepare, pushLevel: .normal) == "Prepare")
    }

    @Test func whenShowsTheTimeYesterdayTheWeekdayOrTheDate() {
        #expect(NeedsYouLabels.whenLabel(Self.now - 2 * Self.hour, now: Self.now, timezone: Self.tz) == "9:05 AM")
        #expect(NeedsYouLabels.whenLabel(Self.now - Self.day, now: Self.now, timezone: Self.tz) == "Yesterday 11:05 AM")
        #expect(NeedsYouLabels.whenLabel(Self.now - 2 * Self.day, now: Self.now, timezone: Self.tz) == "Mon 11:05 AM")
        #expect(NeedsYouLabels.whenLabel(Self.now + 2 * Self.day, now: Self.now, timezone: Self.tz) == "Fri 11:05 AM")
        #expect(NeedsYouLabels.whenLabel(Self.now - 10 * Self.day, now: Self.now, timezone: Self.tz) == "Oct 18")
        // An unknown zone falls back to the device and still prints a time.
        let fallback = NeedsYouLabels.whenLabel(Self.now - 5 * Self.minute, now: Self.now, timezone: "Not/AZone")
        #expect(fallback.hasSuffix(" AM") || fallback.hasSuffix(" PM"))
    }

    @Test func agoCountsMinutesHoursThenDays() {
        #expect(NeedsYouLabels.agoLabel(Self.now - 10_000, now: Self.now) == "just now")
        #expect(NeedsYouLabels.agoLabel(Self.now + 10_000, now: Self.now) == "just now")
        #expect(NeedsYouLabels.agoLabel(Self.now - 2 * Self.minute, now: Self.now) == "2 min ago")
        #expect(NeedsYouLabels.agoLabel(Self.now - 3 * Self.hour, now: Self.now) == "3 hr ago")
        #expect(NeedsYouLabels.agoLabel(Self.now - Self.day, now: Self.now) == "1 day ago")
        #expect(NeedsYouLabels.agoLabel(Self.now - 3 * Self.day, now: Self.now) == "3 days ago")
    }

    @Test func expiryCountsUpToTheMinuteThenHoursThenSaysExpired() {
        #expect(NeedsYouLabels.expiryLabel(expiresAt: Self.now + 8 * Self.minute, now: Self.now) == "8 min")
        #expect(NeedsYouLabels.expiryLabel(expiresAt: Self.now + 7 * Self.minute + 1, now: Self.now) == "8 min")
        #expect(NeedsYouLabels.expiryLabel(expiresAt: Self.now + 65 * Self.minute, now: Self.now) == "1 hr 5 min")
        #expect(NeedsYouLabels.expiryLabel(expiresAt: Self.now + 2 * Self.hour, now: Self.now) == "2 hr")
        #expect(NeedsYouLabels.expiryLabel(expiresAt: Self.now, now: Self.now) == "Expired")
    }

    @Test func theRingShowsTheShareOfTheLifeThatIsLeft() {
        let code = ObligationCode(value: "1", expiresAt: Self.now + 8 * Self.minute)
        let createdAt = Self.now - 2 * Self.minute
        #expect(abs(NeedsYouLabels.expiryFraction(createdAt: createdAt, code: code, now: Self.now) - 0.8) < 0.001)
        #expect(NeedsYouLabels.expiryFraction(createdAt: createdAt, code: code, now: Self.now + 20 * Self.minute) == 0)
        #expect(NeedsYouLabels.expiryFraction(createdAt: createdAt, code: code, now: Self.now - 10 * Self.minute) == 1)
        #expect(NeedsYouLabels.expiryFraction(createdAt: Self.now, code: ObligationCode(value: "1"), now: Self.now) == 0)
        #expect(NeedsYouLabels.expiryFraction(createdAt: Self.now, code: ObligationCode(value: "1", expiresAt: Self.now), now: Self.now) == 0)
    }

    @Test func sixAndEightDigitsGetGroups() {
        #expect(NeedsYouLabels.spacedCode("482913") == "482 913")
        #expect(NeedsYouLabels.spacedCode("482 913") == "482 913")
        #expect(NeedsYouLabels.spacedCode("12345678") == "1234 5678")
        #expect(NeedsYouLabels.spacedCode("AB-12") == "AB-12")
        #expect(NeedsYouLabels.spacedCode("1234567") == "1234567")
    }

    @Test func theDetailSentenceNamesTheIssuerOrTheAsker() {
        #expect(NeedsYouLabels.sentence(item(kind: .code, code: ObligationCode(value: "1", issuer: "Northwind Bank")))
            == "Verification code from Northwind Bank.")
        #expect(NeedsYouLabels.sentence(item(kind: .code, code: ObligationCode(value: "1"))) == "Verification code from Ada Example.")
        #expect(NeedsYouLabels.sentence(item()) == "Asks for a reply.")
    }

    @Test func theDueDayWord() {
        let label = { (dueAt: ObligationMillis) in NeedsYouLabels.dueDayLabel(dueAt, now: Self.now, timezone: Self.tz) }
        #expect(label(Self.startOfToday + 18 * Self.hour + 40 * Self.minute) == "Today 6:40 PM")
        #expect(label(Self.startOfToday) == "Today")
        // A past day is never "Today".
        #expect(label(Self.startOfToday - Self.hour) == "Yesterday 11:00 PM")
        #expect(label(Self.startOfToday - 3 * Self.day + 9 * Self.hour) == "Oct 25")
        // A parsed due day ends at 23:59:59.999 and shows no time.
        #expect(label(Self.startOfToday + Self.day - 1) == "Today")
        #expect(label(Self.startOfToday - 1) == "Yesterday")
        #expect(label(Self.startOfToday + Self.day) == "Tomorrow")
        #expect(label(Self.startOfToday + Self.day + 9 * Self.hour) == "Tomorrow 9:00 AM")
        #expect(label(Self.startOfToday + 2 * Self.day) == "Fri")
        #expect(label(Self.startOfToday + 15 * Self.day + 12 * Self.hour) == "Nov 12")
    }

    @Test func theDueColumnOfARow() {
        let due = { (obligation: ObligationView) in NeedsYouLabels.dueLabel(obligation, now: Self.now, timezone: Self.tz) }
        #expect(due(item(state: .done, closeReason: .userDoneNoReply)) == NeedsYouDueLabel(text: "Done, no reply sent", tone: .done))
        #expect(due(item(kind: .code, code: ObligationCode(value: "1"))) == NeedsYouDueLabel(text: "", tone: .plain))
        #expect(due(item(kind: .code, code: ObligationCode(value: "1", expiresAt: Self.now - 1))) == NeedsYouDueLabel(text: "Expired", tone: .plain))
        #expect(due(item(kind: .code, code: ObligationCode(value: "1", expiresAt: Self.now + 8 * Self.minute)))
            == NeedsYouDueLabel(text: "8 min", sub: "expires", tone: .hot))
        #expect(due(item(kind: .waiting, createdAt: Self.now - Self.hour)) == NeedsYouDueLabel(text: "Today", sub: "waiting", tone: .plain))
        #expect(due(item(kind: .waiting, createdAt: Self.now - Self.day)) == NeedsYouDueLabel(text: "1 day", sub: "waiting", tone: .plain))
        #expect(due(item(kind: .waiting, createdAt: Self.now - 6 * Self.day)).text == "6 days")
        #expect(due(item(dueAt: Self.startOfToday + 18 * Self.hour, pushLevel: .timeSensitive))
            == NeedsYouDueLabel(text: "Today 6:00 PM", tone: .hot))
        #expect(due(item(dueAt: Self.startOfToday + 18 * Self.hour)).tone == .today)
        #expect(due(item(dueAt: Self.startOfToday + 2 * Self.day)) == NeedsYouDueLabel(text: "Fri", tone: .plain))
        #expect(due(item(due: .today)) == NeedsYouDueLabel(text: "Today", tone: .today))
        #expect(due(item(due: .today, pushLevel: .timeSensitive)).tone == .hot)
        #expect(due(item(due: .soon)) == NeedsYouDueLabel(text: "Soon", tone: .plain))
        #expect(due(item(due: .soon, pushLevel: .timeSensitive)).tone == .hot)
        #expect(due(item(due: .later)) == NeedsYouDueLabel(text: "Later", tone: .plain))
        #expect(due(item(due: .none)) == NeedsYouDueLabel(text: "", tone: .plain))
        #expect(due(item(due: .none, pushLevel: .timeSensitive)).tone == .hot)
    }

    @Test func theDueSentenceOfTheDetail() {
        let sentence = { (obligation: ObligationView) in NeedsYouLabels.dueSentence(obligation, now: Self.now, timezone: Self.tz) }
        #expect(sentence(item(state: .done)) == "")
        #expect(sentence(item(kind: .code)) == "")
        #expect(sentence(item(kind: .waiting)) == "")
        #expect(sentence(item(dueAt: Self.startOfToday + 2 * Self.day + 17 * Self.hour)) == "Due Friday")
        #expect(sentence(item(dueAt: Self.startOfToday + Self.day)) == "Due tomorrow")
        #expect(sentence(item(dueAt: Self.startOfToday + 18 * Self.hour)) == "Due today 6:00 PM")
        #expect(sentence(item(dueAt: Self.startOfToday + 15 * Self.day + 12 * Self.hour)) == "Due Nov 12")
        #expect(sentence(item(due: .today)) == "Due today")
        #expect(sentence(item(due: .soon)) == "Due soon")
        #expect(sentence(item(due: .later)) == "Due later")
        #expect(sentence(item(due: .none)) == "")
    }

    @Test func theQuietLineUnderTheActions() {
        #expect(NeedsYouLabels.actionNote(kind: .reply).contains("Done closes this without a reply"))
        #expect(NeedsYouLabels.actionNote(kind: .code).contains("closes itself when you use the code"))
        #expect(NeedsYouLabels.actionNote(kind: .waiting).contains("when the reply arrives"))
        #expect(NeedsYouLabels.actionNote(kind: .action) == "Done closes this. Undo for 10 seconds.")
        #expect(NeedsYouLabels.actionNote(kind: .change) == "Done closes this. Undo for 10 seconds.")
        #expect(NeedsYouLabels.actionNote(kind: .rsvp) == "Done closes this. Undo for 10 seconds.")
    }
}
