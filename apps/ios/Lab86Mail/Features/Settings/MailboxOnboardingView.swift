import SwiftUI

struct MailboxOnboardingView: View {
    private enum Step {
        case mailbox
        case intelligence
    }

    @Environment(AppEnvironment.self) private var environment
    let ownerID: String
    let completion: () -> Void

    @State private var step: Step = .mailbox
    @State private var isLoading = true
    @State private var activeProvider: String?
    @State private var errorMessage: String?
    @State private var capabilities: [ProviderCapability] = []

    private struct ProviderCapability: Identifiable {
        let id: String
        let label: String
        let connectable: Bool
        let reason: String?
    }

    var body: some View {
        NavigationStack {
            Group {
                switch step {
                case .mailbox:
                    mailboxStep
                case .intelligence:
                    AISettingsView(onboardingCompletion: completion)
                }
            }
            .navigationBarBackButtonHidden()
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Skip for now", action: completion)
                }
            }
        }
        .task { await load() }
    }

    private var mailboxStep: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Bring your inbox")
                        .font(environment.theme.displayType.displayFont(size: 34))
                    Text("Connect the mailbox Albatross should organize first. Authorization stays with your provider, and you return here to finish setup.")
                        .foregroundStyle(.secondary)
                }

                if isLoading {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Checking mail providers…").foregroundStyle(.secondary)
                    }
                } else {
                    VStack(spacing: 12) {
                        ForEach(capabilities) { provider in
                            Button {
                                Task { await connect(provider) }
                            } label: {
                                HStack(spacing: 14) {
                                    Image(systemName: provider.id == "google" ? "envelope.fill" : "building.2.fill")
                                        .frame(width: 28)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("Connect \(provider.label)")
                                            .font(.headline)
                                        if let reason = provider.reason, !provider.connectable {
                                            Text(reason)
                                                .font(.footnote)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer()
                                    if activeProvider == provider.id {
                                        ProgressView().controlSize(.small)
                                    } else {
                                        Image(systemName: "arrow.up.right")
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                .padding(16)
                                .surfaceCard()
                            }
                            .buttonStyle(.plain)
                            .disabled(!provider.connectable || activeProvider != nil)
                            .accessibilityHint(
                                provider.connectable
                                    ? "Opens secure provider authorization"
                                    : provider.reason ?? "Unavailable"
                            )
                        }
                    }
                }

                if let errorMessage {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                        Button("Try again") { Task { await load() } }
                    }
                    .font(.footnote)
                }
            }
            .padding(24)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .background(environment.theme.paperColor)
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        _ = await environment.refreshAccounts(ownerID: ownerID)
        if MailboxOnboardingPolicy.hasConnectedMailbox(
            bootstrapAccountCount: environment.accountStore.accounts.count
        ) {
            completion()
            return
        }
        do {
            let response = try await environment.backend.get(path: "/api/nylas/status")
            if MailboxOnboardingPolicy.hasConnectedMailbox(statusResponse: response) {
                completion()
                return
            }
            capabilities = (response["capabilities"]?.arrayValue ?? []).compactMap { row in
                guard row["visible"]?.boolValue != false,
                      let provider = row["provider"]?.stringValue else { return nil }
                return ProviderCapability(
                    id: provider,
                    label: row["label"]?.stringValue ?? provider.capitalized,
                    connectable: row["connectable"]?.boolValue == true,
                    reason: row["reason"]?.stringValue
                )
            }
            if capabilities.isEmpty {
                throw BackendError.server(status: 503, message: "No mailbox providers are available.")
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func connect(_ provider: ProviderCapability) async {
        activeProvider = provider.id
        errorMessage = nil
        defer { activeProvider = nil }
        do {
            try await environment.webAuthentication.connectMailbox(provider: provider.id)
            guard await environment.refreshAccounts(ownerID: ownerID),
                  !environment.accountStore.accounts.isEmpty else {
                throw BackendError.server(
                    status: 502,
                    message: "The provider returned, but the mailbox is not connected yet. Try again."
                )
            }
            step = .intelligence
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

enum MailboxOnboardingPolicy {
    static func hasConnectedMailbox(
        bootstrapAccountCount: Int = 0,
        statusResponse: JSONValue? = nil
    ) -> Bool {
        bootstrapAccountCount > 0 || !(statusResponse?["accounts"]?.arrayValue ?? []).isEmpty
    }
}
