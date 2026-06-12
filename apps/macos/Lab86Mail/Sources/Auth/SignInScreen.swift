import ClerkKitUI
import SwiftUI

struct SignInScreen: View {
    @Environment(ThemeManager.self) private var theme

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

            AuthView(isDismissible: false)
                .frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
                .background(.regularMaterial)
        }
    }
}
