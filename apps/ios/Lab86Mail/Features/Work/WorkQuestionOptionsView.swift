import SwiftUI

/// A Work question's options as buttons (NAT-12). A tap answers through the
/// Work answer endpoint; chat stays available for an answer the options do
/// not cover.
struct WorkQuestionOptionsView: View {
    @Environment(AppEnvironment.self) private var environment
    let question: WorkDetail.Question
    let onAnswered: () async -> Void
    let onAnswerInChat: () -> Void

    @State private var answeringID: String?
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(question.options) { option in
                Button {
                    Task { await answer(option) }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(answeringID == option.id ? "Saving…" : option.label)
                            .font(.subheadline.weight(.medium))
                        if let detail = option.detail {
                            Text(detail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.bordered)
                .disabled(answeringID != nil)
            }
            if failed {
                Text("The answer did not save. Try again.")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            if question.options.isEmpty {
                Button("Answer in chat") { onAnswerInChat() }
                    .buttonStyle(.borderedProminent)
            } else {
                Button("Answer in your own words") { onAnswerInChat() }
                    .buttonStyle(.borderless)
                    .font(.subheadline)
                    .disabled(answeringID != nil)
            }
        }
    }

    private func answer(_ option: WorkDetail.Question.Option) async {
        answeringID = option.id
        failed = false
        let saved = await environment.store.answerWorkQuestion(question, answer: option.label, optionID: option.id)
        answeringID = nil
        if saved {
            await onAnswered()
        } else {
            failed = true
        }
    }
}
