import Foundation
import Testing
import UserNotifications
@testable import Lab86Mail

// What a notification response asks for, and what the app does with it. The
// two are tested apart because the system delivers the response off the main
// actor and the app applies it on the main actor.
struct NotificationResponseRouterTests {
    private func mailInput(
        actionIdentifier: String = UNNotificationDefaultActionIdentifier,
        userText: String? = nil
    ) -> NotificationResponseInput {
        NotificationResponseInput(
            actionIdentifier: actionIdentifier,
            deepLink: "/mail/thread?account=acct-1&thread=thread-1&message=msg-1",
            accountID: "acct-1",
            threadID: "thread-1",
            messageID: "msg-1",
            userText: userText
        )
    }

    // The notification the user actually taps. It must carry a route and ask
    // for nothing else.
    @Test
    func tappingAMailNotificationOpensItsThread() {
        let plan = NotificationResponseRouter.plan(for: mailInput())

        #expect(plan.route == "/mail/thread?account=acct-1&thread=thread-1&message=msg-1")
        #expect(plan.bannerAction == nil)
        #expect(plan.bannerReply == nil)
        #expect(plan.textResponse == nil)
        #expect(plan.suggestion == nil)
    }

    @Test
    func anExplicitRouteWinsOverTheDeepLinkAndAPayloadWithNeitherFallsBackToActivity() {
        var input = mailInput()
        input.route = "/mail/thread?account=acct-2&thread=thread-2"
        #expect(NotificationResponseRouter.plan(for: input).route == "/mail/thread?account=acct-2&thread=thread-2")

        let bare = NotificationResponseInput(actionIdentifier: UNNotificationDefaultActionIdentifier)
        #expect(NotificationResponseRouter.plan(for: bare).route == NotificationResponseRouter.fallbackRoute)
    }

    @Test
    func bannerActionsActOnTheThreadWithoutOpeningIt() {
        let markRead = NotificationResponseRouter.plan(
            for: mailInput(actionIdentifier: NotificationActionID.mailMarkRead)
        )
        #expect(markRead.bannerAction == MailBannerAction(kind: .markRead, accountID: "acct-1", threadID: "thread-1"))
        #expect(markRead.route == nil)

        let archive = NotificationResponseRouter.plan(
            for: mailInput(actionIdentifier: NotificationActionID.mailArchive)
        )
        #expect(archive.bannerAction?.kind == .archive)
        #expect(archive.route == nil)
    }

    @Test
    func aBannerReplyWithTextSendsItAndOneWithoutOpensTheComposer() {
        let sent = NotificationResponseRouter.plan(
            for: mailInput(actionIdentifier: NotificationActionID.mailReply, userText: "  On my way.  ")
        )
        #expect(
            sent.textResponse == NotificationTextResponse(
                kind: .mail(accountID: "acct-1", threadID: "thread-1", messageID: "msg-1"),
                text: "On my way."
            )
        )
        #expect(sent.route == nil)

        let empty = NotificationResponseRouter.plan(
            for: mailInput(actionIdentifier: NotificationActionID.mailReply, userText: "   ")
        )
        #expect(empty.textResponse == nil)
        #expect(
            empty.bannerReply == MailBannerReply(
                accountID: "acct-1",
                threadID: "thread-1",
                messageID: "msg-1",
                text: ""
            )
        )
        #expect(empty.route == nil)
    }

    // A reply the banner cannot send must not take the user's words with it.
    @Test
    func aReplyToAPayloadWithNoMessageKeepsTheTextForTheComposer() {
        var input = mailInput(actionIdentifier: NotificationActionID.mailReply, userText: "Ten minutes late.")
        input.messageID = nil

        let plan = NotificationResponseRouter.plan(for: input)

        #expect(plan.textResponse == nil)
        #expect(
            plan.bannerReply == MailBannerReply(
                accountID: "acct-1",
                threadID: "thread-1",
                messageID: nil,
                text: "Ten minutes late."
            )
        )
    }

    @Test
    func aCheckInAnswerCarriesItsPromptKindAndAnEmptyOneStillOpensTheApp() {
        let answered = NotificationResponseRouter.plan(
            for: NotificationResponseInput(
                actionIdentifier: NotificationActionID.answerCheckIn,
                deepLink: "/?checkin=c1&prompt=tomorrow",
                notificationID: "n1",
                promptKind: "tomorrow",
                userText: "Two calls and the review."
            )
        )
        #expect(
            answered.textResponse == NotificationTextResponse(
                kind: .checkIn(notificationID: "n1", promptKind: "tomorrow"),
                text: "Two calls and the review."
            )
        )

        let blank = NotificationResponseRouter.plan(
            for: NotificationResponseInput(
                actionIdentifier: NotificationActionID.answerCheckIn,
                deepLink: "/?checkin=c1&prompt=tomorrow",
                notificationID: "n1",
                userText: ""
            )
        )
        #expect(blank.textResponse == nil)
        #expect(blank.route == "/?checkin=c1&prompt=tomorrow")
    }

    @Test
    func deferringACheckInAsksForNothing() {
        let plan = NotificationResponseRouter.plan(
            for: NotificationResponseInput(
                actionIdentifier: NotificationActionID.checkInLater,
                deepLink: "/?checkin=c1&prompt=reflection"
            )
        )

        #expect(plan == NotificationResponsePlan())
    }

    @Test
    func aSuggestionActionDecidesTheSuggestionAndStillOpensItsRoute() {
        let accepted = NotificationResponseRouter.plan(
            for: NotificationResponseInput(
                actionIdentifier: NotificationActionID.addToCalendar,
                deepLink: "/mail/thread?account=acct-1&thread=thread-1&suggestion=s1",
                suggestionID: "s1"
            )
        )
        #expect(accepted.suggestion == SuggestionDecision(suggestionID: "s1", action: "accept"))
        #expect(accepted.route == "/mail/thread?account=acct-1&thread=thread-1&suggestion=s1")

        let dismissed = NotificationResponseRouter.plan(
            for: NotificationResponseInput(
                actionIdentifier: NotificationActionID.dismiss,
                deepLink: "/mail/thread?account=acct-1&thread=thread-1&suggestion=s1",
                suggestionID: "s1"
            )
        )
        #expect(dismissed.suggestion?.action == "dismiss")
    }

    // A mail action without the thread it applies to has nothing to act on, so
    // it falls back to opening what the notification points at.
    @Test
    func aMailActionMissingItsThreadOpensTheRouteInstead() {
        let plan = NotificationResponseRouter.plan(
            for: NotificationResponseInput(
                actionIdentifier: NotificationActionID.mailArchive,
                deepLink: "/mail/thread?account=acct-1"
            )
        )

        #expect(plan.bannerAction == nil)
        #expect(plan.route == "/mail/thread?account=acct-1")
    }

    @Test
    func thePayloadIsReadWithTheKeysTheServerSends() {
        let input = NotificationResponseInput(
            actionIdentifier: NotificationActionID.mailMarkRead,
            userInfo: [
                "route": "/mail/thread?account=acct-1&thread=thread-1&message=msg-1",
                "deepLink": "/mail/thread?account=acct-1&thread=thread-1&message=msg-1",
                "accountId": "acct-1",
                "threadId": "thread-1",
                "messageId": "msg-1",
                "notificationId": "n1",
                "promptKind": "tomorrow",
                "suggestionId": "s1",
            ],
            userText: "note"
        )

        #expect(input.accountID == "acct-1")
        #expect(input.threadID == "thread-1")
        #expect(input.messageID == "msg-1")
        #expect(input.notificationID == "n1")
        #expect(input.promptKind == "tomorrow")
        #expect(input.suggestionID == "s1")
        #expect(input.userText == "note")
    }

    // The route survives a tap that launches the app, where there is no shell
    // yet to hear the announcement.
    @Test @MainActor
    func aTappedRouteIsWrittenDownSoALaunchingAppStillOpensIt() {
        let suite = "Lab86MailTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        AppDelegate.apply(
            NotificationResponseRouter.plan(for: mailInput()),
            defaults: defaults
        )
        #expect(
            defaults.string(forKey: "pendingAlbatrossDeepLink")
                == "/mail/thread?account=acct-1&thread=thread-1&message=msg-1"
        )

        let navigation = NavigationModel()
        navigation.consumePendingDeepLink(defaults: defaults)

        #expect(navigation.selectedTab == .mail)
        #expect(navigation.threadRoute == ThreadRoute(accountID: "acct-1", threadID: "thread-1"))
        #expect(defaults.string(forKey: "pendingAlbatrossDeepLink") == nil)
    }

    // Reading it twice must not reopen the thread the user has since left.
    @Test @MainActor
    func aTappedRouteOpensExactlyOnce() {
        let suite = "Lab86MailTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        AppDelegate.apply(NotificationResponseRouter.plan(for: mailInput()), defaults: defaults)
        let navigation = NavigationModel()
        navigation.consumePendingDeepLink(defaults: defaults)
        navigation.threadRoute = nil

        navigation.consumePendingDeepLink(defaults: defaults)

        #expect(navigation.threadRoute == nil)
    }

    @Test @MainActor
    func aBannerActionIsWrittenDownForTheShellToApply() {
        let suite = "Lab86MailTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        AppDelegate.apply(
            NotificationResponseRouter.plan(for: mailInput(actionIdentifier: NotificationActionID.mailArchive)),
            defaults: defaults
        )

        #expect(defaults.string(forKey: "pendingAlbatrossMailNotificationAction") == "archive")
        #expect(defaults.string(forKey: "pendingAlbatrossMailNotificationAccount") == "acct-1")
        #expect(defaults.string(forKey: "pendingAlbatrossMailNotificationThread") == "thread-1")
        #expect(defaults.string(forKey: "pendingAlbatrossDeepLink") == nil)
    }

    @Test @MainActor
    func aBannerReplyPrefillsTheComposerWithWhateverTheUserWrote() {
        let suite = "Lab86MailTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        var input = mailInput(actionIdentifier: NotificationActionID.mailReply, userText: "Ten minutes late.")
        input.messageID = nil

        AppDelegate.apply(NotificationResponseRouter.plan(for: input), defaults: defaults)
        let navigation = NavigationModel()
        navigation.consumeAppIntentRequests(defaults: defaults)

        #expect(navigation.pendingCompose?.mode == "reply")
        #expect(navigation.pendingCompose?.accountID == "acct-1")
        #expect(navigation.pendingCompose?.threadID == "thread-1")
        #expect(navigation.pendingCompose?.body == "Ten minutes late.")
    }

    // The response has to reach an app that is already in front of the user,
    // which never sees an activation.
    @Test @MainActor
    func everyDurableResponseIsAnnouncedForAnAppThatIsAlreadyRunning() {
        let suite = "Lab86MailTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let announcements = AnnouncementCounter()
        let token = NotificationCenter.default.addObserver(
            forName: .lab86NotificationRequest,
            object: nil,
            queue: nil
        ) { _ in announcements.count += 1 }
        defer { NotificationCenter.default.removeObserver(token) }

        AppDelegate.apply(NotificationResponseRouter.plan(for: mailInput()), defaults: defaults)
        #expect(announcements.count == 1)

        AppDelegate.apply(
            NotificationResponseRouter.plan(
                for: mailInput(actionIdentifier: NotificationActionID.mailReply, userText: " ")
            ),
            defaults: defaults
        )
        #expect(announcements.count == 2)

        // Marking read writes nothing the shell must route to, so it announces
        // on its own channel and not on this one.
        AppDelegate.apply(
            NotificationResponseRouter.plan(for: mailInput(actionIdentifier: NotificationActionID.mailMarkRead)),
            defaults: defaults
        )
        #expect(announcements.count == 2)
    }
}

// The announcement is posted and observed synchronously on the main actor, but
// the observer block is a Sendable escaping closure, so the count needs a
// reference rather than a captured local.
private final class AnnouncementCounter: @unchecked Sendable {
    var count = 0
}
