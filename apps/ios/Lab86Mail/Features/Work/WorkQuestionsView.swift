import SwiftUI

// The open questions of a Work that no run owns: the plan asked them
// (docs/albatross-document-handoff.md). The header counts every pending
// question, so the thread shows these above the composer, or "Needs your
// answer" points at nothing. The web rule is `openWorkQuestions` and the card
// is components/albatross/thread/WorkQuestions.tsx.
enum WorkQuestions {
    static let label = "Albatross asks"

    /// Pending questions of the Work whose id no run's question has.
    static func open(_ questions: [WorkDetail.Question], runs: [ThreadRunView]) -> [ThreadQuestion] {
        let owned = Set(runs.compactMap { $0.question?.id })
        return questions
            .filter { $0.status == "pending" && !owned.contains($0.id) }
            .map(ThreadQuestion.init(legacy:))
    }
}

/// "Albatross asks" and the form of each open Work question. One button, as
/// for a run's question; a message in the chat can answer too.
struct WorkQuestionsView: View {
    let model: WorkThreadModel

    var body: some View {
        let questions = model.openWorkQuestions
        if !questions.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                ForEach(questions) { question in
                    WorkQuestionCard(question: question, model: model)
                }
            }
        }
    }
}

private struct WorkQuestionCard: View {
    let question: ThreadQuestion
    let model: WorkThreadModel

    var body: some View {
        let state = model.questionState(forQuestionID: question.id)
        VStack(alignment: .leading, spacing: 6) {
            Text(WorkQuestions.label)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            FormQuestionCard(
                form: question.resolvedForm,
                allowsSkip: false,
                fieldErrors: state.fieldErrors,
                sendError: state.error,
                isSending: state.isSending,
                onSubmit: { answer, _ in Task { await model.answer(question, form: answer) } }
            )
        }
    }
}
