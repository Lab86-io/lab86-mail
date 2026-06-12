import ClerkKit
import ClerkKitUI
import SwiftUI

struct SignInScreen: View {
    @Environment(ThemeManager.self) private var theme
    @State private var loadError: String?
    @State private var loading = false

    var body: some View {
        ZStack {
            backdrop

            HStack(spacing: 24) {
                VStack(alignment: .leading, spacing: 16) {
                    Image(systemName: "envelope.badge.shield.half.filled")
                        .font(.system(size: 44, weight: .semibold))
                        .foregroundStyle(theme.accent)
                    Text("Lab86 Mail")
                        .font(.system(size: 38, weight: .bold, design: .serif))
                    Text("Your mail, triaged. Smart categories, daily editions, and an assistant that actually does things — now native on the Mac.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(36)
                .frame(maxWidth: 400, alignment: .leading)
                .glassEffect(.regular, in: .rect(cornerRadius: 28))

                authCard
                    .frame(width: 420)
                    .glassEffect(.regular, in: .rect(cornerRadius: 28))
            }
            .padding(40)
        }
        .task { await loadClerk() }
    }

    private var backdrop: some View {
        MeshGradient(
            width: 3, height: 3,
            points: [
                [0, 0], [0.5, 0], [1, 0],
                [0, 0.5], [0.6, 0.4], [1, 0.5],
                [0, 1], [0.5, 1], [1, 1],
            ],
            colors: [
                OKLCH.color(l: 0.93, c: theme.accentChroma * 0.5, h: theme.accentHue),
                OKLCH.color(l: 0.97, c: 0.01, h: theme.backgroundHue),
                OKLCH.color(l: 0.90, c: theme.accentChroma * 0.4, h: theme.accentHue + 40),
                OKLCH.color(l: 0.95, c: 0.02, h: theme.backgroundHue),
                OKLCH.color(l: 0.88, c: theme.accentChroma * 0.6, h: theme.accentHue),
                OKLCH.color(l: 0.96, c: 0.01, h: theme.backgroundHue + 20),
                OKLCH.color(l: 0.92, c: theme.accentChroma * 0.3, h: theme.accentHue - 30),
                OKLCH.color(l: 0.94, c: 0.02, h: theme.backgroundHue),
                OKLCH.color(l: 0.89, c: theme.accentChroma * 0.5, h: theme.accentHue + 20),
            ]
        )
        .ignoresSafeArea()
    }

    @ViewBuilder
    private var authCard: some View {
        if let loadError {
            VStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.largeTitle)
                    .foregroundStyle(.orange)
                Text("Can't reach sign-in")
                    .font(.headline)
                Text(loadError)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
                Button("Retry") {
                    Task { await loadClerk() }
                }
                .buttonStyle(.glassProminent)
                .disabled(loading)
            }
            .padding(32)
        } else if loading {
            ProgressView("Connecting…")
                .padding(60)
        } else {
            AuthView(isDismissible: false)
                .clipShape(.rect(cornerRadius: 28))
        }
    }

    // Load the Clerk environment explicitly so configuration problems (e.g.
    // Native API disabled on the instance) surface as readable errors instead
    // of an empty auth card.
    private func loadClerk() async {
        loading = true
        loadError = nil
        defer { loading = false }
        do {
            if !Clerk.shared.isLoaded {
                _ = try await Clerk.shared.refreshEnvironment()
                _ = try await Clerk.shared.refreshClient()
            }
        } catch {
            loadError = error.localizedDescription
        }
    }
}
