import SwiftUI

// The overflow backlog under the letter (brief round 2026-09-22). These
// conversations met the brief criteria and fell past the edition's highlight
// limit. Collapsed by default: one line with the count. Open, it lists each
// subject with its reason; a tap opens the thread. Copy mirrors the web.
struct BriefMailBacklog: View {
    let items: [BriefOverflowItem]
    let onOpen: (BriefOverflowItem) -> Void

    @State private var expanded = false

    var body: some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation(.snappy(duration: 0.2)) { expanded.toggle() }
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(BriefOverflowItem.summary(count: items.count))
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.primary)
                        Spacer(minLength: 8)
                        Text(expanded ? "Hide" : "Show")
                            .font(.subheadline)
                            .foregroundStyle(.tint)
                    }
                    .padding(.vertical, 12)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(.isButton)
                .accessibilityValue(expanded ? "Expanded" : "Collapsed")

                if expanded {
                    Text(BriefOverflowItem.note)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, 8)
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                        Divider()
                        Button {
                            onOpen(item)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.subject)
                                    .font(.subheadline)
                                    .foregroundStyle(.primary)
                                    .lineLimit(2)
                                if !item.whyItMatters.isEmpty {
                                    Text(item.whyItMatters)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            .padding(.vertical, 10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(
                            [item.subject, item.whyItMatters.isEmpty ? nil : item.whyItMatters]
                                .compactMap { $0 }
                                .joined(separator: ", ")
                        )
                        .accessibilityAddTraits(.isButton)
                        .id(index)
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 4)
            .overlay(alignment: .top) { Divider().padding(.horizontal, 20) }
        }
    }
}
