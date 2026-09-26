import Foundation
import MobileAPI
import Testing
@testable import Lab86Mail

// The Today widget (round 2, FEATURES item 19): the app maps the summary,
// writes it to the App Group, and the widget reads the same file.
@MainActor
struct TodayWidgetTests {
    private static let summaryJSON = #"""
    {"version":1,"reportID":"r1","kind":"morning","generatedAt":"2026-09-26T11:00:00.000Z",
     "leadLine":"Two replies are owed.",
     "nextMove":{"title":"Venue count","detail":"  ","refKind":"thread","refID":"t1","accountID":"a1"},
     "nextMeeting":{"eventID":"e1","accountID":"a1","title":"Standup","startAt":"2026-09-26T13:00:00.000Z","endAt":"2026-09-26T13:30:00.000Z","location":"Room 2"},
     "sourcesNeedingAttention":2,"serverTime":"2026-09-26T12:00:00.000Z"}
    """#

    private static func decodeSummary(_ json: String) throws -> Components.Schemas.TodaySummary {
        let transcoder = LenientISO8601DateTranscoder()
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            try transcoder.decode(try decoder.singleValueContainer().decode(String.self))
        }
        return try decoder.decode(Components.Schemas.TodaySummary.self, from: Data(json.utf8))
    }

    @Test
    func theSummaryMapsToTheWidgetSnapshot() throws {
        let fetchedAt = Date(timeIntervalSince1970: 1_790_424_000)
        let snapshot = MobileV1Client.todaySnapshot(from: try Self.decodeSummary(Self.summaryJSON), fetchedAt: fetchedAt)
        #expect(snapshot.reportID == "r1")
        #expect(!snapshot.isWeeklyReview)
        #expect(snapshot.leadLine == "Two replies are owed.")
        #expect(snapshot.nextMove == TodayWidgetSnapshot.Move(
            title: "Venue count", detail: nil, kind: .thread, refID: "t1", accountID: "a1"
        ))
        #expect(snapshot.nextMeeting?.title == "Standup")
        #expect(snapshot.nextMeeting?.location == "Room 2")
        #expect(snapshot.nextMeeting?.startAt == Date(timeIntervalSince1970: 1_790_427_600))
        #expect(snapshot.attentionLine == "2 sources need to reconnect")
        #expect(snapshot.fetchedAt == fetchedAt)

        let weekly = MobileV1Client.todaySnapshot(from: try Self.decodeSummary(
            #"{"version":1,"kind":"weekly","leadLine":"This week you finished 3 things.","nextMove":{"title":"Book the tent","refKind":"task","refID":"card-1"},"sourcesNeedingAttention":0,"serverTime":"2026-09-27T09:00:00Z"}"#
        ))
        #expect(weekly.isWeeklyReview)
        #expect(weekly.nextMove?.kind == .task)
        #expect(weekly.nextMeeting == nil)
        #expect(weekly.attentionLine == nil)
    }

    @Test
    func theMeetingLeavesOnceItEnds() {
        let start = Date(timeIntervalSince1970: 1_790_427_600)
        let snapshot = TodayWidgetSnapshot(
            leadLine: "Lead.",
            nextMeeting: .init(eventID: "e1", accountID: "a1", title: "Standup", startAt: start, endAt: start.addingTimeInterval(1_800), location: nil)
        )
        #expect(snapshot.upcomingMeeting(at: start.addingTimeInterval(-60))?.eventID == "e1")
        #expect(snapshot.upcomingMeeting(at: start.addingTimeInterval(600))?.eventID == "e1")
        #expect(snapshot.upcomingMeeting(at: start.addingTimeInterval(1_800)) == nil)
        #expect(TodayWidgetSnapshot(leadLine: "x", sourcesNeedingAttention: 1).attentionLine == "1 source needs to reconnect")
    }

    @Test
    func aTapOpensTheMoveTheMeetingOrToday() {
        let thread = TodayWidgetSnapshot.Move(title: "T", detail: nil, kind: .thread, refID: "t 1", accountID: "a1")
        #expect(TodayWidgetSnapshot.link(for: thread)?.absoluteString == "lab86://thread?account=a1&thread=t%201")
        let orphan = TodayWidgetSnapshot.Move(title: "T", detail: nil, kind: .thread, refID: "t1", accountID: nil)
        #expect(TodayWidgetSnapshot.link(for: orphan) == TodayWidgetSnapshot.todayLink)
        let task = TodayWidgetSnapshot.Move(title: "T", detail: nil, kind: .task, refID: "c1", accountID: nil)
        #expect(TodayWidgetSnapshot.link(for: task)?.absoluteString == "lab86://tasks")
        let meeting = TodayWidgetSnapshot.Meeting(eventID: "e1", accountID: "a1", title: "M", startAt: .now, endAt: .now, location: nil)
        #expect(TodayWidgetSnapshot.link(for: meeting)?.absoluteString == "lab86://event?account=a1&event=e1")
        #expect(TodayWidgetSnapshot.todayLink?.absoluteString == "lab86://today")
    }

    @Test
    func theLinksOpenTheRightPlaceInTheApp() {
        let navigation = NavigationModel()
        navigation.open(URL(string: "lab86://thread?account=a1&thread=t1")!)
        #expect(navigation.threadRoute == ThreadRoute(accountID: "a1", threadID: "t1"))
        navigation.open(URL(string: "lab86://today")!)
        #expect(navigation.selectedTab == .today)
    }

    @Test
    func theAppWritesTheFileTheWidgetReads() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "widget-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appending(path: TodayWidgetSnapshot.fileName)
        let snapshot = TodayWidgetSnapshot(
            reportID: "r1",
            isWeeklyReview: true,
            generatedAt: Date(timeIntervalSince1970: 1_790_420_400),
            leadLine: "Lead.",
            nextMove: .init(title: "Move", detail: "Why", kind: .thread, refID: "t1", accountID: "a1"),
            sourcesNeedingAttention: 1,
            fetchedAt: Date(timeIntervalSince1970: 1_790_424_000)
        )
        TodayWidgetBridge.publish(snapshot, to: url)
        #expect(TodayWidgetSnapshot.read(from: url) == snapshot)
        TodayWidgetBridge.clear(at: url)
        #expect(TodayWidgetSnapshot.read(from: url) == nil)
        #expect(TodayWidgetSnapshot.read(from: nil) == nil)
        #expect(TodayWidgetSnapshot.placeholder.leadLine == "Open Albatross to bring in today’s brief.")
    }
}
