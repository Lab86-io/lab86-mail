import Foundation

enum NotificationActionID {
    static let addToCalendar = "ADD_TO_CALENDAR"
    static let view = "VIEW"
    static let dismiss = "DISMISS"
    static let answerCheckIn = "ANSWER_CHECKIN"
    static let checkInLater = "CHECKIN_LATER"
    static let mailMarkRead = "MAIL_MARK_READ"
    static let mailArchive = "MAIL_ARCHIVE"
    static let mailReply = "MAIL_REPLY"
    static let openBrief = "OPEN_BRIEF"
}

// What the system delivered, reduced to values that can cross an actor
// boundary. The notification payload itself is a dictionary of `Any`, so it is
// read once here, in the same nonisolated context that receives it.
struct NotificationResponseInput: Equatable, Sendable {
    var actionIdentifier: String
    var route: String?
    var deepLink: String?
    var accountID: String?
    var threadID: String?
    var messageID: String?
    var notificationID: String?
    var promptKind: String?
    var suggestionID: String?
    var userText: String?
    // A Needs you push (phase 5): `type` and `obligationId` when the server
    // names the obligation; the thread keys name it otherwise.
    var type: String?
    var obligationID: String?

    init(
        actionIdentifier: String,
        route: String? = nil,
        deepLink: String? = nil,
        accountID: String? = nil,
        threadID: String? = nil,
        messageID: String? = nil,
        notificationID: String? = nil,
        promptKind: String? = nil,
        suggestionID: String? = nil,
        userText: String? = nil,
        type: String? = nil,
        obligationID: String? = nil
    ) {
        self.actionIdentifier = actionIdentifier
        self.route = route
        self.deepLink = deepLink
        self.accountID = accountID
        self.threadID = threadID
        self.messageID = messageID
        self.notificationID = notificationID
        self.promptKind = promptKind
        self.suggestionID = suggestionID
        self.userText = userText
        self.type = type
        self.obligationID = obligationID
    }

    init(actionIdentifier: String, userInfo: [AnyHashable: Any], userText: String?) {
        self.init(
            actionIdentifier: actionIdentifier,
            route: userInfo["route"] as? String,
            deepLink: userInfo["deepLink"] as? String,
            accountID: userInfo["accountId"] as? String,
            threadID: userInfo["threadId"] as? String,
            messageID: userInfo["messageId"] as? String,
            notificationID: userInfo["notificationId"] as? String,
            promptKind: userInfo["promptKind"] as? String,
            suggestionID: userInfo["suggestionId"] as? String,
            userText: userText,
            type: userInfo["type"] as? String,
            obligationID: userInfo["obligationId"] as? String
        )
    }
}

struct MailBannerReply: Equatable, Sendable {
    let accountID: String
    let threadID: String
    let messageID: String?
    // Empty when the user sent nothing. Non-empty when they wrote a reply the
    // banner could not send, which happens if the payload names no message.
    let text: String
}

struct MailBannerAction: Equatable, Sendable {
    enum Kind: String, Equatable, Sendable {
        case markRead = "mark_read"
        case archive
    }

    let kind: Kind
    let accountID: String
    let threadID: String
}

struct SuggestionDecision: Equatable, Sendable {
    let suggestionID: String
    // "accept" or "dismiss", as the suggestion API names them.
    let action: String
}

// Everything a single notification response asks the app to do. A plan holds
// only data, so it can be built off the main actor and applied on it.
struct NotificationResponsePlan: Equatable, Sendable {
    var textResponse: NotificationTextResponse?
    var bannerReply: MailBannerReply?
    var bannerAction: MailBannerAction?
    var suggestion: SuggestionDecision?
    var route: String?
    // The Needs you keys of a tap, beside the route (phase 5).
    var obligationTap: ObligationNotificationTap?
}

// Decides what a tap or a banner action means. Kept apart from the delegate so
// the rule is testable without a notification centre, and so the delegate has
// nothing left to do but apply the result on the main actor.
enum NotificationResponseRouter {
    static let fallbackRoute = "/activity"

    private static let mailActionIdentifiers: Set<String> = [
        NotificationActionID.mailMarkRead,
        NotificationActionID.mailArchive,
        NotificationActionID.mailReply,
    ]

    private static let suggestionActionIdentifiers: Set<String> = [
        NotificationActionID.addToCalendar,
        NotificationActionID.dismiss,
    ]

    static func plan(for input: NotificationResponseInput) -> NotificationResponsePlan {
        let route = input.route ?? input.deepLink ?? fallbackRoute
        let text = input.userText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !text.isEmpty, let response = textResponse(for: input, text: text) {
            return NotificationResponsePlan(textResponse: response)
        }
        if let accountID = input.accountID,
           let threadID = input.threadID,
           mailActionIdentifiers.contains(input.actionIdentifier) {
            if input.actionIdentifier == NotificationActionID.mailReply {
                // The banner could not send it: either the user wrote nothing,
                // or the payload names no message to reply to. Hand whatever
                // they did write to the composer rather than dropping it.
                return NotificationResponsePlan(
                    bannerReply: MailBannerReply(
                        accountID: accountID,
                        threadID: threadID,
                        messageID: input.messageID,
                        text: text
                    )
                )
            }
            return NotificationResponsePlan(
                bannerAction: MailBannerAction(
                    kind: input.actionIdentifier == NotificationActionID.mailMarkRead ? .markRead : .archive,
                    accountID: accountID,
                    threadID: threadID
                )
            )
        }
        // Deferring a check-in is the one action that asks for nothing at all,
        // not even the app in front of the user.
        if input.actionIdentifier == NotificationActionID.checkInLater {
            return NotificationResponsePlan()
        }
        var plan = NotificationResponsePlan()
        if let suggestionID = input.suggestionID,
           suggestionActionIdentifiers.contains(input.actionIdentifier) {
            plan.suggestion = SuggestionDecision(
                suggestionID: suggestionID,
                action: input.actionIdentifier == NotificationActionID.addToCalendar ? "accept" : "dismiss"
            )
        }
        plan.obligationTap = ObligationNotificationTap.make(from: input)
        plan.route = route
        return plan
    }

    private static func textResponse(
        for input: NotificationResponseInput,
        text: String
    ) -> NotificationTextResponse? {
        if input.actionIdentifier == NotificationActionID.answerCheckIn,
           let notificationID = input.notificationID {
            return NotificationTextResponse(
                kind: .checkIn(
                    notificationID: notificationID,
                    promptKind: input.promptKind ?? "reflection"
                ),
                text: text
            )
        }
        if input.actionIdentifier == NotificationActionID.mailReply,
           let accountID = input.accountID,
           let threadID = input.threadID,
           let messageID = input.messageID {
            return NotificationTextResponse(
                kind: .mail(accountID: accountID, threadID: threadID, messageID: messageID),
                text: text
            )
        }
        return nil
    }
}

// A tap on a Needs you push (docs/needs-you.md, phase 5). A phase 1 payload
// names the mail thread (`accountId`, `threadId`); a newer server can name
// the obligation itself (`type`, `obligationId`). The keys are written down
// with the route and read by the navigation model with it, so a tap that
// launches the app and a tap on a running app open the same page.
struct ObligationNotificationTap: Equatable, Sendable {
    var obligationID: String?
    var accountID: String?
    var threadID: String?
    /// True when the payload says it is an obligation push.
    var isObligation: Bool

    static let typeKey = "pendingAlbatrossObligationType"
    static let idKey = "pendingAlbatrossObligationID"
    static let accountKey = "pendingAlbatrossObligationAccount"
    static let threadKey = "pendingAlbatrossObligationThread"

    /// Nil when the tap names neither an obligation nor a thread.
    static func make(from input: NotificationResponseInput) -> ObligationNotificationTap? {
        let obligationID = input.obligationID?.trimmingCharacters(in: .whitespacesAndNewlines)
        let isObligation = input.type == "obligation" || obligationID?.isEmpty == false
        let hasThread = input.accountID?.isEmpty == false && input.threadID?.isEmpty == false
        guard isObligation || hasThread else { return nil }
        return ObligationNotificationTap(
            obligationID: obligationID?.isEmpty == false ? obligationID : nil,
            accountID: hasThread ? input.accountID : nil,
            threadID: hasThread ? input.threadID : nil,
            isObligation: isObligation
        )
    }

    var target: ObligationTarget? {
        if let obligationID { return .id(obligationID) }
        if let accountID, let threadID { return .thread(accountID: accountID, threadID: threadID) }
        return nil
    }

    func write(to defaults: UserDefaults) {
        defaults.set(isObligation ? "obligation" : "thread", forKey: Self.typeKey)
        defaults.set(obligationID, forKey: Self.idKey)
        defaults.set(accountID, forKey: Self.accountKey)
        defaults.set(threadID, forKey: Self.threadKey)
    }

    /// Reads the tap and removes it.
    static func consume(from defaults: UserDefaults) -> ObligationNotificationTap? {
        guard let type = defaults.string(forKey: typeKey) else { return nil }
        let tap = ObligationNotificationTap(
            obligationID: defaults.string(forKey: idKey),
            accountID: defaults.string(forKey: accountKey),
            threadID: defaults.string(forKey: threadKey),
            isObligation: type == "obligation"
        )
        for key in [typeKey, idKey, accountKey, threadKey] { defaults.removeObject(forKey: key) }
        return tap
    }
}
