import ClerkKit
import SwiftUI

struct SettingsView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(Clerk.self) private var clerk
    @Environment(\.dismiss) private var dismiss
    @State private var modelStatus = "Checking…"
    @State private var isSigningOut = false
    @State private var signOutError: String?
    @State private var undoSendSeconds: Int?
    @State private var sendingError: String?
    @State private var showsAccountDeletion = false

    private static let undoSendChoices: [(seconds: Int, label: String)] = [
        (0, "Instant (off)"),
        (5, "5 seconds"),
        (10, "10 seconds"),
        (20, "20 seconds"),
        (30, "30 seconds"),
        (60, "1 minute"),
        (120, "2 minutes"),
        (300, "5 minutes"),
    ]

    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
                    LabeledContent("Albatross", value: "Signed in")
                    NavigationLink("Mailboxes") { MailboxesSettingsView() }
                    NavigationLink("Connections") { ConnectionsSettingsView() }
                    Button("Sign out", role: .destructive) {
                        Task { await signOut() }
                    }
                    .disabled(isSigningOut)
                    Button("Delete account and data", role: .destructive) {
                        showsAccountDeletion = true
                    }
                    if let signOutError {
                        Text(signOutError).font(.footnote).foregroundStyle(.red)
                    }
                }

                Section("Notifications") {
                    NavigationLink("Delivery and schedule") { NotificationSettingsView() }
                }

                Section("Personalization") {
                    NavigationLink("Appearance") { AppearanceSettingsView() }
                    NavigationLink("AI") { AISettingsView() }
                    NavigationLink("Smart Labels") { SmartLabelsSettingsView() }
                    NavigationLink("Keyboard Shortcuts") { ShortcutReferenceView() }
                }

                Section {
                    Picker(
                        "Undo send window",
                        selection: Binding(
                            get: { undoSendSeconds ?? 10 },
                            set: { newValue in
                                undoSendSeconds = newValue
                                Task { await saveUndoSend(newValue) }
                            }
                        )
                    ) {
                        ForEach(Self.undoSendChoices, id: \.seconds) { choice in
                            Text(choice.label).tag(choice.seconds)
                        }
                    }
                    .disabled(undoSendSeconds == nil)
                    if let sendingError {
                        Text(sendingError).font(.footnote).foregroundStyle(.red)
                    }
                } header: {
                    Text("Sending")
                } footer: {
                    Text("Sent mail is held this long before it actually goes out, so you can undo.")
                }

                Section("Intelligence") {
                    Label(modelStatus, systemImage: "apple.intelligence")
                    Text("Small, private transformations prefer the phone. Large-context planning and connected-source work use Lab86’s server models.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Build") {
                    LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0")
                    if let refresh = environment.store.lastRefresh {
                        LabeledContent("Last sync", value: refresh.formatted(.relative(presentation: .named)))
                    }
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .task {
                await environment.notifications.refreshAuthorizationStatus()
                await environment.notifications.loadPreferences()
                modelStatus = await environment.modelRouter.availabilityLabel()
                await loadUndoSend()
            }
            .sheet(isPresented: $showsAccountDeletion) {
                AccountDeletionView {
                    showsAccountDeletion = false
                    dismiss()
                }
            }
        }
    }

    private func loadUndoSend() async {
        guard undoSendSeconds == nil else { return }
        do {
            let result = try await environment.backend.get(path: "/api/prefs")
            undoSendSeconds = Int(result["prefs"]?["undoSendSeconds"]?.doubleValue ?? 10)
        } catch {
            sendingError = "Couldn’t load sending preferences."
        }
    }

    private func saveUndoSend(_ seconds: Int) async {
        sendingError = nil
        do {
            _ = try await environment.backend.post(
                path: "/api/prefs",
                body: .object(["undoSendSeconds": .number(Double(seconds))])
            )
        } catch {
            sendingError = error.localizedDescription
        }
    }

    private func signOut() async {
        isSigningOut = true
        defer { isSigningOut = false }
        do {
            let ownerID = clerk.user?.id
            let coordinator = SignOutCoordinator(
                revokePush: { try await environment.notifications.revoke() },
                unregisterPushLocally: { environment.notifications.unregisterLocally() },
                clearProductState: {
                    environment.sessionStore.clear()
                    await environment.store.clearForSignOut()
                    await environment.pendingSends.clear(ownerID: ownerID)
                    environment.accountStore.clear()
                    if let ownerID {
                        clearActivityLocalState(ownerID: ownerID)
                        try? await environment.commandOutbox.purge(ownerID: ownerID)
                        await environment.syncCoordinator.cancel(ownerID: ownerID)
                    }
                },
                signOutAuthentication: { try await clerk.auth.signOut() },
                recoverLocalAuthentication: {
                    guard let publishableKey = environment.configuration.clerkPublishableKey else {
                        throw BackendError.configuration
                    }
                    try await Clerk.reconfigure(
                        publishableKey: publishableKey,
                        options: ClerkConfiguration.options(for: publishableKey)
                    )
                }
            )
            _ = try await coordinator.run()
            dismiss()
        } catch {
            signOutError = error.localizedDescription
        }
    }
}

private struct AccountDeletionView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(Clerk.self) private var clerk
    @Environment(\.dismiss) private var dismiss
    let completion: () -> Void

    @State private var confirmation = ""
    @State private var isDeleting = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("This permanently removes your Albatross account, connected-provider grants, indexed mail, calendars, tasks, Areas, Work, and settings.")
                        .foregroundStyle(.secondary)
                    TextField("Type DELETE", text: $confirmation)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                } header: {
                    Text("Permanent account deletion")
                } footer: {
                    Text("This is different from signing out and cannot be undone.")
                }
                Section {
                    Button("Delete account and all data", role: .destructive) {
                        Task { await deleteAccount() }
                    }
                    .disabled(confirmation != "DELETE" || isDeleting)
                    if isDeleting { ProgressView("Deleting account…") }
                    if let errorMessage {
                        Text(errorMessage).font(.footnote).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Delete Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isDeleting)
                }
            }
        }
        .interactiveDismissDisabled(isDeleting)
    }

    private func deleteAccount() async {
        guard confirmation == "DELETE" else { return }
        isDeleting = true
        errorMessage = nil
        do {
            _ = try await environment.backend.delete(path: "/api/account", body: .object([:]))
            let ownerID = environment.sessionStore.ownerID
            try? await environment.notifications.revoke()
            environment.notifications.unregisterLocally()
            environment.sessionStore.clear()
            await environment.store.clearForSignOut()
            await environment.pendingSends.clear(ownerID: ownerID)
            environment.accountStore.clear()
            if let ownerID {
                clearActivityLocalState(ownerID: ownerID)
                try? await environment.commandOutbox.purge(ownerID: ownerID)
                await environment.syncCoordinator.cancel(ownerID: ownerID)
            }
            try? await clerk.auth.signOut()
            completion()
        } catch {
            errorMessage = error.localizedDescription
            isDeleting = false
        }
    }
}

private func clearActivityLocalState(ownerID: String) {
    UserDefaults.standard.removeObject(forKey: "albatross.activity.\(ownerID).archived")
    UserDefaults.standard.removeObject(forKey: "albatross.activity.\(ownerID).read")
}
