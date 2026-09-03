import MobileAPI
import SwiftUI

// The budget brief (2026-09-03) reads as a short letter. The server emits a
// fixed region layout: `lede`, then the lanes `answer`, `today`, `know`, then
// `week-ahead`, then `areas`. The area brief emits `lede`, `pulse`, `ask`,
// `open-work`. This file holds the pure layout decision and the letter views.
// Any region the layout does not recognise falls back to the node renderer,
// so older editions keep their look.

// MARK: - Pure layout

enum BriefLetterLane: String, CaseIterable, Equatable, Sendable {
    case answer
    case today
    case know

    var title: String {
        switch self {
        case .answer: "Answer"
        case .today: "Today"
        case .know: "Know"
        }
    }

    var note: String {
        switch self {
        case .answer: "Replies you owe"
        case .today: "Deadlines and the calendar"
        case .know: "Worth a look"
        }
    }
}

struct BriefPulseLine: Equatable, Sendable {
    let label: String?
    let text: String

    // The area pulse writes "Last change: ..." lines. The label is the part
    // before the first colon when that part is short; otherwise the whole
    // line is the text.
    static func parse(_ line: String) -> BriefPulseLine {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let colon = trimmed.firstIndex(of: ":") else { return BriefPulseLine(label: nil, text: trimmed) }
        let label = trimmed[..<colon].trimmingCharacters(in: .whitespaces)
        let rest = trimmed[trimmed.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        guard !label.isEmpty, !rest.isEmpty, label.split(separator: " ").count <= 3 else {
            return BriefPulseLine(label: nil, text: trimmed)
        }
        return BriefPulseLine(label: label, text: rest)
    }
}

enum BriefLetterSection: Equatable {
    case lede(text: String)
    case lane(BriefLetterLane, items: [BriefEntityItem])
    case weekAhead(text: String)
    case areas(items: [BriefEntityItem])
    case pulse(lines: [BriefPulseLine])
    case node(BriefRegion)

    var isLede: Bool {
        if case .lede = self { return true }
        return false
    }
}

enum BriefLetterLayout {
    static let areaLimit = 3

    // Classify one region by its id and node kind. Both must match: an old
    // edition may reuse an id with a different tree, and a new tree may
    // arrive under an unknown id. Either way the node renderer takes it.
    static func classify(_ region: BriefRegion) -> BriefLetterSection {
        let tree = region.tree
        switch (region.id, tree.kind) {
        case ("lede", "hero"):
            let text = tree.children?.first { $0.kind == "text" && $0.role == "lede" }?.text
                ?? tree.children?.first { $0.kind == "text" }?.text
                ?? region.summary
            return .lede(text: text.trimmingCharacters(in: .whitespacesAndNewlines))
        case ("answer", "entity_list"), ("today", "entity_list"), ("know", "entity_list"):
            guard let lane = BriefLetterLane(rawValue: region.id) else { return .node(region) }
            return .lane(lane, items: tree.items ?? [])
        case ("week-ahead", "text"):
            return .weekAhead(text: (tree.text ?? region.summary).trimmingCharacters(in: .whitespacesAndNewlines))
        case ("areas", "entity_list"):
            return .areas(items: Array((tree.items ?? []).prefix(areaLimit)))
        case ("pulse", "stack"):
            let lines = (tree.children ?? [])
                .filter { $0.kind == "text" }
                .compactMap { $0.text?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .map(BriefPulseLine.parse)
            return lines.isEmpty ? .node(region) : .pulse(lines: lines)
        default:
            return .node(region)
        }
    }

    // The sections in render order. An empty lane or an empty area list
    // does not render. The lede renders only when the owner surface asks for
    // it: Today draws the lede itself above the document, the area page does
    // not. The legacy frontier gate never renders.
    static func sections(for document: BriefDocumentV2, includeLede: Bool) -> [BriefLetterSection] {
        document.regions.compactMap { region -> BriefLetterSection? in
            if region.id == "frontier-gate" { return nil }
            let section = classify(region)
            switch section {
            case .lede(let text):
                return includeLede && !text.isEmpty ? section : nil
            case .lane(_, let items):
                return items.isEmpty ? nil : section
            case .areas(let items):
                return items.isEmpty ? nil : section
            case .weekAhead(let text):
                return text.isEmpty ? nil : section
            case .pulse, .node:
                return section
            }
        }
    }

    // A letter edition carries a lede region and at least one lane, a week
    // ahead, or a pulse. Older editions render node by node.
    static func isLetter(_ document: BriefDocumentV2) -> Bool {
        var hasLede = false
        var hasBody = false
        for region in document.regions {
            switch classify(region) {
            case .lede: hasLede = true
            case .lane, .weekAhead, .pulse: hasBody = true
            default: break
            }
        }
        return hasLede && hasBody
    }

    // A stable key for one section, for `ForEach` and for the rise motion.
    static func key(for section: BriefLetterSection, at index: Int) -> String {
        switch section {
        case .lede: "lede"
        case .lane(let lane, _): "lane:\(lane.rawValue)"
        case .weekAhead: "week-ahead"
        case .areas: "areas"
        case .pulse: "pulse"
        case .node(let region): "node:\(region.id):\(index)"
        }
    }
}

// MARK: - Week ahead emphasis

// Weekday names and calendar dates in the week-ahead paragraph render
// semibold on device. The model writes plain text; the emphasis is a client
// pass, so a model that names "Thursday" and one that names "Sep 12" both
// catch the eye.
enum WeekAheadEmphasis {
    static func terms(in text: String, locale: Locale = .current) -> [String] {
        ranges(in: text, locale: locale).map { String(text[$0]) }
    }

    static func attributed(_ text: String, locale: Locale = .current) -> AttributedString {
        var result = AttributedString(text)
        for range in ranges(in: text, locale: locale) {
            guard let lower = AttributedString.Index(range.lowerBound, within: result),
                  let upper = AttributedString.Index(range.upperBound, within: result) else { continue }
            result[lower..<upper].inlinePresentationIntent = .stronglyEmphasized
        }
        return result
    }

    // Case-sensitive on purpose: "sat" and "may" are verbs, "Sat" and "May 12"
    // are dates.
    static func ranges(in text: String, locale: Locale = .current) -> [Range<String.Index>] {
        guard let regex = try? NSRegularExpression(pattern: pattern(locale: locale)) else {
            return []
        }
        let whole = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: whole).compactMap { Range($0.range, in: text) }
    }

    private static func pattern(locale: Locale) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        let weekdays = (formatter.weekdaySymbols ?? []) + (formatter.shortWeekdaySymbols ?? [])
        let months = (formatter.monthSymbols ?? []) + (formatter.shortMonthSymbols ?? [])
        let escaped = { (names: [String]) -> String in
            names
                .map { $0.trimmingCharacters(in: .punctuationCharacters) }
                .filter { $0.count >= 3 }
                .map(NSRegularExpression.escapedPattern(for:))
                .joined(separator: "|")
        }
        let weekday = escaped(weekdays)
        let month = escaped(months)
        // "Thursday", "Thu", "September 12", "Sep 12", "12 September",
        // "Sep 12th", "9/12". Word boundaries keep "Monetary" and "Sunrise" plain.
        return
            "\\b(?:" + weekday + ")\\b" +
            "|\\b(?:" + month + ")\\.? [0-3]?[0-9](?:st|nd|rd|th)?\\b" +
            "|\\b[0-3]?[0-9](?:st|nd|rd|th)? (?:" + month + ")\\b" +
            "|\\b[01]?[0-9]/[0-3]?[0-9]\\b"
    }
}

// MARK: - Event time slot

// Calendar rows show the start time where a mail row shows the avatar. The
// server writes the local time range into `framing.reason` ("9:00 AM to 9:30
// AM, Room 2"); the hydrated entity carries `startAt` when it resolves.
enum BriefEventTimeSlot {
    struct Slot: Equatable {
        let time: String
        let suffix: String?
    }

    static func make(reason: String?, startAt: Double?, timeZone: TimeZone = .current) -> Slot? {
        if let reason = reason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty {
            if reason.lowercased().hasPrefix("all day") { return Slot(time: "All", suffix: "day") }
            if let regex = try? NSRegularExpression(pattern: "^([0-2]?[0-9][:.][0-5][0-9])\\s*([AaPp][Mm])?"),
               let match = regex.firstMatch(in: reason, range: NSRange(reason.startIndex..., in: reason)),
               let timeRange = Range(match.range(at: 1), in: reason) {
                let suffix = Range(match.range(at: 2), in: reason).map { String(reason[$0]).uppercased() }
                return Slot(time: String(reason[timeRange]), suffix: suffix)
            }
        }
        guard let startAt else { return nil }
        let date = Date(timeIntervalSince1970: startAt > 10_000_000_000 ? startAt / 1_000 : startAt)
        var style = Date.FormatStyle(date: .omitted, time: .shortened)
        style.timeZone = timeZone
        let text = date.formatted(style)
        let parts = text.split(separator: " ", maxSplits: 1).map(String.init)
        return Slot(time: parts.first ?? text, suffix: parts.count > 1 ? parts[1] : nil)
    }
}

// MARK: - Footer copy

// One sentence from `stats`. The count is the mail that arrived and did not
// earn a place in the letter.
enum DailyBriefFooterCopy {
    static func sentence(noise: Int, selected: Int) -> String {
        if selected == 0 { return "Nothing in your mail needs you this morning." }
        switch noise {
        case 0: return "Nothing else arrived."
        case 1: return "1 other message arrived. It did not need you."
        default: return "\(noise) other messages arrived. None needed you."
        }
    }
}

// MARK: - Row copy

// The pure parts of one mail row, so the accessibility sentence and the
// fallbacks are testable without a view.
struct BriefMailRowCopy: Equatable {
    let sender: String?
    let subject: String
    let line: String?
    let action: String?

    init(item: BriefEntityItem, entity: BriefHydratedEntity?) {
        sender = item.framing?.sender?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
        subject = entity?.title.nilIfBlank ?? item.ref.label?.nilIfBlank ?? "(no subject)"
        line = item.framing?.reason?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
        action = item.actions?.first?.label.nilIfBlank
    }

    var accessibilityLabel: String {
        var parts: [String] = []
        if let sender { parts.append("From \(sender)") }
        parts.append(subject)
        if let line { parts.append(line) }
        if let action { parts.append("action \(action)") }
        return parts.joined(separator: ", ")
    }

    // The avatar seeds from the sender when there is one, else the subject.
    var avatarName: String { sender ?? subject }
}

// MARK: - Views

// A section rule in the Today voice: hairline, serif title, quiet note.
struct BriefSectionRule: View {
    let title: String
    let note: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Rectangle()
                .fill(Color.secondary.opacity(0.45))
                .frame(width: 18, height: 1)
            Text(title).font(.system(.subheadline, design: .serif).weight(.semibold))
            if let note {
                Text(note).font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

// The lede in the display face at 21 pt. No card. Today places it above the
// document; the area page renders it from the `lede` region.
struct BriefLedeText: View {
    @Environment(AppEnvironment.self) private var environment
    let text: String

    var body: some View {
        Text(text.trimmingCharacters(in: .whitespacesAndNewlines))
            .font(environment.theme.displayType.displayFont(size: 21, weight: .regular))
            .lineSpacing(4)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }
}

// One lane of the letter: the rule, then real rows with hairlines between.
struct BriefLaneSection: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let lane: BriefLetterLane
    let items: [BriefEntityItem]
    let entities: [String: BriefHydratedEntity]
    let hiddenRefs: Set<String>
    let editionKey: String
    let onAction: (BriefDocumentAction, BriefSourceRef?) async -> Void

    @State private var risenEdition: String?

    var body: some View {
        let visible = items.filter { !hiddenRefs.contains($0.ref.key) }
        VStack(alignment: .leading, spacing: 4) {
            BriefSectionRule(title: lane.title, note: lane.note)
                .padding(.bottom, 6)
            ForEach(Array(visible.enumerated()), id: \.element.ref.key) { index, item in
                VStack(alignment: .leading, spacing: 0) {
                    if item.ref.kind == "event" {
                        BriefEventRow(item: item, entity: entities[item.ref.key], onAction: onAction)
                    } else {
                        BriefMailRow(item: item, entity: entities[item.ref.key], onAction: onAction)
                    }
                    if index < visible.count - 1 {
                        Divider().padding(.leading, 44)
                    }
                }
                .modifier(BriefRise(shown: risenEdition == editionKey, index: index, reduceMotion: reduceMotion))
            }
        }
        .task(id: editionKey) {
            guard risenEdition != editionKey else { return }
            withAnimation(reduceMotion ? .easeInOut(duration: 0.18) : .smooth(duration: 0.26)) {
                risenEdition = editionKey
            }
        }
    }
}

// `rise`: 8 pt up and opacity 0 to 1, with a 40 ms stagger, once per edition.
// Reduce Motion crosses opacity only.
private struct BriefRise: ViewModifier {
    let shown: Bool
    let index: Int
    let reduceMotion: Bool

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown || reduceMotion ? 0 : 8)
            .animation(
                (reduceMotion ? Animation.easeInOut(duration: 0.18) : .smooth(duration: 0.26))
                    .delay(Double(index) * 0.04),
                value: shown
            )
    }
}

// A real email row: avatar, sender in the display face, subject, the model's
// line, and a plain-text action word. The row opens the thread; the word runs
// the action. At `.xxxLarge` the word moves under the text. At accessibility
// sizes the avatar hides.
struct BriefMailRow: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let item: BriefEntityItem
    let entity: BriefHydratedEntity?
    let onAction: (BriefDocumentAction, BriefSourceRef?) async -> Void

    private var copy: BriefMailRowCopy { BriefMailRowCopy(item: item, entity: entity) }
    private var primaryAction: BriefDocumentAction? { item.actions?.first }
    private var openAction: BriefDocumentAction {
        BriefDocumentAction(action: "open_thread", label: "Open", payload: [:], style: "quiet")
    }
    private var stacksAction: Bool { dynamicTypeSize >= .xxxLarge }
    private var showsAvatar: Bool { !dynamicTypeSize.isAccessibilitySize }

    var body: some View {
        let copy = copy
        HStack(alignment: .top, spacing: 12) {
            if showsAvatar {
                InitialsAvatar(name: copy.avatarName, seed: copy.avatarName, size: 32)
                    .padding(.top, 2)
            }
            VStack(alignment: .leading, spacing: 6) {
                Button {
                    Task { await onAction(openAction, item.ref) }
                } label: {
                    textBlock(copy)
                }
                .buttonStyle(.plain)
                if stacksAction, let action = primaryAction {
                    actionWord(action)
                }
            }
            if !stacksAction, let action = primaryAction {
                Spacer(minLength: 12)
                actionWord(action)
                    .padding(.top, 2)
            }
        }
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(copy.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { Task { await onAction(openAction, item.ref) } }
        .accessibilityAction(named: primaryAction?.label ?? "Open") {
            if let action = primaryAction { Task { await onAction(action, item.ref) } }
        }
    }

    @ViewBuilder private func textBlock(_ copy: BriefMailRowCopy) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if let sender = copy.sender {
                Text(sender)
                    .font(environment.theme.displayType.displayFont(size: 15))
                    .foregroundStyle(entity?.gone == true ? .secondary : .primary)
                    .lineLimit(1)
            }
            Text(copy.subject)
                .font(.subheadline)
                .foregroundStyle(entity?.gone == true ? .secondary : .primary)
                .strikethrough(entity?.gone == true)
                .lineLimit(2)
            if let line = copy.line {
                Text(line)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if entity?.gone == true {
                Text("This conversation is no longer available.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private func actionWord(_ action: BriefDocumentAction) -> some View {
        Button(action.label) { Task { await onAction(action, item.ref) } }
            .buttonStyle(.plain)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.tint)
            .fixedSize()
    }
}

// A calendar row: the start time sits where the avatar sits, in monospaced
// digits. Title, then the time range and place, then the action word.
struct BriefEventRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let item: BriefEntityItem
    let entity: BriefHydratedEntity?
    let onAction: (BriefDocumentAction, BriefSourceRef?) async -> Void

    private var primaryAction: BriefDocumentAction? { item.actions?.first }
    private var openAction: BriefDocumentAction {
        BriefDocumentAction(action: "open_event", label: "Open", payload: [:], style: "quiet")
    }
    private var title: String { entity?.title ?? item.ref.label ?? "Event" }
    private var detail: String? { item.framing?.reason ?? entity?.subtitle }
    private var slot: BriefEventTimeSlot.Slot? {
        BriefEventTimeSlot.make(reason: item.framing?.reason, startAt: entity?.startAt)
    }
    private var stacksAction: Bool { dynamicTypeSize >= .xxxLarge }
    private var showsSlot: Bool { !dynamicTypeSize.isAccessibilitySize }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if showsSlot {
                VStack(spacing: 0) {
                    Text(slot?.time ?? "—")
                        .font(.caption.weight(.semibold).monospacedDigit())
                    if let suffix = slot?.suffix {
                        Text(suffix)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(width: 32)
                .padding(.top, 3)
            }
            VStack(alignment: .leading, spacing: 6) {
                Button {
                    Task { await onAction(openAction, item.ref) }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.primary)
                            .lineLimit(2)
                        if let detail {
                            Text(detail)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if stacksAction, let action = primaryAction {
                    actionWord(action)
                }
            }
            if !stacksAction, let action = primaryAction {
                Spacer(minLength: 12)
                actionWord(action)
                    .padding(.top, 2)
            }
        }
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { Task { await onAction(openAction, item.ref) } }
        .accessibilityAction(named: primaryAction?.label ?? "Open") {
            if let action = primaryAction { Task { await onAction(action, item.ref) } }
        }
    }

    private var accessibilityLabel: String {
        [title, detail, primaryAction.map { "action \($0.label)" }].compactMap { $0 }.joined(separator: ", ")
    }

    private func actionWord(_ action: BriefDocumentAction) -> some View {
        Button(action.label) { Task { await onAction(action, item.ref) } }
            .buttonStyle(.plain)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.tint)
            .fixedSize()
    }
}

// The week-ahead paragraph with weekday names and dates in semibold.
struct WeekAheadText: View {
    let text: String

    var body: some View {
        Text(WeekAheadEmphasis.attributed(text))
            .font(.body)
            .lineSpacing(3)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }
}

// At most three area lines: the name, then one line. Tap opens the area.
struct BriefAreaLines: View {
    @Environment(AppEnvironment.self) private var environment
    let items: [BriefEntityItem]
    let onAction: (BriefDocumentAction, BriefSourceRef?) async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            BriefSectionRule(title: "Areas", note: nil)
                .padding(.bottom, 6)
            ForEach(Array(items.enumerated()), id: \.element.ref.key) { index, item in
                let open = item.actions?.first
                    ?? BriefDocumentAction(action: "open_area", label: "Open", payload: [:], style: "quiet")
                Button {
                    Task { await onAction(open, item.ref) }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.ref.label ?? "Area")
                            .font(environment.theme.displayType.displayFont(size: 15))
                            .foregroundStyle(.primary)
                        if let line = item.framing?.reason, !line.isEmpty {
                            Text(line)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.vertical, 9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel([item.ref.label, item.framing?.reason].compactMap { $0 }.joined(separator: ", "))
                if index < items.count - 1 {
                    Divider()
                }
            }
        }
    }
}

// The area pulse: "Last change", "Next move", "Open question", each label
// semibold and the text plain.
struct BriefPulseLines: View {
    let lines: [BriefPulseLine]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                if let label = line.label {
                    Text("\(Text(label).fontWeight(.semibold)). \(line.text)")
                        .font(.body)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text(line.text)
                        .font(.body)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .textSelection(.enabled)
    }
}

// Three placeholder bars where the lede will land while the edition is
// written. No text; the progress line above already says "Writing…".
struct BriefPlaceholderBars: View {
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            bar(width: 0.92)
            bar(width: 0.78)
            bar(width: 0.55)
        }
        .accessibilityHidden(true)
    }

    private func bar(width: CGFloat) -> some View {
        GeometryReader { proxy in
            RoundedRectangle(cornerRadius: 6)
                .fill(environment.theme.subtleColor)
                .frame(width: proxy.size.width * width, height: 12)
        }
        .frame(height: 12)
    }
}
