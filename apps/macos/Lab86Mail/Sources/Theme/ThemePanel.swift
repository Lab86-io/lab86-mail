import SwiftUI

struct ThemePanel: View {
    @Environment(ThemeManager.self) private var theme

    var body: some View {
        @Bindable var theme = theme
        VStack(alignment: .leading, spacing: 16) {
            Text("Appearance")
                .font(.headline)
            Picker("Appearance", selection: $theme.appearance) {
                ForEach(Appearance.allCases) { mode in
                    Text(mode.title).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            Text("Accent")
                .font(.headline)
            HStack(spacing: 10) {
                ForEach(AccentPreset.allCases) { preset in
                    Button {
                        theme.apply(preset)
                    } label: {
                        Circle()
                            .fill(OKLCH.color(l: 0.64, c: preset.chroma, h: preset.hue))
                            .frame(width: 26, height: 26)
                            .overlay {
                                if abs(theme.accentHue - preset.hue) < 1 {
                                    Image(systemName: "checkmark")
                                        .font(.caption.bold())
                                        .foregroundStyle(.white)
                                }
                            }
                    }
                    .buttonStyle(.plain)
                    .help(preset.title)
                }
            }

            LabeledContent("Hue") {
                Slider(value: $theme.accentHue, in: 0...359)
            }
            LabeledContent("Intensity") {
                Slider(value: $theme.accentChroma, in: 0.01...0.16)
            }

            Text("Background")
                .font(.headline)
            LabeledContent("Hue") {
                Slider(value: $theme.backgroundHue, in: 0...359)
            }
            LabeledContent("Tint") {
                Slider(value: $theme.backgroundTint, in: 0...1)
            }
        }
        .padding(20)
        .frame(width: 320)
    }
}
