import Kingfisher
import SwiftUI

// The masthead of the live Today page (BriefMasthead.tsx, `plain`): the day's
// painting in true color inside a slim moulding, the date on its lower edge,
// and the credit under the frame. The scrim sits only under the words, so the
// painting keeps its color. The painting box lines up with the text margin
// and the moulding sits outside it, on the wall.
struct TodayLiveMasthead: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .largeTitle) private var scaledDateSize: CGFloat = 28
    let generatedAt: Date
    let art: DailyBriefArt?
    /// The height of the page, for the share of it the painting takes.
    let viewportHeight: CGFloat

    @State private var walk = ImageSourceWalk()
    @State private var width: CGFloat = 0

    /// The moulding on the screen.
    static let mouldingWidth: CGFloat = 10
    /// The text margin of the page. The painting lines up with it.
    static let pageMargin: CGFloat = 20
    /// The date follows Dynamic Type up to this size. Past that the painting
    /// would be mostly type.
    static let dateSizeCap: CGFloat = 58

    /// The owner's decision: the art stays big. A wide page gives it 34% of
    /// the viewport inside a fixed band; a narrow page follows its width and
    /// keeps at most that same share.
    static func paintingHeight(width: CGFloat, viewportHeight: CGFloat) -> CGFloat {
        let share = viewportHeight * 0.34
        if width >= 680 { return min(360, max(260, share)) }
        let byWidth = max(192, width * 0.62)
        return viewportHeight > 0 ? min(max(192, share), byWidth) : byWidth
    }

    /// The whole masthead, moulding included, for the toolbar's date.
    static func frameHeight(width: CGFloat, viewportHeight: CGFloat) -> CGFloat {
        paintingHeight(width: width, viewportHeight: viewportHeight) + 2 * mouldingWidth
    }

    /// 28 pt on a phone, up to 48 pt on a wide page, and more with Dynamic Type.
    static func dateSize(width: CGFloat, scaled: CGFloat) -> CGFloat {
        min(dateSizeCap, max(scaled, min(48, width * 0.05)))
    }

    private var sources: [URL] { art?.orderedURLs ?? [] }
    private var dateSize: CGFloat { Self.dateSize(width: width, scaled: scaledDateSize) }

    /// The painting grows with the two lines of the date it carries.
    private var paintingHeight: CGFloat {
        max(Self.paintingHeight(width: width, viewportHeight: viewportHeight), dateSize * 2.2 + 40)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            painting
                .padding(Self.mouldingWidth)
                .background { TodayFrameMoulding() }
                .shadow(color: .black.opacity(0.18), radius: 12, y: 6)
                .padding(.horizontal, Self.pageMargin - Self.mouldingWidth)
                .padding(.top, 8)
                .onGeometryChange(for: CGFloat.self) { proxy in
                    proxy.size.width
                } action: { newWidth in
                    width = max(0, newWidth - 2 * Self.pageMargin)
                }
            creditText
        }
        .onChange(of: sources) { old, new in
            walk.resetIfSourcesChanged(from: old, to: new)
        }
    }

    // The field behind the image takes its size from the frame, and the image
    // fills it as an overlay, so an aspect-fill image can never push the date
    // off the lower edge.
    private var painting: some View {
        environment.theme.accentSoftColor
            .overlay { artImage }
            .clipped()
            .overlay(alignment: .bottom) { scrim }
            .overlay(alignment: .bottomLeading) { dateText }
            .overlay {
                Rectangle()
                    .strokeBorder(Color.black.opacity(0.45), lineWidth: 1)
                    .accessibilityHidden(true)
            }
            .frame(height: paintingHeight)
            .frame(maxWidth: .infinity)
    }

    @ViewBuilder private var artImage: some View {
        if let url = walk.current(in: sources) {
            KFImage(url)
                .setProcessor(DownsamplingImageProcessor(size: DailyBriefMasthead.downsampleTarget))
                .scaleFactor(DailyBriefMasthead.downsampleScale)
                .cacheOriginalImage()
                .onFailure { _ in
                    walk.advance(in: sources)
                }
                .placeholder { environment.theme.accentSoftColor }
                .fade(duration: 0.2)
                .resizable()
                .aspectRatio(contentMode: .fill)
                // A scan often ends in a bright edge. The frame opening hides it.
                .scaleEffect(1.03)
                .accessibilityHidden(true)
        }
    }

    private var scrim: some View {
        LinearGradient(
            stops: [
                .init(color: .black.opacity(0.68), location: 0),
                .init(color: .black.opacity(0.42), location: 0.45),
                .init(color: .black.opacity(0), location: 1),
            ],
            startPoint: .bottom,
            endPoint: .top
        )
        .frame(height: paintingHeight * 0.46)
        .accessibilityHidden(true)
    }

    private var dateText: some View {
        Text(TodayComposition.dateline(generatedAt))
            .font(environment.theme.displayType.fixedDisplayFont(size: dateSize, weight: .medium))
            .foregroundStyle(.white)
            .lineLimit(2)
            .minimumScaleFactor(0.7)
            .multilineTextAlignment(.leading)
            .shadow(color: .black.opacity(0.45), radius: 9, y: 1)
            .padding(16)
            .accessibilityAddTraits(.isHeader)
    }

    // A footnote to the art, so it steps aside at accessibility sizes.
    @ViewBuilder private var creditText: some View {
        if !dynamicTypeSize.isAccessibilitySize,
           let credit = DailyBriefMasthead.creditLine(credit: art?.credit, source: art?.source) {
            Text(credit)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, Self.pageMargin)
                .padding(.top, Self.mouldingWidth + 2)
        }
    }
}

/// One dark moulding with three thin ribs. The web chooses a frame for each
/// day from its asset registry; the app draws this one.
private struct TodayFrameMoulding: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(red: 0.17, green: 0.16, blue: 0.15),
                    Color(red: 0.07, green: 0.07, blue: 0.07),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            Rectangle()
                .strokeBorder(Color.white.opacity(0.12), lineWidth: 1)
            Rectangle()
                .strokeBorder(Color.black.opacity(0.6), lineWidth: 1)
                .padding(3)
            Rectangle()
                .strokeBorder(Color.white.opacity(0.07), lineWidth: 1)
                .padding(6)
        }
        .accessibilityHidden(true)
    }
}
