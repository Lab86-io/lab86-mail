import Foundation

@MainActor
struct SignOutCoordinator {
    struct Result: Equatable, Sendable {
        let pushRevocationFailed: Bool
        let recoveredLocalAuthentication: Bool
    }

    let revokePush: @MainActor () async throws -> Void
    let unregisterPushLocally: @MainActor () -> Void
    let clearProductState: @MainActor () async -> Void
    let signOutAuthentication: @MainActor () async throws -> Void
    let recoverLocalAuthentication: @MainActor () async throws -> Void

    func run() async throws -> Result {
        var pushRevocationFailed = false
        do {
            try await revokePush()
        } catch {
            // A dead network connection must not leave the user signed in.
            // Stop delivery on this installation even if the authenticated
            // server-side device revocation cannot complete.
            pushRevocationFailed = true
            unregisterPushLocally()
        }

        await clearProductState()

        do {
            try await signOutAuthentication()
            return Result(
                pushRevocationFailed: pushRevocationFailed,
                recoveredLocalAuthentication: false
            )
        } catch {
            // Clerk's sign-out endpoint can fail for an already-invalid or
            // half-restored session. Reconfiguration clears Clerk's keychain
            // and in-memory client state so that state can never trap the UI.
            try await recoverLocalAuthentication()
            return Result(
                pushRevocationFailed: pushRevocationFailed,
                recoveredLocalAuthentication: true
            )
        }
    }
}
