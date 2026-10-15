import SwiftUI

// One saved file on a draft (docs/albatross-goal-runs.md, G3): the name,
// then the format, the size, and "From Albatross", or the sealed line ("The
// tax ID fills in when you send."). Remove takes it off the draft. With no
// remove handler the row is read-only (the draft item of document mode).
// No icon before the text. iOS and macOS share this file.

struct DraftAttachmentRow: View {
    let attachment: DraftAttachment
    var onRemove: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text(attachment.name)
                    .font(.subheadline)
                    .lineLimit(1)
                Text(attachment.composerLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            if let onRemove {
                Button("Remove", systemImage: "xmark.circle.fill", action: onRemove)
                    .labelStyle(.iconOnly)
                    .foregroundStyle(.tertiary)
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove \(attachment.name)")
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
        .accessibilityElement(children: .contain)
    }
}
