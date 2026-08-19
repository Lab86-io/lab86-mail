import ClerkKit
import ClerkKitUI
import SwiftUI

struct RootView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(Clerk.self) private var clerk
    @Environment(\.scenePhase) private var scenePhase
    @State private var showsAuthentication = false
    @State private var authenticationRetry = 0
    @State private var onboardingCompletedOwners: Set<String> = []
    private let onboardingDismissals = OnboardingDismissalStore()

    var body: some View {
        Group {
            if !environment.configuration.isReady {
                ConfigurationRequiredView(keys: environment.configuration.missingKeys)
            } else {
                authenticatedRoot
            }
        }
        .sheet(isPresented: $showsAuthentication) {
            AuthView()
        }
        .task(id: SessionTaskID(snapshot: sessionSnapshot, retry: authenticationRetry)) {
            guard environment.configuration.isReady else { return }
            await environment.sessionStore.synchronize(snapshot: sessionSnapshot) {
                try await ClerkSessionAccess.activeToken(from: clerk)
            }
            if environment.sessionStore.ownerID != nil {
                showsAuthentication = false
            }
        }
        .task(id: environment.sessionStore.ownerID) {
            guard environment.sessionStore.ownerID != nil else {
                // Codes belong to the account that received them, so signing
                // out has to take them off the keyboard as well as out of the
                // vault.
                await environment.oneTimeCodes.clear()
                return
            }
            await environment.notifications.activateForSignedInUser()
            await environment.oneTimeCodes.refresh()
        }
        .onChange(of: scenePhase) { _, phase in
            // Refreshing on foreground is what keeps AutoFill current on a
            // build that receives no push, and it covers the ordinary case
            // where a code arrived while the app was suspended.
            guard phase == .active, environment.sessionStore.ownerID != nil else { return }
            Task { await environment.oneTimeCodes.refresh() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .lab86OneTimeCodeAvailable)) { _ in
            guard environment.sessionStore.ownerID != nil else { return }
            Task { await environment.oneTimeCodes.refresh() }
        }
    }

    @ViewBuilder
    private var authenticatedRoot: some View {
        switch environment.sessionStore.state {
        case .loading, .activating, .validating:
            ProgressView("Finishing sign in…")
        case .signedOut:
            signedOutView
        case .ready(let ownerID):
            if ownerID == sessionSnapshot.userID {
                if onboardingCompletedOwners.contains(ownerID) || onboardingDismissals.contains(ownerID: ownerID) {
                    #if os(macOS)
                    MacShellView()
                    #else
                    AppShellView()
                    #endif
                } else {
                    MailboxOnboardingView(ownerID: ownerID) {
                        onboardingDismissals.insert(ownerID: ownerID)
                        onboardingCompletedOwners.insert(ownerID)
                    }
                }
            } else {
                ProgressView("Finishing sign in…")
            }
        case .failed(let message):
            ProgressView("Finishing sign in…")
                .alert("Couldn’t finish signing in", isPresented: failureAlertBinding) {
                    Button("Try Again") { authenticationRetry += 1 }
                } message: {
                    Text(message)
                }
        }
    }

    private var sessionSnapshot: SessionSnapshot {
        ClerkSessionAccess.snapshot(from: clerk)
    }

    private var failureAlertBinding: Binding<Bool> {
        Binding(
            get: { environment.sessionStore.failureMessage != nil },
            set: { isPresented in
                if !isPresented {
                    environment.sessionStore.acknowledgeFailure()
                }
            }
        )
    }

    private var signedOutView: some View {
        NavigationStack {
            ContentUnavailableView {
                Label("Your day, handled", systemImage: "bird")
            } description: {
                Text("Mail, calendar, tasks, and the work behind them—together, with Albatross watching for what needs your attention.")
            } actions: {
                Button("Sign in") { showsAuthentication = true }
                    .buttonStyle(.borderedProminent)
            }
            .navigationTitle("Albatross")
        }
    }
}

struct OnboardingDismissalStore {
    private static let keyPrefix = "lab86-mail-onboarding-dismissed-v1."
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func contains(ownerID: String) -> Bool {
        defaults.bool(forKey: Self.keyPrefix + ownerID)
    }

    func insert(ownerID: String) {
        defaults.set(true, forKey: Self.keyPrefix + ownerID)
    }
}

private struct SessionTaskID: Equatable {
    let snapshot: SessionSnapshot
    let retry: Int
}

struct ConfigurationRequiredView: View {
    let keys: [String]

    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label("Connect this build", systemImage: "wrench.and.screwdriver")
            } description: {
                Text("Add the missing values to Config/Local.xcconfig, regenerate the project, and relaunch.\n\n\(keys.joined(separator: "\n"))")
            }
            .navigationTitle("Albatross")
        }
    }
}
