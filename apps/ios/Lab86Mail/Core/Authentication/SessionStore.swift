import ClerkKit
import Foundation
import Observation

enum SessionAuthenticationError: LocalizedError, Sendable, Equatable {
    case clerkNotLoaded
    case sessionNotActive
    case tokenUnavailable

    var errorDescription: String? {
        switch self {
        case .clerkNotLoaded, .sessionNotActive:
            "Your sign-in session is still being activated. Try again."
        case .tokenUnavailable:
            "Albatross could not create an authenticated session. Try again."
        }
    }
}

struct SessionSnapshot: Equatable, Hashable, Sendable {
    let isLoaded: Bool
    let userID: String?
    let sessionID: String?
    let isActive: Bool

    var boundaryState: SessionStore.State {
        guard isLoaded else { return .loading }
        guard let userID, sessionID != nil else { return .signedOut }
        guard isActive else { return .activating }
        return .validating(ownerID: userID)
    }
}

@MainActor
enum ClerkSessionAccess {
    static func snapshot(from clerk: Clerk) -> SessionSnapshot {
        SessionSnapshot(
            isLoaded: clerk.isLoaded,
            userID: clerk.user?.id,
            sessionID: clerk.session?.id,
            isActive: clerk.session?.status == .active
        )
    }

    static func activeToken(from clerk: Clerk = .shared) async throws -> String {
        guard clerk.isLoaded else { throw SessionAuthenticationError.clerkNotLoaded }
        guard let session = clerk.session, session.status == .active else {
            throw SessionAuthenticationError.sessionNotActive
        }
        guard let token = try await session.getToken(), !token.isEmpty else {
            throw SessionAuthenticationError.tokenUnavailable
        }
        return token
    }
}

@MainActor
@Observable
final class SessionStore {
    enum State: Equatable, Sendable {
        case loading
        case signedOut
        case activating
        case validating(ownerID: String)
        case ready(ownerID: String)
        case failed(message: String)
    }

    private(set) var state: State = .loading
    private var validationGeneration = 0

    var ownerID: String? {
        guard case .ready(let ownerID) = state else { return nil }
        return ownerID
    }

    var failureMessage: String? {
        guard case .failed(let message) = state else { return nil }
        return message
    }

    func synchronize(
        snapshot: SessionSnapshot,
        tokenProvider: @escaping @MainActor () async throws -> String
    ) async {
        validationGeneration += 1
        let generation = validationGeneration
        let boundaryState = snapshot.boundaryState
        state = boundaryState

        guard case .validating(let ownerID) = boundaryState else { return }
        do {
            let token = try await tokenProvider()
            guard generation == validationGeneration, snapshot.boundaryState == boundaryState else { return }
            guard !token.isEmpty else { throw SessionAuthenticationError.tokenUnavailable }
            state = .ready(ownerID: ownerID)
        } catch is CancellationError {
            return
        } catch {
            guard generation == validationGeneration else { return }
            state = .failed(message: error.localizedDescription)
        }
    }

    func acknowledgeFailure() {
        guard case .failed = state else { return }
        state = .activating
    }

    func clear() {
        validationGeneration += 1
        state = .signedOut
    }
}
