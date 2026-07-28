import Foundation
import MapKit
import MobileAPI
import SwiftUI

struct BriefDataTableNodeView: View {
    let node: BriefNode

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            BriefToolHeading(title: node.title ?? "Details", description: node.description)
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 0) {
                    GridRow {
                        ForEach(node.tableColumns ?? [], id: \.key) { column in
                            Text(column.label)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .frame(width: 130, alignment: .leading)
                                .padding(.vertical, 8)
                        }
                    }
                    Divider()
                    ForEach(Array((node.tableRows ?? []).enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(node.tableColumns ?? [], id: \.key) { column in
                                Text(row[column.key]?.briefDisplayValue ?? "—")
                                    .font(.subheadline)
                                    .frame(width: 130, alignment: .leading)
                                    .padding(.vertical, 9)
                            }
                        }
                        Divider()
                    }
                }
            }
        }
        .padding(15)
        .surfaceCard(cornerRadius: 16)
        .accessibilityElement(children: .contain)
    }
}

struct BriefProgressNodeView: View {
    let node: BriefNode

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            BriefToolHeading(title: node.title ?? "Progress", description: node.description)
            ForEach(Array((node.progressSteps ?? []).enumerated()), id: \.element.id) { index, step in
                HStack(alignment: .top, spacing: 11) {
                    VStack(spacing: 4) {
                        Image(systemName: progressSymbol(step.status))
                            .symbolRenderingMode(.hierarchical)
                            .foregroundStyle(progressColor(step.status))
                        if index < (node.progressSteps?.count ?? 0) - 1 {
                            Rectangle().fill(.quaternary).frame(width: 1, height: 30)
                        }
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(step.label).font(.subheadline.weight(.medium))
                        if let description = step.description {
                            Text(description).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(15)
        .surfaceCard(cornerRadius: 16)
    }

    private func progressSymbol(_ status: String) -> String {
        switch status {
        case "completed": "checkmark.circle.fill"
        case "in-progress": "arrow.trianglehead.2.clockwise.rotate.90.circle.fill"
        case "failed": "exclamationmark.circle.fill"
        default: "circle"
        }
    }

    private func progressColor(_ status: String) -> Color {
        switch status {
        case "completed": .green
        case "failed": .red
        case "in-progress": .accentColor
        default: .secondary
        }
    }
}

struct BriefWeatherNodeView: View {
    let node: BriefNode

    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(node.weatherLocation ?? node.title ?? "Weather")
                        .font(.headline)
                    Text(conditionLabel)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: weatherSymbol(node.weatherCurrent?.conditionCode))
                    .font(.title)
                    .symbolRenderingMode(.multicolor)
            }
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(temperature(node.weatherCurrent?.temperature))
                    .font(.system(size: 52, weight: .medium, design: .rounded))
                Text("H \(temperature(node.weatherCurrent?.tempMax))  L \(temperature(node.weatherCurrent?.tempMin))")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            ScrollView(.horizontal) {
                HStack(spacing: 10) {
                    ForEach(Array((node.weatherDaily ?? []).enumerated()), id: \.offset) { _, day in
                        VStack(spacing: 7) {
                            Text(day.label).font(.caption.weight(.semibold))
                            Image(systemName: weatherSymbol(day.conditionCode))
                                .symbolRenderingMode(.hierarchical)
                            Text("\(temperature(day.tempMax)) / \(temperature(day.tempMin))")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .frame(width: 76)
                        .padding(.vertical, 10)
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            }
            if let attributionURL = node.attributionURL {
                Link("Weather data by \(node.source ?? "weather provider")", destination: attributionURL)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(17)
        .background(
            LinearGradient(
                colors: [Color.accentColor.opacity(0.18), Color.secondary.opacity(0.06)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: 20)
        )
        .overlay { RoundedRectangle(cornerRadius: 20).stroke(.quaternary) }
    }

    private var conditionLabel: String {
        (node.weatherCurrent?.conditionCode ?? "cloudy")
            .replacingOccurrences(of: "-", with: " ")
            .capitalized
    }

    private func temperature(_ value: Double?) -> String {
        guard let value else { return "—" }
        return "\(Int(value.rounded()))°"
    }

    private func weatherSymbol(_ condition: String?) -> String {
        switch condition {
        case "clear": "sun.max.fill"
        case "partly-cloudy": "cloud.sun.fill"
        case "fog": "cloud.fog.fill"
        case "drizzle", "rain": "cloud.rain.fill"
        case "heavy-rain", "thunderstorm": "cloud.bolt.rain.fill"
        case "snow": "cloud.snow.fill"
        case "sleet", "hail": "cloud.hail.fill"
        case "windy": "wind"
        default: "cloud.fill"
        }
    }
}

struct BriefPlanNodeView: View {
    let node: BriefNode
    let onAction: (BriefDocumentAction, BriefSourceRef?) async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            BriefToolHeading(title: node.title ?? "Today’s runway", description: node.description)
            ForEach(Array((node.planItems ?? []).enumerated()), id: \.element.id) { index, item in
                HStack(alignment: .top, spacing: 11) {
                    VStack(spacing: 4) {
                        Image(systemName: planSymbol(item.status))
                            .foregroundStyle(item.status == "in_progress" ? .tint : .secondary)
                        if index < (node.planItems?.count ?? 0) - 1 {
                            Rectangle().fill(.quaternary).frame(width: 1, height: 34)
                        }
                    }
                    VStack(alignment: .leading, spacing: 5) {
                        Text(item.label)
                            .font(.subheadline.weight(.medium))
                            .strikethrough(item.status == "completed" || item.status == "cancelled")
                        if let description = item.description {
                            Text(description).font(.caption).foregroundStyle(.secondary)
                        }
                        if let action = item.action {
                            BriefActionFlow(actions: [action], sourceRef: item.ref, onAction: onAction)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            BriefActionFlow(actions: node.actions ?? [], sourceRef: node.sourceRefs?.first, onAction: onAction)
        }
        .padding(15)
        .surfaceCard(cornerRadius: 16)
    }

    private func planSymbol(_ status: String) -> String {
        switch status {
        case "completed": "checkmark.circle.fill"
        case "in_progress": "circle.inset.filled"
        case "cancelled": "xmark.circle.fill"
        default: "circle"
        }
    }
}

struct BriefEmailPreviewNodeView: View {
    let node: BriefNode
    let onAction: (BriefDocumentAction, BriefSourceRef?) async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 11) {
                Image(systemName: node.channel == "slack" ? "bubble.left.and.text.bubble.right.fill" : "envelope.fill")
                    .foregroundStyle(.tint)
                    .frame(width: 34, height: 34)
                    .background(Color.accentColor.opacity(0.12), in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text(node.title ?? "Message").font(.headline).lineLimit(2)
                    Text(node.sender ?? "Unknown sender").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if let sentAt = node.sentAt {
                    Text(Date(timeIntervalSince1970: sentAt / 1_000), style: .time)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(15)
            Divider()
            VStack(alignment: .leading, spacing: 12) {
                Text(node.snippet ?? "")
                    .font(.subheadline)
                    .lineLimit(8)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 14) {
                    if (node.attachmentCount ?? 0) > 0 {
                        Label("\(node.attachmentCount ?? 0)", systemImage: "paperclip")
                    }
                    if (node.messageCount ?? 1) > 1 {
                        Label("\(node.messageCount ?? 1) messages", systemImage: "bubble.left.and.bubble.right")
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
                BriefActionFlow(actions: node.actions ?? [], sourceRef: node.previewRef, onAction: onAction)
            }
            .padding(15)
        }
        .surfaceCard(cornerRadius: 16)
    }
}

struct BriefDecisionNodeView: View {
    let node: BriefNode
    let onAction: (BriefDocumentAction, BriefSourceRef?) async -> Void
    @State private var selectedID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            BriefToolHeading(title: node.title ?? "Decision", description: node.description)
            ForEach(node.decisionOptions ?? [], id: \.id) { option in
                Button {
                    selectedID = option.id
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: selectedID == option.id ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(selectedID == option.id ? .tint : .secondary)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(option.label).font(.subheadline.weight(.medium))
                            if let description = option.description {
                                Text(description).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(11)
                .background(Color.secondary.opacity(selectedID == option.id ? 0.1 : 0.05), in: RoundedRectangle(cornerRadius: 12))
            }
            if let option = (node.decisionOptions ?? []).first(where: { $0.id == selectedID }) {
                BriefActionFlow(actions: [option.action], sourceRef: node.sourceRefs?.first, onAction: onAction)
            } else {
                Text("Choose an option to review the next action.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(15)
        .surfaceCard(cornerRadius: 16)
    }
}

struct BriefCitationsNodeView: View {
    let node: BriefNode

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title = node.title { Text(title).font(.headline) }
            ForEach(node.citations ?? [], id: \.id) { citation in
                Link(destination: citation.href) {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: citationSymbol(citation.type))
                            .foregroundStyle(.tint)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(citation.title).font(.subheadline.weight(.medium)).foregroundStyle(.primary)
                            if let snippet = citation.snippet {
                                Text(snippet).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }
                            if let domain = citation.domain {
                                Text(domain).font(.caption2).foregroundStyle(.tertiary)
                            }
                        }
                        Spacer()
                        Image(systemName: "arrow.up.right").font(.caption2).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .padding(15)
        .surfaceCard(cornerRadius: 16)
    }

    private func citationSymbol(_ type: String?) -> String {
        switch type {
        case "code": "chevron.left.forwardslash.chevron.right"
        case "api": "server.rack"
        case "article": "newspaper"
        case "document": "doc.text"
        default: "globe"
        }
    }
}

struct BriefGeoMapNodeView: View {
    let node: BriefNode

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            BriefToolHeading(title: node.title ?? "Map", description: node.description)
            Map(initialPosition: .region(region)) {
                ForEach(node.mapMarkers ?? [], id: \.id) { marker in
                    Marker(
                        marker.label ?? "Location",
                        coordinate: CLLocationCoordinate2D(latitude: marker.lat, longitude: marker.lng)
                    )
                }
                ForEach(node.mapRoutes ?? [], id: \.id) { route in
                    MapPolyline(coordinates: route.points.map {
                        CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lng)
                    })
                    .stroke(.tint, lineWidth: 4)
                }
            }
            .mapStyle(.standard(elevation: .realistic))
            .frame(height: 270)
            .clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .padding(15)
        .surfaceCard(cornerRadius: 16)
    }

    private var region: MKCoordinateRegion {
        let markers = node.mapMarkers ?? []
        guard let first = markers.first else {
            return MKCoordinateRegion(
                center: CLLocationCoordinate2D(latitude: 0, longitude: 0),
                span: MKCoordinateSpan(latitudeDelta: 30, longitudeDelta: 30)
            )
        }
        let latitudes = markers.map(\.lat)
        let longitudes = markers.map(\.lng)
        let latitudeDelta = max((latitudes.max() ?? first.lat) - (latitudes.min() ?? first.lat), 0.08)
        let longitudeDelta = max((longitudes.max() ?? first.lng) - (longitudes.min() ?? first.lng), 0.08)
        return MKCoordinateRegion(
            center: CLLocationCoordinate2D(
                latitude: ((latitudes.min() ?? first.lat) + (latitudes.max() ?? first.lat)) / 2,
                longitude: ((longitudes.min() ?? first.lng) + (longitudes.max() ?? first.lng)) / 2
            ),
            span: MKCoordinateSpan(latitudeDelta: latitudeDelta * 1.4, longitudeDelta: longitudeDelta * 1.4)
        )
    }
}

struct BriefCodeDiffNodeView: View {
    let node: BriefNode

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            BriefToolHeading(title: node.title ?? "Code change", description: node.filename)
            ScrollView(.horizontal) {
                VStack(alignment: .leading, spacing: 0) {
                    if let oldCode = node.oldCode, !oldCode.isEmpty {
                        codeBlock(oldCode, prefix: "−", color: .red)
                    }
                    if let newCode = node.newCode, !newCode.isEmpty {
                        codeBlock(newCode, prefix: "+", color: .green)
                    }
                }
            }
        }
        .padding(15)
        .surfaceCard(cornerRadius: 16)
    }

    private func codeBlock(_ code: String, prefix: String, color: Color) -> some View {
        Text(code.split(separator: "\n", omittingEmptySubsequences: false).map { "\(prefix) \($0)" }.joined(separator: "\n"))
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(.primary)
            .padding(10)
            .frame(minWidth: 520, alignment: .leading)
            .background(color.opacity(0.08))
    }
}

struct BriefTerminalNodeView: View {
    let node: BriefNode

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            BriefToolHeading(title: node.title ?? "Command output", description: node.cwd)
            ScrollView([.horizontal, .vertical]) {
                Text(output)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.white)
                    .frame(minWidth: 520, alignment: .leading)
                    .padding(13)
            }
            .frame(maxHeight: 320)
            .background(Color.black.opacity(0.9), in: RoundedRectangle(cornerRadius: 12))
            HStack {
                Label(node.exitCode == 0 ? "Succeeded" : "Exited \(node.exitCode ?? 0)", systemImage: node.exitCode == 0 ? "checkmark.circle" : "exclamationmark.triangle")
                Spacer()
                if let durationMs = node.durationMs {
                    Text(durationMs < 1_000 ? "\(Int(durationMs)) ms" : String(format: "%.1f s", durationMs / 1_000))
                }
                if node.truncated == true { Text("Truncated") }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding(15)
        .surfaceCard(cornerRadius: 16)
    }

    private var output: String {
        [
            (node.cwd.map { "\($0)$ " } ?? "$ ") + (node.command ?? ""),
            node.stdout ?? "",
            node.stderr ?? "",
        ]
        .filter { !$0.isEmpty }
        .joined(separator: "\n")
    }
}

private struct BriefToolHeading: View {
    let title: String
    let description: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.headline)
            if let description {
                Text(description).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

private extension BriefJSONValue {
    var briefDisplayValue: String {
        switch self {
        case .string(let value): value
        case .number(let value): value.formatted()
        case .bool(let value): value ? "Yes" : "No"
        case .object: "Details"
        case .array: "Items"
        case .null: "—"
        }
    }
}
