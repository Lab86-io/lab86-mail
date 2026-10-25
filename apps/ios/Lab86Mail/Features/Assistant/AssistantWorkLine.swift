import SwiftUI

// The work line (docs/research/ios-refresh-design-2026-10-24.md): one italic
// sentence over the cards that names what Albatross did, from the tool rows.
// "Read 3 threads and the calendar" replaces "Did 1 thing · 1s". While the
// turn runs it names the current action in the present tense; a failure
// turns it red. The composition is pure so tests can read it.

enum AssistantWorkLine {
    enum Tone: Equatable, Sendable {
        case done
        case live
        case failed
        case waiting
        case paused
    }

    struct Line: Equatable, Sendable {
        let text: String
        let tone: Tone
    }

    /// The line while a reply streams and no row has arrived.
    static let workingText = "Working"
    static let waitingText = "Waiting for your choice"
    static let moreSteps = "more steps"

    static func line(rows: [AssistantToolRow], turnFinished: Bool) -> Line {
        let failed = rows.filter { $0.state == .failed }
        if failed.count == 1, let row = failed.first {
            return Line(text: failureText(row), tone: .failed)
        }
        if failed.count > 1 {
            return Line(text: "\(failed.count) steps failed", tone: .failed)
        }
        if let running = rows.last(where: { $0.state == .running }) {
            return Line(text: liveText(running), tone: .live)
        }
        if rows.contains(where: { $0.state == .needsInput }) {
            return Line(text: waitingText, tone: .waiting)
        }
        let paused = rows.filter { $0.state == .paused }.count
        if paused > 0 {
            return Line(text: AssistantWorkLog.headerText(.paused(count: paused)), tone: .paused)
        }
        let sentences = rows.filter { $0.state == .done }.map(\.sentence)
        guard !sentences.isEmpty else {
            return Line(text: workingText, tone: turnFinished ? .done : .live)
        }
        return Line(text: compose(sentences), tone: .done)
    }

    /// The failure sentence of one row, without the detail after the dash.
    static func failureText(_ row: AssistantToolRow) -> String {
        let sentence = row.sentence
        guard let dash = sentence.range(of: " — ") else { return sentence }
        return String(sentence[..<dash.lowerBound])
    }

    /// The present-tense sentence of a running row, without its ellipsis.
    static func liveText(_ row: AssistantToolRow) -> String {
        var text = row.sentence
        while text.hasSuffix("…") || text.hasSuffix(".") {
            text.removeLast()
        }
        return text
    }

    /// "A", "A and b", "A, b, and c", or "A, b, and 2 more steps". Repeated
    /// sentences count once.
    static func compose(_ sentences: [String]) -> String {
        var unique: [String] = []
        for sentence in sentences where !unique.contains(sentence) {
            unique.append(sentence)
        }
        guard let first = unique.first else { return "" }
        switch unique.count {
        case 1:
            return first
        case 2:
            return "\(first) and \(lowercasedFirst(unique[1]))"
        case 3:
            return "\(first), \(lowercasedFirst(unique[1])), and \(lowercasedFirst(unique[2]))"
        default:
            return "\(first), \(lowercasedFirst(unique[1])), and \(unique.count - 2) \(moreSteps)"
        }
    }

    /// The grammar's sentences start with a verb, so only the first letter
    /// moves.
    static func lowercasedFirst(_ sentence: String) -> String {
        guard let first = sentence.first else { return sentence }
        return first.lowercased() + sentence.dropFirst()
    }
}

/// The work line as drawn: display italic, secondary, red on failure, with
/// three pulsing dots while live.
struct WorkLineView: View {
    @Environment(AppEnvironment.self) private var environment
    let line: AssistantWorkLine.Line
    var showsChevron = false
    var expanded = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(line.text)
                .font(environment.theme.displayType.displayItalicFont(size: 15))
                .foregroundStyle(color)
                .fixedSize(horizontal: false, vertical: true)
            if line.tone == .live {
                PulsingDots()
            }
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
            }
        }
    }

    private var color: Color {
        line.tone == .failed ? .red : .secondary
    }
}

/// Three small dots that pulse in turn. Still under Reduce Motion.
struct PulsingDots: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 3) {
            PulsingDot(delay: 0, animates: !reduceMotion)
            PulsingDot(delay: 0.18, animates: !reduceMotion)
            PulsingDot(delay: 0.36, animates: !reduceMotion)
        }
        .accessibilityHidden(true)
    }
}

private struct PulsingDot: View {
    let delay: Double
    let animates: Bool
    @State private var lit = false

    var body: some View {
        Circle()
            .fill(.secondary)
            .frame(width: 4, height: 4)
            .opacity(animates ? (lit ? 0.9 : 0.25) : 0.6)
            .onAppear {
                guard animates else { return }
                withAnimation(.easeInOut(duration: 0.5).repeatForever(autoreverses: true).delay(delay)) {
                    lit = true
                }
            }
    }
}
