import AuthenticationServices
import Foundation
import Observation

/// Keeps the phone's AutoFill offering in step with the codes the server holds.
///
/// The work splits in two. The vault is what the extension actually reads, and
/// the credential identity store is what makes iOS show a code above the
/// keyboard without the user going looking for it. Both have to be written, and
/// the identity store has to be written from the app: an extension cannot
/// register identities for itself.
@MainActor
@Observable
final class OneTimeCodeCoordinator {
    private let backend: BackendClient
    private let vault: OneTimeCodeVault
    private let reporter: OneTimeCodeConsumeReporter
    private let identityStore: CredentialIdentityStoring

    /// Whether the user has enabled Albatross under Settings ▸ AutoFill.
    /// Without that, everything here is inert, so the UI says so plainly.
    private(set) var isEnabledAsProvider = false
    private(set) var activeCodeCount = 0
    private(set) var lastError: String?
    /// Mirrors the server's setting; the server is the only writer.
    private(set) var autofillEnabled = true
    private(set) var cleanupMode: OneTimeCodeCleanup = .none

    init(
        backend: BackendClient,
        vault: OneTimeCodeVault = OneTimeCodeVault(),
        reporter: OneTimeCodeConsumeReporter = OneTimeCodeConsumeReporter(),
        identityStore: CredentialIdentityStoring = SystemCredentialIdentityStore()
    ) {
        self.backend = backend
        self.vault = vault
        self.reporter = reporter
        self.identityStore = identityStore
    }

    /// Pulls the current codes and republishes them.
    ///
    /// Called on foreground and whenever a push says a code has arrived. The
    /// foreground path is what makes this work at all on a build that cannot
    /// receive push, so it is not merely a fallback.
    func refresh() async {
        await refreshProviderState()
        do {
            let response = try await backend.get(path: "/api/mobile/one-time-codes")
            guard response["ok"]?.boolValue == true else { throw BackendError.invalidResponse }
            // The policy travels with the codes, so a setting the user changed
            // on another device takes effect on this one's next refresh.
            autofillEnabled = response["autofillEnabled"]?.boolValue ?? true
            cleanupMode = OneTimeCodeCleanup(rawValue: response["cleanup"]?.stringValue ?? "none") ?? .none
            let codes = (response["codes"]?.arrayValue ?? []).compactMap(Self.decode)
            await publish(codes: codes, consumeToken: response["consumeToken"]?.stringValue)
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
        await flushPendingConsumptions()
    }

    func refreshProviderState() async {
        isEnabledAsProvider = await identityStore.isEnabled()
    }

    /// Reports consumptions the extension could not send itself.
    ///
    /// The extension is torn down as soon as it hands over a credential, so its
    /// own report often does not finish. This is the path that actually files
    /// most of the mail.
    func flushPendingConsumptions() async {
        let pending = vault.pendingConsumptions()
        guard !pending.isEmpty else { return }
        for item in pending {
            do {
                // Uses the app's own session rather than the scoped token: the
                // app has one, and it is the stronger guarantee of the two.
                let response = try await backend.post(
                    path: "/api/mobile/one-time-codes/consume",
                    body: .object([
                        "codeId": .string(item.codeID),
                        "cleanup": .string(item.cleanup),
                    ])
                )
                if response["ok"]?.boolValue == true {
                    vault.clearPendingConsumption(codeID: item.codeID)
                }
            } catch BackendError.server(let status, _) where status == 404 {
                // The server has forgotten this code; nothing left to report.
                vault.clearPendingConsumption(codeID: item.codeID)
            } catch {
                // Leave it queued for the next foreground.
            }
        }
    }

    /// Drops every code. Called on sign-out — these belong to one account.
    func clear() async {
        vault.clear()
        await identityStore.removeAll()
        activeCodeCount = 0
    }

    private func publish(codes: [StoredOneTimeCode], consumeToken: String?) async {
        vault.removeExpired()
        vault.replace(
            codes: codes,
            consumeToken: consumeToken,
            cleanupMode: cleanupMode.rawValue,
            apiBaseURL: AppConfiguration.current.apiBaseURL?.absoluteString
        )
        activeCodeCount = codes.count
        await identityStore.replaceAll(identities(for: codes))
    }

    private func identities(for codes: [StoredOneTimeCode]) -> [any ASCredentialIdentity] {
        // One identity per service a code is valid for. iOS matches the
        // requesting site against these, so a code registered only under its
        // sender's domain would never surface on the site it is actually for.
        codes.flatMap { code in
            code.serviceIdentifiers.map { identifier in
                ASOneTimeCodeCredentialIdentity(
                    serviceIdentifier: ASCredentialServiceIdentifier(
                        identifier: identifier,
                        type: .domain
                    ),
                    label: code.label,
                    recordIdentifier: code.id
                )
            }
        }
    }

    private static func decode(_ value: JSONValue) -> StoredOneTimeCode? {
        guard let id = value["id"]?.stringValue,
              let code = value["code"]?.stringValue,
              let expiresAt = value["expiresAt"]?.doubleValue
        else { return nil }
        return StoredOneTimeCode(
            id: id,
            code: code,
            label: value["label"]?.stringValue ?? "Verification code",
            issuer: value["issuer"]?.stringValue ?? "",
            serviceIdentifiers: (value["serviceIdentifiers"]?.arrayValue ?? [])
                .compactMap(\.stringValue),
            // The server sends epoch milliseconds; Date expects seconds.
            receivedAt: Date(timeIntervalSince1970: (value["receivedAt"]?.doubleValue ?? 0) / 1000),
            expiresAt: Date(timeIntervalSince1970: expiresAt / 1000)
        )
    }
}

/// What to do with the mail that carried a code, once the code has been used.
/// Mirrors the server's setting; `trash` exists because the API accepts it, but
/// the app only ever asks for `archive` — filing mail reversibly is a much
/// easier thing to be wrong about than deleting it.
enum OneTimeCodeCleanup: String, Sendable {
    case none
    case archive
    case trash
}

/// Seam over `ASCredentialIdentityStore` so the coordinator is testable without
/// the real system store, which is unavailable in a unit test host.
protocol CredentialIdentityStoring: Sendable {
    func isEnabled() async -> Bool
    func replaceAll(_ identities: [any ASCredentialIdentity]) async
    func removeAll() async
}

struct SystemCredentialIdentityStore: CredentialIdentityStoring {
    func isEnabled() async -> Bool {
        await ASCredentialIdentityStore.shared.state().isEnabled
    }

    func replaceAll(_ identities: [any ASCredentialIdentity]) async {
        // Replace rather than save: a code the server has dropped must stop
        // being offered, and saving alone would leave the stale one behind.
        guard await isEnabled() else { return }
        try? await ASCredentialIdentityStore.shared.replaceCredentialIdentities(identities)
    }

    func removeAll() async {
        guard await isEnabled() else { return }
        try? await ASCredentialIdentityStore.shared.removeAllCredentialIdentities()
    }
}
