import SwiftUI

// "Answer" on a row of the Mac source list (docs/albatross-threads.md, T10;
// lead decision 7): the pending form of the Work in a popover beside the
// row, with the PR 1 form card. The answer resumes the run on the server;
// the row changes on the next read. An allow or an identity check is not a
// form: the popover says so and offers the thread. The same reads and words
// as the iOS AnswerSheet.
struct MacAnswerPopover: View {
    @Environment(AppEnvironment.self) private var environment
    let row: ThreadListRow
    /// The answer went: the caller closes the popover and reads the list again.
    let onAnswered: () -> Void
    /// "Open" and "Open the Albatross".
    let onOpen: () -> Void

    @State private var store: WorkThreadStore
    @State private var state = WorkThreadModel.QuestionState()

    static let width: CGFloat = 380

    init(row: ThreadListRow, onAnswered: @escaping () -> Void, onOpen: @escaping () -> Void) {
        self.row = row
        self.onAnswered = onAnswered
        self.onOpen = onOpen
        _store = State(initialValue: WorkThreadStore(workID: row.id))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(row.title)
                    .font(.headline)
                    .lineLimit(2)
                Spacer(minLength: 8)
                Button(AnswerSheetCopy.open, action: onOpen)
                    .buttonStyle(.borderless)
                    .font(.subheadline)
            }
            content
        }
        .padding(20)
        .frame(width: Self.width)
        .task { await store.load(environment.backend) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(AnswerSheetCopy.needsYourAnswer): \(row.title)")
    }

    @ViewBuilder private var content: some View {
        if !store.loaded {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(AnswerSheetCopy.loading)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
        } else if let question = store.pendingQuestion {
            VStack(alignment: .leading, spacing: 12) {
                Text(AnswerSheetCopy.needsYourAnswer)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(environment.theme.accentColor)
                FormQuestionCard(
                    form: question.resolvedForm,
                    receipt: nil,
                    allowsSkip: false,
                    fieldErrors: state.fieldErrors,
                    sendError: state.error,
                    isSending: state.isSending,
                    onSubmit: { answer, _ in Task { await submit(question, answer: answer) } }
                )
            }
        } else if waitsOnAllow {
            VStack(alignment: .leading, spacing: 10) {
                Text(MacAnswerPopoverCopy.allowInThread)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button(AnswerSheetCopy.openAlbatross, action: onOpen)
                    .buttonStyle(.bordered)
            }
        } else if let error = store.loadError {
            VStack(alignment: .leading, spacing: 10) {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button(AnswerSheetCopy.tryAgain) {
                    Task { await store.load(environment.backend) }
                }
                .buttonStyle(.bordered)
            }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                Text(AnswerSheetCopy.answeredElsewhere)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button(AnswerSheetCopy.openAlbatross, action: onOpen)
                    .buttonStyle(.bordered)
            }
        }
    }

    /// The newest run waits on an allow, not a form: the identity check
    /// lives in the thread.
    private var waitsOnAllow: Bool {
        guard let newest = store.newestRun, newest.run.isHandoff else { return false }
        return newest.run.next?.kind == .allowSecure
    }

    private func submit(_ question: ThreadQuestion, answer: FormAnswer) async {
        state = WorkThreadModel.QuestionState(isSending: true)
        let outcome = await store.answer(question: question, form: answer, transport: environment.backend)
        switch outcome {
        case .sent:
            state = WorkThreadModel.QuestionState()
            onAnswered()
        case .fieldErrors(let errors):
            state = WorkThreadModel.QuestionState(isSending: false, fieldErrors: errors, error: nil)
        case .failed(let message):
            state = WorkThreadModel.QuestionState(isSending: false, fieldErrors: [:], error: message)
        }
    }
}

enum MacAnswerPopoverCopy {
    static let allowInThread = "Open the thread to allow this."
}
