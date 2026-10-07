import SwiftUI

/// Cards use only the server shape. Raw tool output remains in the work log.
struct AssistantShapeCardView: View {
    let shape: ToolShape

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !shape.title.isEmpty {
                Text(shape.title).font(.footnote.weight(.semibold))
            }
            if let summary = shape.summary {
                Text(summary).font(.footnote).foregroundStyle(.secondary)
            }
            content
            if !shape.actions.isEmpty {
                AssistantShapeActions(actions: shape.actions)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .surfaceCard(cornerRadius: 14)
    }

    @ViewBuilder private var content: some View {
        switch shape.content {
        case .threads(let items, let total):
            ForEach(items.prefix(8)) { row in AssistantShapeThreadView(row: row) }
            if let total, total > items.count { detail("\(total) results") }
        case .thread(let item, let excerpt):
            AssistantShapeThreadView(row: item)
            if let excerpt { detail(excerpt) }
        case .events(let items, let total):
            ForEach(items.prefix(8)) { row in AssistantShapeEventView(row: row) }
            if let total, total > items.count { detail("\(total) results") }
        case .event(let item):
            AssistantShapeEventView(row: item)
            if let attendees = item.attendees, !attendees.isEmpty { detail(attendees.joined(separator: ", ")) }
            if let calendar = item.calendarName { detail(calendar) }
        case .slots(let items):
            ForEach(items.prefix(8)) { row in
                VStack(alignment: .leading, spacing: 5) {
                    Text(AssistantShapeDate.span(start: row.start, end: row.end)).font(.footnote)
                    AssistantShapeActions(actions: row.actions)
                }
            }
        case .tasks(let items, _, let boardTitle):
            if let boardTitle { detail(boardTitle) }
            ForEach(items.prefix(8)) { row in AssistantShapeTaskView(row: row) }
        case .task(let item):
            AssistantShapeTaskView(row: item, expanded: true)
        case .board(_, let columns):
            ForEach(columns) { column in
                HStack {
                    Text(column.name)
                    Spacer()
                    Text(column.count.formatted()).foregroundStyle(.secondary)
                }.font(.footnote)
            }
        case .work(let item): AssistantShapeWorkView(row: item)
        case .works(let items):
            ForEach(items.prefix(8)) { row in AssistantShapeWorkView(row: row) }
        case .area(_, let name, let kind, let domain, let description):
            Text(name).font(.subheadline.weight(.medium))
            detail([kind, domain].compactMap { $0 }.joined(separator: " · "))
            if let description { detail(description) }
        case .document(_, let kind, let status, let revision, let path, _):
            detail([kind, status, revision.map { "Revision \($0)" }].compactMap { $0 }.joined(separator: " · "))
            if let path { detail(path) }
        case .files(let items):
            ForEach(items.prefix(8)) { row in
                VStack(alignment: .leading, spacing: 5) {
                    Text(row.name).font(.subheadline.weight(.medium)).lineLimit(2)
                    detail([row.kind, row.source].compactMap { $0 }.joined(separator: " · "))
                    AssistantShapeActions(actions: row.actions)
                }
            }
        case .contact(let name, let email, let count, let lastSeen, let memory):
            Text(name ?? email).font(.subheadline.weight(.medium))
            if name != nil { detail(email) }
            if let count { detail("\(count) messages") }
            if let lastSeen, let date = CalendarDateParser.date(fromString: lastSeen) {
                detail("Last contact: \(date.formatted(date: .abbreviated, time: .omitted))")
            }
            if let memory { detail(memory) }
        case .count(let value, let label):
            Text(value.formatted()).font(.title.weight(.semibold))
            detail(label)
        case .receipt(let surface, _, _): detail(surface.capitalized)
        case .sources(let items):
            ForEach(Array(items.prefix(8).enumerated()), id: \.offset) { _, row in
                VStack(alignment: .leading, spacing: 5) {
                    Text(row.title).font(.subheadline.weight(.medium)).lineLimit(2)
                    if let snippet = row.snippet { detail(snippet) }
                    if let source = row.source { detail(source) }
                    AssistantShapeActions(actions: row.actions)
                }
            }
        case .text(let text): detail(text)
        case .unknown:
            if shape.summary == nil { detail("This result is available in the web app.") }
        }
    }

    private func detail(_ text: String) -> some View {
        Text(text).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
}

private struct AssistantShapeThreadView: View {
    let row: ShapeThreadRow
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(row.from).font(.subheadline.weight(row.unread == true ? .semibold : .regular)).lineLimit(1)
                Spacer(minLength: 8)
                if let date = row.date {
                    Text(date.formatted(date: .abbreviated, time: .omitted)).font(.caption2).foregroundStyle(.secondary)
                }
            }
            Text(row.subject).font(.footnote.weight(.medium)).lineLimit(2)
            if let snippet = row.snippet { Text(snippet).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
            if row.messageCount != nil || row.attachmentCount != nil {
                Text([row.messageCount.map { "\($0) messages" }, row.attachmentCount.map { "\($0) attachments" }]
                    .compactMap { $0 }.joined(separator: " · ")).font(.caption2).foregroundStyle(.secondary)
            }
            AssistantShapeActions(actions: row.actions)
        }
        .accessibilityElement(children: .contain)
    }
}

private struct AssistantShapeEventView: View {
    let row: ShapeEventRow
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(row.title).font(.subheadline.weight(.medium)).lineLimit(2)
            Text(AssistantShapeDate.span(start: row.start, end: row.end, allDay: row.allDay == true))
                .font(.caption).foregroundStyle(.secondary)
            if let location = row.location { Text(location).font(.caption).foregroundStyle(.secondary) }
            AssistantShapeActions(actions: row.actions)
        }
    }
}

private struct AssistantShapeTaskView: View {
    let row: ShapeTaskRow
    var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(row.title).font(.subheadline.weight(.medium)).strikethrough(row.completed == true).lineLimit(2)
            Text([row.column, row.priority, row.due.map { $0.formatted(date: .abbreviated, time: .omitted) }]
                .compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
            if expanded, let description = row.description { Text(description).font(.footnote).foregroundStyle(.secondary) }
            if expanded, let labels = row.labels, !labels.isEmpty {
                Text(labels.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary)
            }
            AssistantShapeActions(actions: row.actions)
        }
    }
}

private struct AssistantShapeWorkView: View {
    let row: ShapeWorkRow
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(row.title).font(.subheadline.weight(.medium)).lineLimit(2)
            Text([row.shape, row.horizon, row.status].compactMap { $0 }.joined(separator: " · "))
                .font(.caption).foregroundStyle(.secondary)
            if let step = row.currentStep { Text(step).font(.footnote).foregroundStyle(.secondary) }
            if let progress = row.progress, progress.total > 0 {
                ProgressView(value: Double(max(0, min(progress.done, progress.total))), total: Double(progress.total)) {
                    Text("\(progress.done) of \(progress.total)").font(.caption2)
                }
            }
            AssistantShapeActions(actions: row.actions)
        }
    }
}

enum AssistantShapeDate {
    static func span(start: Date?, end: Date?, allDay: Bool = false) -> String {
        guard let start else { return "Time unavailable" }
        if allDay { return start.formatted(date: .abbreviated, time: .omitted) + " · All day" }
        let first = start.formatted(date: .abbreviated, time: .shortened)
        guard let end else { return first }
        return first + " – " + end.formatted(date: Calendar.current.isDate(start, inSameDayAs: end) ? .omitted : .abbreviated, time: .shortened)
    }
}
