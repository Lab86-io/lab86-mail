import SwiftUI

// Native counterpart of the desktop ThemePanel: appearance mode, the six
// curated dual-accent palettes, fine-tune sliders over the same OKLCH seeds,
// and the display type voice. Client-side state, like the web.
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
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 92), spacing: 12)], spacing: 14) {
                    ForEach(PalettePreset.all) { preset in
                        paletteSwatch(preset, selected: theme.selectedPreset == preset)
                    }
                }
                .padding(.vertical, 4)
            } header: {
                Text("Palette")
            } footer: {
                Text("Two-accent pairings shared with the desktop app — a print accent and an editorial second voice.")
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
                accentSliders(
                    title: "Accent",
                    hue: $theme.accentHue,
                    chroma: $theme.accentChroma,
                    color: theme.accentColor
                )
                accentSliders(
                    title: "Second accent",
                    hue: $theme.accent2Hue,
                    chroma: $theme.accent2Chroma,
                    color: theme.accent2Color
                )
            } header: {
                Text("Fine-tune")
            } footer: {
                Text("Hue turns the color wheel; intensity moves from near-neutral to saturated.")
            }

            Section {
                LabeledContent("Background wash") {
                    Slider(value: $theme.backgroundWash, in: 0...1)
                }
                LabeledContent("Navigation wash") {
                    Slider(value: $theme.railWash, in: 0...1)
                }
                LabeledContent("Paper grain") {
                    Slider(value: $theme.grain, in: 0...1)
                }
            } header: {
                Text("Surfaces")
            } footer: {
                Text("Grain automatically disappears when Reduce Transparency is enabled.")
            }
        }
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func paletteSwatch(_ preset: PalettePreset, selected: Bool) -> some View {
        let accent = Color(ThemeStore.oklch(l: 0.45, c: preset.chroma, h: preset.hue))
        let accent2 = Color(ThemeStore.oklch(l: 0.45, c: preset.chroma2, h: preset.hue2))
        return Button {
            environment.theme.apply(preset)
        } label: {
            VStack(spacing: 6) {
                ZStack {
                    Circle()
                        .fill(accent)
                        .frame(width: 34, height: 34)
                        .offset(x: -7)
                    Circle()
                        .fill(accent2)
                        .frame(width: 34, height: 34)
                        .offset(x: 7)
                }
                .frame(width: 58, height: 38)
                .overlay(alignment: .bottomTrailing) {
                    if selected {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 15))
                            .foregroundStyle(accent)
                            .background(Circle().fill(Color(uiColor: .systemBackground)))
                    }
                }
                Text(preset.name)
                    .font(.caption)
                    .foregroundStyle(selected ? .primary : .secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(selected ? Color.primary.opacity(0.06) : .clear)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(preset.name)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    @ViewBuilder private func accentSliders(
        title: String,
        hue: Binding<Double>,
        chroma: Binding<Double>,
        color: Color
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title)
                Spacer()
                Circle().fill(color).frame(width: 18, height: 18)
            }
            LabeledContent {
                Slider(value: hue, in: 0...359, step: 1)
            } label: {
                Text("Hue").font(.footnote).foregroundStyle(.secondary).frame(width: 60, alignment: .leading)
            }
            LabeledContent {
                Slider(value: chroma, in: 0.01...0.16)
            } label: {
                Text("Intensity").font(.footnote).foregroundStyle(.secondary).frame(width: 60, alignment: .leading)
            }
        }
        .padding(.vertical, 2)
    }
}
