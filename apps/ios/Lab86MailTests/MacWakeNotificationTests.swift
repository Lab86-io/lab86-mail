#if os(macOS)
import Foundation
import Testing
import UserNotifications
@testable import Lab86Mail

// NAT-8: a wake that arrives while the Mac app is not active also goes to
// Notification Center, and its Open action lands on the Work.
struct MacWakeNotificationTests {
    @Test
    @MainActor
    func theWakeCategoryRegistersBesideTheSharedCategoriesInOneSet() {
        let categories = NotificationCoordinator.categories(adding: [MacWakeNotifier.category])
        let identifiers = Set(categories.map(\.identifier))
        #expect(identifiers == [
            NotificationCategoryID.commitment,
            NotificationCategoryID.checkIn,
            NotificationCategoryID.mail,
            NotificationCategoryID.brief,
            NotificationCategoryID.urgent,
            MacWakeNotifier.categoryID,
        ])
        // The shared set alone stays as it was.
        #expect(!NotificationCoordinator.categories().map(\.identifier).contains(MacWakeNotifier.categoryID))
    }

    @Test
    func theWakeCategoryOffersOneOpenActionThatBringsTheAppForward() {
        let category = MacWakeNotifier.category
        #expect(category.identifier == "LAB86_WAKE")
        #expect(category.actions.map(\.identifier) == [MacWakeNotifier.openActionID])
        #expect(category.actions.first?.title == "Open")
        #expect(category.actions.first?.options.contains(.foreground) == true)
    }

    @Test
    func aWakePostsToNotificationCenterOnlyWhileTheAppIsNotActive() {
        #expect(MacWakeNotifier.shouldPost(appIsActive: false))
        #expect(!MacWakeNotifier.shouldPost(appIsActive: true))
    }

    @Test
    func theWakeRequestCarriesTheLineAndTheWorkRoute() {
        let nudge = WakeNudge(workID: "w1", title: "Passport renewal", wokeAt: Date(timeIntervalSince1970: 1_800_000_000))
        let request = MacWakeNotifier.request(for: nudge)
        #expect(request.identifier == "wake:\(nudge.id)")
        #expect(request.content.body == "Passport renewal is back. Ready when you are.")
        #expect(request.content.categoryIdentifier == MacWakeNotifier.categoryID)
        #expect(request.content.userInfo["route"] as? String == "/work?work=w1")
        #expect(request.trigger == nil)
    }

    @Test
    @MainActor
    func openingTheWakeNotificationLandsOnItsWork() {
        let nudge = WakeNudge(workID: "w1", title: "Passport renewal", wokeAt: Date(timeIntervalSince1970: 1_800_000_000))
        let userInfo = MacWakeNotifier.request(for: nudge).content.userInfo
        for action in [MacWakeNotifier.openActionID, UNNotificationDefaultActionIdentifier] {
            let plan = NotificationResponseRouter.plan(
                for: NotificationResponseInput(actionIdentifier: action, userInfo: userInfo, userText: nil)
            )
            #expect(plan.route == "/work?work=w1")
            let navigation = NavigationModel()
            navigation.open(route: plan.route ?? "")
            #expect(navigation.workRoute?.workID == "w1")
        }
    }
}
#endif
