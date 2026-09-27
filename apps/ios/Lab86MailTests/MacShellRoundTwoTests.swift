#if os(macOS)
import Foundation
import Testing
@testable import Lab86Mail

// The Mac shell in round 2: the Files row, the reads repeated on return to
// the app, the open Snoozed row, and the sheet sizes.
@MainActor
struct MacShellRoundTwoTests {
    @Test
    func theFilesRowFollowsTheSwitchAndItsListGivesWayToToday() {
        #expect(PrimaryTab.sourceList(showsFiles: false) == [.today, .mail, .work, .calendar])
        #expect(PrimaryTab.sourceList(showsFiles: true).contains(.files))

        #expect(MacSourceSelection.destination(afterFilesShown: false, selectedTab: .files, documentOpen: false) == .today)
        // An open document stays open, as a link to one does.
        #expect(MacSourceSelection.destination(afterFilesShown: false, selectedTab: .files, documentOpen: true) == nil)
        #expect(MacSourceSelection.destination(afterFilesShown: false, selectedTab: .mail, documentOpen: false) == nil)
        #expect(MacSourceSelection.destination(afterFilesShown: true, selectedTab: .files, documentOpen: false) == nil)
    }

    @Test
    func theRoundTwoReadsRunOnReturnAtMostOnceInFiveMinutes() {
        let refresh = MacActivationRefresh()
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(refresh.claim(now: start))
        #expect(!refresh.claim(now: start.addingTimeInterval(60)))
        #expect(!refresh.claim(now: start.addingTimeInterval(299)))
        #expect(refresh.claim(now: start.addingTimeInterval(300)))
        #expect(refresh.lastRun == start.addingTimeInterval(300))
    }

    @Test
    func theOpenSnoozedRowIsTheOneInTheReadingPane() {
        let row = MailSnoozedThread(
            id: "snooze-1",
            accountID: "acc",
            threadID: "t1",
            until: Date(timeIntervalSince1970: 2_000_000_000),
            subject: "Invoice",
            sender: "Billing <billing@acme.com>"
        )
        #expect(ThreadRoute(accountID: "acc", threadID: "t1").matches(row))
        #expect(!ThreadRoute(accountID: "acc", threadID: "t2").matches(row))
        #expect(!ThreadRoute(accountID: "other", threadID: "t1").matches(row))
    }

    @Test
    func everyRoundTwoSheetHasARoomySize() {
        for size in [MacSheetSize.settingsPage, .editor, .workList] {
            #expect(size.minWidth >= 480)
            #expect(size.minHeight >= 440)
        }
        #expect(MacSheetSize.workList.minWidth > MacSheetSize.editor.minWidth)
    }
}
#endif
