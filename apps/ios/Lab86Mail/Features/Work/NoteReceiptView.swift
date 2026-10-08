import SwiftUI

// The receipt under a note the user sent to a run (docs/albatross-threads.md,
// T7 and T9): "Sent to the run", "Read by Albatross · 10:40", "Not read: the
// run ended first" with "Send again". The rule is pure; the view is one line.

/// What a sent note's receipt says.
enum NoteReceipt: Equatable, Sendable {
    /// The run has not read it yet, or a later run of the step carries it.
    case sent
    case read(Date?)
    /// The run ended first, and no run continues.
    case notRead
    /// This device could not post it.
    case notSent
    /// A note that restarted a stopped run.
    case redirectSent

    var offersSendAgain: Bool {
        self == .notRead || self == .notSent
    }
}

enum NoteReceiptPresentation {
    static let logPrefix = "Read your note"

    /// The receipt of one note. Runs are oldest first; the newest run that
    /// carries the note wins, because an unread note carries to the next
    /// run of the step under the same id.
    static func receipt(
        noteID: String,
        runID: String,
        redirect: Bool,
        text: String,
        failed: Bool,
        runs: [ThreadRunView]
    ) -> NoteReceipt {
        if failed { return .notSent }
        if redirect {
            // A redirect note is the first instruction of the run that
            // continues the stopped one (`runID`); it read the note when it
            // began work.
            let restarted = runs.first { $0.run.parentRunID == runID && $0.run.startedAt != nil }
            if let startedAt = restarted?.run.startedAt { return .read(startedAt) }
            return .redirectSent
        }
        for view in runs.reversed() {
            guard let note = view.note(id: noteID) else { continue }
            if let readAt = note.readAt { return .read(readAt) }
            if view.run.state.isOpen { return .sent }
            return carried(after: view, runs: runs) ? .sent : .notRead
        }
        // A run that read the note before the server linked it writes the
        // log line; the line is the receipt then.
        let fragment = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(40))
        for view in runs.reversed() {
            if let line = view.run.log.first(where: {
                $0.text.hasPrefix(logPrefix) && (fragment.isEmpty || $0.text.contains(fragment))
            }) {
                return .read(line.at)
            }
        }
        guard let view = runs.first(where: { $0.id == runID }) else { return .sent }
        if view.run.state.isOpen { return .sent }
        return carried(after: view, runs: runs) ? .sent : .notRead
    }

    /// A later run of the same step is open: the note carries to it.
    private static func carried(after view: ThreadRunView, runs: [ThreadRunView]) -> Bool {
        let started = view.run.createdAt ?? .distantPast
        return runs.contains { candidate in
            candidate.id != view.id
                && candidate.run.stepKey == view.run.stepKey
                && candidate.run.state.isOpen
                && (candidate.run.createdAt ?? .distantPast) >= started
        }
    }

    static func line(_ receipt: NoteReceipt, locale: Locale = .current) -> String {
        switch receipt {
        case .sent:
            return "Sent to the run"
        case .read(let at):
            guard let at else { return "Read by Albatross" }
            return "Read by Albatross · " + at.formatted(.dateTime.hour().minute().locale(locale))
        case .notRead:
            return "Not read: the run ended first"
        case .notSent:
            return "Not sent. Check your connection."
        case .redirectSent:
            return "Sent. The run restarts with this note."
        }
    }

    static let sendAgain = "Send again"
}

/// One quiet line under a steer bubble, right-aligned with it.
struct NoteReceiptView: View {
    let receipt: NoteReceipt
    /// "Send again", when the receipt offers it and the host allows it.
    var onSendAgain: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 6) {
            Spacer(minLength: 56)
            Text(NoteReceiptPresentation.line(receipt))
                .font(.caption2)
                .foregroundStyle(.secondary)
            if receipt.offersSendAgain, let onSendAgain {
                Text("·")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                Button(NoteReceiptPresentation.sendAgain, action: onSendAgain)
                    .buttonStyle(.borderless)
                    .font(.caption2.weight(.medium))
            }
        }
        .padding(.trailing, 4)
        .accessibilityElement(children: .contain)
    }
}
