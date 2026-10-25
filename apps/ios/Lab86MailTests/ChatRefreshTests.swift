import Foundation
import Testing
@testable import Lab86Mail

// The chat refresh (docs/research/ios-refresh-design-2026-10-24.md): the
// desk, the work line, the history groups, the composer words, and the jump
// control. The fixtures use the tour's neutral names.
@MainActor
struct ChatRefreshTests {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        calendar.locale = Locale(identifier: "en_US")
        calendar.firstWeekday = 1
        return calendar
    }

    private let locale = Locale(identifier: "en_US")
    /// Friday, 2026-10-23, 15:00 UTC.
    private let friday = Date(timeIntervalSince1970: 1_792_767_600)

    private func at(_ hour: Int, _ minute: Int = 0, dayOffset: Int = 0) -> Date {
        let day = calendar.startOfDay(for: friday).addingTimeInterval(Double(dayOffset) * 86_400)
        return day.addingTimeInterval(Double(hour * 3_600 + minute * 60))
    }

    private func sentence(_ input: ChatDesk.Input) -> String {
        ChatDesk.sentence(input: input, now: friday, calendar: calendar, locale: locale)
    }

    private func rows(_ input: ChatDesk.Input) -> [ChatDesk.Row] {
        ChatDesk.rows(input: input, now: friday, calendar: calendar, locale: locale)
    }

    private let sarah = ChatDesk.Mail(id: "t-venue", senderName: "Sarah Chen", subject: "Offsite venue: final head count", date: Date(timeIntervalSince1970: 1_792_767_600 - 720))
    private let priya = ChatDesk.Mail(id: "t-invoice", senderName: "Priya Patel", subject: "Invoice 2211 is past due", date: Date(timeIntervalSince1970: 1_792_767_600 - 3_300))
    private let sam = ChatDesk.Mail(id: "t-sam", senderName: "Sam Lee", subject: "Lake plans", date: Date(timeIntervalSince1970: 1_792_767_600 - 7_200))

    private var standup: ChatDesk.Event { ChatDesk.Event(id: "e-standup", title: "Standup", start: at(15, 30), end: at(15, 45)) }
    private var walkthrough: ChatDesk.Event { ChatDesk.Event(id: "e-walk", title: "Venue walkthrough", start: at(11), end: at(12)) }
    private let headcount = ChatDesk.Work(id: "w-headcount", title: "Confirm the offsite head count")
    private let offsite = ChatDesk.Area(id: "area-offsite", name: "Team offsite", needsYou: 1)

    // MARK: - The desk

    @Test
    func theDatelineReadsTheWeekdayAndThePartOfTheDay() {
        #expect(ChatDesk.dateline(now: friday, calendar: calendar, locale: locale) == "Friday afternoon")
        #expect(ChatDesk.partOfDay(hour: 2) == "morning")
        #expect(ChatDesk.partOfDay(hour: 11) == "morning")
        #expect(ChatDesk.partOfDay(hour: 12) == "afternoon")
        #expect(ChatDesk.partOfDay(hour: 16) == "afternoon")
        #expect(ChatDesk.partOfDay(hour: 17) == "evening")
        #expect(ChatDesk.partOfDay(hour: 23) == "evening")
    }

    @Test
    func theSentenceNamesWhoWroteAndWhatTheDataProves() {
        #expect(sentence(ChatDesk.Input()) == ChatDesk.fallbackSentence)
        #expect(sentence(ChatDesk.Input(mail: [sarah])) == "Sarah wrote to you.")
        #expect(sentence(ChatDesk.Input(mail: [sarah, priya])) == "Sarah and Priya wrote to you.")
        #expect(sentence(ChatDesk.Input(mail: [sarah, priya, sam])) == "Sarah, Priya, and 1 other wrote to you.")
        // Two threads from one sender name one person.
        #expect(sentence(ChatDesk.Input(mail: [sarah, sarah, priya])) == "Sarah and Priya wrote to you.")
        var waiting = sarah
        waiting.waitsOnReply = true
        var waitingPriya = priya
        waitingPriya.waitsOnReply = true
        #expect(sentence(ChatDesk.Input(mail: [waiting])) == "Sarah waits on a reply.")
        #expect(sentence(ChatDesk.Input(mail: [waiting, waitingPriya])) == "Sarah and Priya wait on a reply.")
        // A mix keeps the weaker verb.
        #expect(sentence(ChatDesk.Input(mail: [waiting, priya])) == "Sarah and Priya wrote to you.")
    }

    @Test
    func theSentenceTakesTheNextEventThenTheOneThatRuns() {
        #expect(sentence(ChatDesk.Input(events: [walkthrough, standup])) == "Standup starts at 3:30 PM.")
        let running = ChatDesk.Event(id: "e-now", title: "Board deck review", start: at(14, 30), end: at(16))
        #expect(sentence(ChatDesk.Input(events: [walkthrough, running])) == "Board deck review runs until 4:00 PM.")
        let allDay = ChatDesk.Event(id: "e-day", title: "Offsite", start: at(0), end: at(0, dayOffset: 1), allDay: true)
        #expect(sentence(ChatDesk.Input(events: [allDay, walkthrough])) == "Offsite is all day.")
        // An all-day event never "starts at".
        #expect(sentence(ChatDesk.Input(events: [allDay, standup])) == "Standup starts at 3:30 PM.")
    }

    @Test
    func theSentenceCountsTheWorkThatNeedsYou() {
        #expect(sentence(ChatDesk.Input(work: [headcount])) == "One Albatross needs you.")
        let second = ChatDesk.Work(id: "w-2", title: "Mail the passport form")
        #expect(sentence(ChatDesk.Input(work: [headcount, second])) == "2 Albatrosses need you.")
        #expect(sentence(ChatDesk.Input(areas: [offsite])) == "Team offsite needs you.")
        let home = ChatDesk.Area(id: "area-home", name: "Home", needsYou: 2)
        #expect(sentence(ChatDesk.Input(areas: [offsite, home])) == "2 areas need you.")
        #expect(sentence(ChatDesk.Input(areas: [ChatDesk.Area(id: "a", name: "Quiet", needsYou: 0)])) == ChatDesk.fallbackSentence)
    }

    @Test
    func theSentenceKeepsTwoPartsInOrder() {
        let full = ChatDesk.Input(mail: [sarah], events: [standup], work: [headcount], areas: [offsite])
        #expect(sentence(full) == "Sarah wrote to you. Standup starts at 3:30 PM.")
        #expect(sentence(ChatDesk.Input(events: [standup], work: [headcount])) == "Standup starts at 3:30 PM. One Albatross needs you.")
        #expect(sentence(ChatDesk.Input(mail: [priya], work: [headcount])) == "Priya wrote to you. One Albatross needs you.")
    }

    @Test
    func theRowsAreRealItemsWithSourcesThenFixedAsks() {
        let desk = rows(ChatDesk.Input(mail: [sarah], events: [walkthrough, standup], work: [headcount]))
        #expect(desk.count == ChatDesk.rowLimit)
        #expect(desk.map(\.kind) == [.mail, .event, .work, .fixed])
        #expect(desk[0].ask == "Reply to Sarah about “Offsite venue: final head count”")
        #expect(desk[0].source == "Sarah Chen, 2:48 PM")
        #expect(desk[1].ask == "Get ready for “Standup”")
        #expect(desk[1].source == "Today at 3:30 PM")
        #expect(desk[2].ask == "What does “Confirm the offsite head count” need from me?")
        #expect(desk[2].source == "Albatross, needs you")
        #expect(desk[3].ask == ChatDesk.fixedAsks[0])
        #expect(desk[3].source == nil)
        #expect(Set(desk.map(\.id)).count == desk.count)
    }

    @Test
    func theRowsCapMailAtTwoAndFallBackToAnArea() {
        let mail = rows(ChatDesk.Input(mail: [sarah, priya, sam], areas: [offsite]))
        #expect(mail.map(\.kind) == [.mail, .mail, .area, .fixed])
        #expect(mail[2].ask == "What does Team offsite need from me?")
        #expect(mail[2].source == "Area, 1 needs you")
        let busy = ChatDesk.Area(id: "area-home", name: "Home", needsYou: 3)
        #expect(rows(ChatDesk.Input(areas: [busy]))[0].source == "Area, 3 need you")
        // Mail from another day names the date.
        var old = priya
        old = ChatDesk.Mail(id: old.id, senderName: old.senderName, subject: old.subject, date: at(9, dayOffset: -3))
        #expect(rows(ChatDesk.Input(mail: [old]))[0].source == "Priya Patel, Oct 20")
    }

    @Test
    func anEmptyDayShowsTheFourFixedAsks() {
        let desk = ChatDesk.make(input: ChatDesk.Input(), now: friday, calendar: calendar, locale: locale)
        #expect(desk.sentence == ChatDesk.fallbackSentence)
        #expect(desk.rows.map(\.ask) == ChatDesk.fixedAsks)
        #expect(desk.rows.allSatisfy { $0.kind == .fixed && $0.source == nil })
    }

    @Test
    func theDeskReadsNamesAndMailCategoriesTheWayTheInboxDoes() {
        #expect(ChatDesk.firstName("Priya Patel") == "Priya")
        #expect(ChatDesk.firstName("\"Sam Lee\"") == "Sam")
        #expect(ChatDesk.firstName("sam@example.com") == "sam")
        #expect(ChatDesk.firstName("  ") == "")
        #expect(ChatDesk.Input.isReplyCandidate(category: nil))
        #expect(ChatDesk.Input.isReplyCandidate(category: "main"))
        #expect(ChatDesk.Input.isReplyCandidate(category: "needs_reply"))
        #expect(!ChatDesk.Input.isReplyCandidate(category: "codes"))
        #expect(!ChatDesk.Input.isReplyCandidate(category: "noise"))
        #expect(!ChatDesk.Input.isReplyCandidate(category: "custom:label-1"))
        #expect(ChatDesk.Input.isNoReply(email: "no-reply@sso.northwind.example"))
        #expect(ChatDesk.Input.isNoReply(email: "NoReply@example.com"))
        #expect(!ChatDesk.Input.isNoReply(email: "priya@ledgerworks.example"))
        #expect(!ChatDesk.Input.isNoReply(email: nil))
    }

    @Test
    func theConversationTitleIsTheFirstThingTheUserSaid() {
        let chat = AssistantChatModel(backend: BackendClient(baseURL: nil), baseURL: nil)
        #expect(chat.conversationTitle == AssistantChatModel.newChatTitle)
        chat.send("Plan the offsite")
        #expect(chat.conversationTitle == "Plan the offsite")
        chat.stop()
    }

    // MARK: - The work line

    private func row(_ id: String, _ tool: String, _ state: AssistantToolRow.State, error: String? = nil) -> AssistantToolRow {
        AssistantToolRow(callID: id, toolName: tool, state: state, errorText: error)
    }

    @Test
    func theWorkLineComposesTheDoneSentences() {
        #expect(AssistantWorkLine.compose(["Read 3 threads"]) == "Read 3 threads")
        #expect(AssistantWorkLine.compose(["Read 3 threads", "Read the calendar"]) == "Read 3 threads and read the calendar")
        #expect(AssistantWorkLine.compose(["Read 3 threads", "Read the calendar", "Counted messages"]) == "Read 3 threads, read the calendar, and counted messages")
        #expect(AssistantWorkLine.compose(["A", "B", "C", "D", "E"]) == "A, b, and 3 more steps")
        #expect(AssistantWorkLine.compose(["Searched mail", "Searched mail"]) == "Searched mail")
        #expect(AssistantWorkLine.compose([]) == "")
        #expect(AssistantWorkLine.lowercasedFirst("Read Priya's thread") == "read Priya's thread")
    }

    @Test
    func theWorkLineReadsTheStateOfTheRows() {
        let done = [row("a", "search_threads", .done), row("b", "corpus_count", .done)]
        let doneLine = AssistantWorkLine.line(rows: done, turnFinished: true)
        #expect(doneLine.tone == .done)
        #expect(doneLine.text == AssistantWorkLine.compose(done.map(\.sentence)))
        #expect(!doneLine.text.contains("·"))

        let failed = AssistantWorkLine.line(rows: [row("a", "search_threads", .done), row("b", "get_thread", .failed, error: "Unavailable")], turnFinished: true)
        #expect(failed.tone == .failed)
        #expect(!failed.text.contains("Unavailable"))
        #expect(!failed.text.contains(" — "))
        let twoFailed = AssistantWorkLine.line(rows: [row("a", "get_thread", .failed), row("b", "get_thread", .failed)], turnFinished: true)
        #expect(twoFailed.text == "2 steps failed")

        let live = AssistantWorkLine.line(rows: [row("a", "search_threads", .done), row("b", "get_thread", .running)], turnFinished: false)
        #expect(live.tone == .live)
        #expect(!live.text.hasSuffix("…"))
        #expect(live.text == AssistantWorkLine.liveText(row("b", "get_thread", .running)))

        #expect(AssistantWorkLine.line(rows: [row("a", "calendar_update_event", .needsInput)], turnFinished: true) == AssistantWorkLine.Line(text: AssistantWorkLine.waitingText, tone: .waiting))
        #expect(AssistantWorkLine.line(rows: [row("a", "send_mail", .paused)], turnFinished: true) == AssistantWorkLine.Line(text: "Paused by you", tone: .paused))
        #expect(AssistantWorkLine.line(rows: [], turnFinished: false) == AssistantWorkLine.Line(text: AssistantWorkLine.workingText, tone: .live))
        #expect(AssistantWorkLine.line(rows: [], turnFinished: true).tone == .done)
    }

    // MARK: - History

    private func session(_ id: String, title: String, at date: Date) throws -> AssistantChatSessionSummary {
        try #require(AssistantChatSessionSummary(json: .object([
            "_id": .string(id),
            "title": .string(title),
            "updatedAt": .number((date.timeIntervalSince1970 * 1_000).rounded()),
        ])))
    }

    @Test
    func historyGroupsByDayAndWeekNewestFirst() throws {
        let sessions = [
            try session("old", title: "Lease renewal", at: at(10, dayOffset: -6)),
            try session("wed", title: "Offsite agenda", at: at(16, dayOffset: -2)),
            try session("yesterday", title: "Passport form", at: at(18, dayOffset: -1)),
            try session("early", title: "Head count", at: at(9)),
            try session("late", title: "Invoice 2211", at: at(14)),
        ]
        let groups = ChatHistoryGroups.group(sessions, now: friday, calendar: calendar)
        #expect(groups.map(\.title) == [ChatHistoryGroups.today, ChatHistoryGroups.yesterday, ChatHistoryGroups.earlierThisWeek, ChatHistoryGroups.older])
        #expect(groups[0].sessions.map(\.id) == ["late", "early"])
        #expect(groups[1].sessions.map(\.id) == ["yesterday"])
        #expect(groups[2].sessions.map(\.id) == ["wed"])
        #expect(groups[3].sessions.map(\.id) == ["old"])
        // A time after now counts as today; a missing time is old.
        #expect(ChatHistoryGroups.bucket(friday.addingTimeInterval(60), now: friday, calendar: calendar) == ChatHistoryGroups.today)
        #expect(ChatHistoryGroups.bucket(.distantPast, now: friday, calendar: calendar) == ChatHistoryGroups.older)
        #expect(ChatHistoryGroups.group([], now: friday, calendar: calendar).isEmpty)
    }

    @Test
    func historySearchAndTimeLabels() throws {
        let sessions = [
            try session("a", title: "Offsite agenda", at: at(9)),
            try session("b", title: "Invoice 2211", at: at(10, dayOffset: -2)),
        ]
        #expect(ChatHistoryGroups.filter(sessions, query: "").count == 2)
        #expect(ChatHistoryGroups.filter(sessions, query: "  ").count == 2)
        #expect(ChatHistoryGroups.filter(sessions, query: "offsite").map(\.id) == ["a"])
        #expect(ChatHistoryGroups.filter(sessions, query: "2211").map(\.id) == ["b"])
        #expect(ChatHistoryGroups.filter(sessions, query: "lease").isEmpty)
        #expect(ChatHistoryGroups.timeLabel(at(9), now: friday, calendar: calendar) == "9:00 AM")
        #expect(ChatHistoryGroups.timeLabel(at(10, dayOffset: -2), now: friday, calendar: calendar) == "Oct 21")
    }

    // MARK: - The composer and the jump control

    @Test
    func theComposerWordsFollowTheRouteAndTheScope() {
        #expect(ComposerCopy.placeholder(for: .ask) == "Ask Albatross")
        #expect(ComposerCopy.placeholder(for: .hold) == "Hand this to Albatross")
        #expect(ComposerCopy.placeholder(for: .run) == ThreadState.running.composerPlaceholder)
        #expect(ComposerCopy.scopeLine(.global) == nil)
        #expect(ComposerCopy.scopeLine(AssistantChatScope(kind: .area, contextID: "area-offsite", label: "Team offsite")) == "In Team offsite")
        #expect(ComposerCopy.scopeLine(AssistantChatScope(kind: .work, contextID: "w", label: nil)) == "In this Albatross")
        #expect(ComposerCopy.scopeAccessibilityLabel(AssistantChatScope(kind: .area, contextID: "a", label: "Team offsite")) == "Attached Area context: Team offsite")
        #expect(RouteControl.options(runAvailable: false) == [.ask, .hold])
        #expect(RouteControl.options(runAvailable: true) == [.run, .ask, .hold])
        #expect(RouteControl.hint(for: .hold) == "Keeps it as Work")
    }

    @Test
    func theJumpControlIsAGlyphForNewestAndWordsForAnAnswer() {
        #expect(ThreadJumpControl.showsGlyph(ThreadJumpPill.newest))
        #expect(!ThreadJumpControl.showsGlyph(ThreadJumpPill.answer))
        #expect(ThreadJumpControl.jumpLabel == "Jump to latest")
    }
}
