import SwiftUI

// A 2 pt line under the week strip. The track is the hairline colour. While
// a sync runs, a 96 pt accent segment moves left to right on a 1.1 s loop.
// On success the segment stretches to the full width in 180 ms and fades in
// 220 ms. On failure it stops, turns accent2, and fades after 400 ms.
// Reduce Motion replaces every move with a cross-fade. Nothing travels.
// VoiceOver never reads the line. The navigation subtitle carries the state.
struct CalendarSyncLine: View {
    let phase: CalendarSyncPhase

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visible = false
    @State private var stretched = false
    @State private var failed = false
    @State private var settle: Task<Void, Never>?

    private static let segmentWidth: CGFloat = 96
    private static let loop: TimeInterval = 1.1
    private static let cross: Animation = .easeInOut(duration: 0.18)

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            ZStack(alignment: .leading) {
                Rectangle().fill(environment.theme.hairlineColor)
                if reduceMotion {
                    Rectangle()
                        .fill(segmentColor)
                        .frame(width: width)
                        .opacity(stretched ? 1 : 0.55)
                } else {
                    TimelineView(.animation(paused: phase != .running)) { context in
                        let elapsed = context.date.timeIntervalSinceReferenceDate
                        let progress = elapsed.truncatingRemainder(dividingBy: Self.loop) / Self.loop
                        Rectangle()
                            .fill(segmentColor)
                            .frame(width: stretched ? width : Self.segmentWidth)
                            .offset(x: stretched ? 0 : progress * (width + Self.segmentWidth) - Self.segmentWidth)
                    }
                }
            }
        }
        .frame(height: 2)
        .clipped()
        .opacity(visible ? 1 : 0)
        .accessibilityHidden(true)
        .onChange(of: phase, initial: true) { _, phase in apply(phase) }
    }

    private var segmentColor: Color {
        failed ? environment.theme.accent2Color : environment.theme.accentColor
    }

    private func apply(_ phase: CalendarSyncPhase) {
        settle?.cancel()
        settle = nil
        switch phase {
        case .idle:
            withAnimation(Self.cross) { visible = false }
        case .running:
            stretched = false
            withAnimation(Self.cross) {
                failed = false
                visible = true
            }
        case .done:
            guard visible else { return }
            withAnimation(.smooth(duration: 0.18)) { stretched = true }
            settle = Task {
                try? await Task.sleep(for: .milliseconds(180))
                guard !Task.isCancelled else { return }
                withAnimation(.easeOut(duration: 0.22)) { visible = false }
                try? await Task.sleep(for: .milliseconds(220))
                guard !Task.isCancelled else { return }
                stretched = false
            }
        case .failed:
            withAnimation(Self.cross) {
                failed = true
                visible = true
            }
            settle = Task {
                try? await Task.sleep(for: .milliseconds(400))
                guard !Task.isCancelled else { return }
                withAnimation(Self.cross) { visible = false }
            }
        }
    }
}
