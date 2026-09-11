import Foundation

// The work log model (docs/chat-agentic-pass.md, section 2). Every tool call
// in an assistant turn leaves one row. Consecutive rows form one block with a
// header that reads the state of the group. The grouping and the header rules
// are pure functions so tests can prove them without a view.

/// One tool call, from the first input byte to its output, error, and shape.
struct AssistantToolRow: Identifiable, Equatable, Sendable {
    enum State: String, Sendable {
        case running
        case done
        case failed
    }

    let callID: String
    var toolName: String
    var state: State
    /// The full input once `tool-input-available` arrives.
    var input: JSONValue?
    /// Partial input text accumulated from `tool-input-delta` chunks.
    var inputText: String
    var output: JSONValue?
    var errorText: String?
    /// The server-resolved display shape and its raw JSON for the transcript.
    var shape: ToolShape?
    var shapeJSON: JSONValue?
    /// The designed component for `show_*` tools.
    var card: AssistantToolCard?
    var startedAt: Date?
    var endedAt: Date?

    var id: String { "row-\(callID)" }

    init(
        callID: String,
        toolName: String,
        state: State = .running,
        input: JSONValue? = nil,
        inputText: String = "",
        output: JSONValue? = nil,
        errorText: String? = nil,
        shape: ToolShape? = nil,
        shapeJSON: JSONValue? = nil,
        card: AssistantToolCard? = nil,
        startedAt: Date? = nil,
        endedAt: Date? = nil
    ) {
        self.callID = callID
        self.toolName = toolName
        self.state = state
        self.input = input
        self.inputText = inputText
        self.output = output
        self.errorText = errorText
        self.shape = shape
        self.shapeJSON = shapeJSON
        self.card = card
        self.startedAt = startedAt
        self.endedAt = endedAt
    }

    /// The input the sentence grammar reads: the full input when known, else
    /// whatever has streamed so far.
    var effectiveInput: JSONValue? {
        input ?? AssistantToolGrammar.partialInput(from: inputText)
    }

    /// The row text. The shape's sentences win once the shape has arrived;
    /// the native grammar covers the time before that and every failure.
    var sentence: String {
        let activity = shape?.activity
            ?? AssistantToolGrammar.sentences(toolName: toolName, input: effectiveInput, output: output)
        switch state {
        case .running:
            return activity.running + "…"
        case .done:
            return activity.done
        case .failed:
            let detail = errorText?.nilIfBlank
                ?? output?["error"]?.stringValue?.nilIfBlank
                ?? output?["message"]?.stringValue?.nilIfBlank
            return detail.map { "\(activity.failed) — \($0)" } ?? activity.failed
        }
    }

    /// The source record the transcript writes for this call.
    var cardSource: AssistantToolCardSource? {
        guard let output else { return nil }
        return AssistantToolCardSource(toolName: toolName, toolCallID: callID, input: input, output: output)
    }
}

/// Model reasoning, rendered as one collapsed line above the reply.
struct AssistantReasoningPart: Identifiable, Equatable, Sendable {
    let id: String
    var text: String
    var startedAt: Date?
    var endedAt: Date?

    var isStreaming: Bool { endedAt == nil }

    /// `Thought` while streaming, `Thought for 3s` once done.
    var label: String {
        guard let startedAt, let endedAt else { return "Thought" }
        let seconds = max(1, Int(endedAt.timeIntervalSince(startedAt).rounded()))
        return "Thought for \(seconds)s"
    }
}

/// A question the agent asked through `ask_user`, `ask_parameters`,
/// `ask_preferences`, or `ask_question_flow`. The answer is the tool output
/// the transcript sends back so the turn can continue.
struct AssistantQuestionPart: Identifiable, Equatable, Sendable {
    enum Kind: String, Sendable {
        case user = "ask_user"
        case parameters = "ask_parameters"
        case preferences = "ask_preferences"
        case questionFlow = "ask_question_flow"
    }

    let id: String
    let toolCallID: String
    let kind: Kind
    let input: JSONValue
    var answer: JSONValue?

    var toolName: String { kind.rawValue }
    var isAnswered: Bool { answer != nil }
}

/// A web or connector source the reply cited (`source-url`).
struct AssistantSourceLink: Identifiable, Equatable, Sendable {
    let id: String
    let url: String
    let title: String?
}

/// What the transcript view renders: parts regrouped so consecutive tool rows
/// become one work log block and adjacent reasoning becomes one line.
enum AssistantTranscriptBlock: Identifiable, Equatable, Sendable {
    case text(id: String, String)
    case reasoning(AssistantReasoningPart)
    case workLog(id: String, rows: [AssistantToolRow])
    case card(id: String, AssistantToolCard, source: AssistantToolCardSource?)
    case approval(AssistantInlineApproval)
    case question(AssistantQuestionPart)

    var id: String {
        switch self {
        case .text(let id, _): id
        case .reasoning(let part): part.id
        case .workLog(let id, _): id
        case .card(let id, _, _): id
        case .approval(let approval): approval.id
        case .question(let question): question.id
        }
    }
}

enum AssistantWorkLog {
    /// Pure regrouping of message parts into transcript blocks.
    static func group(parts: [AssistantChatPart]) -> [AssistantTranscriptBlock] {
        var blocks: [AssistantTranscriptBlock] = []
        for part in parts {
            switch part {
            case .text(let id, let text):
                blocks.append(.text(id: id, text))
            case .reasoning(let reasoning):
                if case .reasoning(var previous)? = blocks.last {
                    previous.text += reasoning.text
                    previous.startedAt = previous.startedAt ?? reasoning.startedAt
                    previous.endedAt = reasoning.endedAt
                    blocks[blocks.count - 1] = .reasoning(previous)
                } else {
                    blocks.append(.reasoning(reasoning))
                }
            case .toolRow(let row):
                if case .workLog(let id, var rows)? = blocks.last {
                    rows.append(row)
                    blocks[blocks.count - 1] = .workLog(id: id, rows: rows)
                } else {
                    blocks.append(.workLog(id: "log-\(row.callID)", rows: [row]))
                }
            case .card(let id, let card, let source):
                blocks.append(.card(id: id, card, source: source))
            case .approval(let approval):
                blocks.append(.approval(approval))
            case .question(let question):
                blocks.append(.question(question))
            }
        }
        return blocks
    }

    enum HeaderState: Equatable, Sendable {
        case working
        case done(count: Int, seconds: Int?)
        case failed(count: Int)
    }

    /// The header state for one block. `turnFinished` adds the duration.
    static func headerState(rows: [AssistantToolRow], turnFinished: Bool) -> HeaderState {
        let failed = rows.filter { $0.state == .failed }.count
        if failed > 0 { return .failed(count: failed) }
        if rows.contains(where: { $0.state == .running }) { return .working }
        return .done(count: rows.count, seconds: turnFinished ? duration(rows: rows) : nil)
    }

    static func headerText(_ state: HeaderState) -> String {
        switch state {
        case .working:
            return "Working"
        case .done(let count, let seconds):
            let base = "Did \(count) thing\(count == 1 ? "" : "s")"
            guard let seconds else { return base }
            return "\(base) · \(seconds)s"
        case .failed(let count):
            return "\(count) step\(count == 1 ? "" : "s") failed"
        }
    }

    /// After the turn finishes, three or more rows with no failure fold to the
    /// header. Any failure, or one or two rows, stays open.
    static func collapsesByDefault(rows: [AssistantToolRow], turnFinished: Bool) -> Bool {
        guard turnFinished, rows.count >= 3 else { return false }
        return !rows.contains { $0.state == .failed }
    }

    /// Whole seconds from the first start to the last end, at least one.
    static func duration(rows: [AssistantToolRow]) -> Int? {
        let starts = rows.compactMap(\.startedAt)
        let ends = rows.compactMap(\.endedAt)
        guard let first = starts.min(), let last = ends.max(), last >= first else { return nil }
        return max(1, Int(last.timeIntervalSince(first).rounded()))
    }
}
