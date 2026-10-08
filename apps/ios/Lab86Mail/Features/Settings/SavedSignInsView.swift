import SwiftUI

/// The words of the Signed-in sites setting, in one place for the view,
/// Settings, and the tests. It was "Saved sign-ins" until Passwords and IDs
/// arrived (docs/albatross-secure-store.md, decision 2): a saved username
/// and password is a sign-in; the shared browser's cookie session is a
/// signed-in site.
enum SavedSignInsCopy {
    static let title = "Signed-in sites"
    static let explanation =
        "When you sign in to a site inside the shared browser, the browser stays signed in for the next step. Albatross never sees a password. The browser keeps the session."
    static let trustFooter =
        "Everything Albatross does on its own, with a pause switch for each. Signed-in sites keep the shared browser signed in. Passwords and IDs, under Account, hold what Albatross types and never shows."
    static let forget = "Forget signed-in sites"
    static let forgetEllipsis = "Forget…"
    static let forgetting = "Forgetting…"
    static let forgetTitle = "Forget signed-in sites?"
    static let forgetDetail =
        "Every site signs you out of the shared browser. You sign in again the next time a step needs it."
    static let forgotten = "Signed-in sites are forgotten."
}

/// Settings, Trust, Signed-in sites: whether a sign-in context exists for
/// the shared browser, and one button to forget it. The row changes only
/// when the server confirms the change.
struct SavedSignInsView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var status: BrowserContextStatus?
    @State private var loadError: String?
    @State private var showsForgetConfirmation = false
    @State private var isForgetting = false
    @State private var message: String?
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section {
                if let status {
                    LabeledContent(SavedSignInsCopy.title, value: status.line())
                } else if let loadError {
                    Text(loadError).foregroundStyle(.secondary)
                    Button("Try Again") { Task { await load() } }
                } else {
                    ProgressView("Checking…")
                }
            } footer: {
                Text(SavedSignInsCopy.explanation)
            }
            Section {
                #if os(macOS)
                // A Mac form puts the action at the trailing edge of its row,
                // as System Settings does. The ellipsis says a confirmation
                // follows.
                LabeledContent(SavedSignInsCopy.forget) {
                    Button(isForgetting ? SavedSignInsCopy.forgetting : SavedSignInsCopy.forgetEllipsis) {
                        showsForgetConfirmation = true
                    }
                    .buttonStyle(.bordered)
                    .disabled(isForgetting || status?.saved != true)
                }
                #else
                Button(isForgetting ? SavedSignInsCopy.forgetting : SavedSignInsCopy.forget, role: .destructive) {
                    showsForgetConfirmation = true
                }
                .disabled(isForgetting || status?.saved != true)
                #endif
                if let errorMessage {
                    Text(errorMessage).font(.footnote).foregroundStyle(.red)
                } else if let message {
                    Text(message).font(.footnote).foregroundStyle(.secondary)
                }
            } footer: {
                Text(SavedSignInsCopy.forgetDetail)
            }
        }
        .navigationTitle(SavedSignInsCopy.title)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .confirmationDialog(
            SavedSignInsCopy.forgetTitle,
            isPresented: $showsForgetConfirmation,
            titleVisibility: .visible
        ) {
            Button(SavedSignInsCopy.forget, role: .destructive) {
                Task { await forget() }
            }
        } message: {
            Text(SavedSignInsCopy.forgetDetail)
        }
    }

    private func load() async {
        do {
            status = try await environment.store.browserContext()
            loadError = nil
        } catch {
            if status == nil { loadError = "Could not read the signed-in sites." }
        }
    }

    private func forget() async {
        isForgetting = true
        defer { isForgetting = false }
        do {
            try await environment.store.forgetBrowserContext()
            status = BrowserContextStatus(saved: false)
            message = SavedSignInsCopy.forgotten
            errorMessage = nil
            PlatformAccessibility.announce(SavedSignInsCopy.forgotten)
        } catch {
            errorMessage = error.localizedDescription.nilIfBlank ?? "Could not forget the signed-in sites."
        }
    }
}
