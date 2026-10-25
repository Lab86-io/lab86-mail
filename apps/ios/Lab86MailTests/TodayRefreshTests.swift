import Foundation
import MobileAPI
import SwiftUI
import Testing
@testable import Lab86Mail

// The iOS refresh round on Today (2026-10-24): the load states, the plate,
// the one sources line, the shared section rule, the reading column, the
// time styles, and the contract fixes the crash audit asked for.
struct TodayRefreshTests {
    private let english = Locale(identifier: "en_US")

    // MARK: - Fixtures

    private func report(
        id: String = "r1",
        status: String? = nil,
        artifactStatus: String? = nil,
        generatedAt: Double = 1_760_000_000_000
    ) throws -> DailyReportModel {
        var json: [String: JSONValue] = [
            "_id": .string(id),
            "generatedAt": .number(generatedAt),
            "title": .string("The Friday Brief"),
        ]
        if let status { json["status"] = .string(status) }
        if let artifactStatus { json["artifactStatus"] = .string(artifactStatus) }
        return try #require(DailyReportModel(json: .object(json)))
    }

    private func source(
        id: String,
        kind: String = "mail",
        status: String = "ok",
        syncedAt: Date?
    ) -> JSONValue {
        var row: [String: JSONValue] = [
            "id": .string(id),
            "kind": .string(kind),
            "label": .string("\(id)@example.com"),
            "provider": .string("google"),
            "status": .string(status),
        ]
        if let syncedAt { row["lastSyncedAt"] = .number(syncedAt.timeIntervalSince1970 * 1_000) }
        return .object(row)
    }

    private func health(_ sources: [JSONValue], line: String = "") throws -> BriefSourceHealth {
        try #require(BriefSourceHealth(json: .object([
            "attention": .number(0),
            "line": .string(line),
            "sources": .array(sources),
        ])))
    }

    private func mail(_ thread: String, account: String = "acct-1") throws -> ImportantMailItem {
        try #require(ImportantMailItem(json: .object([
            "account": .string(account),
            "threadId": .string(thread),
            "subject": .string("Subject \(thread)"),
            "sender": .string("Sender"),
        ])))
    }

    private func threadItem(_ id: String, account: String = "acct-1") -> String {
        """
        {
          "ref": { "kind": "thread", "id": "\(id)", "account": "\(account)", "label": "Subject \(id)" },
          "framing": { "lane": "answer" },
          "actions": [
            { "action": "open_thread", "label": "Open", "payload": { "account": "\(account)", "threadId": "\(id)" }, "style": "quiet" }
          ]
        }
        """
    }

    private func letter(items: [String]) throws -> BriefDocumentV2 {
        let json = """
        {
          "version": 2,
          "title": "The Friday Brief",
          "summary": "Two replies are owed.",
          "generatedAt": 1788400000000,
          "timezone": "America/New_York",
          "regions": [
            {
              "id": "answer",
              "summary": "Answer lane.",
              "tree": {
                "kind": "stack",
                "emphasis": "standard",
                "tone": "neutral",
                "children": [
                  {
                    "kind": "entity_list",
                    "emphasis": "standard",
                    "tone": "neutral",
                    "title": "Answer",
                    "variant": "rows",
                    "items": [\(items.joined(separator: ","))]
                  }
                ]
              }
            }
          ]
        }
        """
        return try #require(BriefDocumentV2.decode(Data(json.utf8)))
    }

    private func entity(_ json: String) throws -> BriefHydratedEntity {
        try JSONDecoder().decode(BriefHydratedEntity.self, from: Data(json.utf8))
    }

    // MARK: - Load states (B1, B4, B5)

    @Test func theNarrativeClearsOnlyInTheBackground() throws {
        #expect(!TodayView.clearsNarrative(in: .active))
        #expect(!TodayView.clearsNarrative(in: .inactive))
        #expect(TodayView.clearsNarrative(in: .background))

        // Control Center and Face ID make the scene inactive; the poll key
        // does not change, so the account stays and the poll goes on.
        let edition = try report()
        let active = TodayView.narrativePollKey(report: edition, scenePhase: .active)
        #expect(TodayView.narrativePollKey(report: edition, scenePhase: .inactive) == active)
        #expect(TodayView.narrativePollKey(report: edition, scenePhase: .background) != active)
        // A new edition starts a new poll.
        let newer = try report(id: "r2", generatedAt: 1_760_100_000_000)
        #expect(TodayView.narrativePollKey(report: newer, scenePhase: .active) != active)
    }

    @Test func theBriefPollsOnlyWhileTheShownEditionIsBeingWritten() throws {
        let writing = try report(status: "partial")
        let composing = try report(artifactStatus: "composing")
        let done = try report(status: "ready")

        #expect(TodayView.pollsBrief(report: writing, scenePhase: .active))
        #expect(TodayView.pollsBrief(report: writing, scenePhase: .inactive))
        #expect(TodayView.pollsBrief(report: composing, scenePhase: .active))
        #expect(!TodayView.pollsBrief(report: writing, scenePhase: .background))
        #expect(!TodayView.pollsBrief(report: done, scenePhase: .active))
        #expect(!TodayView.pollsBrief(report: nil, scenePhase: .active))

        #expect(
            TodayView.briefPollKey(report: writing, scenePhase: .active)
                != TodayView.briefPollKey(report: done, scenePhase: .active)
        )
        #expect(TodayView.briefPollInterval == .seconds(5))
    }

    @Test func theBriefRuleSaysReadingBeforeTheFirstReadEnds() throws {
        let now = Date(timeIntervalSince1970: 1_760_000_600)
        #expect(TodayView.briefStanding(report: nil, briefDidLoad: false, now: now) == "Reading today\u{2019}s edition")
        #expect(TodayView.briefStanding(report: nil, briefDidLoad: true, now: now) == "Not written yet today.")
        let standing = try TodayView.briefStanding(report: report(), briefDidLoad: true, now: now)
        #expect(standing.hasPrefix("Written just now"))
    }

    @Test func anEmptyHistoryWithAnErrorOnRecordReadsAsTheFailure() {
        #expect(TodayView.historyFailure(reportCount: 0, loadError: "Offline") == "Offline")
        #expect(TodayView.historyFailure(reportCount: 0, loadError: nil) == nil)
        #expect(TodayView.historyFailure(reportCount: 3, loadError: "Offline") == nil)
    }

    // MARK: - Copy without middle dots

    @Test func theCountSummaryAndTheNextMoveJoinWithCommas() {
        let counts = DailyReportModel.SectionCounts(
            replyOwed: 2, followUpOwed: 0, newPeople: 0, timeSensitive: 1,
            tracked: 0, fyi: 0, tasks: 0, calendar: 3
        )
        #expect(TodayView.countSummaryLine(counts) == "2 reply owed, 1 time-sensitive, 3 events")
        #expect(!TodayView.countSummaryLine(counts).contains("·"))

        let move = TodayComposition.NextMove(workID: "w", workTitle: "Passport renewal", stepTitle: "Send", time: "2:00 PM")
        #expect(TodayComposition.nextMoveSourceLine(move) == "2:00 PM, Passport renewal")
    }

    @Test func factsJoinAsProse() {
        #expect(BriefCopy.join(["Five days late.", "Harbor Hall"]) == "Five days late. Harbor Hall")
        #expect(BriefCopy.join(["9:30 AM – 9:45 AM", "Harbor Hall"]) == "9:30 AM – 9:45 AM, Harbor Hall")
        #expect(BriefCopy.join(["Done?", "Yes"]) == "Done? Yes")
        #expect(BriefCopy.join([nil, "  ", "One"]) == "One")
        #expect(BriefCopy.join([]) == "")
        #expect(!BriefCopy.join(["a", "b", "c"]).contains("·"))
    }

    // MARK: - The plate (D4)

    @Test func theCreditLineJoinsWithAWordNotADot() {
        #expect(
            DailyBriefMasthead.creditLine(credit: "Fallback edition art", source: "Albatross")
                == "Fallback edition art, from Albatross"
        )
        #expect(DailyBriefMasthead.creditLine(credit: "A painting", source: nil) == "A painting")
        #expect(DailyBriefMasthead.creditLine(credit: "A painting", source: "") == "A painting")
        #expect(DailyBriefMasthead.creditLine(credit: nil, source: "The Met") == nil)
    }

    @Test func thePlateGrowsWithLargeTypeAndKeepsTheWidthRuleOtherwise() {
        let base = DailyBriefMasthead.height(forWidth: 402)
        #expect(DailyBriefMasthead.plateHeight(width: 402, titleSize: 40, datelineSize: 15) == base)
        let large = DailyBriefMasthead.plateHeight(
            width: 402,
            titleSize: DailyBriefMasthead.titleSizeCap,
            datelineSize: DailyBriefMasthead.datelineSizeCap
        )
        #expect(large > base)
        // Two title lines, the dateline, and the room around them.
        #expect(large == DailyBriefMasthead.titleSizeCap * 2.4 + DailyBriefMasthead.datelineSizeCap + 96)
    }

    // MARK: - One sources line

    @Test func theSourcesLineCountsAndNamesTheOldestSync() throws {
        let now = Date(timeIntervalSince1970: 1_760_000_000)
        let three = try health([
            source(id: "a", syncedAt: now.addingTimeInterval(-4 * 60)),
            source(id: "b", syncedAt: now.addingTimeInterval(-6 * 60)),
            source(id: "c", kind: "calendar", syncedAt: now.addingTimeInterval(-4 * 60)),
        ])
        let line = try #require(BriefSourceSummary.line(three, now: now))
        #expect(line == "3 sources synced 6 minutes ago")
        #expect(!line.contains("@"))
        #expect(!line.contains("·"))

        let one = try health([source(id: "a", syncedAt: now.addingTimeInterval(-10))])
        #expect(BriefSourceSummary.line(one, now: now) == "1 source synced just now")
    }

    @Test func theSourcesLineSaysWhenASourceStillSyncs() throws {
        let now = Date(timeIntervalSince1970: 1_760_000_000)
        let mixed = try health([
            source(id: "a", syncedAt: now.addingTimeInterval(-60)),
            source(id: "b", status: "syncing", syncedAt: nil),
        ])
        #expect(BriefSourceSummary.line(mixed, now: now) == "2 sources, 1 still syncing")
        let all = try health([source(id: "b", status: "syncing", syncedAt: nil)])
        #expect(BriefSourceSummary.line(all, now: now) == "1 source, still syncing")
    }

    @Test func theSourcesLineFallsBackToTheServerLineAndHidesWhenOnlyProblemsRemain() throws {
        let now = Date(timeIntervalSince1970: 1_760_000_000)
        let named = try health([], line: "Mail and calendar synced a few minutes ago.")
        #expect(BriefSourceSummary.line(named, now: now) == "Mail and calendar synced a few minutes ago.")
        let broken = try health([source(id: "a", status: "reconnect", syncedAt: nil)])
        #expect(broken.problems.count == 1)
        #expect(BriefSourceSummary.line(broken, now: now) == nil)
    }

    @Test func syncAgesReadInFullWords() {
        let now = Date(timeIntervalSince1970: 1_760_000_000)
        #expect(BriefSourceSummary.ago(now.addingTimeInterval(-30), now: now) == "just now")
        #expect(BriefSourceSummary.ago(now.addingTimeInterval(-60), now: now) == "1 minute ago")
        #expect(BriefSourceSummary.ago(now.addingTimeInterval(-8 * 60), now: now) == "8 minutes ago")
        #expect(BriefSourceSummary.ago(now.addingTimeInterval(-60 * 60), now: now) == "1 hour ago")
        #expect(BriefSourceSummary.ago(now.addingTimeInterval(-3 * 3_600), now: now) == "3 hours ago")
        #expect(BriefSourceSummary.ago(now.addingTimeInterval(-26 * 3_600), now: now) == "yesterday")
        #expect(BriefSourceSummary.ago(now.addingTimeInterval(-3 * 86_400), now: now) == "3 days ago")
        #expect(BriefSourceSummary.sentence("synced 4 min ago") == "Synced 4 min ago")
        #expect(BriefSourceSummary.sentence("") == "")
    }

    // MARK: - The shared section rule and the reading column

    @Test func theSectionRuleStacksItsNoteAtAccessibilitySizes() {
        #expect(!BriefSectionRule.stacks(.large))
        #expect(!BriefSectionRule.stacks(.xxxLarge))
        #expect(BriefSectionRule.stacks(.accessibility1))
        #expect(BriefSectionRule.stacks(.accessibility3))
    }

    @Test func theColumnLeavesRoomForTheFloatingButtonOnlyOnRegularWidth() {
        #expect(TodayView.trailingReserve(regularWidth: false) == 0)
        #expect(TodayView.trailingReserve(regularWidth: true) == 76)
        #expect(TodayView.readingWidth == 720)
        #expect(TodayView.bottomReserve >= 80)
    }

    // MARK: - The same mail is never on the page twice (D19)

    @Test func mailTheLetterListsLeavesTheLiveSection() throws {
        let document = try letter(items: [threadItem("t1"), threadItem("t2")])
        let keys = TodayComposition.letterThreadKeys(in: document)
        #expect(keys == ["acct-1:t1", "acct-1:t2"])

        let items = try [mail("t1"), mail("t2"), mail("t9")]
        let shown = TodayComposition.mailOutsideLetter(items, letterThreadKeys: keys)
        #expect(shown.map(\.threadID) == ["t9"])

        // Without a letter the section keeps its rows, at most four.
        let many = try ["a", "b", "c", "d", "e"].map { try mail($0) }
        #expect(TodayComposition.mailOutsideLetter(many, letterThreadKeys: []).count == 4)
        // Another account's thread with the same id is a different thread.
        let other = try [mail("t1", account: "acct-2")]
        #expect(TodayComposition.mailOutsideLetter(other, letterThreadKeys: keys).count == 1)
    }

    // MARK: - One time style on the ribbon (D16)

    @Test func hourTicksReadLikeTheRowTimes() {
        #expect(DayRibbon.tickLabel(hour: 10, locale: english) == "10 AM")
        #expect(DayRibbon.tickLabel(hour: 13, locale: english) == "1 PM")
        #expect(DayRibbon.tickLabel(hour: 0, locale: english) == "12 AM")
        #expect(DayRibbon.tickLabel(hour: 24, locale: english) == "12 AM")
        #expect(DayRibbon.widestTickLabel(locale: english) == "12 PM")
        #expect(DayRibbon.detailLine(label: "9:30 AM – 9:45 AM", location: "Harbor Hall") == "9:30 AM – 9:45 AM, Harbor Hall")
        #expect(DayRibbon.detailLine(label: "9:30 AM – 9:45 AM", location: nil) == "9:30 AM – 9:45 AM")
        let gap = DayRibbon.Gap(top: 0, height: 0.1, minutes: 60, label: "1 hour free")
        #expect(DayRibbon.openAirLine([gap]) == "One opening left, 1 hour free.")
    }

    // MARK: - Contract fixes

    @Test func theHydrationIndexKeepsTheFirstOfTwoRowsWithOneKey() throws {
        let first = try entity(#"{"kind":"event","id":"e1","account":"acct-1","title":"Standup","gone":false}"#)
        let second = try entity(#"{"kind":"event","id":"e1","account":"acct-1","title":"Standup (second calendar)","gone":false}"#)
        let other = try entity(#"{"kind":"work","id":"w1","title":"Passport","gone":false}"#)
        #expect(first.key == second.key)
        let index = BriefHydrationIndex.make([first, second, other])
        #expect(index.count == 2)
        #expect(index[first.key]?.title == "Standup")
        #expect(index[other.key]?.title == "Passport")
        #expect(BriefHydrationIndex.make([]).isEmpty)
    }

    @Test func theMapRegionStaysInsideWhatMapKitAccepts() {
        // Hawaii and Tokyo: the margin used to push the longitude span past 360.
        let wide = BriefMapRegion.fit(latitudes: [21.3, 35.7], longitudes: [-157.8, 139.7])
        #expect(wide.longitudeDelta == 360)
        #expect(abs(wide.latitudeDelta - (35.7 - 21.3) * 1.4) < 0.0001)
        #expect(abs(wide.centerLatitude - 28.5) < 0.0001)

        let single = BriefMapRegion.fit(latitudes: [40.7], longitudes: [-74.0])
        #expect(abs(single.latitudeDelta - 0.08 * 1.4) < 0.0001)
        #expect(abs(single.longitudeDelta - 0.08 * 1.4) < 0.0001)

        let pole = BriefMapRegion.fit(latitudes: [89.99], longitudes: [0])
        #expect(pole.latitudeDelta <= 2 * (90 - 89.99) + 0.0001)
        #expect(pole.latitudeDelta >= 0)

        #expect(BriefMapRegion.fit(latitudes: [], longitudes: []) == BriefMapRegion.world)
    }

    @Test func theQueryListReadsAgainOnlyWhenTheAttemptChanges() {
        #expect(BriefQueryAttempt(query: nil, attempt: 0) == BriefQueryAttempt(query: nil, attempt: 0))
        #expect(BriefQueryAttempt(query: nil, attempt: 0) != BriefQueryAttempt(query: nil, attempt: 1))
    }

    @MainActor
    @Test func theLegacyArtifactIsComposedOncePerViewAndMeasuresItsOwnHeight() {
        let nonce = UUID().uuidString
        let raw = "<html><head></head><body><p>Hello</p></body></html>"
        let before = BriefArtifactDocument.composedCount
        let first = BriefArtifactDocument.memoized(from: raw, nonce: nonce, themeCSS: ":root{}")
        let second = BriefArtifactDocument.memoized(from: raw, nonce: nonce, themeCSS: ":root{}")
        #expect(first == second)
        #expect(BriefArtifactDocument.composedCount == before + 1)
        // A new theme composes again under the same nonce.
        let themed = BriefArtifactDocument.memoized(from: raw, nonce: nonce, themeCSS: ":root{--x:1}")
        #expect(themed != first)
        #expect(BriefArtifactDocument.composedCount == before + 1)

        // The root sizes to its content, so the web view can shrink.
        #expect(first.contains("html, body { height: auto !important; min-height: 0 !important; }"))
        #expect(BriefArtifactDocument.bridgeJS.contains("getBoundingClientRect"))
        #expect(first.contains("nonce=\"\(nonce)\""))
    }

    @Test func theLaneTimeColumnTakesItsWidthFromTheWidestTime() {
        #expect(BriefEventTimeSlot.widestTime == "12:00")
        let slot = BriefEventTimeSlot.make(reason: "11:00 AM to 12:00 PM, Harbor Hall", startAt: nil)
        #expect(slot?.time == "11:00")
        #expect(slot?.suffix == "AM")
        #expect((slot?.time.count ?? 0) <= BriefEventTimeSlot.widestTime.count)
    }
}
