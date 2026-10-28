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

/// How a token read failed (K5). With an active local Clerk session, a
/// network failure mounts the shell from this owner's cache and the token
/// is tried again in the background; an auth failure keeps the shell down.
enum SessionValidationFailure: Equatable, Sendable {
    case network
    case auth

    static func classify(_ error: Error) -> SessionValidationFailure {
        if error is SessionAuthenticationError { return .auth }
        if let url = error as? URLError {
            switch url.code {
            case .userAuthenticationRequired, .userCancelledAuthentication: return .auth
            default: return .network
            }
        }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain || ns.domain == NSPOSIXErrorDomain { return .network }
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError,
           underlying.domain == NSURLErrorDomain || underlying.domain == NSPOSIXErrorDomain {
            return .network
        }
        return .auth
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
    // True while the shell runs from the cache and the token read still
    // waits for the network (K5).
    private(set) var isValidationPending = false
    private var validationGeneration = 0
    private var revalidationTask: Task<Void, Never>?
    /// The waits between background token reads. The last one repeats.
    var revalidationDelays: [Duration] = [.seconds(5), .seconds(15), .seconds(60), .seconds(120)]

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
        revalidationTask?.cancel()
        revalidationTask = nil
        isValidationPending = false
        let boundaryState = snapshot.boundaryState
        state = boundaryState

        guard case .validating(let ownerID) = boundaryState else { return }
        do {
            let token = try await tokenProvider()
            guard generation == validationGeneration, snapshot.boundaryState == boundaryState else { return }
            guard !token.isEmpty else { throw SessionAuthenticationError.tokenUnavailable }
            state = .ready(ownerID: ownerID)
        } catch {
            if error.isCancellation { return }
            guard generation == validationGeneration else { return }
            switch SessionValidationFailure.classify(error) {
            case .network:
                // The local session is active and only the network is gone:
                // the shell mounts from this owner's cache now, and the token
                // is read again in the background (K5). The owner id comes
                // from the local Clerk session, so no other owner's cache
                // can show.
                state = .ready(ownerID: ownerID)
                isValidationPending = true
                scheduleRevalidation(generation: generation, tokenProvider: tokenProvider)
            case .auth:
                state = .failed(message: error.localizedDescription)
            }
        }
    }

    private func scheduleRevalidation(
        generation: Int,
        tokenProvider: @escaping @MainActor () async throws -> String
    ) {
        let delays = revalidationDelays
        revalidationTask = Task { [weak self] in
            var attempt = 0
            while !Task.isCancelled {
                let delay = delays.isEmpty ? Duration.seconds(60) : delays[min(attempt, delays.count - 1)]
                attempt += 1
                try? await Task.sleep(for: delay)
                guard !Task.isCancelled, let self, self.validationGeneration == generation else { return }
                do {
                    let token = try await tokenProvider()
                    guard self.validationGeneration == generation else { return }
                    guard !token.isEmpty else { throw SessionAuthenticationError.tokenUnavailable }
                    self.isValidationPending = false
                    self.revalidationTask = nil
                    return
                } catch {
                    if error.isCancellation { return }
                    guard self.validationGeneration == generation else { return }
                    if SessionValidationFailure.classify(error) == .auth {
                        // The session is not good after all: the shell comes
                        // down, with the reason.
                        self.isValidationPending = false
                        self.revalidationTask = nil
                        self.state = .failed(message: error.localizedDescription)
                        return
                    }
                }
            }
        }
    }

    func acknowledgeFailure() {
        guard case .failed = state else { return }
        state = .activating
    }

    func clear() {
        validationGeneration += 1
        revalidationTask?.cancel()
        revalidationTask = nil
        isValidationPending = false
        state = .signedOut
    }
}
