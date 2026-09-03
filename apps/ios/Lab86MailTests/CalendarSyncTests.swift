import Foundation
import Testing
@testable import Lab86Mail

// Calendar sync kicks: the resync request the app sends, the answer it
// reads, the freshness subtitle, the dashed-border rule for a new event, and
// the follow rule that waits for the server copy.
struct CalendarSyncTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func minutesAgo(_ minutes: Double) -> Date {
        now.addingTimeInterval(-minutes * 60)
    }

    // MARK: - Request builder

    @Test
    func requestPathIsTheResyncRoute() {
        #expect(CalendarResyncRequest.path == "/api/calendar/resync")
    }

    @Test
    func requestBodyCarriesTheWireReason() {
        #expect(CalendarResyncRequest(reason: .viewOpen).body == .object(["reason": .string("view_open")]))
        #expect(CalendarResyncRequest(reason: .pull).body == .object(["reason": .string("pull")]))
        #expect(CalendarResyncRequest(reason: .manualHTTP).body == .object(["reason": .string("manual_http")]))
    }

    @Test
    func requestBodyAddsTheAccountOnlyWhenGiven() {
        let scoped = CalendarResyncRequest(accountID: "acct_1", reason: .pull)
        #expect(scoped.body == .object(["accountId": .string("acct_1"), "reason": .string("pull")]))
        let blank = CalendarResyncRequest(accountID: "   ", reason: .pull)
        #expect(blank.accountID == nil)
        #expect(blank.body == .object(["reason": .string("pull")]))
    }

    @Test
    func everyReasonMatchesTheContract() {
        #expect(CalendarResyncReason.allCases.map(\.rawValue) == ["view_open", "pull", "manual_http"])
    }

    // MARK: - Response

    @Test
    func responseReadsStartedAndEpochMilliseconds() {
        let json: JSONValue = .object([
            "ok": .bool(true),
            "started": .bool(true),
            "lastSyncedAt": .number(1_800_000_000_000),
            "reason": .string("pull"),
        ])
        let response = CalendarResyncResponse(json: json)
        #expect(response?.started == true)
        #expect(response?.lastSyncedAt == now)
    }

    @Test
    func responseKeepsNullFreshnessAsNil() {
        let json: JSONValue = .object(["ok": .bool(true), "started": .bool(false), "lastSyncedAt": .null])
        let response = CalendarResyncResponse(json: json)
        #expect(response?.started == false)
        #expect(response?.lastSyncedAt == nil)
    }

    @Test
    func responseRejectsAnErrorEnvelope() {
        let json: JSONValue = .object(["ok": .bool(false), "error": .string("Resync failed.")])
        #expect(CalendarResyncResponse(json: json) == nil)
    }

    // MARK: - Freshness subtitle

    @Test
    func subtitleReadsJustNowUnderOneMinute() {
        #expect(CalendarFreshness.updated(at: now.addingTimeInterval(-59), now: now) == "Updated just now")
        #expect(CalendarFreshness.updated(at: now, now: now) == "Updated just now")
    }

    @Test
    func subtitleCountsMinutesThenHours() {
        #expect(CalendarFreshness.updated(at: minutesAgo(4), now: now) == "Updated 4 min ago")
        #expect(CalendarFreshness.updated(at: minutesAgo(59.9), now: now) == "Updated 59 min ago")
        #expect(CalendarFreshness.updated(at: minutesAgo(60), now: now) == "Updated 1 hr ago")
        #expect(CalendarFreshness.updated(at: minutesAgo(23 * 60), now: now) == "Updated 23 hr ago")
    }

    @Test
    func subtitleFallsBackToADateAfterOneDay() {
        let date = minutesAgo(48 * 60)
        let expected = "Updated \(date.formatted(date: .abbreviated, time: .omitted))"
        #expect(CalendarFreshness.updated(at: date, now: now) == expected)
    }

    @Test
    func subtitleNeverGoesNegativeForAFutureClock() {
        #expect(CalendarFreshness.updated(at: now.addingTimeInterval(120), now: now) == "Updated just now")
    }

    @Test
    func subtitleStatesTheRunningSyncAndTheFailure() {
        var state = CalendarSyncState(phase: .running, lastSyncedAt: minutesAgo(4))
        #expect(CalendarFreshness.subtitle(state: state, now: now) == "Syncing…")
        state.phase = .failed
        state.failureMessage = CalendarSyncState.failureCopy
        #expect(CalendarFreshness.subtitle(state: state, now: now) == "Could not sync. Pull to try again.")
        state.phase = .done
        #expect(CalendarFreshness.subtitle(state: state, now: now) == "Updated 4 min ago")
        state.lastSyncedAt = nil
        #expect(CalendarFreshness.subtitle(state: state, now: now) == "Not synced yet")
    }

    // MARK: - Pending event rule

    @Test
    func eventCreatedAfterTheLastSyncIsPending() {
        #expect(CalendarPendingEvents.isPending(createdAt: minutesAgo(1), lastSyncedAt: minutesAgo(5), now: now))
    }

    @Test
    func eventIsSettledOnceASyncCompletesAfterIt() {
        #expect(!CalendarPendingEvents.isPending(createdAt: minutesAgo(1), lastSyncedAt: minutesAgo(0.5), now: now))
        #expect(!CalendarPendingEvents.isPending(createdAt: now, lastSyncedAt: now, now: now))
    }

    @Test
    func eventWithNoSyncOnRecordIsPending() {
        #expect(CalendarPendingEvents.isPending(createdAt: minutesAgo(1), lastSyncedAt: nil, now: now))
    }

    @Test
    func pendingBorderExpiresWhenASyncNeverLands() {
        #expect(!CalendarPendingEvents.isPending(createdAt: minutesAgo(11), lastSyncedAt: nil, now: now))
        #expect(CalendarPendingEvents.isPending(createdAt: minutesAgo(9), lastSyncedAt: nil, now: now))
    }

    @Test
    func stateUsesTheAccountRowBeforeTheGlobalTime() {
        let state = CalendarSyncState(
            lastSyncedAt: minutesAgo(10),
            rows: [
                CalendarSyncStateRow(accountID: "a", status: "ready", lastSyncedAt: minutesAgo(1)),
                CalendarSyncStateRow(accountID: "b", status: "ready", lastSyncedAt: minutesAgo(10)),
            ]
        )
        #expect(state.lastSyncedAt(forAccount: "a") == minutesAgo(1))
        #expect(state.lastSyncedAt(forAccount: "b") == minutesAgo(10))
        #expect(state.lastSyncedAt(forAccount: "missing") == minutesAgo(10))
    }

    // MARK: - Sync state rows

    @Test
    func rowReadsTheToolShape() {
        let row = CalendarSyncStateRow(json: .object([
            "accountId": .string("acct_1"),
            "status": .string("syncing"),
            "lastSyncedAt": .number(1_800_000_000_000),
            "error": .string(""),
        ]))
        #expect(row?.accountID == "acct_1")
        #expect(row?.status == "syncing")
        #expect(row?.lastSyncedAt == now)
        #expect(row?.error == nil)
        #expect(CalendarSyncStateRow(json: .object(["status": .string("ready")])) == nil)
    }

    @Test
    func oldestSyncedAtSkipsUnauthorizedAndFailsOnAnUnsyncedAccount() {
        let ready = CalendarSyncStateRow(accountID: "a", status: "ready", lastSyncedAt: minutesAgo(2))
        let older = CalendarSyncStateRow(accountID: "b", status: "ready", lastSyncedAt: minutesAgo(7))
        let unauthorized = CalendarSyncStateRow(accountID: "c", status: "unauthorized", lastSyncedAt: nil)
        let never = CalendarSyncStateRow(accountID: "d", status: "idle", lastSyncedAt: nil)
        #expect(CalendarSyncStateRow.oldestSyncedAt([ready, older, unauthorized]) == minutesAgo(7))
        #expect(CalendarSyncStateRow.oldestSyncedAt([ready, never]) == nil)
        #expect(CalendarSyncStateRow.oldestSyncedAt([]) == nil)
    }

    // MARK: - Follow rule

    @Test
    func followWaitsWhileAnAccountSyncs() {
        let rows = [
            CalendarSyncStateRow(accountID: "a", status: "syncing", lastSyncedAt: minutesAgo(5)),
            CalendarSyncStateRow(accountID: "b", status: "ready", lastSyncedAt: now),
        ]
        #expect(CalendarSyncFollow.outcome(rows: rows, since: minutesAgo(5)) == .waiting)
    }

    @Test
    func followWaitsUntilTheFreshnessMovesPastTheKick() {
        let stale = [CalendarSyncStateRow(accountID: "a", status: "ready", lastSyncedAt: minutesAgo(5))]
        #expect(CalendarSyncFollow.outcome(rows: stale, since: minutesAgo(5)) == .waiting)
        let fresh = [CalendarSyncStateRow(accountID: "a", status: "ready", lastSyncedAt: now)]
        #expect(CalendarSyncFollow.outcome(rows: fresh, since: minutesAgo(5)) == .done(lastSyncedAt: now))
    }

    @Test
    func followFinishesOnTheFirstSyncWhenNothingCameBefore() {
        let fresh = [CalendarSyncStateRow(accountID: "a", status: "ready", lastSyncedAt: now)]
        #expect(CalendarSyncFollow.outcome(rows: fresh, since: nil) == .done(lastSyncedAt: now))
        let empty: [CalendarSyncStateRow] = []
        #expect(CalendarSyncFollow.outcome(rows: empty, since: nil) == .waiting)
    }

    @Test
    func followReportsAnErrorRow() {
        let rows = [CalendarSyncStateRow(accountID: "a", status: "error", lastSyncedAt: minutesAgo(5), error: "Grant expired")]
        #expect(CalendarSyncFollow.outcome(rows: rows, since: minutesAgo(5)) == .failed(message: "Grant expired"))
    }
}
