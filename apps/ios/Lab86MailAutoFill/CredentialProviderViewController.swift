import AuthenticationServices
import SwiftUI
import UIKit

/// Supplies one-time codes from mail to system AutoFill.
///
/// The system instantiates this in a separate, short-lived, memory-constrained
/// process. It reads codes the app has already put in the shared container —
/// it never fetches, never authenticates, and never touches the mail corpus.
/// Everything expensive happened before the user tapped the field.
final class CredentialProviderViewController: ASCredentialProviderViewController {
    /// How the chosen code has to be handed back.
    ///
    /// The two AutoFill entry points this extension declares complete through
    /// different methods, and calling the wrong one leaves the request hanging
    /// until the system times it out.
    private enum Completion {
        case oneTimeCode
        case textToInsert
    }

    private let vault = OneTimeCodeVault()
    private let reporter = OneTimeCodeConsumeReporter()

    deinit {}

    // MARK: - Supplying a code for a specific request

    /// The fast path: can a code be supplied with no UI at all?
    ///
    /// It can whenever exactly one code matches. Nothing here sits behind
    /// authentication — these codes were already delivered to this user's
    /// device and are worthless once their few minutes are up.
    override func provideCredentialWithoutUserInteraction(for credentialRequest: any ASCredentialRequest) {
        let matches = codes(for: credentialRequest.credentialIdentity.serviceIdentifier)
        // Two matches is a real choice between services, and choosing for the
        // user risks filling one site's code into another. Ask for UI instead.
        guard matches.count == 1, let match = matches.first else {
            cancel(.userInteractionRequired)
            return
        }
        complete(with: match, using: .oneTimeCode)
    }

    /// Called when the silent path asked for UI, for one specific identity.
    override func prepareInterfaceToProvideCredential(for credentialRequest: any ASCredentialRequest) {
        present(
            codes: codes(for: credentialRequest.credentialIdentity.serviceIdentifier),
            completion: .oneTimeCode,
            scopedToService: true
        )
    }

    /// Called when the user taps the key icon to see every available code.
    ///
    /// This is the one-time-code list, which is a different entry point from
    /// `prepareCredentialList(for:)` — that one is the password list, and a
    /// provider declaring only `ProvidesOneTimeCodes` never receives it.
    override func prepareOneTimeCodeCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
        // Apple orders these most-specific first, so preserving order keeps the
        // best match at the top of the list.
        let matches = serviceIdentifiers.flatMap { codes(for: $0) }
        // The array is allowed to be empty, and the system still expects a list
        // to choose from — that is the case where the user went looking.
        let unique = Self.deduplicated(matches.isEmpty ? vault.activeCodes() : matches)
        present(codes: unique, completion: .oneTimeCode, scopedToService: !matches.isEmpty)
    }

    /// The `ProvidesTextToInsert` path, for fields iOS does not recognise as
    /// one-time code fields. Completes with plain text rather than a credential.
    override func prepareInterfaceForUserChoosingTextToInsert() {
        present(codes: vault.activeCodes(), completion: .textToInsert, scopedToService: false)
    }

    // MARK: - Presentation

    private func codes(for identifier: ASCredentialServiceIdentifier) -> [StoredOneTimeCode] {
        vault.codes(forServiceIdentifier: identifier.identifier)
    }

    private static func deduplicated(_ codes: [StoredOneTimeCode]) -> [StoredOneTimeCode] {
        var seen = Set<String>()
        return codes.filter { seen.insert($0.id).inserted }
    }

    private func present(codes: [StoredOneTimeCode], completion: Completion, scopedToService: Bool) {
        let view = OneTimeCodePickerView(
            codes: codes,
            scopedToService: scopedToService,
            onSelect: { [weak self] code in self?.complete(with: code, using: completion) },
            onCancel: { [weak self] in self?.cancel(.userCanceled) }
        )
        let host = UIHostingController(rootView: view)
        addChild(host)
        host.view.frame = self.view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        self.view.addSubview(host.view)
        host.didMove(toParent: self)
    }

    // MARK: - Completion

    private func complete(with code: StoredOneTimeCode, using completion: Completion) {
        // Spend the code locally before handing it over. This process is torn
        // down the instant the system takes the credential — the normal way it
        // ends — so the code has to already be gone, or it would be offered
        // again on a field it can no longer satisfy.
        let cleanup = vault.cleanupMode
        vault.consume(codeID: code.id, cleanup: cleanup)
        reportConsumption(codeID: code.id, cleanup: cleanup)

        switch completion {
        case .oneTimeCode:
            extensionContext.completeOneTimeCodeRequest(using: ASOneTimeCodeCredential(code: code.code))
        case .textToInsert:
            extensionContext.completeRequest(withTextToInsert: code.code)
        }
    }

    /// Best effort, and detached: the extension is killed as soon as the
    /// credential is delivered, so this either finishes in the moment it has or
    /// the app flushes the record the vault kept on its next foreground.
    private func reportConsumption(codeID: String, cleanup: String) {
        guard cleanup != "none" else { return }
        let baseURL = vault.apiBaseURL
        let token = vault.consumeToken
        let vault = self.vault
        let reporter = self.reporter
        Task.detached(priority: .utility) {
            do {
                try await reporter.report(
                    codeID: codeID,
                    cleanup: cleanup,
                    baseURL: baseURL,
                    consumeToken: token
                )
                vault.clearPendingConsumption(codeID: codeID)
            } catch {
                // Left queued deliberately; the app will report it.
            }
        }
    }

    private func cancel(_ code: ASExtensionError.Code) {
        extensionContext.cancelRequest(
            withError: NSError(domain: ASExtensionErrorDomain, code: code.rawValue)
        )
    }
}

/// The list shown when the user has to choose between codes.
///
/// Plain system styling on purpose: this is presented over someone else's login
/// screen, and it should read as part of iOS rather than as a piece of
/// Albatross that has escaped onto another app.
private struct OneTimeCodePickerView: View {
    let codes: [StoredOneTimeCode]
    let scopedToService: Bool
    let onSelect: (StoredOneTimeCode) -> Void
    let onCancel: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                if codes.isEmpty {
                    ContentUnavailableView(
                        "No codes from mail",
                        systemImage: "envelope",
                        description: Text(
                            scopedToService
                                ? "No code has arrived for this site in the last few minutes."
                                : "Codes appear here for a few minutes after they arrive."
                        )
                    )
                } else {
                    List(codes) { code in
                        Button { onSelect(code) } label: {
                            LabeledContent {
                                Text(code.code)
                                    .font(.body.monospacedDigit())
                                    .fontWeight(.medium)
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(code.issuer.isEmpty ? code.label : code.issuer)
                                    Text(code.receivedAt, style: .relative)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .tint(.primary)
                    }
                }
            }
            .navigationTitle("Codes from mail")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
            }
        }
    }
}
