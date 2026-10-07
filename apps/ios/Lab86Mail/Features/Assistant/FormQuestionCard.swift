import SwiftUI

// The form card (docs/albatross-thread.md, "Questions are forms"): one card for
// the chat's `ask_form` and the runner's `needs_answer`. The recommended
// option is selected first. Bound fields prefill from the personal details
// with a quiet source line. "Save to my details" shows only when a bound
// value is new or differs from the saved one. A chat form may be skipped; a
// runner question may not (the run block keeps its "Dismiss").

struct FormQuestionCard: View {
    /// How the form ended.
    enum Receipt: Equatable, Sendable {
        case answered(FormAnswer)
        /// Answered through the form on another device: only the answer line
        /// is known.
        case answeredText(String?)
        case answeredInChat(String?)
        case dismissed
        case skipped
    }

    @Environment(AppEnvironment.self) private var environment
    let form: FormQuestion
    var receipt: Receipt? = nil
    var allowsSkip = false
    /// Messages the server returned for fields, by field id.
    var fieldErrors: [String: String] = [:]
    var sendError: String? = nil
    var isSending = false
    /// The answer and the labels of the details it saves.
    let onSubmit: (FormAnswer, [String]) -> Void
    var onSkip: (() -> Void)? = nil

    @State private var draft: FormDraft?
    @State private var userEdited = false
    @FocusState private var focusedField: String?

    static let saveToggle = "Save to my details"
    static let saveFootnote = "Albatross uses saved details in later forms."
    static let skip = "Skip"
    static let sending = "Sending…"
    static let answeredLine = "Answered."
    static let answeredInChatLine = "Answered in the chat."
    static let dismissedLine = "No longer needed."
    static let skippedLine = "Skipped."

    var body: some View {
        QuestionShell(title: form.title) {
            if let receipt {
                receiptBody(receipt)
            } else if let draft {
                formBody(draft)
            } else {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .task(id: form) {
            if draft == nil {
                draft = FormDraft.initial(form: form, details: environment.personalDetails.byKey)
            }
            await environment.personalDetails.load(environment.backend)
            // The details landed after the card: fill the fields the user has
            // not touched yet.
            if !userEdited {
                draft = FormDraft.initial(form: form, details: environment.personalDetails.byKey)
            }
        }
        .onChange(of: focusedField) { previous, _ in
            guard let previous else { return }
            draft?.touched.insert(FormFocus.fieldID(of: previous))
        }
        #if os(iOS)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { focusedField = nil }
            }
        }
        #endif
    }

    // MARK: - The form

    @ViewBuilder private func formBody(_ draft: FormDraft) -> some View {
        if let detail = form.detail {
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        ForEach(form.fields) { field in
            FormFieldView(
                field: field,
                value: valueBinding(field),
                error: fieldErrors[field.id] ?? draft.shownError(for: field),
                source: draft.sources[field.id]?.line,
                focus: $focusedField,
                disabled: isSending
            )
        }
        if draft.showsSaveToggle(form) {
            VStack(alignment: .leading, spacing: 4) {
                Toggle(Self.saveToggle, isOn: Binding(
                    get: { self.draft?.save ?? true },
                    // A choice here is an edit: a late details reload must not reset it.
                    set: {
                        self.draft?.save = $0
                        self.userEdited = true
                    }
                ))
                .tint(environment.theme.accentColor)
                .disabled(isSending)
                Text(Self.saveFootnote)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        if let sendError {
            Text(sendError)
                .font(.footnote)
                .foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
        }
        HStack(alignment: .center) {
            if allowsSkip, let onSkip {
                Button(Self.skip, action: onSkip)
                    .buttonStyle(.borderless)
                    .font(.subheadline)
                    .disabled(isSending)
            }
            Spacer(minLength: 0)
            SubmitButton(
                label: isSending ? Self.sending : form.submitTitle,
                enabled: !isSending && hasRequiredValues(draft),
                shortcut: Self.submitShortcut(fieldFocused: focusedField != nil)
            ) {
                submit()
            }
        }
    }

    /// On the Mac, Return submits while a field of this form has focus, and
    /// Command-Return submits from anywhere in the thread. The phone has
    /// neither: its keyboard has "Done".
    static func submitShortcut(fieldFocused: Bool) -> KeyboardShortcut? {
        #if os(macOS)
        return fieldFocused ? .defaultAction : KeyboardShortcut.waitingAction
        #else
        return nil
        #endif
    }

    private func valueBinding(_ field: FormField) -> Binding<FormDraftValue> {
        Binding(
            get: { draft?.value(for: field) ?? FormDraftValue.empty(for: field.kind, country: "US") },
            set: { next in
                userEdited = true
                draft?.values[field.id] = next
            }
        )
    }

    /// The submit control opens once every required field has a value. The
    /// format check runs on submit, so a wrong value shows its line.
    private func hasRequiredValues(_ draft: FormDraft) -> Bool {
        form.fields.allSatisfy { field in
            !field.required || !draft.value(for: field).isEmpty
        }
    }

    private func submit() {
        guard var current = draft else { return }
        current.touchAll(form)
        draft = current
        guard current.isComplete(form) else {
            if let first = form.fields.first(where: { current.error(for: $0) != nil }) {
                focusedField = first.kind.firstFocusSuffix.map { "\(first.id).\($0)" } ?? first.id
            }
            return
        }
        focusedField = nil
        let answer = current.answer(form)
        onSubmit(answer, answer.save ? current.savedLabels(form) : [])
    }

    // MARK: - The receipt

    @ViewBuilder private func receiptBody(_ receipt: Receipt) -> some View {
        switch receipt {
        case .answered(let answer):
            AnswerSummary(rows: Self.rows(form: form, answer: answer))
            let saved = Self.savedLabels(form: form, answer: answer)
            if !saved.isEmpty {
                Text("Saved to your details: \(saved.joined(separator: ", "))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .answeredText(let line):
            Text(Self.answeredLine)
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let line {
                Text(line)
                    .font(.footnote.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .answeredInChat(let line):
            Text(Self.answeredInChatLine)
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let line {
                Text(line)
                    .font(.footnote.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .dismissed:
            Text(Self.dismissedLine)
                .font(.footnote)
                .foregroundStyle(.tertiary)
        case .skipped:
            Text(Self.skippedLine)
                .font(.footnote)
                .foregroundStyle(.tertiary)
        }
    }

    /// The label and value rows of an answered form.
    static func rows(form: FormQuestion, answer: FormAnswer) -> [(label: String, value: String)] {
        form.fields.compactMap { field in
            guard let json = answer.values[field.id],
                  let value = FormDraftValue.from(json: json, kind: field.kind, country: "US") else { return nil }
            return (field.label, value.display(field: field))
        }
    }

    /// The labels of the bound fields the answer saved.
    static func savedLabels(form: FormQuestion, answer: FormAnswer) -> [String] {
        guard answer.save else { return [] }
        return form.fields.compactMap { field in
            guard let key = field.boundDetail, answer.values[field.id] != nil else { return nil }
            return key.fixedLabel ?? field.label
        }
    }
}
