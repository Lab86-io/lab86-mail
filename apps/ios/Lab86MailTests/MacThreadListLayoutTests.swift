#if os(macOS)
import Foundation
import Testing
@testable import Lab86Mail

// The Albatrosses section of the Mac source list
// (docs/research/albatross-threads-macos-design-2026-10-08.md): which rows
// are awake, the cap and "Show N more", the dot on folded rows, the hover
// verbs, the Go menu's hop, where the window goes after the open thread
// leaves, the Dock badge, the menu titles, and the persisted filter. The
// shared words, dots, sections, and sorts are in ThreadRowPresentationTests.
@MainActor
struct MacThreadListLayoutTests {
    private static let now = Date(timeIntervalSince1970: 1_760_000_600)

    private static func item(
        _ id: String,
        title: String = "Renew the car registration",
        workState: String? = "active",
        areaID: String? = "area-home",
        areaName: String? = "Household",
        openQuestions: Int = 0,
        updatedAt: Date? = nil
    ) -> WorkListItem {
        var row: [String: JSONValue] = [
            "_id": .string(id),
            "title": .string(title),
            "rawText": .string(title),
            "status": .string("ready"),
            "openQuestions": .number(Double(openQuestions)),
        ]
        if let workState { row["workState"] = .string(workState) }
        if let areaID { row["primaryAreaId"] = .string(areaID) }
        if let areaName { row["areaName"] = .string(areaName) }
        if let updatedAt { row["updatedAt"] = .number(updatedAt.timeIntervalSince1970 * 1_000) }
        return WorkListItem(json: .object(row))!
    }

    private static func live(
        _ id: String,
        status: ThreadRowStatus,
        unread: Bool = false,
        closed: Bool = false,
        lastActivityAt: Date? = nil
    ) -> ThreadRow {
        ThreadRow(
            workID: id,
            title: "Renew the car registration",
            status: status,
            lastActivityAt: lastActivityAt ?? now.addingTimeInterval(-600),
            unread: unread,
            closed: closed
        )
    }

    private static func row(_ live: ThreadRow?, item: WorkListItem? = nil) -> ThreadListRow {
        ThreadListRow(item: item ?? Self.item(live?.workID ?? "w"), live: live)
    }

    // MARK: - Awake

    @Test func rowsThatNeedTheUserOrWorkAreAwake() {
        #expect(MacThreadListLayout.isAwake(Self.row(Self.live("w", status: .needsAnswer)), now: Self.now))
        #expect(MacThreadListLayout.isAwake(Self.row(Self.live("w", status: .yourTurn)), now: Self.now))
        #expect(MacThreadListLayout.isAwake(Self.row(Self.live("w", status: .inProgress)), now: Self.now))
        #expect(MacThreadListLayout.isAwake(Self.row(Self.live("w", status: .answering)), now: Self.now))
        #expect(MacThreadListLayout.isAwake(Self.row(Self.live("w", status: .startsSoon)), now: Self.now))
    }

    @Test func aFinishedRowIsAwakeOnlyWhileUnread() {
        let unread = Self.live("w", status: .done, unread: true, closed: true)
        let seen = Self.live("w", status: .done, unread: false, closed: true)
        let done = Self.item("w", workState: "done")
        #expect(MacThreadListLayout.isAwake(Self.row(unread, item: done), now: Self.now))
        #expect(!MacThreadListLayout.isAwake(Self.row(seen, item: done), now: Self.now))
    }

    @Test func aQuietRowStaysAwakeForSevenDays() {
        let recent = Self.live("w", status: .idle, lastActivityAt: Self.now.addingTimeInterval(-6 * 86_400))
        let old = Self.live("w", status: .idle, lastActivityAt: Self.now.addingTimeInterval(-8 * 86_400))
        #expect(MacThreadListLayout.isAwake(Self.row(recent), now: Self.now))
        #expect(!MacThreadListLayout.isAwake(Self.row(old), now: Self.now))
        // Without a live row, the list item's own time decides.
        let itemRecent = Self.item("w", updatedAt: Self.now.addingTimeInterval(-3_600))
        let itemOld = Self.item("w", updatedAt: Self.now.addingTimeInterval(-9 * 86_400))
        #expect(MacThreadListLayout.isAwake(Self.row(nil, item: itemRecent), now: Self.now))
        #expect(!MacThreadListLayout.isAwake(Self.row(nil, item: itemOld), now: Self.now))
    }

    @Test func aDormantRowSleepsOnTheAlbatrossesPage() {
        let later = WorkHorizon(kind: .later, notBefore: Self.now.addingTimeInterval(86_400), label: nil)
        let item = Self.item("w").withHorizon(later)
        #expect(!MacThreadListLayout.isAwake(Self.row(Self.live("w", status: .idle), item: item), now: Self.now))
    }

    // MARK: - Order, the cap, and the fold

    @Test func rowsComeInSectionOrderUnderTheFilter() {
        let items = [Self.item("open"), Self.item("needs"), Self.item("works")]
        let live = [
            Self.live("open", status: .idle),
            Self.live("needs", status: .needsAnswer),
            Self.live("works", status: .inProgress),
        ]
        let all = MacThreadListLayout.rows(items: items, live: live, filter: .all, now: Self.now)
        #expect(all.map(\.id) == ["needs", "works", "open"])
        let needs = MacThreadListLayout.rows(items: items, live: live, filter: .needsYou, now: Self.now)
        #expect(needs.map(\.id) == ["needs"])
        let working = MacThreadListLayout.rows(items: items, live: live, filter: .inProgress, now: Self.now)
        #expect(working.map(\.id) == ["works"])
    }

    @Test func twelveRowsShowAndTheRestFold() {
        let rows = (0..<14).map { Self.row(Self.live("w\($0)", status: .idle)) }
        let folded = MacThreadListLayout.visible(rows, showsAll: false)
        #expect(folded.shown.count == MacThreadListLayout.rowLimit)
        #expect(folded.hidden == 2)
        #expect(MacThreadListLayout.folded(rows, showsAll: false).map(\.id) == ["w12", "w13"])
        let open = MacThreadListLayout.visible(rows, showsAll: true)
        #expect(open.shown.count == 14)
        #expect(open.hidden == 0)
        #expect(MacThreadListLayout.moreLabel(total: 14, showsAll: false) == "Show 2 more")
        #expect(MacThreadListLayout.moreLabel(total: 14, showsAll: true) == "Show fewer")
        #expect(MacThreadListLayout.moreLabel(total: 12, showsAll: false) == nil)
    }

    @Test func theFoldedDotIsTheMostUrgentInside() {
        let needs = Self.row(Self.live("a", status: .needsAnswer))
        let works = Self.row(Self.live("b", status: .inProgress))
        let waits = Self.row(Self.live("c", status: .startsSoon))
        let quiet = Self.row(Self.live("d", status: .idle))
        #expect(MacThreadListLayout.dot(for: [quiet, works, needs]) == .needsYou)
        #expect(MacThreadListLayout.dot(for: [quiet, waits, works]) == .working)
        #expect(MacThreadListLayout.dot(for: [quiet, waits]) == .startsSoon)
        #expect(MacThreadListLayout.dot(for: [quiet]) == .none)
        #expect(MacThreadListLayout.dot(for: []) == .none)
    }

    // MARK: - The hover slot

    @Test func theHoverVerbsByStatus() {
        #expect(MacThreadListLayout.hoverVerbs(.needsAnswer) == [.answer])
        #expect(MacThreadListLayout.hoverVerbs(.yourTurn) == [.openPage])
        #expect(MacThreadListLayout.hoverVerbs(.inProgress) == [.steer, .stop])
        #expect(MacThreadListLayout.hoverVerbs(.answering) == [.stopReply])
        #expect(MacThreadListLayout.hoverVerbs(.startsSoon) == [.stop])
        #expect(MacThreadListLayout.hoverVerbs(.stopped) == [.continueRun])
        #expect(MacThreadListLayout.hoverVerbs(.readyForYou).isEmpty)
        #expect(MacThreadListLayout.hoverVerbs(.idle).isEmpty)
    }

    // MARK: - The hop

    private static var hopRows: [ThreadListRow] {
        [
            Self.row(Self.live("needs1", status: .needsAnswer)),
            Self.row(Self.live("works", status: .inProgress)),
            Self.row(Self.live("needs2", status: .yourTurn)),
            Self.row(Self.live("open", status: .idle)),
        ]
    }

    @Test func nextAndPreviousWrap() {
        let rows = Self.hopRows
        #expect(MacThreadListLayout.target(.next, from: "needs1", in: rows)?.id == "works")
        #expect(MacThreadListLayout.target(.next, from: "open", in: rows)?.id == "needs1")
        #expect(MacThreadListLayout.target(.previous, from: "needs1", in: rows)?.id == "open")
        #expect(MacThreadListLayout.target(.previous, from: "works", in: rows)?.id == "needs1")
        // Without an open thread, the ends.
        #expect(MacThreadListLayout.target(.next, from: nil, in: rows)?.id == "needs1")
        #expect(MacThreadListLayout.target(.previous, from: nil, in: rows)?.id == "open")
        // An open thread that left the list: the ends again.
        #expect(MacThreadListLayout.target(.next, from: "gone", in: rows)?.id == "needs1")
        #expect(MacThreadListLayout.target(.next, from: "x", in: []) == nil)
    }

    @Test func nextThatNeedsYouGoesForwardThenFromTheTop() {
        let rows = Self.hopRows
        #expect(MacThreadListLayout.target(.nextNeedsYou, from: "needs1", in: rows)?.id == "needs2")
        #expect(MacThreadListLayout.target(.nextNeedsYou, from: "needs2", in: rows)?.id == "needs1")
        #expect(MacThreadListLayout.target(.nextNeedsYou, from: "open", in: rows)?.id == "needs1")
        #expect(MacThreadListLayout.target(.nextNeedsYou, from: nil, in: rows)?.id == "needs1")
        // The only row that needs the user is the open one: nowhere to go.
        let one = [Self.row(Self.live("needs1", status: .needsAnswer)), Self.row(Self.live("open", status: .idle))]
        #expect(MacThreadListLayout.target(.nextNeedsYou, from: "needs1", in: one) == nil)
        let none = [Self.row(Self.live("open", status: .idle))]
        #expect(MacThreadListLayout.target(.nextNeedsYou, from: nil, in: none) == nil)
    }

    @Test func afterTheOpenThreadLeavesTheNextOneThatNeedsYouOpens() {
        let rows = Self.hopRows
        #expect(MacThreadListLayout.afterLeaving("works", in: rows)?.id == "needs1")
        #expect(MacThreadListLayout.afterLeaving("needs1", in: rows)?.id == "needs2")
        // Nothing needs the user: the next row.
        let quiet = [
            Self.row(Self.live("a", status: .idle)),
            Self.row(Self.live("b", status: .idle)),
            Self.row(Self.live("c", status: .idle)),
        ]
        #expect(MacThreadListLayout.afterLeaving("b", in: quiet)?.id == "c")
        #expect(MacThreadListLayout.afterLeaving("c", in: quiet)?.id == "a")
        // The last one: the Albatrosses page.
        #expect(MacThreadListLayout.afterLeaving("a", in: [Self.row(Self.live("a", status: .idle))]) == nil)
    }

    @Test func theBannerShowsOnlyWhileTheSourceListIsHidden() {
        #expect(MacThreadListLayout.showsBanner(sidebarShown: false))
        #expect(!MacThreadListLayout.showsBanner(sidebarShown: true))
    }

    // MARK: - The badge, the menus, the filter

    @Test func theDockBadgeIsTheNeedsYouCount() {
        #expect(MacDockBadge.label(needsYou: 0) == nil)
        #expect(MacDockBadge.label(needsYou: 3) == "3")
    }

    @Test func theMenuTitles() {
        #expect(MacThreadCommandState.albatrossesTitle(expanded: true) == "Hide Albatrosses")
        #expect(MacThreadCommandState.albatrossesTitle(expanded: false) == "Show Albatrosses")
        #expect(MacThreadCommandState.unreadTitle(unread: true) == "Mark as Read")
        #expect(MacThreadCommandState.unreadTitle(unread: false) == "Mark as Unread")
        #expect(MacThreadCommandState.filterItemTitle(.all) == "All Albatrosses")
        #expect(MacThreadCommandState.filterItemTitle(.needsYou) == "Needs You")
        #expect(MacThreadCommandState.filterItemTitle(.inProgress) == "In Progress")
        // Enabled exactly when the move finds a row in the same rows.
        let rows = [Self.row(Self.live("needs1", status: .needsAnswer)), Self.row(Self.live("open", status: .idle))]
        #expect(MacGoCommandState.nextNeedsYouEnabled(from: "open", in: rows))
        #expect(MacGoCommandState.nextNeedsYouEnabled(from: nil, in: rows))
        // The only needs-you row is the open one, or the filter hid them all.
        #expect(!MacGoCommandState.nextNeedsYouEnabled(from: "needs1", in: rows))
        #expect(!MacGoCommandState.nextNeedsYouEnabled(from: nil, in: [Self.row(Self.live("open", status: .idle))]))
        #expect(MacThreadListLayout.filters == [.all, .needsYou, .inProgress])
    }

    @Test func theSectionWordsForVoiceOver() {
        #expect(MacThreadRowsCopy.headerLabel(needsYou: 0, expanded: true) == "Albatrosses, expanded")
        #expect(MacThreadRowsCopy.headerLabel(needsYou: 1, expanded: false) == "Albatrosses, 1 needs you, collapsed")
        #expect(MacThreadRowsCopy.headerLabel(needsYou: 2, expanded: true) == "Albatrosses, 2 need you, expanded")
        #expect(MacThreadRowsCopy.stopped("Pay the water bill") == "Stopped Pay the water bill")
        #expect(MacThreadListLayout.emptyLine(filter: .needsYou) == "Nothing needs you.")
        #expect(MacThreadListLayout.emptyLine(filter: .inProgress) == "Nothing in progress.")
    }

    @Test func theFilterAndTheDisclosureSurviveARelaunch() throws {
        let suite = "MacThreadListLayoutTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = MacRequests(defaults: defaults)
        #expect(first.threadFilter == .all)
        #expect(first.threadsExpanded)
        first.setThreadFilter(.needsYou)
        first.setThreadsExpanded(false)
        let second = MacRequests(defaults: defaults)
        #expect(second.threadFilter == .needsYou)
        #expect(!second.threadsExpanded)
    }

    @Test func theAlbatrossesRowYieldsToAnOpenThread() {
        #expect(MacSourceSelection.isPrimarySelected(.work, selectedTab: .work, areaID: nil, mailLabelID: nil, workOpen: false))
        #expect(!MacSourceSelection.isPrimarySelected(.work, selectedTab: .work, areaID: nil, mailLabelID: nil, workOpen: true))
        // Other rows do not care.
        #expect(MacSourceSelection.isPrimarySelected(.today, selectedTab: .today, areaID: nil, mailLabelID: nil, workOpen: true))
    }
}
#endif
