import Foundation
import Testing
@testable import Lab86Mail

// The push refresh plan (K2) and the staleness rule for a return to the
// foreground (K3).
struct RefreshPlanningTests {
    @Test
    func aBriefPushRefreshesOnlyTheBrief() {
        let plan = RemoteRefreshPlan.make(RemoteWakePayload(route: "/brief?id=rep_1", category: "LAB86_BRIEF"))
        #expect(plan.domains == [.brief])
        #expect(!plan.isUnspecific)
    }

    @Test
    func aMailPushRefreshesOnlyMail() {
        let byIDs = RemoteRefreshPlan.make(
            RemoteWakePayload(route: "/mail/thread", category: "LAB86_MAIL", accountID: "acct", threadID: "t1")
        )
        #expect(byIDs.domains == [.mail])
        let urgent = RemoteRefreshPlan.make(RemoteWakePayload(route: "/", category: "LAB86_URGENT"))
        #expect(urgent.domains == [.mail])
        let byView = RemoteRefreshPlan.make(RemoteWakePayload(route: "/?view=mail&account=a&draft=d"))
        #expect(byView.domains == [.mail])
    }

    @Test
    func checkInAndCommitmentPushesNameTheirDomains() {
        #expect(RemoteRefreshPlan.make(RemoteWakePayload(route: "/checkin", category: "LAB86_CHECKIN")).domains == [.activity])
        #expect(RemoteRefreshPlan.make(RemoteWakePayload(route: "/?view=notifications&approval=a1")).domains == [.activity])
        #expect(RemoteRefreshPlan.make(RemoteWakePayload(route: "/activity")).domains == [.activity])
        #expect(RemoteRefreshPlan.make(RemoteWakePayload(route: "/", category: "LAB86_COMMITMENT")).domains == [.work])
        #expect(RemoteRefreshPlan.make(RemoteWakePayload(route: "/?view=work&work=w1")).domains == [.work])
        #expect(RemoteRefreshPlan.make(RemoteWakePayload(route: "/?view=calendar&account=a&event=e")).domains == [.calendar])
        #expect(RemoteRefreshPlan.make(RemoteWakePayload(route: "/?view=tasks&card=c1")).domains == [.tasks])
    }

    @Test
    func aWakeThatNamesNothingIsUnspecific() {
        let plan = RemoteRefreshPlan.make(RemoteWakePayload(route: "/?view=files&file=f1"))
        #expect(plan.isUnspecific)
        #expect(RemoteRefreshPlan.make(RemoteWakePayload()).isUnspecific)
        #expect(RemoteRefreshPlan.make(RemoteWakePayload(codeAvailable: true)).isUnspecific)
    }

    @Test
    func thePayloadReadsTheSystemDictionaryOnce() {
        let userInfo: [AnyHashable: Any] = [
            "aps": ["category": "LAB86_MAIL", "alert": ["title": "New mail"]],
            "route": "/mail/thread",
            "accountId": "acct-1",
            "threadId": "thread-1",
            "codeAvailable": true,
        ]
        let payload = RemoteWakePayload(userInfo: userInfo)
        #expect(payload == RemoteWakePayload(
            route: "/mail/thread",
            category: "LAB86_MAIL",
            accountID: "acct-1",
            threadID: "thread-1",
            codeAvailable: true
        ))
    }

    @Test
    func anActiveAppSkipsADomainItReadAMomentAgo() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let plan = RemoteRefreshPlan(domains: [.mail, .brief])
        let fresh = [ProductDomain.mail: now.addingTimeInterval(-10)]
        #expect(plan.due(refreshedAt: fresh, appIsActive: true, now: now, window: 60) == [.brief])
        // In the background every named domain reads.
        #expect(plan.due(refreshedAt: fresh, appIsActive: false, now: now, window: 60) == [.mail, .brief])
        // An old read is due again.
        let old = [ProductDomain.mail: now.addingTimeInterval(-120)]
        #expect(plan.due(refreshedAt: old, appIsActive: true, now: now, window: 60) == [.mail, .brief])
    }

    @Test
    func dataIsStaleAfterTheAgeOrOnANewDay() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let noon = Date(timeIntervalSince1970: 1_800_000_000 - (1_800_000_000 % 86_400) + 12 * 3_600)
        #expect(RefreshStaleness.isStale(lastRefresh: nil, now: noon, calendar: calendar))
        #expect(!RefreshStaleness.isStale(lastRefresh: noon.addingTimeInterval(-4 * 60), now: noon, calendar: calendar))
        #expect(RefreshStaleness.isStale(lastRefresh: noon.addingTimeInterval(-6 * 60), now: noon, calendar: calendar))
        // One minute before midnight, read again one minute after: a new day.
        let lateNight = noon.addingTimeInterval(11 * 3_600 + 59 * 60)
        let earlyMorning = lateNight.addingTimeInterval(2 * 60)
        #expect(RefreshStaleness.isStale(lastRefresh: lateNight, now: earlyMorning, calendar: calendar))
    }
}
