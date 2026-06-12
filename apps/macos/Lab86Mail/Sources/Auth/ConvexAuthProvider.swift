import ClerkKit
import ConvexMobile
import Foundation

// Feeds Clerk-minted JWTs (template "convex" — the same template the web app
// uses) into the Convex client, and keeps them fresh as Clerk rotates tokens.
@MainActor
final class Lab86ConvexAuthProvider: AuthProvider {
    typealias T = String

    private var onIdToken: (@Sendable (String?) -> Void)?
    private var authEventsTask: Task<Void, Never>?
    private weak var client: ConvexClientWithAuth<String>?

    func bind(client: ConvexClientWithAuth<String>) {
        self.client = client
        startAuthSync()
    }

    func login(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String {
        self.onIdToken = onIdToken
        return try await fetchConvexToken()
    }

    func loginFromCache(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String {
        self.onIdToken = onIdToken
        return try await fetchConvexToken()
    }

    func logout() async throws {
        authEventsTask?.cancel()
        authEventsTask = nil
        onIdToken = nil
        try await Clerk.shared.auth.signOut()
    }

    nonisolated func extractIdToken(from authResult: String) -> String {
        authResult
    }

    private func fetchConvexToken(skipCache: Bool = false) async throws -> String {
        guard Clerk.shared.isLoaded else { throw AuthError.clerkNotLoaded }
        guard let session = Clerk.shared.session, session.status == .active else {
            throw AuthError.noActiveSession
        }
        guard let token = try await session.getToken(.init(template: "convex", skipCache: skipCache)) else {
            throw AuthError.missingToken
        }
        return token
    }

    private func startAuthSync() {
        authEventsTask?.cancel()
        authEventsTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await syncSession()
            for await event in Clerk.shared.auth.events {
                guard !Task.isCancelled else { break }
                switch event {
                case .sessionChanged:
                    await syncSession()
                case .tokenRefreshed:
                    await refreshConvexToken()
                default:
                    break
                }
            }
        }
    }

    private func syncSession() async {
        guard let client else { return }
        if Clerk.shared.session?.status == .active {
            _ = await client.loginFromCache()
        } else {
            onIdToken?(nil)
        }
    }

    private func refreshConvexToken() async {
        do {
            onIdToken?(try await fetchConvexToken())
        } catch {
            onIdToken?(nil)
        }
    }

    enum AuthError: LocalizedError {
        case clerkNotLoaded, noActiveSession, missingToken

        var errorDescription: String? {
            switch self {
            case .clerkNotLoaded: "Account services are still loading."
            case .noActiveSession: "No active session — sign in first."
            case .missingToken: "Could not mint a Convex session token."
            }
        }
    }
}
