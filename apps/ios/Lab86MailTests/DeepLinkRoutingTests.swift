import Foundation
import Testing
@testable import Lab86Mail

// Web app paths (`/?view=...`) route to their native target instead of Today.
@MainActor
struct DeepLinkRoutingTests {
    @Test
    func aSavedFileLinkOpensTheFileViewer() throws {
        let navigation = NavigationModel()
        navigation.open(appPath: "/?view=files&file=file_123")
        guard case .savedFile(let target) = navigation.sheet else {
            Issue.record("Expected the saved file sheet, got \(String(describing: navigation.sheet))")
            return
        }
        #expect(target.fileID == "file_123")
    }

    @Test
    func anOfficeOrDocumentLinkOpensTheDocumentEditor() {
        let office = NavigationModel()
        office.open(appPath: "/?view=files&office=doc_9")
        #expect(office.selectedTab == .files)
        #expect(office.documentRoute?.documentID == "doc_9")

        let document = NavigationModel()
        document.open(URL(string: "lab86://open/?view=files&document=doc_4")!)
        #expect(document.selectedTab == .files)
        #expect(document.documentRoute?.documentID == "doc_4")
    }

    @Test
    func aViewLinkOpensThatPage() {
        let tasks = NavigationModel()
        tasks.open(appPath: "/?view=tasks&card=card_1")
        #expect(tasks.selectedTab == .tasks)

        let files = NavigationModel()
        files.open(appPath: "/?view=files")
        #expect(files.selectedTab == .files)
        #expect(files.sheet == nil)

        let notifications = NavigationModel()
        notifications.open(appPath: "/?view=notifications&approval=ap_1")
        guard case .activity = notifications.sheet else {
            Issue.record("Expected the Activity sheet")
            return
        }

        let event = NavigationModel()
        event.open(appPath: "/?view=calendar&account=acct_1&event=evt_1")
        #expect(event.selectedTab == .calendar)
        #expect(event.eventRoute?.eventID == "evt_1")

        let work = NavigationModel()
        work.open(appPath: "/?view=work&work=work_1")
        #expect(work.selectedTab == .work)
        #expect(work.workRoute?.workID == "work_1")
    }

    @Test
    func olderPathLinksStillRoute() {
        let thread = NavigationModel()
        thread.open(URL(string: "lab86://mail/thread?account=acct_1&id=thr_1")!)
        #expect(thread.threadRoute == ThreadRoute(accountID: "acct_1", threadID: "thr_1"))

        let brief = NavigationModel()
        brief.open(route: "/brief?id=rep_1")
        #expect(brief.selectedTab == .today)
        #expect(brief.consumeBriefEdition() == "rep_1")

        let plain = NavigationModel()
        plain.open(appPath: "/")
        #expect(plain.selectedTab == .today)
    }

    @Test
    func appLinksAreToldApartFromTheWeb() {
        #expect(NavigationModel.isAppLink("/?view=files&file=f1"))
        #expect(NavigationModel.isAppLink("?view=mail"))
        #expect(NavigationModel.isAppLink("lab86://mail/thread?account=a&id=t"))
        #expect(NavigationModel.isAppLink("https://mail.lab86.io/?view=tasks"))
        #expect(NavigationModel.isAppLink("https://lab86.io/?view=tasks"))
        #expect(NavigationModel.isAppLink("mailto:a@example.com"))
        #expect(!NavigationModel.isAppLink("https://example.com/invoice.pdf"))
        #expect(!NavigationModel.isAppLink(""))
        // Near misses: the text inside another host is not the app.
        #expect(!NavigationModel.isAppLink("https://lab86.io.example.com/?view=tasks"))
        #expect(!NavigationModel.isAppLink("https://notlab86.io/?view=tasks"))
        #expect(!NavigationModel.isAppHost("lab86.io.example.com"))
        #expect(!NavigationModel.isAppHost("notlab86.io"))
        #expect(NavigationModel.isAppHost("Files.LAB86.io"))
        #expect(!NavigationModel.isAppHost(nil))
    }

    @Test
    func aLinkIntoAnotherHostDoesNotRoute() {
        let navigation = NavigationModel()
        navigation.selectPrimary(.mail)
        navigation.open(URL(string: "https://lab86.io.example.com/?view=tasks")!)
        navigation.open(URL(string: "https://notlab86.io/?view=calendar")!)
        #expect(navigation.selectedTab == .mail)
        #expect(navigation.sheet == nil)
    }
}
