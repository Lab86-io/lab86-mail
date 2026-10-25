import SwiftUI

/// The desk as drawn: the dateline in display italic, the sentence in the
/// display face, and the rows as plain text with hairlines. Left aligned,
/// 24 pt margins, inside the chat measure.
struct ChatDeskView: View {
    @Environment(AppEnvironment.self) private var environment
    let desk: ChatDesk
    let onAsk: (String) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                heading
                rows
                    .padding(.top, 28)
            }
            .padding(.horizontal, 24)
            .padding(.top, 12)
            .padding(.bottom, 24)
            .frame(maxWidth: ChatLayout.measure, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private var heading: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(desk.dateline)
                .font(environment.theme.displayType.displayItalicFont(size: 17))
                .foregroundStyle(.secondary)
            Text(desk.sentence)
                .font(environment.theme.displayType.displayFont(size: 30))
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private var rows: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(desk.rows) { row in
                Button {
                    onAsk(row.ask)
                } label: {
                    DeskRowLabel(row: row)
                }
                .buttonStyle(.plain)
                .accessibilityHint(ChatDesk.sendHint)
                Divider().overlay(environment.theme.hairlineColor)
            }
        }
    }
}

private struct DeskRowLabel: View {
    let row: ChatDesk.Row

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(row.ask)
                .font(.body)
                .foregroundStyle(.primary)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
            if let source = row.source {
                Text(source)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 12)
        .contentShape(.rect)
    }
}
