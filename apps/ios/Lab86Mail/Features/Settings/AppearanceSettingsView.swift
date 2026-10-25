import SwiftUI

// Native counterpart of the desktop ThemePanel: appearance mode, the palette
// wheel with its brilliance, the display type voice, fine-tune sliders over
// the same OKLCH seeds, and the surface controls. Client-side state, like the
// web.
struct AppearanceSettingsView: View {
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        @Bindable var theme = environment.theme
        Form {
            Section("Appearance") {
                Picker("Appearance", selection: $theme.appearance) {
                    ForEach(AppearanceChoice.allCases) { choice in
                        Text(choice.title).tag(choice)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }

            Section {
                PaletteWheelControl(
                    stopIndex: theme.wheelStop,
                    brilliance: theme.brilliance,
                    onScrub: { index, brilliance in
                        environment.theme.applyWheel(stop: index, brilliance: brilliance)
                    }
                )
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                brillianceSlider
            } header: {
                Text("Palette")
            } footer: {
                Text("Turn the wheel to change the whole palette. Brilliance moves it from near-grey to vivid.")
            }

            Section("Display type") {
                Picker("Display type", selection: $theme.displayType) {
                    ForEach(DisplayTypeChoice.allCases) { choice in
                        Text(choice.title).tag(choice)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                Text("Albatross")
                    .font(theme.displayType.displayFont(size: 23))
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 2)
                    .accessibilityHidden(true)
            }

            Section {
                // Folded by default: the wheel is the control; these edit one
                // color at a time on top of what the wheel wrote.
                DisclosureGroup("Fine-tune each color") {
                    AccentSliders(title: "Accent", hue: $theme.accentHue, chroma: $theme.accentChroma, color: theme.accentColor)
                    AccentSliders(title: "Second accent", hue: $theme.accent2Hue, chroma: $theme.accent2Chroma, color: theme.accent2Color)
                    AccentSliders(title: "Third accent", hue: $theme.accent3Hue, chroma: $theme.accent3Chroma, color: theme.accent3Color)
                }
            } footer: {
                Text("Hue turns one color on the wheel. Intensity moves it from near-grey to saturated.")
            }

            Section {
                LabeledContent("Paper tint") {
                    Slider(value: $theme.surfaceTint, in: 0...PaletteWheel.maxSurfaceTint)
                }
                depthSlider
                LabeledContent("Paper grain") {
                    Slider(value: $theme.grain, in: 0...1)
                }
            } header: {
                Text("Surfaces")
            } footer: {
                Text("Depth sets the distance between the page, its wells, and its sheets. Grain turns off with Reduce Transparency.")
            }
        }
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var brillianceSlider: some View {
        @Bindable var theme = environment.theme
        return LabeledContent {
            HStack(spacing: 10) {
                Slider(
                    value: Binding(
                        get: { theme.brilliance },
                        set: { theme.applyWheel(stop: theme.wheelStop, brilliance: $0) }
                    ),
                    in: PaletteWheel.minBrilliance...PaletteWheel.maxBrilliance,
                    step: 0.05
                )
                Text("\(Int((theme.brilliance * 100).rounded()))%")
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 40, alignment: .trailing)
            }
        } label: {
            Text("Brilliance")
        }
    }

    private var depthSlider: some View {
        @Bindable var theme = environment.theme
        return LabeledContent {
            HStack(spacing: 10) {
                Slider(value: $theme.depthSpread, in: PaletteWheel.minDepth...PaletteWheel.maxDepth, step: 0.05)
                Text(PaletteWheel.depthLabel(theme.depthSpread))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 64, alignment: .trailing)
            }
        } label: {
            Text("Depth")
        }
    }
}

/// Hue and intensity for one accent voice.
private struct AccentSliders: View {
    let title: String
    @Binding var hue: Double
    @Binding var chroma: Double
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title)
                Spacer()
                Circle().fill(color).frame(width: 18, height: 18)
            }
            LabeledContent {
                Slider(value: $hue, in: 0...359, step: 1)
            } label: {
                Text("Hue").font(.footnote).foregroundStyle(.secondary).frame(width: 60, alignment: .leading)
            }
            LabeledContent {
                Slider(value: $chroma, in: PaletteWheel.minChroma...PaletteWheel.maxChroma)
            } label: {
                Text("Intensity").font(.footnote).foregroundStyle(.secondary).frame(width: 60, alignment: .leading)
            }
        }
        .padding(.vertical, 2)
    }
}

/// The geometry of the wheel: where each stop sits and which stop a touch
/// point means. Pure, so PaletteWheelTests can hold it.
enum PaletteWheelGeometry {
    static let size: CGFloat = 196
    static let ringRadius: CGFloat = 80
    static let dotSize: CGFloat = 18
    /// One dot spacing of radial pull changes brilliance by about 0.45.
    static let brilliancePerPoint = 0.011
    /// The paper disc in the middle: the sample, not a control.
    static let innerRadius: CGFloat = ringRadius - dotSize - 5

    /// Whether a touch at this distance from the center starts a scrub. A
    /// touch on the paper disc does not; a touch on or near the ring does.
    static func startsScrub(radius: Double) -> Bool {
        radius >= Double(innerRadius)
    }

    /// The center of stop `index`, with stop 0 at twelve o'clock.
    static func position(of index: Int, in size: CGFloat = size, radius: CGFloat = ringRadius) -> CGPoint {
        let angle = (Double(index) * PaletteWheel.stepDegrees - 90) * .pi / 180
        return CGPoint(
            x: size / 2 + CGFloat(cos(angle)) * radius,
            y: size / 2 + CGFloat(sin(angle)) * radius
        )
    }

    /// The stop nearest to a touch point, and the touch's distance from the
    /// center.
    static func read(point: CGPoint, in size: CGFloat = size) -> (index: Int, radius: Double) {
        let dx = Double(point.x - size / 2)
        let dy = Double(point.y - size / 2)
        var degrees = atan2(dy, dx) * 180 / .pi + 90
        degrees = (degrees.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
        let index = Int((degrees / PaletteWheel.stepDegrees).rounded()) % PaletteWheel.stopCount
        return (index, (dx * dx + dy * dy).squareRoot())
    }

    /// Brilliance after a radial pull from where the drag began.
    static func brilliance(start: Double, startRadius: Double, radius: Double) -> Double {
        PaletteWheel.clampBrilliance(start + (radius - startRadius) * brilliancePerPoint)
    }
}

/// The palette wheel: twenty chord swatches around a paper disc. A tap or a
/// turn picks a stop; a pull in or out changes brilliance. VoiceOver adjusts
/// it as one control.
struct PaletteWheelControl: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let stopIndex: Int
    let brilliance: Double
    let onScrub: (Int, Double) -> Void

    @State private var dragStart: (radius: Double, brilliance: Double)?
    // True for a drag that began on the paper disc: it never scrubs.
    @State private var ignoresDrag = false

    private var current: PaletteWheel.Stop { PaletteWheel.stop(stopIndex, brilliance: brilliance) }

    var body: some View {
        ZStack {
            paperDisc
            ForEach(0..<PaletteWheel.stopCount, id: \.self) { index in
                PaletteStopDot(stop: PaletteWheel.stop(index, brilliance: brilliance), selected: index == stopIndex)
                    .position(PaletteWheelGeometry.position(of: index))
            }
        }
        .frame(width: PaletteWheelGeometry.size, height: PaletteWheelGeometry.size)
        .contentShape(.rect)
        .gesture(drag)
        .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: stopIndex)
        .sensoryFeedback(.selection, trigger: stopIndex)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Palette wheel")
        .accessibilityValue("Palette \(stopIndex + 1) of \(PaletteWheel.stopCount)")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: onScrub((stopIndex + 1) % PaletteWheel.stopCount, brilliance)
            case .decrement: onScrub((stopIndex + PaletteWheel.stopCount - 1) % PaletteWheel.stopCount, brilliance)
            @unknown default: break
            }
        }
    }

    private var paperDisc: some View {
        let stop = current
        let paper = Color(ThemeStore.oklch(l: 0.96, c: 0.008 + stop.surfaceTint * 0.03, h: stop.paperHue))
        let ink = Color(ThemeStore.oklch(l: 0.45, c: stop.chroma, h: stop.hue))
        return Circle()
            .fill(paper)
            .overlay(Circle().strokeBorder(Color.primary.opacity(0.08), lineWidth: 1))
            .overlay(
                // The ink of the stop on its paper, in the user's display face.
                Text("Aa")
                    .font(environment.theme.displayType.displayFont(size: 26))
                    .foregroundStyle(ink)
            )
            .frame(width: PaletteWheelGeometry.innerRadius * 2)
            .accessibilityHidden(true)
    }

    private var drag: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                let read = PaletteWheelGeometry.read(point: value.location)
                if ignoresDrag { return }
                if dragStart == nil {
                    guard PaletteWheelGeometry.startsScrub(radius: read.radius) else {
                        ignoresDrag = true
                        return
                    }
                    dragStart = (read.radius, brilliance)
                    onScrub(read.index, brilliance)
                    return
                }
                guard let start = dragStart else { return }
                let moved = PaletteWheelGeometry.brilliance(start: start.brilliance, startRadius: start.radius, radius: read.radius)
                onScrub(read.index, moved)
            }
            .onEnded { _ in
                dragStart = nil
                ignoresDrag = false
            }
    }
}

/// One stop: the three voices of its chord in one swatch.
private struct PaletteStopDot: View {
    let stop: PaletteWheel.Stop
    let selected: Bool

    var body: some View {
        Circle()
            .fill(gradient)
            .frame(width: PaletteWheelGeometry.dotSize, height: PaletteWheelGeometry.dotSize)
            .overlay(Circle().strokeBorder(Color.primary.opacity(selected ? 0.9 : 0.1), lineWidth: selected ? 2 : 1))
            .scaleEffect(selected ? 1.3 : 1)
            .accessibilityHidden(true)
    }

    private var gradient: AngularGradient {
        let a1 = Color(ThemeStore.oklch(l: 0.62, c: stop.chroma, h: stop.hue))
        let a2 = Color(ThemeStore.oklch(l: 0.62, c: stop.chroma2, h: stop.hue2))
        let a3 = Color(ThemeStore.oklch(l: 0.62, c: stop.chroma3, h: stop.hue3))
        return AngularGradient(
            stops: [
                .init(color: a1, location: 0), .init(color: a1, location: 0.5),
                .init(color: a2, location: 0.5), .init(color: a2, location: 0.75),
                .init(color: a3, location: 0.75), .init(color: a3, location: 1),
            ],
            center: .center,
            angle: .degrees(-90)
        )
    }
}
