import Charts
import Kingfisher
import SwiftUI

// Native renderings of the agent's show_* display tools. The server envelope
// is {ok, component, payload, summary} (lib/tools/display.ts); the web spreads
// payload into React tool-ui components — here each supported payload parses
// into a typed card, and anything unrecognized falls back to the envelope's
// plain-language summary so a tool call is never silently invisible.

enum AssistantToolCard: Equatable, Sendable {
    struct Stat: Equatable, Sendable {
        let label: String
        let value: String
    }

    struct TableCard: Equatable, Sendable {
        let title: String?
        let columns: [String]
        let rows: [[String]]
    }

    struct PlanItem: Equatable, Sendable {
        let label: String
        let done: Bool
        let active: Bool
    }

    struct Citation: Equatable, Sendable {
        let title: String
        let url: URL?
        let domain: String?
        let snippet: String?
    }

    struct ImageCard: Equatable, Sendable {
        let url: URL
        let title: String?
    }

    struct WeatherCard: Equatable, Sendable {
        let location: String
        let line: String
    }

    struct DraftCard: Equatable, Sendable {
        let to: String
        let subject: String
        let body: String
    }

    struct ChartCard: Equatable, Sendable {
        struct Point: Equatable, Sendable {
            let x: String
            let series: String
            let y: Double
        }

        let isLine: Bool
        let title: String?
        let points: [Point]
    }

    case stats(title: String?, [Stat])
    case table(TableCard)
    case plan(title: String, [PlanItem])
    case citations([Citation])
    case link(title: String, url: URL?, detail: String?)
    case images([ImageCard])
    case weather(WeatherCard)
    case draft(DraftCard)
    case chart(ChartCard)
    case summary(tool: String, String)

    // MARK: - Parsing

    static func parse(toolName: String, output: JSONValue) -> AssistantToolCard? {
        guard toolName.hasPrefix("show_") else { return nil }
        let payload = output["payload"] ?? .null
        guard output["ok"]?.boolValue != false else {
            return output["error"]?.stringValue.map { .summary(tool: toolName, $0) }
        }
        switch toolName {
        case "show_stats":
            let stats = (payload["stats"]?.arrayValue ?? []).compactMap { row -> Stat? in
                guard let label = row["label"]?.stringValue else { return nil }
                return Stat(label: label, value: scalarText(row["value"]))
            }
            guard !stats.isEmpty else { break }
            return .stats(title: payload["title"]?.stringValue, stats)

        case "show_table":
            let columnRows = payload["columns"]?.arrayValue ?? []
            let columns = columnRows.compactMap { $0["label"]?.stringValue ?? $0["key"]?.stringValue }
            let keys = columnRows.compactMap { $0["key"]?.stringValue }
            let rows = (payload["rows"]?.arrayValue ?? []).prefix(10).map { row in
                keys.map { scalarText(row[$0]) }
            }
            guard !columns.isEmpty, !rows.isEmpty else { break }
            return .table(TableCard(
                title: payload["title"]?.stringValue,
                columns: Array(columns.prefix(3)),
                rows: rows.map { Array($0.prefix(3)) }
            ))

        case "show_plan", "show_progress":
            let itemsKey = toolName == "show_plan" ? "todos" : "steps"
            let items = (payload[itemsKey]?.arrayValue ?? []).compactMap { row -> PlanItem? in
                guard let label = row["label"]?.stringValue else { return nil }
                let status = row["status"]?.stringValue ?? "pending"
                return PlanItem(
                    label: label,
                    done: status == "completed",
                    active: status == "in_progress" || status == "in-progress"
                )
            }
            guard !items.isEmpty else { break }
            return .plan(title: payload["title"]?.stringValue ?? "Plan", items)

        case "show_citations":
            let rows = payload.arrayValue ?? payload["citations"]?.arrayValue ?? []
            let citations = rows.compactMap { row -> Citation? in
                guard let title = row["title"]?.stringValue else { return nil }
                return Citation(
                    title: title,
                    url: row["href"]?.stringValue.flatMap(URL.init(string:)),
                    domain: row["domain"]?.stringValue,
                    snippet: row["snippet"]?.stringValue
                )
            }
            guard !citations.isEmpty else { break }
            return .citations(citations)

        case "show_link_preview":
            let url = (payload["url"] ?? payload["href"])?.stringValue.flatMap(URL.init(string:))
            let title = payload["title"]?.stringValue ?? url?.host() ?? "Link"
            return .link(title: title, url: url, detail: payload["description"]?.stringValue)

        case "show_image":
            guard let url = payload["url"]?.stringValue.flatMap(URL.init(string:)) else { break }
            return .images([ImageCard(url: url, title: payload["title"]?.stringValue ?? payload["alt"]?.stringValue)])

        case "show_image_gallery":
            let images = (payload["images"]?.arrayValue ?? []).compactMap { row -> ImageCard? in
                guard let url = row["url"]?.stringValue.flatMap(URL.init(string:)) else { return nil }
                return ImageCard(url: url, title: row["title"]?.stringValue ?? row["alt"]?.stringValue)
            }
            guard !images.isEmpty else { break }
            return .images(images)

        case "show_weather":
            let location = payload["locationName"]?.stringValue ?? "Weather"
            if let summary = output["summary"]?.stringValue {
                return .weather(WeatherCard(location: location, line: summary))
            }
            break

        case "show_message_draft":
            let to = (payload["to"]?.arrayValue ?? []).compactMap(\.stringValue).joined(separator: ", ")
            guard let subject = payload["subject"]?.stringValue,
                  let body = payload["body"]?.stringValue else { break }
            return .draft(DraftCard(to: to, subject: subject, body: body))

        case "show_chart":
            let xKey = payload["xKey"]?.stringValue ?? "x"
            let series = (payload["series"]?.arrayValue ?? []).compactMap { row -> (String, String)? in
                guard let key = row["key"]?.stringValue else { return nil }
                return (key, row["label"]?.stringValue ?? key)
            }
            var points: [ChartCard.Point] = []
            for row in payload["data"]?.arrayValue ?? [] {
                let x = scalarText(row[xKey])
                for (key, label) in series {
                    if let y = row[key]?.doubleValue {
                        points.append(ChartCard.Point(x: x, series: label, y: y))
                    }
                }
            }
            guard !points.isEmpty else { break }
            return .chart(ChartCard(
                isLine: payload["type"]?.stringValue == "line",
                title: payload["title"]?.stringValue,
                points: points
            ))

        default:
            break
        }
        // Anything else — or a payload shape this client doesn't model — shows
        // the envelope's own summary line.
        if let summary = output["summary"]?.stringValue {
            return .summary(tool: toolName, summary)
        }
        return .summary(tool: toolName, describe(toolName))
    }

    private static func scalarText(_ value: JSONValue?) -> String {
        switch value {
        case .string(let string): string
        case .number(let number):
            number == number.rounded() && abs(number) < 1e15
                ? String(Int(number))
                : String(number)
        case .bool(let bool): bool ? "Yes" : "No"
        default: "—"
        }
    }

    private static func describe(_ toolName: String) -> String {
        toolName.replacingOccurrences(of: "show_", with: "Shared a ")
            .replacingOccurrences(of: "_", with: " ")
    }
}

// MARK: - Rendering

struct AssistantToolCardView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    let card: AssistantToolCard

    var body: some View {
        Group {
            switch card {
            case .stats(let title, let stats):
                cardShell(title) {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), spacing: 10)], spacing: 10) {
                        ForEach(Array(stats.enumerated()), id: \.offset) { _, stat in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(stat.value)
                                    .font(.title3.weight(.semibold))
                                    .foregroundStyle(environment.theme.accentColor)
                                Text(stat.label)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }

            case .table(let table):
                cardShell(table.title) {
                    Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                        GridRow {
                            ForEach(table.columns, id: \.self) { column in
                                Text(column)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Divider()
                        ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                            GridRow {
                                ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                    Text(cell).font(.footnote).lineLimit(2)
                                }
                            }
                        }
                    }
                }

            case .plan(let title, let items):
                cardShell(title) {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Image(systemName: item.done ? "checkmark.circle.fill" : (item.active ? "circle.dotted.circle" : "circle"))
                                    .font(.footnote)
                                    .foregroundStyle(item.done ? Color.secondary : environment.theme.accentColor)
                                Text(item.label)
                                    .font(.footnote)
                                    .strikethrough(item.done)
                                    .foregroundStyle(item.done ? .secondary : .primary)
                            }
                        }
                    }
                }

            case .citations(let citations):
                cardShell("Sources") {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(citations.prefix(5).enumerated()), id: \.offset) { _, citation in
                            Button {
                                if let url = citation.url { openURL(url) }
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(citation.title)
                                        .font(.footnote.weight(.medium))
                                        .multilineTextAlignment(.leading)
                                    if let domain = citation.domain {
                                        Text(domain).font(.caption2).foregroundStyle(.secondary)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

            case .link(let title, let url, let detail):
                cardShell(nil) {
                    Button {
                        if let url { openURL(url) }
                    } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(title).font(.footnote.weight(.semibold))
                            if let detail {
                                Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }
                            if let url {
                                Text(url.host() ?? url.absoluteString)
                                    .font(.caption2)
                                    .foregroundStyle(environment.theme.accentColor)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                }

            case .images(let images):
                cardShell(nil) {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(Array(images.prefix(6).enumerated()), id: \.offset) { _, image in
                                KFImage(image.url)
                                    .placeholder { Color.primary.opacity(0.06) }
                                    .fade(duration: 0.2)
                                    .resizable()
                                    .aspectRatio(contentMode: .fill)
                                    .frame(width: images.count == 1 ? 260 : 150, height: 130)
                                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                        }
                    }
                }

            case .weather(let weather):
                cardShell(weather.location) {
                    Text(weather.line).font(.footnote)
                }

            case .draft(let draft):
                cardShell("Draft") {
                    VStack(alignment: .leading, spacing: 5) {
                        if !draft.to.isEmpty {
                            Text("To: \(draft.to)").font(.caption).foregroundStyle(.secondary)
                        }
                        Text(draft.subject).font(.footnote.weight(.semibold))
                        Text(draft.body)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(8)
                    }
                }

            case .chart(let chart):
                cardShell(chart.title) {
                    Chart(Array(chart.points.enumerated()), id: \.offset) { _, point in
                        if chart.isLine {
                            LineMark(x: .value("x", point.x), y: .value("y", point.y))
                                .foregroundStyle(by: .value("Series", point.series))
                        } else {
                            BarMark(x: .value("x", point.x), y: .value("y", point.y))
                                .foregroundStyle(by: .value("Series", point.series))
                                .position(by: .value("Series", point.series))
                        }
                    }
                    .chartForegroundStyleScale(range: [
                        environment.theme.accentColor,
                        environment.theme.accent2Color,
                        Color.secondary,
                    ])
                    .frame(height: 170)
                }

            case .summary(_, let text):
                cardShell(nil) {
                    Text(text).font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder private func cardShell(_ title: String?, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title, !title.isEmpty {
                Text(title)
                    .font(.footnote.weight(.semibold))
            }
            content()
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .surfaceCard(cornerRadius: 14)
    }
}
