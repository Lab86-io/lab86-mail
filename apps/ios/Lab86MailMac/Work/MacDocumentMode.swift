import SwiftUI

// Document mode of the Albatross thread on the Mac
// (docs/albatross-document-handoff.md, D5, and
// docs/research/document-handoff-macos-design-2026-10-08.md). The web editor
// opens in the native workspace, docked in the center of the detail column.
// The thread moves to a column on the right, with the "your part" card on
// top. The card shows the blank sentence ("Fill in ___ and ___.") or the
// handoff's words (docs/albatross-blank-design.md). The pure rules are here
// and tested; the views stay thin.

/// The words of document mode that only the Mac uses.
enum MacDocumentModeCopy {
    /// The header title when no run names the document.
    static let document = "Document"
    /// The VoiceOver name of the card. The card shows no label above it.
    static let yourPart = "Your part"
}

/// What the "your part" card shows: the fields to fill in, else the
/// handoff's words.
struct MacDocumentYourPart: Equatable {
    let blanks: [String]
    let detail: String?
}

enum MacDocumentMode {
    /// The header title: the newest run artifact that names the document,
    /// else "Document".
    static func title(runs: [ThreadRunView], target: DocumentTarget) -> String {
        for view in runs.reversed() {
            let named = view.run.artifacts.first { artifact in
                artifact.kind == .document && DocumentTarget.of(url: artifact.url, id: artifact.referenceID)?.id == target.id
            }
            if let title = named?.title.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank { return title }
        }
        return MacDocumentModeCopy.document
    }

    /// The content of the "your part" card for the handoff of the open
    /// document. Nil (no card) when there is no handoff, or when the handoff
    /// names no blank and has no words.
    static func yourPart(of run: ThreadRunView?) -> MacDocumentYourPart? {
        guard let next = run?.run.next else { return nil }
        let blanks = next.blanks
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let detail = next.detail?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
        guard !blanks.isEmpty || detail != nil else { return nil }
        return MacDocumentYourPart(blanks: blanks, detail: detail)
    }

    /// The step line of the "your part" card: "Step 2: Make the hours
    /// summary", or the title alone when the plan has no position for it.
    /// The web rule is the `stepLabel` of `YourPartCard` in WorkThread.tsx.
    /// No middle dot joins the parts (docs/albatross-blank-design.md).
    static func stepLabel(detail: WorkDetail?, run: ThreadRunView?) -> String? {
        guard let run else { return nil }
        let title = run.run.stepTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let index = detail?.execution.guideSteps.firstIndex(where: { $0.id == run.run.stepKey }) else {
            return title.nilIfBlank
        }
        return title.isEmpty ? "Step \(index + 1)" : "Step \(index + 1): \(title)"
    }
}

/// The docked split: the document in the center, the thread column on the
/// right. The divider drags, within the column's band.
struct MacDocumentSplit<Column: View>: View {
    @Environment(AppEnvironment.self) private var environment
    let target: DocumentTarget
    let title: String
    let reloadToken: Int
    /// The column's width for this window (`MacThreadLayout.documentColumnWidth`).
    let columnWidth: CGFloat
    let onClose: () -> Void
    @ViewBuilder let column: () -> Column

    var body: some View {
        HSplitView {
            document
                .frame(minWidth: MacThreadLayout.documentMinWidth, maxWidth: .infinity, maxHeight: .infinity)
            column()
                .frame(
                    minWidth: MacThreadLayout.documentColumnMinWidth,
                    idealWidth: columnWidth,
                    maxWidth: MacThreadLayout.documentColumnMaxWidth,
                    maxHeight: .infinity
                )
        }
        .background(environment.theme.paperColor)
        .accessibilityElement(children: .contain)
    }

    /// The web editor, docked. A new document is a new browser; a change of
    /// the token loads the saved document again.
    private var document: some View {
        NativeWorkspaceView(
            destination: target.workspaceDestination,
            reloadToken: reloadToken,
            dock: NativeWorkspaceDock(title: title, onClose: onClose)
        )
        .id(target)
    }
}

/// The card on top of the thread column: the step, the blank sentence (or
/// the handoff's words alone), "Done, continue", and the quiet "Back to
/// thread".
/// No label shows above the card (docs/albatross-blank-design.md).
struct MacDocumentYourPartCard: View {
    let stepLabel: String?
    let yourPart: MacDocumentYourPart
    var busy = false
    var notice: String? = nil
    let onDone: () -> Void
    let onBack: () -> Void

    /// The point size of the blank sentence. The handoff's words alone
    /// show a little smaller, as on the web card.
    static let sentenceSize: CGFloat = 19
    static let fallbackSize: CGFloat = 17

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let stepLabel {
                Text(stepLabel)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            BlankSentence(
                blanks: yourPart.blanks,
                fallback: yourPart.detail,
                size: yourPart.blanks.isEmpty ? Self.fallbackSize : Self.sentenceSize
            )
            .frame(maxWidth: .infinity, alignment: .leading)
            // With blanks, the handoff's words stay as a quiet line under
            // the sentence: what happens after the fields are full.
            if !yourPart.blanks.isEmpty, let detail = yourPart.detail {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            buttons
            if let notice {
                Text(notice)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(MacDocumentModeCopy.yourPart)
    }

    private var buttons: some View {
        HStack(spacing: 10) {
            Button(busy ? DocumentHandoffCopy.saving : DocumentHandoffCopy.done, action: onDone)
                .buttonStyle(.borderedProminent)
                .disabled(busy)
            Button(DocumentHandoffCopy.backToThread, action: onBack)
                .buttonStyle(.borderless)
                .disabled(busy)
        }
    }
}
