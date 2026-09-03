import SwiftUI

/// The route chip inside the composer. It reads "Ask" or "Hold". A tap, a
/// horizontal swipe, or the Tab key flips it and pins it for this text.
struct RouteChip: View {
    let route: BarRoute
    var isPinned: Bool = false
    var isEnabled: Bool = true
    let onFlip: () -> Void

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var flipAngle: Double = 0
    @State private var shownRoute: BarRoute = .ask

    private var tint: Color {
        route == .ask ? environment.theme.accentColor : environment.theme.accent2Color
    }

    var body: some View {
        Button(action: flip) {
            Text(shownRoute.word)
                .font(.footnote.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(tint)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .frame(minWidth: 52)
                .background(tint.opacity(isEnabled ? 0.14 : 0.07), in: Capsule())
                .overlay(
                    Capsule().strokeBorder(tint.opacity(isPinned ? 0.45 : 0), lineWidth: 1)
                )
                .rotation3DEffect(.degrees(flipAngle), axis: (x: 0, y: 1, z: 0))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.5)
        .highPriorityGesture(
            DragGesture(minimumDistance: 12)
                .onEnded { value in
                    guard isEnabled, abs(value.translation.width) > abs(value.translation.height) else { return }
                    flip()
                }
        )
        .modifier(RouteChipHaptics(route: route))
        .accessibilityLabel("Route: \(route.word)")
        .accessibilityHint("Double tap to change to \(route.flipped.word)")
        .onAppear { shownRoute = route }
        .onChange(of: route) { _, next in
            guard next != shownRoute else { return }
            animateFlip(to: next)
        }
    }

    /// The chip moves under the field at the largest text sizes, so the word
    /// is never cut. The parent reads this to choose its layout.
    static func sitsUnderField(_ size: DynamicTypeSize) -> Bool {
        size >= .xxLarge
    }

    private func flip() {
        guard isEnabled else { return }
        onFlip()
    }

    private func animateFlip(to next: BarRoute) {
        withAnimation(.easeIn(duration: 0.14)) { flipAngle = 90 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.14) {
            shownRoute = next
            flipAngle = -90
            withAnimation(.easeOut(duration: 0.14)) { flipAngle = 0 }
        }
    }
}

/// `.selection` when the route changes. Silent on the Mac.
private struct RouteChipHaptics: ViewModifier {
    let route: BarRoute

    func body(content: Content) -> some View {
        #if os(iOS)
        content.sensoryFeedback(.selection, trigger: route)
        #else
        content
        #endif
    }
}
