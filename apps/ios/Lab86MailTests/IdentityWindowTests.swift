import Foundation
import Testing
@testable import Lab86Mail

// The 10-minute window, read from the session token's `fva` and `iat`. The
// tokens here are unsigned and invented; the server checks real signatures.
@MainActor
struct IdentityWindowTests {
    private static func token(payload: [String: Any]) -> String {
        let header = Data("{\"alg\":\"none\"}".utf8).base64EncodedString()
        let body = try! JSONSerialization.data(withJSONObject: payload).base64EncodedString()
        return [header, body, "sig"].map { part in
            part.replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }.joined(separator: ".")
    }

    @Test func aFreshFirstFactorOpensTheWindow() {
        let now = Date(timeIntervalSince1970: 1_759_800_000)
        let fresh = Self.token(payload: ["fva": [0, -1], "iat": Int(now.timeIntervalSince1970), "sub": "user_x"])
        #expect(IdentityWindow.firstFactorAgeMinutes(token: fresh, now: now) == 0)
        #expect(IdentityWindow.isOpen(token: fresh, now: now))
        // Five minutes at issue, four minutes ago: nine, still open.
        let nine = Self.token(payload: ["fva": [5, -1], "iat": Int(now.timeIntervalSince1970) - 240])
        #expect(IdentityWindow.firstFactorAgeMinutes(token: nine, now: now) == 9)
        #expect(IdentityWindow.isOpen(token: nine, now: now))
        // Nine minutes at issue, two minutes ago: eleven, closed.
        let eleven = Self.token(payload: ["fva": [9, -1], "iat": Int(now.timeIntervalSince1970) - 120])
        #expect(IdentityWindow.firstFactorAgeMinutes(token: eleven, now: now) == 11)
        #expect(!IdentityWindow.isOpen(token: eleven, now: now))
        // Ten exactly is closed: the rule is "under ten", Clerk's own.
        let ten = Self.token(payload: ["fva": [10, -1], "iat": Int(now.timeIntervalSince1970)])
        #expect(!IdentityWindow.isOpen(token: ten, now: now))
    }

    @Test func aTokenWithoutTheClaimIsClosed() {
        let now = Date(timeIntervalSince1970: 1_759_800_000)
        #expect(IdentityWindow.firstFactorAgeMinutes(token: Self.token(payload: ["sub": "user_x"]), now: now) == nil)
        #expect(!IdentityWindow.isOpen(token: Self.token(payload: ["sub": "user_x"]), now: now))
        // A factor that is not enrolled reads -1.
        #expect(!IdentityWindow.isOpen(token: Self.token(payload: ["fva": [-1, -1]]), now: now))
        #expect(!IdentityWindow.isOpen(token: "not.a.jwt.at.all", now: now))
        #expect(!IdentityWindow.isOpen(token: "", now: now))
        #expect(IdentityWindow.payload(of: "a.b") == nil)
    }

    @Test func thePresenterAnswersOneCheckAtATime() async {
        let presenter = IdentityCheckPresenter()
        #expect(presenter.request == nil)
        async let result = presenter.check(reason: "A new site for your Chase sign-in.")
        // Let the check post its request.
        while presenter.request == nil { await Task.yield() }
        #expect(presenter.request?.reason == "A new site for your Chase sign-in.")
        presenter.finish(.passed)
        #expect(await result == .passed)
        #expect(presenter.request == nil)
        // A cancel with nothing waiting does nothing.
        presenter.cancel()
        #expect(presenter.request == nil)
        async let second = presenter.check(reason: "Again.")
        while presenter.request == nil { await Task.yield() }
        presenter.cancel()
        #expect(await second == .cancelled)
    }

    @Test func theGuardRetriesOnceAfterA403() async {
        let presenter = IdentityCheckPresenter()
        var calls = 0
        // The window is open: no sheet, one call.
        let open = await IdentityGuard.run(reason: "r", presenter: presenter, windowOpen: { true }) { calls += 1 }
        #expect(open == .done)
        #expect(calls == 1)
        // The window is closed and the user cancels: no call at all.
        calls = 0
        let cancelTask = Task {
            while presenter.request == nil { await Task.yield() }
            presenter.cancel()
        }
        let cancelled = await IdentityGuard.run(reason: "r", presenter: presenter, windowOpen: { false }) { calls += 1 }
        await cancelTask.value
        #expect(cancelled == .cancelled)
        #expect(calls == 0)
        // The window looked open, the server said no, the check passed: two calls.
        calls = 0
        let passTask = Task {
            while presenter.request == nil { await Task.yield() }
            presenter.finish(.passed)
        }
        let retried = await IdentityGuard.run(reason: "r", presenter: presenter, windowOpen: { true }) {
            calls += 1
            if calls == 1 { throw SecureSaveError.verifyIdentity }
        }
        await passTask.value
        #expect(retried == .done)
        #expect(calls == 2)
        // Another error is reported as it is.
        let other = await IdentityGuard.run(reason: "r", presenter: presenter, windowOpen: { true }) {
            throw SecureSaveError.closed(nil)
        }
        #expect(other == .error(.closed(nil)))
    }
}
