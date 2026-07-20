import ClerkKit
import ClerkKitUI
import SwiftUI

struct RootView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(Clerk.self) private var clerk
    @State private var showsAuthentication = false
    @State private var authenticationRetry = 0

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
            guard environment.sessionStore.ownerID != nil else { return }
            await environment.notifications.activateForSignedInUser()
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
                AppShellView()
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
