import SwiftUI

// The one-line banner at the top of a thread when another Albatross needs
// the user (docs/albatross-threads.md, lead decision 3): the title and the
// status word, with "Open". Two or more: the count, with "Show". It leaves
// after ten seconds, on a tap, or on a swipe up.
struct NeedsYouBanner: View {
    @Environment(AppEnvironment.self) private var environment
    let rows: [ThreadRow]
    /// The one row to open, or nil for "Show" (the list, "Needs you").
    let onOpen: (ThreadRow?) -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(NeedsYouBannerCopy.line(rows))
                .font(.footnote)
                .foregroundStyle(.primary)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 8)
            Button(rows.count == 1 ? NeedsYouBannerCopy.open : NeedsYouBannerCopy.show) {
                onOpen(rows.count == 1 ? rows.first : nil)
            }
            .buttonStyle(.borderless)
            .font(.footnote.weight(.semibold))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .surfaceCard(theme: environment.theme, cornerRadius: 14)
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .gesture(
            DragGesture(minimumDistance: 20).onEnded { value in
                if value.translation.height < -10 { onDismiss() }
            }
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(NeedsYouBannerCopy.line(rows))
    }
}

enum NeedsYouBannerCopy {
    static let open = "Open"
    static let show = "Show"

    /// "Renew the car registration · Needs your answer", or "2 Albatrosses need you".
    static func line(_ rows: [ThreadRow]) -> String {
        if rows.count == 1, let row = rows.first {
            return "\(row.title) · \(row.word ?? "Needs you")"
        }
        return "\(rows.count) Albatrosses need you"
    }

    /// The VoiceOver announcement for the same event.
    static func announcement(_ rows: [ThreadRow]) -> String {
        if rows.count == 1, let row = rows.first {
            return "\(row.title) \(row.word?.lowercased() ?? "needs you")."
        }
        return "\(rows.count) Albatrosses need you."
    }
}
