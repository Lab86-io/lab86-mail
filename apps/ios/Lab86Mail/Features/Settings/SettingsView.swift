import ClerkKit
import SwiftUI
import UserNotifications

struct SettingsView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(Clerk.self) private var clerk
    @Environment(\.dismiss) private var dismiss
    @State private var modelStatus = "Checking…"
    @State private var isSigningOut = false
    @State private var signOutError: String?
    @State private var undoSendSeconds: Int?
    @State private var sendingError: String?

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
                    ForEach(environment.store.accounts) { account in
                        LabeledContent(account.displayName ?? account.email, value: account.provider.capitalized)
                    }
                    Button("Sign out", role: .destructive) {
                        Task { await signOut() }
                    }
                    .disabled(isSigningOut)
                    if let signOutError {
                        Text(signOutError).font(.footnote).foregroundStyle(.red)
                    }
                }

                Section("Notifications") {
                    LabeledContent("Permission", value: notificationLabel)
                    if environment.notifications.authorizationStatus != .authorized {
                        Button("Enable notifications") {
                            Task { await environment.notifications.requestAuthorization() }
                        }
                    }
                    if let date = environment.notifications.lastRegisteredAt {
                        LabeledContent("Registered", value: date.formatted(.relative(presentation: .named)))
                    }
                    if let error = environment.notifications.registrationError {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                }

                Section {
                    Toggle(
                        "Allow Albatross notifications",
                        isOn: preferenceBinding(\.nativePushEnabled)
                    )
                    Toggle("New mail", isOn: preferenceBinding(\.newMailPushEnabled))
                        .disabled(!environment.notifications.preferences.nativePushEnabled)
                    Toggle(
                        "Calendar suggestions from mail",
                        isOn: preferenceBinding(\.eventSuggestionPushEnabled)
                    )
                    .disabled(!environment.notifications.preferences.nativePushEnabled)
                    Toggle("Evening check-in", isOn: preferenceBinding(\.eveningCheckinEnabled))
                        .disabled(!environment.notifications.preferences.nativePushEnabled)
                    if let error = environment.notifications.preferencesError {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                } header: {
                    Text("Proactive notifications")
                } footer: {
                    Text("These settings follow your Albatross account across devices. iOS Focus and notification settings still take precedence.")
                }

                Section("Personalization") {
                    NavigationLink("Appearance") { AppearanceSettingsView() }
                    NavigationLink("AI") { AISettingsView() }
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
        }
    }

    private var notificationLabel: String {
        switch environment.notifications.authorizationStatus {
        case .authorized, .provisional, .ephemeral: "Enabled"
        case .denied: "Disabled in Settings"
        case .notDetermined: "Not requested"
        @unknown default: "Unknown"
        }
    }

    private func preferenceBinding(_ keyPath: WritableKeyPath<MobileNotificationPreferences, Bool>) -> Binding<Bool> {
        Binding(
            get: { environment.notifications.preferences[keyPath: keyPath] },
            set: { newValue in
                var next = environment.notifications.preferences
                next[keyPath: keyPath] = newValue
                Task { await environment.notifications.savePreferences(next) }
            }
        )
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
                    environment.accountStore.clear()
                    if let ownerID {
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
