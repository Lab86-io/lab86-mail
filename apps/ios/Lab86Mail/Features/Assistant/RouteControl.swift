import SwiftUI

/// The route control inside the composer: "Ask | Hold" as two words, and
/// "Run" in front while a run takes notes. The selected word has a soft
/// tint. A tap on a word selects it and pins it for this text; a horizontal
/// swipe or the Tab key flips, as before.
struct RouteControl: View {
    let route: BarRoute
    var isPinned = false
    var runAvailable = false
    let onSelect: (BarRoute) -> Void
    let onFlip: () -> Void

    @Environment(AppEnvironment.self) private var environment

    /// The words shown, in order.
    static func options(runAvailable: Bool) -> [BarRoute] {
        runAvailable ? [.run, .ask, .hold] : [.ask, .hold]
    }

    static func hint(for route: BarRoute) -> String {
        switch route {
        case .ask: "Sends to Albatross"
        case .hold: "Keeps it as Work"
        case .run: "Sends a note to the run"
        }
    }

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(options.enumerated()), id: \.element) { index, option in
                if index > 0 {
                    Rectangle()
                        .fill(environment.theme.hairlineColor)
                        .frame(width: 1, height: 14)
                }
                segment(option)
            }
        }
        .highPriorityGesture(
            DragGesture(minimumDistance: 12)
                .onEnded { value in
                    guard abs(value.translation.width) > abs(value.translation.height) else { return }
                    onFlip()
                }
        )
        .modifier(RouteControlHaptics(route: route))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Route")
    }

    private var options: [BarRoute] {
        var options = Self.options(runAvailable: runAvailable)
        if !options.contains(route) { options.insert(route, at: 0) }
        return options
    }

    private func segment(_ option: BarRoute) -> some View {
        let selected = option == route
        let tint = tint(for: option)
        return Button {
            onSelect(option)
        } label: {
            Text(option.word)
                .font(.footnote.weight(.semibold))
                // Three words at the largest text sizes still fit beside
                // the attach and send controls.
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .foregroundStyle(selected ? tint : Color.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(
                    selected ? tint.opacity(0.14) : Color.clear,
                    in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(tint.opacity(selected && isPinned ? 0.45 : 0), lineWidth: 1)
                )
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(option.word)
        .accessibilityHint(Self.hint(for: option))
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private func tint(for option: BarRoute) -> Color {
        option == .ask ? environment.theme.accentColor : environment.theme.accent2Color
    }
}

/// `.selection` when the route changes. Silent on the Mac.
private struct RouteControlHaptics: ViewModifier {
    let route: BarRoute

    func body(content: Content) -> some View {
        #if os(iOS)
        content.sensoryFeedback(.selection, trigger: route)
        #else
        content
        #endif
    }
}
