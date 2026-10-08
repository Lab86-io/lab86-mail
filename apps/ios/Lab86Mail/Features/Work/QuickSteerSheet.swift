import SwiftUI

// "Steer" from a list row (docs/albatross-threads.md, T10): one line to the
// run that works, with what the run does now above the field. The redirect
// mode stops the run and starts it again with the note, in one call. The
// Mac mounts `QuickSteerForm` in its own window.
struct QuickSteerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let row: ThreadListRow
    var startsInRedirect = false
    /// Posts the note. The sheet closes on `.sent`.
    let onSend: (String, Bool) async -> ThreadsStore.SteerOutcome
    /// "Open the Albatross" after the run ended.
    let onOpen: () -> Void

    @State private var note = ""
    @State private var redirect = false
    @State private var sending = false
    @State private var error: String?
    @State private var runEnded = false
    @FocusState private var focused: Bool

    private var canSend: Bool {
        !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sending && !runEnded
    }

    var body: some View {
        NavigationStack {
            QuickSteerForm(
                row: row,
                note: $note,
                redirect: $redirect,
                sending: sending,
                error: error,
                runEnded: runEnded,
                focus: $focused,
                onOpen: {
                    dismiss()
                    onOpen()
                }
            )
            .navigationTitle(row.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(sending ? QuickSteerCopy.sendBusy : (redirect ? QuickSteerCopy.sendRedirect : QuickSteerCopy.send)) {
                        Task { await send() }
                    }
                    .disabled(!canSend)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .onAppear { redirect = startsInRedirect }
        .task {
            try? await Task.sleep(for: .milliseconds(60))
            focused = true
        }
    }

    private func send() async {
        guard canSend else { return }
        sending = true
        error = nil
        let outcome = await onSend(note, redirect)
        sending = false
        switch outcome {
        case .sent:
            dismiss()
        case .runEnded:
            runEnded = true
        case .failed(let message):
            error = message.nilIfBlank ?? QuickSteerCopy.sendFailed
        }
    }
}

/// The body of the sheet: the state line, the newest preview, the field,
/// and the redirect switch.
struct QuickSteerForm: View {
    @Environment(AppEnvironment.self) private var environment
    let row: ThreadListRow
    @Binding var note: String
    @Binding var redirect: Bool
    var sending = false
    var error: String?
    var runEnded = false
    var focus: FocusState<Bool>.Binding
    let onOpen: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(QuickSteerCopy.subtitle(row: row, redirect: redirect))
                    .font(.footnote)
                    .foregroundStyle(redirect ? environment.theme.accent2Color : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let preview = row.live?.preview?.nilIfBlank {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        if let at = row.live?.lastActivityAt {
                            Text(at.formatted(date: .omitted, time: .shortened))
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.tertiary)
                        }
                        Text(preview)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(environment.theme.subtleColor, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                TextField(QuickSteerCopy.placeholder, text: $note, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...4)
                    .focused(focus)
                    .padding(12)
                    .background(environment.theme.elevatedColor, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(environment.theme.hairlineColor, lineWidth: 1)
                    )
                    .disabled(sending || runEnded)
                if runEnded {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(QuickSteerCopy.runEnded)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Button(QuickSteerCopy.openAlbatross, action: onOpen)
                            .buttonStyle(.bordered)
                    }
                } else {
                    Button(redirect ? QuickSteerCopy.keepRun : QuickSteerCopy.stopAndRedirect) {
                        redirect.toggle()
                    }
                    .buttonStyle(.borderless)
                    .font(.footnote)
                    .disabled(sending)
                }
                if let error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            .padding(20)
        }
        .background(environment.theme.paperColor)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(QuickSteerCopy.accessibilityLabel(row: row))
    }
}

enum QuickSteerCopy {
    static let placeholder = "Tell Albatross what to change"
    static let send = "Send"
    static let sendBusy = "Sending…"
    static let sendRedirect = "Stop and send"
    static let stopAndRedirect = "Stop and redirect…"
    static let keepRun = "Keep the run"
    static let redirectLine = "The run stops when you send. A new run starts with your note."
    static let runEnded = "The run ended. Open the Albatross to continue."
    static let openAlbatross = "Open the Albatross"
    static let sendFailed = "Could not send. Try again."

    /// "In progress · Pay the bill on the city site", or the redirect line.
    static func subtitle(row: ThreadListRow, redirect: Bool) -> String {
        if redirect { return redirectLine }
        let word = ThreadRowPresentation.word(row) ?? "In progress"
        guard let step = row.live?.stepTitle?.nilIfBlank else { return word }
        return "\(word) · \(step)"
    }

    static func accessibilityLabel(row: ThreadListRow) -> String {
        "Steer \(row.title). \(subtitle(row: row, redirect: false))."
    }
}
