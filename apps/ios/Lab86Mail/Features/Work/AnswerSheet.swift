import SwiftUI

// "Answer" from a list row (docs/albatross-threads.md, T10): the pending
// form of the Work in a sheet, with the PR 1 form card. The answer resumes
// the run on the server; the row changes on the next read. An allow or an
// identity check is not a form: those rows open the thread instead.
struct AnswerSheet: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    let row: ThreadListRow
    /// The answer went: the list reads again.
    let onAnswered: () -> Void
    /// "Open" and "Open the Albatross".
    let onOpen: () -> Void

    @State private var store: WorkThreadStore
    @State private var state = WorkThreadModel.QuestionState()

    init(row: ThreadListRow, onAnswered: @escaping () -> Void, onOpen: @escaping () -> Void) {
        self.row = row
        self.onAnswered = onAnswered
        self.onOpen = onOpen
        _store = State(initialValue: WorkThreadStore(workID: row.id))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                content
                    .padding(20)
            }
            .background(environment.theme.paperColor)
            .navigationTitle(row.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(AnswerSheetCopy.open) {
                        dismiss()
                        onOpen()
                    }
                }
            }
            .task { await store.load(environment.backend) }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
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
            .padding(.vertical, 40)
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
        } else if let error = store.loadError {
            VStack(alignment: .leading, spacing: 10) {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
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
                Button(AnswerSheetCopy.openAlbatross) {
                    dismiss()
                    onOpen()
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private func submit(_ question: ThreadQuestion, answer: FormAnswer) async {
        state = WorkThreadModel.QuestionState(isSending: true)
        let outcome = await store.answer(question: question, form: answer, transport: environment.backend)
        switch outcome {
        case .sent:
            state = WorkThreadModel.QuestionState()
            onAnswered()
            dismiss()
        case .fieldErrors(let errors):
            state = WorkThreadModel.QuestionState(isSending: false, fieldErrors: errors, error: nil)
        case .failed(let message):
            state = WorkThreadModel.QuestionState(isSending: false, fieldErrors: [:], error: message)
        }
    }
}

enum AnswerSheetCopy {
    static let open = "Open"
    static let loading = "Loading the question…"
    static let needsYourAnswer = "Needs your answer"
    static let answeredElsewhere = "This question was answered on another device, or it was dismissed."
    static let openAlbatross = "Open the Albatross"
    static let tryAgain = "Try again"
}
