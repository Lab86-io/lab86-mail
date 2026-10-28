import Foundation
import Testing
@testable import Lab86Mail

// Cold launch without network (K5): an active local session mounts the shell
// from the cache; only an auth failure keeps it down.
@MainActor
struct SessionNetworkFallbackTests {
    private let snapshot = SessionSnapshot(isLoaded: true, userID: "user-1", sessionID: "sess-1", isActive: true)

    private actor Attempts {
        private(set) var count = 0
        func next() -> Int {
            count += 1
            return count
        }
    }

    @Test
    func failuresAreClassified() {
        #expect(SessionValidationFailure.classify(URLError(.notConnectedToInternet)) == .network)
        #expect(SessionValidationFailure.classify(URLError(.timedOut)) == .network)
        #expect(SessionValidationFailure.classify(NSError(domain: NSPOSIXErrorDomain, code: 50)) == .network)
        #expect(SessionValidationFailure.classify(URLError(.userAuthenticationRequired)) == .auth)
        #expect(SessionValidationFailure.classify(SessionAuthenticationError.tokenUnavailable) == .auth)
        #expect(SessionValidationFailure.classify(NSError(domain: "clerk", code: 401)) == .auth)
        let wrapped = NSError(
            domain: "clerk",
            code: 1,
            userInfo: [NSUnderlyingErrorKey: URLError(.cannotFindHost) as NSError]
        )
        #expect(SessionValidationFailure.classify(wrapped) == .network)
    }

    @Test
    func aNetworkFailureMountsTheShellAndKeepsValidationPending() async {
        let store = SessionStore()
        store.revalidationDelays = [.seconds(60)]
        await store.synchronize(snapshot: snapshot) { throw URLError(.notConnectedToInternet) }
        #expect(store.state == .ready(ownerID: "user-1"))
        #expect(store.ownerID == "user-1")
        #expect(store.isValidationPending)
        store.clear()
        #expect(!store.isValidationPending)
        #expect(store.state == .signedOut)
    }

    @Test
    func anAuthFailureKeepsTheShellDown() async {
        let store = SessionStore()
        await store.synchronize(snapshot: snapshot) { throw SessionAuthenticationError.tokenUnavailable }
        #expect(store.ownerID == nil)
        #expect(store.failureMessage == SessionAuthenticationError.tokenUnavailable.errorDescription)
        #expect(!store.isValidationPending)
    }

    @Test
    func theBackgroundReadClearsThePendingMarkWhenTheNetworkReturns() async {
        let store = SessionStore()
        store.revalidationDelays = [.milliseconds(5)]
        let attempts = Attempts()
        await store.synchronize(snapshot: snapshot) {
            let attempt = await attempts.next()
            if attempt < 3 { throw URLError(.notConnectedToInternet) }
            return "token"
        }
        #expect(store.state == .ready(ownerID: "user-1"))
        for _ in 0 ..< 200 where store.isValidationPending {
            try? await Task.sleep(for: .milliseconds(10))
        }
        #expect(!store.isValidationPending)
        #expect(store.state == .ready(ownerID: "user-1"))
        let tries = await attempts.count
        #expect(tries >= 3)
    }

    @Test
    func theBackgroundReadBringsTheShellDownOnAnAuthFailure() async {
        let store = SessionStore()
        store.revalidationDelays = [.milliseconds(5)]
        let attempts = Attempts()
        await store.synchronize(snapshot: snapshot) {
            let attempt = await attempts.next()
            if attempt == 1 { throw URLError(.notConnectedToInternet) }
            throw SessionAuthenticationError.sessionNotActive
        }
        #expect(store.state == .ready(ownerID: "user-1"))
        for _ in 0 ..< 200 where store.failureMessage == nil {
            try? await Task.sleep(for: .milliseconds(10))
        }
        #expect(store.failureMessage == SessionAuthenticationError.sessionNotActive.errorDescription)
        #expect(!store.isValidationPending)
    }
}
