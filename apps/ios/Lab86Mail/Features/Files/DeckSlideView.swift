import Charts
import SwiftUI

// The one renderer for a version 2 slide: filmstrip thumbnails, the editor
// canvas and presentation mode all draw through here. Colors and fonts come
// from the deck theme only; the application theme never touches a slide.
// Geometry is percent of the slide; type and stroke sizes are points on a
// 960 pt wide slide and scale with the drawn width.

struct DeckSlideView: View {
    let slide: AlbatrossDeckSlideV2
    let theme: AlbatrossDeckTheme
    /// Resolves relative asset paths such as `/art/fallback-1.jpg`.
    var assetBaseURL: URL? = nil
    /// Empty text shows its role name at low opacity, so the editor can find it.
    var showsPlaceholders = false
    /// The element replaced by an inline text field; the renderer skips it.
    var hiddenElementID: String? = nil

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            ZStack(alignment: .topLeading) {
                DeckPalette.color(slide.background, fallback: theme.colors.background, theme: theme)
                if let backgroundImage = slide.backgroundImage {
                    DeckImageContent(
                        url: DeckAssets.url(backgroundImage.src, base: assetBaseURL),
                        alt: "",
                        fit: "cover",
                        focal: backgroundImage.focal,
                        aspect: nil,
                        size: size,
                        theme: theme,
                        slideWidth: size.width
                    )
                    .frame(width: size.width, height: size.height)
                    .clipped()
                    .opacity(backgroundImage.opacity ?? 1)
                }
                ForEach(slide.elements) { element in
                    if element.id != hiddenElementID {
                        DeckElementView(
                            element: element,
                            theme: theme,
                            slideSize: size,
                            assetBaseURL: assetBaseURL,
                            showsPlaceholders: showsPlaceholders
                        )
                    }
                }
            }
            .frame(width: size.width, height: size.height)
            .clipped()
        }
        .aspectRatio(DeckGeometry.aspect, contentMode: .fit)
    }
}

/// One element placed in its box, rotated and faded as the model says.
struct DeckElementView: View {
    let element: AlbatrossDeckElementV2
    let theme: AlbatrossDeckTheme
    let slideSize: CGSize
    var assetBaseURL: URL? = nil
    var showsPlaceholders = false

    var body: some View {
        let rect = DeckGeometry.rect(for: element.bounds, in: slideSize)
        let scale = DeckGeometry.scale(slideWidth: slideSize.width)
        content(rect: rect, scale: scale)
            .frame(width: element.isLine ? nil : max(rect.width, 1), height: element.isLine ? nil : max(rect.height, 1))
            .rotationEffect(.degrees(element.rotation ?? 0))
            .opacity(element.opacity ?? 1)
            .position(x: rect.midX, y: rect.midY)
            .allowsHitTesting(false)
    }

    @ViewBuilder
    private func content(rect: CGRect, scale: Double) -> some View {
        switch element.content {
        case .text(let text):
            DeckTextContent(text: text, theme: theme, scale: scale, showsPlaceholder: showsPlaceholders)
        case .shape(let shape):
            DeckShapeContent(shape: shape, theme: theme, scale: scale)
        case .line(let line):
            DeckLineContent(line: line, rect: rect, theme: theme, scale: scale)
        case .image(let image):
            DeckImageContent(
                url: DeckAssets.url(image.src, base: assetBaseURL),
                alt: image.alt,
                fit: image.fit ?? "cover",
                focal: image.focal,
                aspect: image.aspect,
                size: rect.size,
                theme: theme,
                slideWidth: slideSize.width
            )
            .clipShape(RoundedRectangle(cornerRadius: (image.radius ?? 0) * scale, style: .continuous))
        case .chart(let chart):
            DeckChartContent(chart: chart, theme: theme, scale: scale)
        case .unknown:
            Color.clear
        }
    }
}

// MARK: - Palette and fonts

enum DeckPalette {
    /// A model color, else the fallback token. Only six-digit hex is accepted.
    static func color(_ value: String?, fallback: String, theme: AlbatrossDeckTheme) -> Color {
        if let components = DeckColor.components(value) {
            return Color(red: components.red, green: components.green, blue: components.blue)
        }
        if let components = DeckColor.components(fallback) {
            return Color(red: components.red, green: components.green, blue: components.blue)
        }
        return .clear
    }

    static func design(for family: String) -> Font.Design {
        let name = family.lowercased()
        if name.contains("fraunces") || name.contains("instrument") || name.contains("georgia") { return .serif }
        if name.contains("geist mono") || name.contains("consolas") { return .monospaced }
        return .default
    }

    static func family(for slot: String, theme: AlbatrossDeckTheme) -> String {
        switch slot {
        case "display": theme.fonts.display.family
        case "mono": (theme.fonts.mono ?? theme.fonts.body).family
        default: theme.fonts.body.family
        }
    }

    static func weight(_ value: Int) -> Font.Weight {
        switch value {
        case ..<150: .ultraLight
        case ..<250: .thin
        case ..<350: .light
        case ..<450: .regular
        case ..<550: .medium
        case ..<680: .semibold
        case ..<750: .bold
        case ..<850: .heavy
        default: .black
        }
    }

    static func font(slot: String, size: Double, weight: Int, italic: Bool, theme: AlbatrossDeckTheme) -> Font {
        let font = Font.system(size: size, weight: Self.weight(weight), design: design(for: family(for: slot, theme: theme)))
        return italic ? font.italic() : font
    }

    /// The theme body font at a reference point size, for chart labels.
    static func bodyFont(size: Double, scale: Double, theme: AlbatrossDeckTheme) -> Font {
        font(slot: "body", size: size * scale, weight: 400, italic: false, theme: theme)
    }
}

enum DeckAssets {
    static func url(_ src: String?, base: URL?) -> URL? {
        guard let src, !src.isEmpty else { return nil }
        if let url = URL(string: src), url.scheme != nil { return url }
        guard let base else { return nil }
        var components = URLComponents()
        components.scheme = base.scheme
        components.host = base.host
        components.port = base.port
        let path = src.hasPrefix("/") ? src : "/" + src
        if let question = path.firstIndex(of: "?") {
            components.path = String(path[..<question])
            components.query = String(path[path.index(after: question)...])
        } else {
            components.path = path
        }
        return components.url
    }
}

// MARK: - Text

private struct DeckTextContent: View {
    let text: AlbatrossDeckElementContent.Text
    let theme: AlbatrossDeckTheme
    let scale: Double
    let showsPlaceholder: Bool

    var body: some View {
        let size = text.resolvedSize * scale
        let slot = text.resolvedSlot
        let font = DeckPalette.font(slot: slot, size: size, weight: text.resolvedWeight, italic: text.italic ?? false, theme: theme)
        let alignment = Self.alignment(text.align)
        let vertical = Self.vertical(text.valign)
        let isEmpty = text.text.isEmpty
        let shown = isEmpty && showsPlaceholder ? Self.placeholder(text.role) : text.text
        Text(shown)
            .font(font)
            .kerning((text.letterSpacing ?? 0) * size)
            .lineSpacing(max(0, (text.resolvedLineHeight - 1.2) * size))
            .multilineTextAlignment(alignment.text)
            .foregroundStyle(DeckPalette.color(text.color, fallback: theme.colors.ink, theme: theme))
            .opacity(isEmpty ? 0.4 : 1)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: Alignment(horizontal: alignment.frame, vertical: vertical))
            .background(text.fill.map { DeckPalette.color($0, fallback: theme.colors.surface, theme: theme) } ?? .clear)
    }

    static func alignment(_ value: String?) -> (text: TextAlignment, frame: HorizontalAlignment) {
        switch value {
        case "center": (.center, .center)
        case "right": (.trailing, .trailing)
        default: (.leading, .leading)
        }
    }

    static func vertical(_ value: String?) -> VerticalAlignment {
        switch value {
        case "top": .top
        case "bottom": .bottom
        default: .center
        }
    }

    static func placeholder(_ role: String?) -> String {
        switch role {
        case "title": "Title"
        case "number": "00"
        default: "Text"
        }
    }
}

// MARK: - Shape

private struct DeckShapeContent: View {
    let shape: AlbatrossDeckElementContent.Shape
    let theme: AlbatrossDeckTheme
    let scale: Double

    var body: some View {
        let fill = DeckPalette.color(shape.fill, fallback: theme.colors.surface, theme: theme)
        let path = DeckShapePath(kind: shape.shape ?? "rect", radius: (shape.radius ?? 12) * scale)
        path.fill(fill)
            .overlay {
                if let stroke = shape.stroke {
                    path.stroke(
                        DeckPalette.color(stroke.color, fallback: "#94A3B8", theme: theme),
                        style: DeckStrokes.style(stroke, scale: scale)
                    )
                }
            }
    }
}

private struct DeckShapePath: Shape {
    let kind: String
    let radius: CGFloat

    func path(in rect: CGRect) -> Path {
        switch kind {
        case "ellipse": Path(ellipseIn: rect)
        case "roundRect": Path(roundedRect: rect, cornerRadius: radius, style: .continuous)
        default: Path(rect)
        }
    }
}

enum DeckStrokes {
    /// Dash units follow the web renderer: dash 3/2 and dot 1/1.5 of the stroke width.
    static func style(_ stroke: AlbatrossDeckStroke, scale: Double) -> StrokeStyle {
        let width = max(0.5, stroke.width * scale)
        let dash: [CGFloat]
        switch stroke.dash {
        case "dash": dash = [3, 2].map { $0 * width }
        case "dot": dash = [1, 1.5].map { $0 * width }
        default: dash = []
        }
        return StrokeStyle(lineWidth: width, lineCap: .butt, dash: dash)
    }
}

// MARK: - Line

/// A line fills its box corner to corner. A flat box (height 0) or an
/// upright box (width 0) has no area, so the view takes the stroke's own
/// thickness in that direction and the path runs through its middle;
/// otherwise nothing would paint.
private struct DeckLineContent: View {
    let line: AlbatrossDeckElementContent.Line
    let rect: CGRect
    let theme: AlbatrossDeckTheme
    let scale: Double

    var body: some View {
        let stroke = line.stroke ?? AlbatrossDeckStroke(color: theme.colors.ink, width: 1)
        let style = DeckStrokes.style(stroke, scale: scale)
        let flat = rect.height <= 0
        let upright = rect.width <= 0
        let width = upright ? style.lineWidth : rect.width
        let height = flat ? style.lineWidth : rect.height
        Path { path in
            if flat {
                path.move(to: CGPoint(x: 0, y: height / 2))
                path.addLine(to: CGPoint(x: width, y: height / 2))
            } else if upright {
                path.move(to: CGPoint(x: width / 2, y: 0))
                path.addLine(to: CGPoint(x: width / 2, y: height))
            } else {
                let flip = line.flip ?? false
                path.move(to: CGPoint(x: 0, y: flip ? height : 0))
                path.addLine(to: CGPoint(x: width, y: flip ? 0 : height))
            }
        }
        .stroke(DeckPalette.color(stroke.color, fallback: theme.colors.ink, theme: theme), style: style)
        .frame(width: width, height: height)
    }
}

// MARK: - Image

struct DeckImageContent: View {
    let url: URL?
    let alt: String
    let fit: String
    let focal: AlbatrossDeckFocal?
    let aspect: Double?
    let size: CGSize
    let theme: AlbatrossDeckTheme
    let slideWidth: Double

    var body: some View {
        if let url {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    if fit == "contain" {
                        image.resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(width: size.width, height: size.height, alignment: Self.alignment(focal))
                    } else {
                        cover(image)
                    }
                case .failure:
                    placeholder
                default:
                    Rectangle().fill(DeckPalette.color(theme.colors.surface, fallback: "#DCE6F2", theme: theme))
                }
            }
            .frame(width: size.width, height: size.height)
            .clipped()
        } else {
            placeholder
        }
    }

    /// Cover crop around the focal point. With a known aspect the offset is
    /// exact; without one the focal point rounds to an edge or the center.
    @ViewBuilder
    private func cover(_ image: Image) -> some View {
        if let aspect, aspect > 0, size.width > 0, size.height > 0 {
            let drawn = Self.coverSize(aspect: aspect, in: size)
            let point = focal ?? AlbatrossDeckFocal(x: 0.5, y: 0.5)
            let offsetX = (size.width - drawn.width) * point.x
            let offsetY = (size.height - drawn.height) * point.y
            image.resizable()
                .frame(width: drawn.width, height: drawn.height)
                .offset(x: offsetX, y: offsetY)
                .frame(width: size.width, height: size.height, alignment: .topLeading)
                .clipped()
        } else {
            image.resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: size.width, height: size.height, alignment: Self.alignment(focal))
                .clipped()
        }
    }

    private var placeholder: some View {
        ZStack {
            DeckPalette.color(theme.colors.surface, fallback: "#DCE6F2", theme: theme)
            Text(alt.isEmpty ? "Image" : alt)
                .font(DeckPalette.bodyFont(size: 12, scale: DeckGeometry.scale(slideWidth: slideWidth), theme: theme))
                .foregroundStyle(DeckPalette.color(theme.colors.muted, fallback: "#94A3B8", theme: theme))
                .multilineTextAlignment(.center)
                .padding(8)
        }
        .frame(width: size.width, height: size.height)
        .clipped()
    }

    /// The drawn size of an image that covers the box at its own aspect.
    static func coverSize(aspect: Double, in size: CGSize) -> CGSize {
        let byWidth = CGSize(width: size.width, height: size.width / aspect)
        let byHeight = CGSize(width: size.height * aspect, height: size.height)
        return byWidth.height >= size.height ? byWidth : byHeight
    }

    static func alignment(_ focal: AlbatrossDeckFocal?) -> Alignment {
        guard let focal else { return .center }
        let horizontal: HorizontalAlignment = focal.x < 0.34 ? .leading : focal.x > 0.66 ? .trailing : .center
        let vertical: VerticalAlignment = focal.y < 0.34 ? .top : focal.y > 0.66 ? .bottom : .center
        return Alignment(horizontal: horizontal, vertical: vertical)
    }
}

// MARK: - Chart

private struct DeckChartPoint: Identifiable {
    let id: String
    let series: String
    let category: String
    let value: Double
}

/// Charts draw with Swift Charts from the model's data, in the theme body
/// font and with the same palette order as the export: accent, ink, muted, surface.
private struct DeckChartContent: View {
    let chart: AlbatrossDeckElementContent.Chart
    let theme: AlbatrossDeckTheme
    let scale: Double

    private var colors: [Color] {
        let named = chart.colors?.compactMap { DeckColor.normalized($0) } ?? []
        let hexes = named.isEmpty
            ? [theme.colors.accent, theme.colors.ink, theme.colors.muted, theme.colors.surface]
            : named
        return hexes.map { DeckPalette.color($0, fallback: theme.colors.ink, theme: theme) }
    }

    private var points: [DeckChartPoint] {
        var points: [DeckChartPoint] = []
        for (seriesIndex, series) in chart.series.enumerated() {
            for (index, category) in chart.categories.enumerated() {
                guard index < series.values.count else { continue }
                points.append(DeckChartPoint(
                    id: "\(seriesIndex)-\(index)",
                    series: series.name.isEmpty ? "Series \(seriesIndex + 1)" : series.name,
                    category: category,
                    value: series.values[index]
                ))
            }
        }
        return points
    }

    private var seriesNames: [String] {
        chart.series.enumerated().map { $0.element.name.isEmpty ? "Series \($0.offset + 1)" : $0.element.name }
    }

    private var unit: String { chart.unit ?? "" }
    private var labelFont: Font { DeckPalette.bodyFont(size: 9, scale: scale, theme: theme) }
    private var ink: Color { DeckPalette.color(theme.colors.ink, fallback: "#17202A", theme: theme) }
    private var muted: Color { DeckPalette.color(theme.colors.muted, fallback: "#94A3B8", theme: theme) }

    private func label(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0 ... 2))) + unit
    }

    var body: some View {
        let isPie = chart.chart == "pie" || chart.chart == "doughnut"
        Group {
            if isPie {
                pie
            } else {
                axes
            }
        }
        .chartLegend(chart.showsLegend ? .visible : .hidden)
        .chartLegend(position: .bottom, alignment: .leading)
        .chartForegroundStyleScale(domain: isPie ? chart.categories : seriesNames, range: paletteFor(count: isPie ? chart.categories.count : seriesNames.count))
        .font(labelFont)
        .foregroundStyle(ink)
    }

    private func paletteFor(count: Int) -> [Color] {
        let palette = colors
        guard !palette.isEmpty else { return [ink] }
        return (0 ..< max(count, 1)).map { palette[$0 % palette.count] }
    }

    private var pie: some View {
        let first = chart.series.first?.values ?? []
        let slices = chart.categories.enumerated().compactMap { index, category -> DeckChartPoint? in
            guard index < first.count else { return nil }
            return DeckChartPoint(id: "\(index)", series: category, category: category, value: max(0, first[index]))
        }
        return Chart(slices) { slice in
            SectorMark(
                angle: .value("Value", slice.value),
                innerRadius: .ratio(chart.chart == "doughnut" ? 0.55 : 0),
                angularInset: 1
            )
            .foregroundStyle(by: .value("Category", slice.category))
            .annotation(position: .overlay) {
                if chart.values ?? false, slice.value > 0 {
                    Text(label(slice.value))
                        .font(labelFont)
                        .foregroundStyle(DeckPalette.color(theme.colors.accentInk, fallback: "#FFFFFF", theme: theme))
                }
            }
        }
    }

    private var axes: some View {
        let points = points
        let maximum = max(1, points.map(\.value).max() ?? 1)
        let ticks = [0, maximum / 2, maximum]
        let horizontal = chart.chart == "bar"
        let base = Chart(points) { point in
            if chart.chart == "line" {
                LineMark(x: .value("Category", point.category), y: .value("Value", point.value))
                    .foregroundStyle(by: .value("Series", point.series))
                    .lineStyle(StrokeStyle(lineWidth: 2 * scale, lineCap: .round, lineJoin: .round))
                PointMark(x: .value("Category", point.category), y: .value("Value", point.value))
                    .foregroundStyle(by: .value("Series", point.series))
                    .symbolSize(24 * scale * scale)
            } else if horizontal {
                BarMark(x: .value("Value", point.value), y: .value("Category", point.category))
                    .foregroundStyle(by: .value("Series", point.series))
                    .position(by: .value("Series", point.series))
                    .annotation(position: .trailing, spacing: 2 * scale) { valueLabel(point) }
            } else {
                BarMark(x: .value("Category", point.category), y: .value("Value", point.value))
                    .foregroundStyle(by: .value("Series", point.series))
                    .position(by: .value("Series", point.series))
                    .annotation(position: .top, spacing: 2 * scale) { valueLabel(point) }
            }
        }
        return Group {
            if horizontal {
                base
                    .chartYScale(domain: chart.categories.reversed())
                    .chartXAxis { valueMarks(ticks) }
                    .chartYAxis { categoryMarks }
            } else {
                base
                    .chartXScale(domain: chart.categories)
                    .chartXAxis { categoryMarks }
                    .chartYAxis { valueMarks(ticks, position: .leading) }
            }
        }
    }

    /// Category labels in ink, no grid.
    private var categoryMarks: some AxisContent {
        AxisMarks(values: chart.categories) { value in
            AxisValueLabel {
                if let category = value.as(String.self) {
                    Text(category).font(labelFont).foregroundStyle(ink)
                }
            }
        }
    }

    /// Three value ticks: a solid baseline and two dashed grid lines, labels in muted.
    private func valueMarks(_ ticks: [Double], position: AxisMarkPosition = .automatic) -> some AxisContent {
        AxisMarks(position: position, values: ticks) { value in
            AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: value.index == 0 ? [] : [2, 2]))
                .foregroundStyle(muted.opacity(value.index == 0 ? 0.9 : 0.5))
            AxisValueLabel {
                if let number = value.as(Double.self) {
                    Text(label(number.rounded())).font(labelFont).foregroundStyle(muted)
                }
            }
        }
    }

    @ViewBuilder
    private func valueLabel(_ point: DeckChartPoint) -> some View {
        if chart.values ?? false {
            Text(label(point.value))
                .font(labelFont)
                .foregroundStyle(ink)
        }
    }
}
