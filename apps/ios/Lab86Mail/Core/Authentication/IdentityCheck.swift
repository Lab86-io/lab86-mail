import Foundation

// The identity check of Passwords and IDs (docs/albatross-secure-store.md,
// "Site rules"): a saved value never goes to a new place without a recent
// sign-in. "Allow once", "Always on {site}", and "Add a site" need it. The
// server reads the session's factor verification age (`fva`) and answers
// 403 `verify_identity` when it is older than 10 minutes. This file holds
// the pure window rule, the result of a check, and the presenter a host view
// uses to open the sheet and wait. ClerkKit itself is driven by
// IdentityCheckSheet.

/// The 10-minute window after a sign-in or a check (`IDENTITY_CHECK_MINUTES`).
enum IdentityWindow {
    static let minutes = 10

    /// The age of the first factor in minutes: the token's `fva[0]` plus the
    /// minutes since the token was issued. Nil when the token has no claim.
    static func firstFactorAgeMinutes(token: String, now: Date = .now) -> Int? {
        guard let payload = payload(of: token),
              let fva = payload["fva"]?.arrayValue,
              let first = fva.first?.doubleValue, first >= 0 else { return nil }
        let issued = payload["iat"]?.doubleValue ?? now.timeIntervalSince1970
        let sinceIssue = max(0, now.timeIntervalSince1970 - issued) / 60
        return Int(first) + Int(sinceIssue.rounded(.down))
    }

    /// True when the first factor is under 10 minutes old, the same rule as
    /// Clerk's `afterMinutes > age`.
    static func isOpen(token: String, now: Date = .now) -> Bool {
        guard let age = firstFactorAgeMinutes(token: token, now: now) else { return false }
        return age < minutes
    }

    /// The payload of a JWT, decoded without a signature check. The server
    /// checks the signature; the client reads only the window.
    static func payload(of token: String) -> JSONValue? {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        var base64 = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64.append("=") }
        guard let data = Data(base64Encoded: base64) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }
}

/// How a check ended.
enum IdentityCheckResult: Equatable, Sendable {
    case passed
    case cancelled
    /// This device could not do the check: the host offers the web.
    case failed(String)
}

/// One request for the check sheet: why, in the user's words.
struct IdentityCheckRequest: Identifiable, Equatable, Sendable {
    let id: UUID
    let reason: String
}

/// The words of the check, shared by every host.
enum IdentityCheckCopy {
    static let title = "One more check"
    static let footer = "You will not be asked again for 10 minutes."
    static let cancelledAllow = "An allow needs a recent sign-in. Do not allow needs none."
    static let cancelledSite = "Adding a site needs a recent sign-in."
    static let deviceFailed = "This device could not do the check. Answer on the web, or press Do not allow."
    static let deviceFailedSite = "This device could not do the check. Add the site on the web."
    static let openWeb = "Open on the web"

    /// "Allow once lets Albatross type your driver's license on dmv.ny.gov for this run."
    static func allowOnceReason(itemLabel: String, host: String) -> String {
        "Allow once lets Albatross use your \(SecureItemLabel.inSentence(itemLabel)) on \(host) for this run."
    }

    /// "Always on ny.gov adds ny.gov to your driver's license. That covers dmv.ny.gov and every page of ny.gov."
    static func allowAlwaysReason(itemLabel: String, site: String, host: String) -> String {
        let covers = host == site ? "every page of \(site)" : "\(host) and every page of \(site)"
        return "Always on \(site) adds \(site) to your \(SecureItemLabel.inSentence(itemLabel)). That covers \(covers)."
    }

    /// "A new site for your Chase sign-in."
    static func addSiteReason(itemLabel: String, noun: String) -> String {
        "A new site for your \(itemLabel) \(noun)."
    }
}

extension String {
    /// "Driver's license" reads "driver's license" inside a sentence; an
    /// acronym ("ID number") keeps its capitals.
    var lowercasedFirst: String {
        guard let head = self.first else { return self }
        let rest = self.dropFirst()
        if let second = rest.first, second.isUppercase { return self }
        return head.lowercased() + rest
    }
}

/// Opens the check sheet for a host view and waits for its result. The host
/// mounts `identityCheckSheet(_:)` once; `check(reason:)` presents it. One
/// check at a time: a second call while one waits is cancelled at once.
@MainActor
@Observable
final class IdentityCheckPresenter {
    private(set) var request: IdentityCheckRequest?
    @ObservationIgnored private var continuation: CheckedContinuation<IdentityCheckResult, Never>?

    func check(reason: String) async -> IdentityCheckResult {
        guard continuation == nil else { return .cancelled }
        return await withCheckedContinuation { continuation in
            self.continuation = continuation
            request = IdentityCheckRequest(id: UUID(), reason: reason)
        }
    }

    func finish(_ result: IdentityCheckResult) {
        request = nil
        let pending = continuation
        continuation = nil
        pending?.resume(returning: result)
    }

    /// The sheet went away without an answer.
    func cancel() {
        guard continuation != nil else { return }
        finish(.cancelled)
    }
}

/// Runs one request that may need the check: the window pre-check first,
/// then the request, then one retry after a 403. The server is the authority.
@MainActor
enum IdentityGuard {
    enum Outcome: Equatable, Sendable {
        case done
        case cancelled
        case checkFailed(String)
        case error(SecureSaveError)
    }

    static func run(
        reason: String,
        presenter: IdentityCheckPresenter,
        windowOpen: () async -> Bool,
        operation: () async throws -> Void
    ) async -> Outcome {
        if !(await windowOpen()) {
            switch await presenter.check(reason: reason) {
            case .passed: break
            case .cancelled: return .cancelled
            case .failed(let message): return .checkFailed(message)
            }
        }
        do {
            try await operation()
            return .done
        } catch SecureSaveError.verifyIdentity {
            switch await presenter.check(reason: reason) {
            case .passed: break
            case .cancelled: return .cancelled
            case .failed(let message): return .checkFailed(message)
            }
            do {
                try await operation()
                return .done
            } catch let error as SecureSaveError {
                return .error(error)
            } catch {
                return .error(.other(error.localizedDescription))
            }
        } catch let error as SecureSaveError {
            return .error(error)
        } catch {
            return .error(.other(error.localizedDescription))
        }
    }
}
