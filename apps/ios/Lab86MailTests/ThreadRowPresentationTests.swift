import Foundation
import Testing
@testable import Lab86Mail

// The pure rules of the thread list (docs/albatross-threads.md and the iOS
// design note of 2026-10-08): the dot, the status line, the time label,
// the sections, the sort, the filter, the verbs, and the VoiceOver label.
// The Mac rail reads the same rules; a change here changes both.
struct ThreadRowPresentationTests {
    private static let now = Date(timeIntervalSince1970: 1_760_000_600)

    private static func item(
        _ id: String,
        title: String = "Renew the car registration",
        status: String = "ready",
        workState: String? = "active",
        agentState: String? = "idle",
        areaID: String? = "area-home",
        areaName: String? = "Household",
        openQuestions: Int = 0,
        nextStep: String? = nil,
        updatedAt: Date? = nil
    ) -> WorkListItem {
        var row: [String: JSONValue] = [
            "_id": .string(id),
            "title": .string(title),
            "rawText": .string(title),
            "status": .string(status),
            "openQuestions": .number(Double(openQuestions)),
        ]
        if let workState { row["workState"] = .string(workState) }
        if let agentState { row["agentState"] = .string(agentState) }
        if let areaID { row["primaryAreaId"] = .string(areaID) }
        if let areaName { row["areaName"] = .string(areaName) }
        if let nextStep { row["nextStep"] = .string(nextStep) }
        if let updatedAt { row["updatedAt"] = .number(updatedAt.timeIntervalSince1970 * 1_000) }
        return WorkListItem(json: .object(row))!
    }

    private static func live(
        _ id: String,
        status: ThreadRowStatus,
        statusLabel: String? = nil,
        preview: String? = nil,
        stepTitle: String? = nil,
        unread: Bool = false,
        runStartedAt: Date? = nil,
        lastActivityAt: Date? = nil
    ) -> ThreadRow {
        ThreadRow(
            workID: id,
            title: "Renew the car registration",
            status: status,
            statusLabel: statusLabel,
            preview: preview,
            stepTitle: stepTitle,
            runStartedAt: runStartedAt,
            lastActivityAt: lastActivityAt,
            unread: unread
        )
    }

    private static func row(_ live: ThreadRow?, item: WorkListItem? = nil) -> ThreadListRow {
        ThreadListRow(item: item ?? Self.item(live?.workID ?? "w"), live: live)
    }

    // MARK: - The dot

    @Test("The dot by status")
    func dot() {
        #expect(ThreadRowPresentation.dot(Self.row(Self.live("w", status: .needsAnswer))) == .needsYou)
        #expect(ThreadRowPresentation.dot(Self.row(Self.live("w", status: .yourTurn))) == .needsYou)
        #expect(ThreadRowPresentation.dot(Self.row(Self.live("w", status: .didNotFinish))) == .needsYou)
        #expect(ThreadRowPresentation.dot(Self.row(Self.live("w", status: .inProgress))) == .working)
        #expect(ThreadRowPresentation.dot(Self.row(Self.live("w", status: .answering))) == .working)
        #expect(ThreadRowPresentation.dot(Self.row(Self.live("w", status: .startsSoon))) == .startsSoon)
        #expect(ThreadRowPresentation.dot(Self.row(Self.live("w", status: .done, unread: true))) == .none)
        #expect(ThreadRowPresentation.dot(Self.row(Self.live("w", status: .idle))) == .none)
    }

    @Test("Without a live row the list item's own rules decide the dot")
    func dotWithoutLive() {
        let asks = Self.item("w", status: "needs_answers", agentState: "needs_input", openQuestions: 1)
        #expect(ThreadRowPresentation.dot(Self.row(nil, item: asks)) == .needsYou)
        #expect(ThreadRowPresentation.dot(Self.row(nil, item: Self.item("w"))) == .none)
    }

    // MARK: - The words

    @Test("Line 2 is the word and the preview, as two parts and as one sentence")
    func statusLine() {
        let row = Self.row(Self.live("w", status: .needsAnswer, preview: "Which renewal term do you want?"))
        let parts = ThreadRowPresentation.statusParts(row)
        #expect(parts.word == "Needs your answer")
        #expect(parts.preview == "Which renewal term do you want?")
        #expect(ThreadRowPresentation.statusLine(row) == "Needs your answer. Which renewal term do you want?")
        #expect(!ThreadRowPresentation.statusLine(row).contains("·"))
    }

    @Test("A working row without a preview shows its step")
    func statusLineStep() {
        let row = Self.row(Self.live("w", status: .inProgress, stepTitle: "Fill in the renewal form"))
        #expect(ThreadRowPresentation.statusParts(row).preview == "Fill in the renewal form")
        #expect(ThreadRowPresentation.statusLine(row) == "In progress. Fill in the renewal form")
    }

    @Test("Without a word the standing line is the preview part")
    func statusPartsStanding() {
        let parts = ThreadRowPresentation.statusParts(Self.row(nil, item: Self.item("w")))
        #expect(parts.word == nil)
        #expect(parts.preview == "Albatross is carrying this")
    }

    @Test("A word alone, a preview alone, and the standing line")
    func statusLineFallbacks() {
        #expect(ThreadRowPresentation.statusLine(Self.row(Self.live("w", status: .done))) == "Done")
        let waiting = Self.row(Self.live("w", status: .waiting, preview: "Waiting on the clerk"))
        #expect(ThreadRowPresentation.statusLine(waiting) == "Waiting on the clerk")
        let idle = Self.row(Self.live("w", status: .idle), item: Self.item("w", nextStep: "Call the DMV"))
        #expect(ThreadRowPresentation.statusLine(idle) == "Next: Call the DMV")
        #expect(ThreadRowPresentation.statusLine(Self.row(nil, item: Self.item("w"))) == "Albatross is carrying this")
    }

    @Test("The server's label leads line 2")
    func serverLabel() {
        let row = Self.row(Self.live("w", status: .stopped, statusLabel: "Stopped by you", preview: "Next: Fill in the renewal form"))
        #expect(ThreadRowPresentation.statusLine(row) == "Stopped by you. Next: Fill in the renewal form")
    }

    @Test("A stale live row says when it was last seen")
    func staleLine() {
        let at = Date(timeIntervalSince1970: 1_760_000_000)
        let row = Self.row(Self.live("w", status: .inProgress, preview: "Typed the plate", lastActivityAt: at))
        let line = ThreadRowPresentation.staleLine(row, locale: Locale(identifier: "en_US"))
        #expect(line.hasPrefix("In progress, last seen "))
        let parts = ThreadRowPresentation.staleParts(row, locale: Locale(identifier: "en_US"))
        #expect(parts.word == "In progress")
        #expect(parts.preview?.hasPrefix("Last seen ") == true)
        #expect(line != ThreadRowPresentation.statusLine(row))
        let done = Self.row(Self.live("w", status: .done, lastActivityAt: at))
        #expect(ThreadRowPresentation.staleLine(done) == "Done")
    }

    // MARK: - The time

    @Test("The elapsed words")
    func elapsed() {
        let locale = Locale(identifier: "en_US")
        let now = Self.now
        #expect(ThreadRowPresentation.elapsed(from: now.addingTimeInterval(-30), to: now, locale: locale) == "now")
        #expect(ThreadRowPresentation.elapsed(from: now.addingTimeInterval(-4 * 60), to: now, locale: locale) == "4 min")
        #expect(ThreadRowPresentation.elapsed(from: now.addingTimeInterval(-2 * 3_600), to: now, locale: locale) == "2 h")
        #expect(ThreadRowPresentation.elapsed(from: now.addingTimeInterval(-3 * 86_400), to: now, locale: locale) == "3 d")
        let old = ThreadRowPresentation.elapsed(from: now.addingTimeInterval(-30 * 86_400), to: now, locale: locale)
        #expect(!old.hasSuffix(" d"))
        #expect(ThreadRowPresentation.elapsed(from: now.addingTimeInterval(60), to: now, locale: locale) == "now")
    }

    @Test("A working row counts from the run start; others from the last activity")
    func timeLabel() {
        let locale = Locale(identifier: "en_US")
        let started = Self.now.addingTimeInterval(-9 * 60)
        let working = Self.row(Self.live("w", status: .inProgress, runStartedAt: started, lastActivityAt: Self.now.addingTimeInterval(-60)))
        #expect(ThreadRowPresentation.timeLabel(working, now: Self.now, locale: locale) == "9 min")
        let done = Self.row(Self.live("w", status: .done, runStartedAt: started, lastActivityAt: Self.now.addingTimeInterval(-3 * 3_600)))
        #expect(ThreadRowPresentation.timeLabel(done, now: Self.now, locale: locale) == "3 h")
        let item = Self.item("w", updatedAt: Self.now.addingTimeInterval(-2 * 86_400))
        #expect(ThreadRowPresentation.timeLabel(Self.row(nil, item: item), now: Self.now, locale: locale) == "2 d")
        #expect(ThreadRowPresentation.timeLabel(Self.row(nil, item: Self.item("w")), now: Self.now, locale: locale) == nil)
    }

    // MARK: - Sections and sort

    @Test("The section by live status: needs you, in progress, open")
    func section() {
        #expect(ThreadRowPresentation.section(Self.row(Self.live("w", status: .needsAnswer))) == .needsYou)
        #expect(ThreadRowPresentation.section(Self.row(Self.live("w", status: .didNotFinish))) == .needsYou)
        #expect(ThreadRowPresentation.section(Self.row(Self.live("w", status: .inProgress))) == .inProgress)
        #expect(ThreadRowPresentation.section(Self.row(Self.live("w", status: .startsSoon))) == .inProgress)
        #expect(ThreadRowPresentation.section(Self.row(Self.live("w", status: .answering))) == .inProgress)
        #expect(ThreadRowPresentation.section(Self.row(Self.live("w", status: .stopped))) == .open)
        #expect(ThreadRowPresentation.section(Self.row(Self.live("w", status: .done))) == .open)
        #expect(ThreadRowPresentation.section(Self.row(Self.live("w", status: .waiting))) == .open)
    }

    @Test("Without a live row the list item decides the section")
    func sectionWithoutLive() {
        let asks = Self.item("w", status: "needs_answers", agentState: "needs_input", openQuestions: 1)
        #expect(ThreadRowPresentation.section(Self.row(nil, item: asks)) == .needsYou)
        #expect(ThreadRowPresentation.section(Self.row(nil, item: Self.item("w"))) == .open)
    }

    @Test("Newest activity first; a run that waits for a slot sorts last")
    func sort() {
        let rows = [
            Self.row(Self.live("a", status: .inProgress, lastActivityAt: Self.now.addingTimeInterval(-300))),
            Self.row(Self.live("b", status: .startsSoon, lastActivityAt: Self.now)),
            Self.row(Self.live("c", status: .inProgress, lastActivityAt: Self.now.addingTimeInterval(-60))),
        ]
        #expect(ThreadRowPresentation.sorted(rows).map(\.id) == ["c", "a", "b"])
    }

    @Test("The sections in order, each sorted, empty ones dropped")
    func sections() {
        let rows = [
            Self.row(Self.live("open", status: .done, lastActivityAt: Self.now)),
            Self.row(Self.live("run", status: .inProgress, lastActivityAt: Self.now)),
            Self.row(Self.live("ask", status: .needsAnswer, lastActivityAt: Self.now)),
        ]
        let sections = ThreadListGrouping.sections(rows)
        #expect(sections.map(\.section) == [.needsYou, .inProgress, .open])
        #expect(sections.map { $0.rows.map(\.id) } == [["ask"], ["run"], ["open"]])
        #expect(ThreadListGrouping.sections([]).isEmpty)
    }

    @Test("The rows merge the two reads on the Work id")
    func merge() {
        let items = [Self.item("a"), Self.item("b")]
        let rows = ThreadListGrouping.rows(items: items, live: [Self.live("b", status: .inProgress), Self.live("zzz", status: .done)])
        #expect(rows.map(\.id) == ["a", "b"])
        #expect(rows[0].live == nil)
        #expect(rows[1].status == .inProgress)
    }

    @Test("The filters: all, needs you, in progress, no area yet, and an Area")
    func filter() {
        let rows = [
            Self.row(Self.live("ask", status: .needsAnswer)),
            Self.row(Self.live("run", status: .inProgress)),
            Self.row(Self.live("done", status: .done), item: Self.item("done", areaID: nil, areaName: nil)),
        ]
        #expect(ThreadListGrouping.filter(rows, by: .all, areaID: nil).map(\.id) == ["ask", "run", "done"])
        #expect(ThreadListGrouping.filter(rows, by: .needsYou, areaID: nil).map(\.id) == ["ask"])
        #expect(ThreadListGrouping.filter(rows, by: .inProgress, areaID: nil).map(\.id) == ["run"])
        #expect(ThreadListGrouping.filter(rows, by: .unhomed, areaID: nil).map(\.id) == ["done"])
        #expect(ThreadListGrouping.filter(rows, by: .all, areaID: "area-home").map(\.id) == ["ask", "run"])
    }

    @Test("The filter words")
    func filterWords() {
        #expect(WorkFilter.all.label == "All")
        #expect(WorkFilter.needsYou.label == "Needs you")
        #expect(WorkFilter.inProgress.label == "In progress")
        #expect(WorkFilter.unhomed.label == "No area yet")
    }

    @Test("The section words")
    func sectionWords() {
        #expect(ThreadListSection.needsYou.label == "Needs you")
        #expect(ThreadListSection.inProgress.label == "In progress")
        #expect(ThreadListSection.open.label == "Open")
        #expect(ThreadListSection.needsYou.asksForYou)
        #expect(!ThreadListSection.open.asksForYou)
    }

    // MARK: - Verbs

    @Test("The swipe buttons by status, two at most, from the edge")
    func swipeVerbs() {
        #expect(ThreadRowPresentation.swipeVerbs(.needsAnswer) == [.answer])
        #expect(ThreadRowPresentation.swipeVerbs(.yourTurn) == [.openPage])
        #expect(ThreadRowPresentation.swipeVerbs(.inProgress) == [.steer, .stop])
        #expect(ThreadRowPresentation.swipeVerbs(.answering) == [.stopReply])
        #expect(ThreadRowPresentation.swipeVerbs(.startsSoon) == [.stop])
        #expect(ThreadRowPresentation.swipeVerbs(.stopped) == [.continueRun])
        #expect(ThreadRowPresentation.swipeVerbs(.readyForYou).isEmpty)
        #expect(ThreadRowPresentation.swipeVerbs(.didNotFinish).isEmpty)
        #expect(ThreadRowPresentation.swipeVerbs(.done).isEmpty)
        #expect(ThreadRowPresentation.swipeVerbs(.idle).isEmpty)
        for status in ThreadRowStatus.allCases {
            #expect(ThreadRowPresentation.swipeVerbs(status).count <= 2)
        }
    }

    @Test("The menu adds Stop and redirect to a run in progress")
    func menuVerbs() {
        #expect(ThreadRowPresentation.menuVerbs(.inProgress) == [.steer, .stopAndRedirect, .stop])
        #expect(ThreadRowPresentation.menuVerbs(.answering) == [.stopReply])
        #expect(ThreadRowPresentation.menuVerbs(.done).isEmpty)
    }

    @Test("The verb words are text only, sentence case")
    func verbWords() {
        #expect(ThreadRowVerb.answer.label == "Answer")
        #expect(ThreadRowVerb.openPage.label == "Open the page")
        #expect(ThreadRowVerb.steer.label == "Steer")
        #expect(ThreadRowVerb.stop.label == "Stop")
        #expect(ThreadRowVerb.stopReply.label == "Stop")
        #expect(ThreadRowVerb.stopReply.menuLabel == "Stop the reply")
        #expect(ThreadRowVerb.steer.menuLabel == "Steer…")
        #expect(ThreadRowVerb.stopAndRedirect.menuLabel == "Stop and redirect…")
        #expect(ThreadRowVerb.continueRun.label == "Continue")
        for verb in ThreadRowVerb.allCases {
            #expect(verb.label == verb.label.lowercased() || verb.label.first?.isUppercase == true)
            #expect(verb.label != verb.label.uppercased())
        }
    }

    // MARK: - Area pills

    @Test("The Area pills come from the rows, by name, once each")
    func areaChoices() {
        let rows = [
            Self.row(nil, item: Self.item("a", areaID: "area-work", areaName: "Team offsite")),
            Self.row(nil, item: Self.item("b", areaID: "area-home", areaName: "Household")),
            Self.row(nil, item: Self.item("c", areaID: "area-work", areaName: "Team offsite")),
            Self.row(nil, item: Self.item("d", areaID: nil, areaName: nil)),
        ]
        let choices = ThreadListGrouping.areaChoices(rows)
        #expect(choices.map(\.name) == ["Household", "Team offsite"])
        #expect(choices.map(\.id) == ["area-home", "area-work"])
        #expect(ThreadListGrouping.filter(rows, by: .all, areaID: "area-work").map(\.id) == ["a", "c"])
    }

    @Test("Paused and released Work offers Pick it up")
    func putDownState() {
        #expect(WorkViewCopy.isPutDown("paused"))
        #expect(WorkViewCopy.isPutDown("released"))
        #expect(!WorkViewCopy.isPutDown("active"))
        #expect(!WorkViewCopy.isPutDown(nil))
    }

    // MARK: - Release

    @Test("A release goes to the recover route with the release recovery and the reason")
    func releaseRequest() {
        #expect(ReleaseRequest.path(workID: "w1") == "/api/albatross/work/w1/recover")
        let body = ReleaseRequest.body(reason: "  Not this year.  ", timezone: "America/New_York")
        #expect(body["recovery"]?.stringValue == "release")
        #expect(body["reasonKind"]?.stringValue == "other")
        #expect(body["timezone"]?.stringValue == "America/New_York")
        #expect(body["reason"]?.stringValue == "Not this year.")
        let silent = ReleaseRequest.body(reason: "   ", timezone: "UTC")
        #expect(silent["reason"] == nil)
        #expect(ReleaseCopy.title("Renew the passport") == "Put “Renew the passport” down?")
    }

    // MARK: - VoiceOver

    @Test("The VoiceOver label: the title leads, then the state, the time, the area, and unread")
    func accessibilityLabel() {
        let row = Self.row(Self.live("w", status: .needsAnswer, preview: "Which renewal term do you want?", unread: true))
        let label = ThreadRowPresentation.accessibilityLabel(row, time: "4 min", area: "Household")
        #expect(label == "Renew the car registration. Needs your answer. Which renewal term do you want? 4 min. Household. Unread")
        #expect(ThreadRowPresentation.spokenJoin(["Done.", "Paid!", "Now"]) == "Done. Paid! Now")
        #expect(ThreadRowPresentation.spokenJoin([]) == "")
        let seen = Self.row(Self.live("w", status: .done))
        #expect(ThreadRowPresentation.accessibilityLabel(seen, time: nil, area: nil) == "Renew the car registration. Done")
    }

    // MARK: - The composer route

    @Test("The route after a flip: Run, Ask, Hold, Run while a run works")
    func routeOrder() {
        #expect(BarRoute.run.next(runAvailable: true) == .ask)
        #expect(BarRoute.ask.next(runAvailable: true) == .hold)
        #expect(BarRoute.hold.next(runAvailable: true) == .run)
        #expect(BarRoute.ask.next(runAvailable: false) == .hold)
        #expect(BarRoute.hold.next(runAvailable: false) == .ask)
        #expect(BarRoute.run.flipped == .ask)
        #expect(BarRoute.run.word == "Run")
    }

    @Test("The route line and the words of the thread")
    func threadWords() {
        #expect(RunBlockCopy.runRouteLine(stepNumber: 2, title: "Renew online") == "To the run · Step 2, Renew online")
        #expect(RunBlockCopy.runRouteLine(stepNumber: nil, title: "Renew online") == "To the run · Renew online")
        // A goal run, as on the web: the checklist names the current item.
        #expect(RunBlockCopy.runRouteLine(stepNumber: 2, title: "Bill Harbor Design for the quarter", goal: true) == "To the run")
        #expect(RunBlockCopy.replyInProgress == "Reply in progress")
        #expect(RunBlockCopy.stopAndRedirect == "Stop and redirect")
        #expect(RunBlockCopy.redirectPlaceholder == "What should Albatross do instead?")
    }

    @Test("The banner line and its announcement")
    func bannerWords() {
        let one = [Self.live("w", status: .needsAnswer)]
        #expect(NeedsYouBannerCopy.line(one) == "Renew the car registration · Needs your answer")
        #expect(NeedsYouBannerCopy.announcement(one) == "Renew the car registration needs your answer.")
        let two = [Self.live("a", status: .needsAnswer), Self.live("b", status: .yourTurn)]
        #expect(NeedsYouBannerCopy.line(two) == "2 Albatrosses need you")
        #expect(NeedsYouBannerCopy.announcement(two) == "2 Albatrosses need you.")
    }

    @Test("The quick-steer subtitle")
    func steerSubtitle() {
        let row = Self.row(Self.live("w", status: .inProgress, stepTitle: "Pay the bill on the city site"))
        #expect(QuickSteerCopy.subtitle(row: row, redirect: false) == "In progress · Pay the bill on the city site")
        #expect(QuickSteerCopy.subtitle(row: row, redirect: true) == QuickSteerCopy.redirectLine)
        #expect(QuickSteerCopy.subtitle(row: Self.row(Self.live("w", status: .inProgress)), redirect: false) == "In progress")
    }
}
