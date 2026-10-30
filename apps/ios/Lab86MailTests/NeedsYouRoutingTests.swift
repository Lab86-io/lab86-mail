import Foundation
import Testing
import UserNotifications
@testable import Lab86Mail

// Where a Needs you push and a Needs you link go (phase 5, I2): the router
// keeps the thread keys beside the route, the applier writes them down, and
// the navigation model opens the page while the feature is on. Everyone
// else keeps the thread.
@MainActor
struct NeedsYouRoutingTests {
    private func makeDefaults() throws -> UserDefaults {
        let suite = "needs-you-routing-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    private func mailTap(type: String? = nil, obligationID: String? = nil) -> NotificationResponseInput {
        NotificationResponseInput(
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            route: "/mail/thread?account=acct-1&thread=thread-1&message=msg-1",
            accountID: "acct-1",
            threadID: "thread-1",
            messageID: "msg-1",
            type: type,
            obligationID: obligationID
        )
    }

    @Test func aTapOnAMailPushKeepsItsThreadBesideTheRoute() {
        let plan = NotificationResponseRouter.plan(for: mailTap())
        #expect(plan.route == "/mail/thread?account=acct-1&thread=thread-1&message=msg-1")
        #expect(plan.obligationTap == ObligationNotificationTap(obligationID: nil, accountID: "acct-1", threadID: "thread-1", isObligation: false))
        #expect(plan.obligationTap?.target == .thread(accountID: "acct-1", threadID: "thread-1"))
    }

    @Test func aPushThatNamesTheObligationSaysSo() {
        let plan = NotificationResponseRouter.plan(for: mailTap(type: "obligation", obligationID: "ob_1"))
        #expect(plan.obligationTap?.isObligation == true)
        #expect(plan.obligationTap?.target == .id("ob_1"))
        let typed = NotificationResponseRouter.plan(for: mailTap(type: "obligation"))
        #expect(typed.obligationTap?.isObligation == true)
        #expect(typed.obligationTap?.target == .thread(accountID: "acct-1", threadID: "thread-1"))
        let payload = NotificationResponseInput(
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: ["route": "/?view=notifications", "type": "obligation", "obligationId": "ob_2"],
            userText: nil
        )
        #expect(payload.type == "obligation")
        #expect(payload.obligationID == "ob_2")
    }

    @Test func aTapWithoutAThreadAndABannerActionCarryNoKeys() {
        let bare = NotificationResponseRouter.plan(for: NotificationResponseInput(actionIdentifier: UNNotificationDefaultActionIdentifier))
        #expect(bare.obligationTap == nil)
        let archive = NotificationResponseRouter.plan(
            for: NotificationResponseInput(
                actionIdentifier: NotificationActionID.mailArchive,
                accountID: "acct-1",
                threadID: "thread-1"
            )
        )
        #expect(archive.obligationTap == nil)
        #expect(archive.bannerAction?.kind == .archive)
    }

    @Test func theRuleForWhereATapGoes() {
        let thread = ObligationNotificationTap(obligationID: nil, accountID: "a", threadID: "t", isObligation: false)
        #expect(NavigationModel.opensNeedsYou(thread, enabled: true))
        #expect(!NavigationModel.opensNeedsYou(thread, enabled: false))
        let named = ObligationNotificationTap(obligationID: "ob", accountID: nil, threadID: nil, isObligation: true)
        #expect(NavigationModel.opensNeedsYou(named, enabled: false))
        let empty = ObligationNotificationTap(obligationID: nil, accountID: nil, threadID: nil, isObligation: false)
        #expect(!NavigationModel.opensNeedsYou(empty, enabled: true))
    }

    @Test func aWrittenTapOpensNeedsYouWhileTheFeatureIsOn() throws {
        let defaults = try makeDefaults()
        NotificationResponseApplier.apply(NotificationResponseRouter.plan(for: mailTap()), defaults: defaults)
        #expect(defaults.string(forKey: "pendingAlbatrossDeepLink") != nil)
        #expect(defaults.string(forKey: ObligationNotificationTap.threadKey) == "thread-1")

        let navigation = NavigationModel()
        navigation.needsYouEnabled = true
        navigation.consumePendingDeepLink(defaults: defaults)
        #expect(navigation.selectedTab == .needsYou)
        #expect(navigation.threadRoute == nil)
        #expect(navigation.pendingObligation == .thread(accountID: "acct-1", threadID: "thread-1"))
        #expect(navigation.consumeObligation() == .thread(accountID: "acct-1", threadID: "thread-1"))
        #expect(navigation.pendingObligation == nil)
        #expect(defaults.string(forKey: "pendingAlbatrossDeepLink") == nil)
        #expect(defaults.string(forKey: ObligationNotificationTap.typeKey) == nil)
        #expect(defaults.string(forKey: ObligationNotificationTap.threadKey) == nil)
    }

    @Test func theSameTapOpensTheThreadWhileTheFeatureIsOff() throws {
        let defaults = try makeDefaults()
        NotificationResponseApplier.apply(NotificationResponseRouter.plan(for: mailTap()), defaults: defaults)
        let navigation = NavigationModel()
        navigation.consumePendingDeepLink(defaults: defaults)
        #expect(navigation.selectedTab == .mail)
        #expect(navigation.threadRoute == ThreadRoute(accountID: "acct-1", threadID: "thread-1"))
        #expect(navigation.pendingObligation == nil)
        #expect(defaults.string(forKey: ObligationNotificationTap.typeKey) == nil)
    }

    @Test func aPushThatNamesTheObligationOpensNeedsYouEvenBeforeTheFlagIsKnown() throws {
        let defaults = try makeDefaults()
        NotificationResponseApplier.apply(
            NotificationResponseRouter.plan(for: mailTap(type: "obligation", obligationID: "ob_1")),
            defaults: defaults
        )
        let navigation = NavigationModel()
        navigation.consumePendingDeepLink(defaults: defaults)
        #expect(navigation.selectedTab == .needsYou)
        #expect(navigation.pendingObligation == .id("ob_1"))
    }

    @Test func aLinkIntoThePageNamesItsItem() {
        let byID = NavigationModel()
        byID.open(appPath: "/?view=needs-you&obligation=ob_1")
        #expect(byID.selectedTab == .needsYou)
        #expect(byID.pendingObligation == .id("ob_1"))

        let byThread = NavigationModel()
        byThread.open(appPath: "/?view=needs-you&account=acct-1&thread=thread-1")
        #expect(byThread.selectedTab == .needsYou)
        #expect(byThread.threadRoute == nil)
        #expect(byThread.pendingObligation == .thread(accountID: "acct-1", threadID: "thread-1"))

        let plain = NavigationModel()
        plain.open(appPath: "/?view=needs-you")
        #expect(plain.selectedTab == .needsYou)
        #expect(plain.pendingObligation == nil)

        let path = NavigationModel()
        path.open(route: "/needs-you")
        #expect(path.selectedTab == .needsYou)

        // A thread link without the view keeps opening the thread.
        let thread = NavigationModel()
        thread.open(appPath: "/mail/thread?account=acct-1&thread=thread-1")
        #expect(thread.selectedTab == .mail)
        #expect(thread.threadRoute == ThreadRoute(accountID: "acct-1", threadID: "thread-1"))
    }

    @Test func theSidebarListsNeedsYouOnlyWhileTheFeatureIsOn() {
        #expect(PrimaryTab.sourceList(showsFiles: true) == [.today, .mail, .work, .calendar, .files])
        #expect(PrimaryTab.sourceList(showsFiles: true, showsNeedsYou: true) == [.today, .needsYou, .mail, .work, .calendar, .files])
        #expect(PrimaryTab.needsYou.symbol == "bell")
        #expect(GlobalCreateMenuPolicy.showsFloatingButton(selectedTab: .needsYou, hasNestedDestination: false) == false)
        let navigation = NavigationModel()
        navigation.openNeedsYou()
        #expect(navigation.selectedTab == .needsYou)
        #expect(!navigation.hasNestedDestination)
    }
}
