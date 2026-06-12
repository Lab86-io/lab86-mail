import ClerkKit
import ClerkKitUI
import SwiftUI

struct SignInScreen: View {
    @Environment(ThemeManager.self) private var theme
    @State private var loadError: String?
    @State private var loading = false

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 16) {
                Spacer()
                Image(systemName: "envelope.badge.shield.half.filled")
                    .font(.system(size: 44, weight: .semibold))
                    .foregroundStyle(theme.accent)
                Text("Lab86 Mail")
                    .font(.system(size: 38, weight: .bold, design: .serif))
                Text("Your mail, triaged. Smart categories, daily editions, and an assistant that actually does things — now native on the Mac.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
            }
            .padding(40)
            .frame(maxWidth: 420, maxHeight: .infinity, alignment: .leading)

            Group {
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
                        .buttonStyle(.borderedProminent)
                        .disabled(loading)
                    }
                    .padding(32)
                    .frame(maxWidth: 420)
                } else if loading {
                    ProgressView("Connecting…")
                } else {
                    AuthView(isDismissible: false)
                }
            }
            .frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
            .background(.regularMaterial)
        }
        .task { await loadClerk() }
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
