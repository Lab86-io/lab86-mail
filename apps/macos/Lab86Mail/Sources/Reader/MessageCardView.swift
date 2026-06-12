import SwiftUI
import UniformTypeIdentifiers

struct MessageCardView: View {
    @Environment(MailStore.self) private var store
    @Environment(ThemeManager.self) private var theme
    let message: MailMessage
    @State private var bodyHeight: CGFloat = 120
    @State private var saveError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(12)
            Divider()
            if let html = message.htmlBody, !html.isEmpty {
                EmailBodyWebView(html: html, height: $bodyHeight)
                    .frame(height: bodyHeight)
            } else {
                Text(message.textBody.isEmpty ? message.snippet : message.textBody)
                    .font(.callout)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            if !message.attachments.filter({ !$0.isInline }).isEmpty {
                Divider()
                attachmentsRow
                    .padding(10)
            }
        }
        .background(.background.secondary, in: .rect(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(.separator, lineWidth: 0.5)
        )
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 10) {
            ZStack {
                Circle().fill(theme.accentSoft)
                Text(EmailAddress.initials(from: message.from))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(theme.accent)
            }
            .frame(width: 34, height: 34)

            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(message.fromDisplay)
                        .font(.callout.weight(.semibold))
                    Text(message.fromEmail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button {
                        store.toggleStar(message: message)
                    } label: {
                        Image(systemName: message.starred ? "star.fill" : "star")
                            .foregroundStyle(message.starred ? .yellow : .secondary)
                    }
                    .buttonStyle(.borderless)
                    Text(message.receivedAt, format: .dateTime.month().day().hour().minute())
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text("to \(message.to)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    private var attachmentsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(message.attachments.filter { !$0.isInline }) { attachment in
                    Button {
                        save(attachment)
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "paperclip")
                            VStack(alignment: .leading, spacing: 0) {
                                Text(attachment.filename)
                                    .font(.caption)
                                    .lineLimit(1)
                                if let size = attachment.size {
                                    Text(ByteCountFormatter.string(
                                        fromByteCount: Int64(size), countStyle: .file))
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Image(systemName: "arrow.down.circle")
                                .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(.quaternary, in: .capsule)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func save(_ attachment: MailAttachment) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = attachment.filename
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            do {
                let data = try await store.api.downloadAttachment(message: message, attachment: attachment)
                try data.write(to: url)
            } catch {
                store.lastError = "Download failed: \(error.localizedDescription)"
            }
        }
    }
}
