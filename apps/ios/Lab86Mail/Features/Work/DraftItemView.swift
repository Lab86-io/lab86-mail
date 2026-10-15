import SwiftUI

// The draft item of document mode (docs/albatross-goal-runs.md, G7): the
// recipients, the subject, the body, and the files that go with it, read
// only. "Edit and send" opens the composer, where the files are removable
// rows. iOS and macOS share this file.

enum DraftItemCopy {
    static let editAndSend = "Edit and send"
    static let noSubject = "No subject"
    static let unavailable = "Albatross could not open the draft. It was sent or deleted."
}

struct DraftItemView: View {
    @Environment(AppEnvironment.self) private var environment
    let draftID: String
    let accountID: String?
    let item: DocumentModeItem
    var onEdit: () -> Void = {}

    @State private var prefill: ComposePrefill?
    @State private var failed = false

    /// The reading measure of the draft.
    static let measure: CGFloat = 720

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let prefill {
                    draft(prefill)
                } else if failed {
                    Text(DraftItemCopy.unavailable)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    ProgressView()
                }
            }
            .padding(20)
            .frame(maxWidth: Self.measure, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(environment.theme.paperColor)
        .task(id: draftID) {
            prefill = await environment.store.loadDraftPrefill(draftID: draftID, accountID: accountID)
            failed = prefill == nil
        }
    }

    @ViewBuilder private func draft(_ prefill: ComposePrefill) -> some View {
        field("To", prefill.recipient)
        if !prefill.cc.isEmpty { field("Cc", prefill.cc) }
        Text(prefill.subject.nilIfBlank ?? DraftItemCopy.noSubject)
            .font(.title3.weight(.semibold))
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
        Text(prefill.body)
            .font(.body)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
        if !prefill.fileAttachments.isEmpty {
            VStack(spacing: 0) {
                Divider()
                ForEach(prefill.fileAttachments) { attachment in
                    DraftAttachmentRow(attachment: attachment)
                    Divider()
                }
            }
            .padding(.horizontal, -20)
        }
        Button(DraftItemCopy.editAndSend, action: onEdit)
            .buttonStyle(.borderedProminent)
            .padding(.top, 6)
    }

    private func field(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(width: 38, alignment: .leading)
            Text(value.nilIfBlank ?? "")
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
    }
}
