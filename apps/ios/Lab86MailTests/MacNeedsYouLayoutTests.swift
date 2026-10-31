#if os(macOS)
import Foundation
import Testing
@testable import Lab86Mail

// Needs you on the Mac (docs/needs-you.md, phase 5): the rows the list
// shows, the moves of the keys, where the selection goes after a row
// leaves, what the bare keys and Command-C do on each kind of row, the
// hover verb, the words and enabled states of the Needs You menu, the menu
// requests, and the sidebar row. The groups, the words, and the first
// button are covered by the shared Needs you tests. Invented people only.
struct MacNeedsYouLayoutTests {
    private static let now: ObligationMillis = 1_793_210_700_000
    private static let tz = "America/Los_Angeles"

    private static func item(
        _ id: String,
        kind: ObligationKind = .reply,
        state: ObligationState = .open,
        source: ObligationSource = .mail,
        url: URL? = nil,
        accountID: String? = "acct_1",
        threadID: String? = "thread_1",
        due: ObligationDue = .soon,
        workID: String? = nil,
        pushLevel: ObligationPushLevel = .normal,
        code: ObligationCode? = nil,
        closedAt: ObligationMillis? = nil,
        closeReason: ObligationCloseReason? = nil
    ) -> ObligationView {
        ObligationView(
            id: id,
            kind: kind,
            state: state,
            source: source,
            sourceKey: "key:\(id)",
            url: url,
            accountID: accountID,
            threadID: threadID,
            title: "Asks you to confirm the start date.",
            asker: "Dana Whitfield",
            askerAddress: "dana@northwindlegal.example.com",
            due: due,
            workID: workID,
            pushLevel: pushLevel,
            code: code,
            createdAt: now - 120_000,
            closedAt: closedAt,
            closeReason: closeReason
        )
    }

    private static let code = item(
        "ob_code",
        kind: .code,
        code: ObligationCode(value: "482913", expiresAt: now + 480_000)
    )
    private static let change = item("ob_change", kind: .change, pushLevel: .timeSensitive)
    private static let reply = item("ob_reply")
    private static let action = item(
        "ob_action",
        kind: .action,
        source: .slack,
        url: URL(string: "https://slack.example.com/archives/C1/p1"),
        accountID: nil,
        threadID: nil,
        workID: "w_1"
    )
    private static let waiting = item("ob_waiting", kind: .waiting, due: .none)
    private static let rsvp = item("ob_rsvp", kind: .rsvp, source: .calendar, accountID: nil, threadID: nil, due: .today)
    private static let done = item("ob_done", state: .done, closedAt: now - 60_000, closeReason: .userDone)

    private static func groups() -> [NeedsYouGroup] {
        NeedsYouGrouping.groups(
            items: [code, change, reply, action, waiting, rsvp, done],
            extras: [NeedsYouExtra(id: "question:q1", kind: .question, title: "Q3 review deck", line: "Which quarter?", workID: "w_2")],
            now: now,
            timezone: tz
        )
    }

    // MARK: - The rows

    @Test func theListShowsTheGroupsInOrderAndHidesClosedUntilOpened() {
        let groups = Self.groups()
        let folded = MacNeedsYouLayout.visibleIDs(groups, showsClosed: false)
        #expect(folded.first == "ob_code")
        #expect(!folded.contains("ob_done"))
        #expect(folded.contains("question:q1"))
        #expect(folded == groups.filter { $0.id != .closedToday }.flatMap { $0.entries.map(\.id) })
        let shown = MacNeedsYouLayout.visibleIDs(groups, showsClosed: true)
        #expect(shown.last == "ob_done")
        #expect(shown.count == folded.count + 1)
        #expect(MacNeedsYouLayout.visibleEntries(groups, showsClosed: true).last?.obligation?.id == "ob_done")
    }

    // MARK: - The keys

    @Test func theKeysMoveAcrossGroupsAndStopAtTheEnds() {
        let ids = ["a", "b", "c"]
        #expect(MacNeedsYouLayout.target(.down, from: nil, in: ids) == "a")
        #expect(MacNeedsYouLayout.target(.up, from: nil, in: ids) == "c")
        #expect(MacNeedsYouLayout.target(.down, from: "a", in: ids) == "b")
        #expect(MacNeedsYouLayout.target(.down, from: "c", in: ids) == "c")
        #expect(MacNeedsYouLayout.target(.up, from: "b", in: ids) == "a")
        #expect(MacNeedsYouLayout.target(.up, from: "a", in: ids) == "a")
        #expect(MacNeedsYouLayout.target(.first, from: "c", in: ids) == "a")
        #expect(MacNeedsYouLayout.target(.last, from: "a", in: ids) == "c")
        // A stale selection moves from the top.
        #expect(MacNeedsYouLayout.target(.down, from: "gone", in: ids) == "a")
        #expect(MacNeedsYouLayout.target(.down, from: nil, in: []) == nil)
    }

    @Test func theSelectionGoesToTheNeighbourAfterItsRowLeaves() {
        let old = ["a", "b", "c", "d"]
        #expect(MacNeedsYouLayout.afterLeaving("b", old: old, remaining: ["a", "c", "d"]) == "c")
        // The row after it left too: the next one that stayed.
        #expect(MacNeedsYouLayout.afterLeaving("b", old: old, remaining: ["a", "d"]) == "d")
        // The last row: the one before it.
        #expect(MacNeedsYouLayout.afterLeaving("d", old: old, remaining: ["a", "b", "c"]) == "c")
        #expect(MacNeedsYouLayout.afterLeaving("a", old: old, remaining: []) == nil)
        // A row the old list did not know: the first row that is there.
        #expect(MacNeedsYouLayout.afterLeaving("x", old: old, remaining: ["c"]) == "c")
    }

    @Test func eMarksDoneAndLOffersLaterOnlyWhereTheDetailOffersThem() {
        #expect(MacNeedsYouLayout.keyAction("e", on: .obligation(Self.reply)) == .done)
        #expect(MacNeedsYouLayout.keyAction("e", on: .obligation(Self.action)) == .done)
        #expect(MacNeedsYouLayout.keyAction("e", on: .obligation(Self.waiting)) == .done)
        #expect(MacNeedsYouLayout.keyAction("e", on: .obligation(Self.code)) == nil)
        #expect(MacNeedsYouLayout.keyAction("e", on: .obligation(Self.rsvp)) == nil)
        #expect(MacNeedsYouLayout.keyAction("e", on: .obligation(Self.done)) == nil)
        #expect(MacNeedsYouLayout.keyAction("l", on: .obligation(Self.reply)) == .later)
        #expect(MacNeedsYouLayout.keyAction("l", on: .obligation(Self.rsvp)) == .later)
        #expect(MacNeedsYouLayout.keyAction("l", on: .obligation(Self.code)) == nil)
        #expect(MacNeedsYouLayout.keyAction("l", on: .obligation(Self.done)) == nil)
        let extra = NeedsYouExtra(id: "question:q1", kind: .question, title: "Q3 review deck")
        #expect(MacNeedsYouLayout.keyAction("e", on: .albatross(extra)) == nil)
        // j and k are moves, not actions; the list handles them first.
        #expect(MacNeedsYouLayout.keyAction("j", on: .obligation(Self.reply)) == nil)
        #expect(MacNeedsYouLayout.keyAction("e", on: nil) == nil)
    }

    @Test func commandCCopiesOnlyAnOpenCode() {
        #expect(MacNeedsYouLayout.copyItems(for: .obligation(Self.code)) == ["482913"])
        #expect(MacNeedsYouLayout.copyItems(for: .obligation(Self.reply)) == [])
        var used = Self.code
        used.state = .done
        used.closeReason = .codeUsed
        #expect(MacNeedsYouLayout.copyItems(for: .obligation(used)) == [])
        #expect(MacNeedsYouLayout.copyItems(for: nil) == [])
    }

    // MARK: - The hover slot

    @Test func theHoverSlotShowsCopyOnACodeAndDoneOnTheRest() {
        #expect(MacNeedsYouLayout.hoverVerbs(Self.code) == [.copy])
        #expect(MacNeedsYouLayout.hoverVerbs(Self.reply) == [.done])
        #expect(MacNeedsYouLayout.hoverVerbs(Self.action) == [.done])
        #expect(MacNeedsYouLayout.hoverVerbs(Self.rsvp) == [])
        #expect(MacNeedsYouLayout.hoverVerbs(Self.done) == [])
        #expect(MacNeedsYouLayout.HoverVerb.copy.label == "Copy")
        #expect(MacNeedsYouLayout.HoverVerb.done.label == "Done")
    }

    // MARK: - The menu

    @Test func theMenuItemsFollowThePageAndTheSelectedRow() {
        #expect(MacNeedsYouCommandState.isPageUp(selectedTab: .needsYou, sheetOpen: false))
        #expect(!MacNeedsYouCommandState.isPageUp(selectedTab: .needsYou, sheetOpen: true))
        #expect(!MacNeedsYouCommandState.isPageUp(selectedTab: .mail, sheetOpen: false))

        #expect(MacNeedsYouCommandState.doneEnabled(pageUp: true, item: Self.reply))
        #expect(!MacNeedsYouCommandState.doneEnabled(pageUp: false, item: Self.reply))
        #expect(!MacNeedsYouCommandState.doneEnabled(pageUp: true, item: nil))
        #expect(!MacNeedsYouCommandState.doneEnabled(pageUp: true, item: Self.code))
        #expect(!MacNeedsYouCommandState.doneEnabled(pageUp: true, item: Self.rsvp))
        #expect(MacNeedsYouCommandState.laterEnabled(pageUp: true, item: Self.reply))
        #expect(!MacNeedsYouCommandState.laterEnabled(pageUp: true, item: Self.code))
        #expect(MacNeedsYouCommandState.notMineEnabled(pageUp: true, item: Self.code))
        #expect(!MacNeedsYouCommandState.notMineEnabled(pageUp: true, item: Self.done))
        #expect(MacNeedsYouCommandState.copyEnabled(pageUp: true, item: Self.code))
        #expect(!MacNeedsYouCommandState.copyEnabled(pageUp: true, item: Self.reply))
        #expect(MacNeedsYouCommandState.startEnabled(pageUp: true, item: Self.action))
        #expect(MacNeedsYouCommandState.startEnabled(pageUp: true, item: Self.reply))
        #expect(!MacNeedsYouCommandState.startEnabled(pageUp: true, item: Self.code))
        #expect(MacNeedsYouCommandState.openEnabled(pageUp: true, item: Self.reply))
        #expect(MacNeedsYouCommandState.openEnabled(pageUp: true, item: Self.action))
        #expect(!MacNeedsYouCommandState.openEnabled(pageUp: true, item: Self.rsvp))

        #expect(MacNeedsYouCommandState.openTitle(Self.reply) == "Open in Mail")
        #expect(MacNeedsYouCommandState.openTitle(Self.action) == "Open in Slack")
        #expect(MacNeedsYouCommandState.openTitle(nil) == "Open in Mail")
        #expect(MacNeedsYouCommandState.menu == "Needs You")
        #expect(MacNeedsYouCommandState.markDone == "Mark Done")
        #expect(MacNeedsYouCommandState.copyCode == "Copy Code")
    }

    @Test @MainActor func aMenuItemIsARequestThePageReads() throws {
        let suite = "mac-needs-you-requests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let requests = MacRequests(defaults: defaults)
        #expect(requests.needsYouSelectedID == nil)
        #expect(requests.needsYouActionToken == 0)
        requests.requestNeedsYouAction(.later(until: Self.now + 3_600_000))
        #expect(requests.needsYouActionToken == 1)
        #expect(requests.needsYouAction == .later(until: Self.now + 3_600_000))
        requests.requestNeedsYouAction(.copyCode)
        #expect(requests.needsYouActionToken == 2)
        #expect(requests.needsYouAction == .copyCode)
        requests.needsYouSelectedID = "ob_code"
        #expect(requests.needsYouSelectedID == "ob_code")
    }

    // MARK: - The sidebar and the split

    @Test func theSidebarRowShowsOnlyWhileTheFeatureIsOnAndIsSelectedOnItsTab() {
        #expect(PrimaryTab.sourceList(showsFiles: false, showsNeedsYou: true) == [.today, .needsYou, .mail, .work, .calendar])
        #expect(!PrimaryTab.sourceList(showsFiles: false, showsNeedsYou: false).contains(.needsYou))
        #expect(MacSourceSelection.isPrimarySelected(.needsYou, selectedTab: .needsYou, areaID: nil, mailLabelID: nil))
        #expect(!MacSourceSelection.isPrimarySelected(.needsYou, selectedTab: .today, areaID: nil, mailLabelID: nil))
        // The row asks the mail list for nothing.
        #expect(MacSourceSelection.mailCategory(forPrimary: .needsYou, mailLabelID: "l1") == nil)
    }

    @Test func theListKeepsTheWebWidthBesideTheDetail() {
        #expect(MacNeedsYouLayout.listWidth == 440)
        #expect(MacNeedsYouLayout.listMinWidth < MacNeedsYouLayout.listWidth)
        #expect(MacNeedsYouLayout.listWidth < MacNeedsYouLayout.listMaxWidth)
        #expect(MacNeedsYouLayout.detailMinWidth >= 440)
    }

    @Test @MainActor func aPushTapOnTheMacOpensThePageWhileTheFeatureIsOn() throws {
        // The Mac delegate goes through the shared applier; the shell sets
        // the flag before it reads the pending link.
        let suite = "mac-needs-you-tap-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let plan = NotificationResponseRouter.plan(
            for: NotificationResponseInput(
                actionIdentifier: "com.apple.UNNotificationDefaultActionIdentifier",
                route: "/mail/thread?account=acct-1&thread=thread-1",
                accountID: "acct-1",
                threadID: "thread-1"
            )
        )
        NotificationResponseApplier.apply(plan, defaults: defaults)
        let navigation = NavigationModel()
        navigation.needsYouEnabled = true
        navigation.consumeAppIntentRequests(defaults: defaults)
        #expect(navigation.selectedTab == .needsYou)
        #expect(navigation.consumeObligation() == .thread(accountID: "acct-1", threadID: "thread-1"))
    }
}
#endif
