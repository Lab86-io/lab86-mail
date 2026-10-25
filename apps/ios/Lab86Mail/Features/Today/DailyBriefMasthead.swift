import Kingfisher
import SwiftUI

// The document-v2 masthead, native: the same daily-art hero desktop renders
// (components/report/brief-canvas/BriefMasthead.tsx), with the dateline, the
// edition title over a scrim, and the art credit. The art and its fallback
// order arrive on the report payload so both platforms show the identical
// museum piece for an edition.
//
// The dateline sits above the title in the display italic, sentence case,
// and the two scale together under a cap, so a large text size never cuts
// the title or runs the dateline into it (D4).
struct DailyBriefMasthead: View {
    @Environment(AppEnvironment.self) private var environment
    @ScaledMetric(relativeTo: .largeTitle) private var scaledTitleSize: CGFloat = 40
    @ScaledMetric(relativeTo: .subheadline) private var scaledDatelineSize: CGFloat = 15
    let generatedAt: Date
    let art: DailyBriefArt?
    // The edition kind. A `weekly` edition is "The Weekly Review".
    var kind: String? = nil

    @State private var walk = ImageSourceWalk()
    @State private var width: CGFloat = 0

    // Mobile-friendly aspect-fill crop: height tracks the container width but
    // stays inside the 220–360pt band the design allows.
    static func height(forWidth width: CGFloat) -> CGFloat {
        guard width > 0 else { return 280 }
        return min(360, max(220, width * 0.62))
    }

    // The title follows Dynamic Type up to this size, the dateline up to
    // its own. Past that the plate would be mostly type.
    static let titleSizeCap: CGFloat = 58
    static let datelineSizeCap: CGFloat = 26

    /// The plate grows with the type it carries: two title lines, the
    /// dateline, and the room around them. At the default text size the
    /// width rule wins.
    static func plateHeight(width: CGFloat, titleSize: CGFloat, datelineSize: CGFloat) -> CGFloat {
        max(height(forWidth: width), titleSize * 2.4 + datelineSize + 96)
    }

    /// "Wheat Field with Cypresses, Vincent van Gogh, 1889, from The Met".
    /// Two facts join with a word, never a middle dot.
    static func creditLine(credit: String?, source: String?) -> String? {
        guard let credit, !credit.isEmpty else { return nil }
        guard let source, !source.isEmpty else { return credit }
        return "\(credit), from \(source)"
    }

    // The decoded bitmap is sized for the plate, not for the museum file. A
    // fixed target keeps one cache entry per piece across rotations: 2,400
    // pixels on the long side covers an iPad plate at 2x and a phone at 3x.
    static let downsampleTarget = CGSize(width: 1_200, height: 744)
    static let downsampleScale: CGFloat = 2

    static let weeklyReviewTitle = "The Weekly Review"

    static func editionTitle(
        for date: Date,
        kind: String?,
        timeZone: TimeZone = .current,
        locale: Locale = .current
    ) -> String {
        if kind == "weekly" { return weeklyReviewTitle }
        return editionTitle(for: date, timeZone: timeZone, locale: locale)
    }

    static func editionTitle(
        for date: Date,
        timeZone: TimeZone = .current,
        locale: Locale = .current
    ) -> String {
        // The 27 SDKs abbreviate Calendar.weekdaySymbols ("Thu"); the explicit
        // EEEE pattern is the stable way to ask for the full weekday name.
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.dateFormat = "EEEE"
        return "The \(formatter.string(from: date)) Brief"
    }

    private var sources: [URL] { art?.orderedURLs ?? [] }
    private var titleSize: CGFloat { min(scaledTitleSize, Self.titleSizeCap) }
    private var datelineSize: CGFloat { min(scaledDatelineSize, Self.datelineSizeCap) }
    private var plateHeight: CGFloat {
        Self.plateHeight(width: width, titleSize: titleSize, datelineSize: datelineSize)
    }

    var body: some View {
        ZStack {
            // Ordered fallback walking; when every source fails the accent
            // field carries the masthead — never a broken-image state.
            environment.theme.accentSoftColor
            artImage
            scrim
            plateText
        }
        .frame(height: plateHeight)
        .frame(maxWidth: .infinity)
        .clipped()
        .overlay(alignment: .bottomTrailing) { creditText }
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.width
        } action: { newWidth in
            width = newWidth
        }
        .onChange(of: sources) { old, new in
            walk.resetIfSourcesChanged(from: old, to: new)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var artImage: some View {
        if let url = walk.current(in: sources) {
            KFImage(url)
                .setProcessor(DownsamplingImageProcessor(size: Self.downsampleTarget))
                .scaleFactor(Self.downsampleScale)
                .cacheOriginalImage()
                .onFailure { _ in
                    walk.advance(in: sources)
                }
                .placeholder { environment.theme.accentSoftColor }
                .fade(duration: 0.2)
                .resizable()
                .aspectRatio(contentMode: .fill)
        }
    }

    private var scrim: some View {
        LinearGradient(
            stops: [
                .init(color: .black.opacity(0.30), location: 0),
                .init(color: .black.opacity(0.10), location: 0.5),
                .init(color: .black.opacity(0.45), location: 1),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    // The dateline narrates in the display italic; the title answers in the
    // upright display face. One column, so neither can overlap the other.
    private var plateText: some View {
        VStack(spacing: 6) {
            Text(generatedAt.formatted(.dateTime.weekday(.wide).month(.wide).day()))
                .font(environment.theme.displayType.fixedDisplayItalicFont(size: datelineSize))
                .foregroundStyle(.white.opacity(0.9))
            Text(Self.editionTitle(for: generatedAt, kind: kind))
                .font(environment.theme.displayType.fixedDisplayFont(size: titleSize))
                .foregroundStyle(.white)
                .lineLimit(2)
                .minimumScaleFactor(0.6)
                .accessibilityAddTraits(.isHeader)
        }
        .multilineTextAlignment(.center)
        .shadow(color: .black.opacity(0.5), radius: 14, y: 2)
        .padding(.horizontal, 24)
    }

    @ViewBuilder private var creditText: some View {
        if let credit = Self.creditLine(credit: art?.credit, source: art?.source) {
            Text(credit)
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.75))
                .shadow(color: .black.opacity(0.65), radius: 4)
                .lineLimit(2)
                .multilineTextAlignment(.trailing)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
        }
    }
}

extension DisplayTypeChoice {
    /// The display face at a size the caller sets. `Font.custom(_:size:)`
    /// scales again with Dynamic Type; the plate scales its type itself, with
    /// a cap, so it asks for a fixed size.
    func fixedDisplayFont(size: CGFloat) -> Font {
        switch self {
        case .serif:
            Font.custom("Fraunces-SemiBold", fixedSize: size)
        case .sans:
            Font.custom("Geist-SemiBold", fixedSize: size)
        case .rounded:
            Font.system(size: size, weight: .semibold, design: .rounded)
        }
    }

    /// The display italic at a fixed size, for the plate's dateline.
    func fixedDisplayItalicFont(size: CGFloat) -> Font {
        switch self {
        case .serif:
            Font.custom("Fraunces-SemiBoldItalic", fixedSize: size)
        case .sans:
            Font.custom("Geist-SemiBold", fixedSize: size).italic()
        case .rounded:
            Font.system(size: size, weight: .semibold, design: .rounded).italic()
        }
    }
}

// The lede: the letter's opening paragraph in the display face at 21 pt.
// No drop cap, no card. Today places it above the document body.
struct DailyBriefLede: View {
    let text: String

    var body: some View {
        BriefLedeText(text: text)
            .padding(.horizontal, 20)
            .padding(.top, 16)
    }
}

// The footer. A budget edition ends with one sentence from `stats`:
// "38 other messages arrived. None needed you." Older editions keep the
// service sentence: "Made for you by Lab86 using your Gmail and Calendar."
struct DailyBriefFooter: View {
    let report: DailyReportModel

    var body: some View {
        if let noise = report.stats.noise, let selected = report.stats.selected {
            let sentence = DailyBriefFooterCopy.sentence(noise: noise, selected: selected)
            VStack(alignment: .leading, spacing: 0) {
                Divider()
                    .padding(.bottom, 12)
                Text(sentence)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 20)
            .padding(.top, 20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(sentence)
        } else {
            DailyBriefServiceFooter(report: report)
        }
    }
}

// The pre-budget footer, kept for older editions.
struct DailyBriefServiceFooter: View {
    let report: DailyReportModel

    var body: some View {
        let services = DailyBriefServices.derive(
            serviceIDs: report.serviceIDs,
            sectionCounts: report.sectionCounts
        )
        VStack(spacing: 6) {
            Divider()
                .padding(.bottom, 12)
            Text("Made for you by \(Text("Lab86").fontWeight(.semibold)) using your \(DailyBriefServices.sentence(services)).")
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
        // A Confluence page comes from the Atlassian sign-in under the `jira`
        // server; the edition names it as its own service.
        case "confluence": DailyBriefServiceMark(id: id, label: "Confluence", symbol: "doc.text")
        case "slack": DailyBriefServiceMark(id: id, label: "Slack", symbol: "number")
        case "granola": DailyBriefServiceMark(id: id, label: "Granola", symbol: "waveform")
        default:
            DailyBriefServiceMark(id: id, label: id.capitalized, symbol: "app.connected.to.app.below.fill")
        }
    }
}
