import SwiftUI

/// The words of the Saved sign-ins setting, in one place for the view and
/// the tests.
enum SavedSignInsCopy {
    static let explanation =
        "When you sign in to a site inside the shared browser, the browser keeps that sign-in for the next step. Albatross never sees a password. The browser keeps the sign-in."
    static let forgetTitle = "Forget saved sign-ins?"
    static let forgetDetail =
        "Every site signs you out of the shared browser. You sign in again the next time a step needs it."
    static let forgotten = "Saved sign-ins are forgotten."
}

/// Settings, Trust, Saved sign-ins: whether a sign-in context exists for the
/// shared browser, and one button to forget it. The row changes only when
/// the server confirms the change.
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
                    LabeledContent("Saved sign-ins", value: status.line())
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
                Button(isForgetting ? "Forgetting…" : "Forget saved sign-ins", role: .destructive) {
                    showsForgetConfirmation = true
                }
                .disabled(isForgetting || status?.saved != true)
                if let errorMessage {
                    Text(errorMessage).font(.footnote).foregroundStyle(.red)
                } else if let message {
                    Text(message).font(.footnote).foregroundStyle(.secondary)
                }
            } footer: {
                Text(SavedSignInsCopy.forgetDetail)
            }
        }
        .navigationTitle("Saved sign-ins")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .confirmationDialog(
            SavedSignInsCopy.forgetTitle,
            isPresented: $showsForgetConfirmation,
            titleVisibility: .visible
        ) {
            Button("Forget saved sign-ins", role: .destructive) {
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
            if status == nil { loadError = "Could not read the saved sign-ins." }
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
            errorMessage = error.localizedDescription.nilIfBlank ?? "Could not forget the saved sign-ins."
        }
    }
}
