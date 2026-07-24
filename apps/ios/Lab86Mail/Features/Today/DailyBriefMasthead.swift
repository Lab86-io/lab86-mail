import Kingfisher
import SwiftUI

// The document-v2 masthead, native: the same daily-art hero desktop renders
// (components/report/brief-canvas/BriefMasthead.tsx), with the dateline, "The
// Daily Brief" mark, the edition title over a scrim, and the art credit. The
// art and its fallback order arrive on the report payload so both platforms
// show the identical museum piece for an edition.
struct DailyBriefMasthead: View {
    @Environment(AppEnvironment.self) private var environment
    let title: String
    let generatedAt: Date
    let art: DailyBriefArt?

    @State private var attempt = 0
    @State private var width: CGFloat = 0

    // Mobile-friendly aspect-fill crop: height tracks the container width but
    // stays inside the 220–360pt band the design allows.
    static func height(forWidth width: CGFloat) -> CGFloat {
        guard width > 0 else { return 280 }
        return min(360, max(220, width * 0.62))
    }

    private var sources: [URL] { art?.orderedURLs ?? [] }

    private var currentSource: URL? {
        guard attempt < sources.count else { return nil }
        return sources[attempt]
    }

    var body: some View {
        ZStack {
            // Ordered fallback walking; when every source fails the accent
            // field carries the masthead — never a broken-image state.
            environment.theme.accentSoftColor
            if let url = currentSource {
                KFImage(url)
                    .onFailure { _ in
                        if attempt < sources.count { attempt += 1 }
                    }
                    .placeholder { environment.theme.accentSoftColor }
                    .fade(duration: 0.2)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            }
            LinearGradient(
                stops: [
                    .init(color: .black.opacity(0.30), location: 0),
                    .init(color: .black.opacity(0.10), location: 0.5),
                    .init(color: .black.opacity(0.45), location: 1),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            Text(title)
                .font(environment.theme.displayType.displayFont(size: 40))
                .fontWeight(.semibold)
                .multilineTextAlignment(.center)
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.5), radius: 14, y: 2)
                .padding(.horizontal, 24)
                .accessibilityAddTraits(.isHeader)
        }
        .frame(height: Self.height(forWidth: width))
        .frame(maxWidth: .infinity)
        .clipped()
        .overlay(alignment: .topLeading) {
            Text(generatedAt.formatted(.dateTime.weekday(.wide).month(.wide).day()))
                .font(.caption2.weight(.medium))
                .textCase(.uppercase)
                .kerning(1.2)
                .foregroundStyle(.white.opacity(0.85))
                .shadow(color: .black.opacity(0.6), radius: 4)
                .padding(12)
        }
        .overlay(alignment: .topTrailing) {
            Text("The Daily Brief")
                .font(.caption2.weight(.medium))
                .textCase(.uppercase)
                .kerning(1.1)
                .foregroundStyle(.white.opacity(0.9))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(.black.opacity(0.35), in: Capsule())
                .padding(10)
        }
        .overlay(alignment: .bottomTrailing) {
            if let credit = creditLine {
                Text(credit)
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.75))
                    .shadow(color: .black.opacity(0.65), radius: 4)
                    .lineLimit(1)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
            }
        }
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.width
        } action: { newWidth in
            width = newWidth
        }
        .accessibilityElement(children: .combine)
    }

    private var creditLine: String? {
        guard let art, let credit = art.credit else { return nil }
        if let source = art.source { return "\(credit) · \(source)" }
        return credit
    }
}

// The desktop footer's semantics, native: "Made for you by Lab86 using your
// Gmail, Calendar, and Tasks." Service ids come from the report payload plus
// actual section content; marks are compact SF Symbols with plain-text
// fallback, and VoiceOver reads the sentence in order.
struct DailyBriefFooter: View {
    let report: DailyReportModel

    var body: some View {
        let services = DailyBriefServices.derive(
            serviceIDs: report.serviceIDs,
            sectionCounts: report.sectionCounts
        )
        VStack(spacing: 6) {
            Divider()
                .padding(.bottom, 12)
            (Text("Made for you by ")
                + Text("Lab86").fontWeight(.semibold)
                + Text(" using your ")
                + Text(DailyBriefServices.sentence(services))
                + Text("."))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            HStack(spacing: 10) {
                ForEach(services, id: \.id) { service in
                    Label(service.label, systemImage: service.symbol)
                        .labelStyle(.iconOnly)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 28)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Made for you by Lab86 using your \(DailyBriefServices.sentence(services)).")
    }
}

struct DailyBriefServiceMark: Hashable {
    let id: String
    let label: String
    let symbol: String
}

// Pure derivation mirroring desktop's servicesForReport: payload service ids,
// plus calendar/tasks when those sections actually have content, defaulting to
// mail — ordered, deduplicated, display-labelled.
enum DailyBriefServices {
    static func derive(serviceIDs: [String], sectionCounts: DailyReportModel.SectionCounts) -> [DailyBriefServiceMark] {
        var ids = serviceIDs
        if sectionCounts.calendar > 0 { ids.append("calendar") }
        if sectionCounts.tasks > 0 { ids.append("tasks") }
        if ids.isEmpty { ids.append("mail") }
        var seen = Set<String>()
        return ids.compactMap { id in
            let key = id.lowercased()
            guard !key.isEmpty, !seen.contains(key) else { return nil }
            seen.insert(key)
            return mark(for: key)
        }
    }

    static func sentence(_ services: [DailyBriefServiceMark]) -> String {
        let labels = services.map(\.label)
        switch labels.count {
        case 0: return "Mail"
        case 1: return labels[0]
        case 2: return "\(labels[0]) and \(labels[1])"
        default:
            return labels.dropLast().joined(separator: ", ") + ", and \(labels.last ?? "")"
        }
    }

    private static func mark(for id: String) -> DailyBriefServiceMark {
        switch id {
        case "gmail": DailyBriefServiceMark(id: id, label: "Gmail", symbol: "envelope")
        case "outlook": DailyBriefServiceMark(id: id, label: "Outlook", symbol: "envelope")
        case "icloud": DailyBriefServiceMark(id: id, label: "iCloud", symbol: "icloud")
        case "mail": DailyBriefServiceMark(id: id, label: "Mail", symbol: "envelope")
        case "calendar": DailyBriefServiceMark(id: id, label: "Calendar", symbol: "calendar")
        case "tasks": DailyBriefServiceMark(id: id, label: "Tasks", symbol: "checklist")
        case "github": DailyBriefServiceMark(id: id, label: "GitHub", symbol: "chevron.left.forwardslash.chevron.right")
        case "bitbucket": DailyBriefServiceMark(id: id, label: "Bitbucket", symbol: "chevron.left.forwardslash.chevron.right")
        case "jira": DailyBriefServiceMark(id: id, label: "Jira", symbol: "square.grid.2x2")
        case "slack": DailyBriefServiceMark(id: id, label: "Slack", symbol: "number")
        case "granola": DailyBriefServiceMark(id: id, label: "Granola", symbol: "waveform")
        default:
            DailyBriefServiceMark(id: id, label: id.capitalized, symbol: "app.connected.to.app.below.fill")
        }
    }
}
