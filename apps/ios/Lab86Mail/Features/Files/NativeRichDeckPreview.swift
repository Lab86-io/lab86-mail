import SwiftUI

/// Read-only view of a version 2 presentation. The full canvas, theme and
/// export live in the web editor; the deck is preserved unchanged here.
struct NativeRichDeckPreview: View {
    let snapshot: AlbatrossRichDeckSnapshot
    let webEditorURL: URL?
    @State private var selectedSlideID: String?

    private var slide: AlbatrossRichDeckSnapshot.Slide {
        snapshot.slides.first { $0.id == (selectedSlideID ?? snapshot.activeSlideID) }
            ?? snapshot.slides[0]
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Label("Presentation preview", systemImage: "rectangle.on.rectangle.angled")
                    .font(.headline)
                Text("Slide text and notes are shown here. Use the full editor for the designed layout, images, charts and export. Your presentation is preserved unchanged.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let webEditorURL {
                    Link("Open full editor", destination: webEditorURL)
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("files.deck.openWeb")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
            Picker("Slide", selection: Binding(
                get: { slide.id },
                set: { selectedSlideID = $0 }
            )) {
                ForEach(Array(snapshot.slides.enumerated()), id: \.element.id) { index, item in
                    Text("\(index + 1) · \(item.title)").tag(item.id)
                }
            }
            .pickerStyle(.menu)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal)
            .accessibilityIdentifier("files.deck.slide")
            List {
                Section(slide.title) {
                    ForEach(Array(slide.lines.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(.body)
                            .textSelection(.enabled)
                    }
                    if slide.lines.isEmpty {
                        Text("This slide has \(slide.elementCount) visual elements and no text.")
                            .foregroundStyle(.secondary)
                    }
                }
                if !slide.notes.isEmpty {
                    Section("Speaker notes") {
                        Text(slide.notes)
                            .font(.callout)
                            .textSelection(.enabled)
                    }
                }
            }
            .accessibilityIdentifier("files.deck.preview")
        }
    }
}
