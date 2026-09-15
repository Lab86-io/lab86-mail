import Foundation

// Version 2 presentation model, decoded for the native canvas. Every type
// keeps an `extra` bag with the JSON fields it does not model, and `json`
// writes the known fields over that bag. A deck that passes through the
// native app keeps every field: unknown, future, `name`, `groupId`,
// `locked`, `overlapAllowed`, `decorative`, `source`. The web schema is
// `deckModelV2Schema` in `lib/documents/model.ts`.

private func number(_ value: JSONValue?) -> Double? {
    guard case .number(let number) = value, number.isFinite else { return nil }
    return number
}

private func bag(_ json: JSONValue, without known: Set<String>) -> [String: JSONValue] {
    (json.objectValue ?? [:]).filter { !known.contains($0.key) }
}

private func merged(_ extra: [String: JSONValue], _ fields: [String: JSONValue]) -> JSONValue {
    var object = extra
    for (key, value) in fields { object[key] = value }
    return .object(object)
}

/// A theme font pair: the web family and the export face.
struct AlbatrossDeckFont: Hashable, Sendable {
    var family: String
    var exportFamily: String?
    var fallback: String?
    var extra: [String: JSONValue] = [:]

    private static let known: Set<String> = ["family", "exportFamily", "fallback"]

    init(family: String, exportFamily: String? = nil, fallback: String? = nil) {
        self.family = family
        self.exportFamily = exportFamily
        self.fallback = fallback
    }

    init?(json: JSONValue?) {
        guard let json, let family = json["family"]?.stringValue, !family.isEmpty else { return nil }
        self.family = family
        exportFamily = json["exportFamily"]?.stringValue
        fallback = json["fallback"]?.stringValue
        extra = bag(json, without: Self.known)
    }

    var json: JSONValue {
        var fields: [String: JSONValue] = ["family": .string(family)]
        if let exportFamily { fields["exportFamily"] = .string(exportFamily) }
        if let fallback { fields["fallback"] = .string(fallback) }
        return merged(extra, fields)
    }
}

struct AlbatrossDeckTheme: Hashable, Sendable {
    struct Colors: Hashable, Sendable {
        var background: String
        var surface: String
        var ink: String
        var muted: String
        var accent: String
        var accentInk: String
        var extra: [String: JSONValue] = [:]

        private static let known: Set<String> = ["background", "surface", "ink", "muted", "accent", "accentInk"]

        init(background: String, surface: String, ink: String, muted: String, accent: String, accentInk: String) {
            self.background = background
            self.surface = surface
            self.ink = ink
            self.muted = muted
            self.accent = accent
            self.accentInk = accentInk
        }

        init?(json: JSONValue?) {
            guard let json,
                  let background = json["background"]?.stringValue,
                  let surface = json["surface"]?.stringValue,
                  let ink = json["ink"]?.stringValue,
                  let muted = json["muted"]?.stringValue,
                  let accent = json["accent"]?.stringValue,
                  let accentInk = json["accentInk"]?.stringValue else { return nil }
            self.init(background: background, surface: surface, ink: ink, muted: muted, accent: accent, accentInk: accentInk)
            extra = bag(json, without: Self.known)
        }

        var json: JSONValue {
            merged(extra, [
                "background": .string(background),
                "surface": .string(surface),
                "ink": .string(ink),
                "muted": .string(muted),
                "accent": .string(accent),
                "accentInk": .string(accentInk),
            ])
        }
    }

    struct Fonts: Hashable, Sendable {
        var display: AlbatrossDeckFont
        var body: AlbatrossDeckFont
        var mono: AlbatrossDeckFont?
        var extra: [String: JSONValue] = [:]

        private static let known: Set<String> = ["display", "body", "mono"]

        init(display: AlbatrossDeckFont, body: AlbatrossDeckFont, mono: AlbatrossDeckFont? = nil) {
            self.display = display
            self.body = body
            self.mono = mono
        }

        init?(json: JSONValue?) {
            guard let json,
                  let display = AlbatrossDeckFont(json: json["display"]),
                  let body = AlbatrossDeckFont(json: json["body"]) else { return nil }
            self.init(display: display, body: body, mono: AlbatrossDeckFont(json: json["mono"]))
            extra = bag(json, without: Self.known)
        }

        var json: JSONValue {
            var fields: [String: JSONValue] = ["display": display.json, "body": body.json]
            if let mono { fields["mono"] = mono.json }
            return merged(extra, fields)
        }
    }

    var name: String?
    var colors: Colors
    var fonts: Fonts
    var extra: [String: JSONValue] = [:]

    private static let known: Set<String> = ["name", "colors", "fonts"]

    init(name: String? = nil, colors: Colors, fonts: Fonts) {
        self.name = name
        self.colors = colors
        self.fonts = fonts
    }

    init?(json: JSONValue?) {
        guard let json, json.objectValue != nil,
              let colors = Colors(json: json["colors"]),
              let fonts = Fonts(json: json["fonts"]) else { return nil }
        self.init(name: json["name"]?.stringValue, colors: colors, fonts: fonts)
        extra = bag(json, without: Self.known)
    }

    var json: JSONValue {
        var fields: [String: JSONValue] = ["colors": colors.json, "fonts": fonts.json]
        if let name { fields["name"] = .string(name) }
        return merged(extra, fields)
    }

    /// The two shipped directions. Applying a preset keeps the theme's extra fields.
    static let editorial = AlbatrossDeckTheme(
        name: "Editorial",
        colors: Colors(background: "#F4F1EA", surface: "#E7E1D3", ink: "#1E2A38", muted: "#5E5A51", accent: "#AE4B2B", accentInk: "#FFFFFF"),
        fonts: Fonts(
            display: AlbatrossDeckFont(family: "Fraunces", exportFamily: "Georgia", fallback: "serif"),
            body: AlbatrossDeckFont(family: "Geist", exportFamily: "Aptos", fallback: "sans-serif"),
            mono: AlbatrossDeckFont(family: "Geist Mono", exportFamily: "Consolas", fallback: "monospace")
        )
    )

    static let signal = AlbatrossDeckTheme(
        name: "Signal",
        colors: Colors(background: "#F7F7F4", surface: "#E4E6E9", ink: "#0B0F14", muted: "#5B6470", accent: "#2F5BFF", accentInk: "#FFFFFF"),
        fonts: Fonts(
            display: AlbatrossDeckFont(family: "Geist", exportFamily: "Aptos", fallback: "sans-serif"),
            body: AlbatrossDeckFont(family: "Geist", exportFamily: "Aptos", fallback: "sans-serif"),
            mono: AlbatrossDeckFont(family: "Geist Mono", exportFamily: "Consolas", fallback: "monospace")
        )
    )

    static let presets: [AlbatrossDeckTheme] = [.editorial, .signal]

    /// Replace colors, fonts and name with a preset; keep this theme's unknown fields.
    mutating func apply(preset: AlbatrossDeckTheme) {
        name = preset.name
        colors = preset.colors
        fonts = preset.fonts
    }
}

struct AlbatrossDeckStroke: Hashable, Sendable {
    var color: String
    var width: Double
    var dash: String?
    var extra: [String: JSONValue] = [:]

    private static let known: Set<String> = ["color", "width", "dash"]

    init(color: String, width: Double, dash: String? = nil) {
        self.color = color
        self.width = width
        self.dash = dash
    }

    init?(json: JSONValue?) {
        guard let json, let color = json["color"]?.stringValue, let width = number(json["width"]) else { return nil }
        self.init(color: color, width: width, dash: json["dash"]?.stringValue)
        extra = bag(json, without: Self.known)
    }

    var json: JSONValue {
        var fields: [String: JSONValue] = ["color": .string(color), "width": .number(width)]
        if let dash { fields["dash"] = .string(dash) }
        return merged(extra, fields)
    }
}

struct AlbatrossDeckFocal: Hashable, Sendable {
    var x: Double
    var y: Double
    var extra: [String: JSONValue] = [:]

    init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }

    init?(json: JSONValue?) {
        guard let json, let x = number(json["x"]), let y = number(json["y"]) else { return nil }
        self.init(x: x, y: y)
        extra = bag(json, without: ["x", "y"])
    }

    var json: JSONValue { merged(extra, ["x": .number(x), "y": .number(y)]) }
}

struct AlbatrossDeckChartSeries: Hashable, Sendable {
    var name: String
    var values: [Double]
    var extra: [String: JSONValue] = [:]

    init(name: String, values: [Double]) {
        self.name = name
        self.values = values
    }

    init?(json: JSONValue) {
        guard json.objectValue != nil else { return nil }
        name = json["name"]?.stringValue ?? ""
        values = (json["values"]?.arrayValue ?? []).compactMap { number($0) }
        extra = bag(json, without: ["name", "values"])
    }

    var json: JSONValue {
        merged(extra, ["name": .string(name), "values": .array(values.map(JSONValue.number))])
    }
}

/// The typed part of an element. Geometry and the shared fields live on the element.
enum AlbatrossDeckElementContent: Hashable, Sendable {
    case text(Text)
    case shape(Shape)
    case line(Line)
    case image(Image)
    case chart(Chart)
    /// An element type this build does not know. It renders nothing and saves unchanged.
    case unknown(type: String)

    struct Text: Hashable, Sendable {
        var text: String
        var role: String?
        var font: String?
        var fontSize: Double?
        var fontWeight: Int?
        var italic: Bool?
        var align: String?
        var valign: String?
        var lineHeight: Double?
        var letterSpacing: Double?
        var color: String?
        var fill: String?

        static let known: Set<String> = [
            "text", "role", "font", "fontSize", "fontWeight", "italic", "align", "valign",
            "lineHeight", "letterSpacing", "color", "fill",
        ]

        init(text: String, role: String? = nil, fontSize: Double? = nil) {
            self.text = text
            self.role = role
            self.fontSize = fontSize
        }

        init(json: JSONValue) {
            text = json["text"]?.stringValue ?? ""
            role = json["role"]?.stringValue
            font = json["font"]?.stringValue
            fontSize = number(json["fontSize"])
            fontWeight = number(json["fontWeight"]).flatMap { Int(exactly: $0) }
            italic = json["italic"]?.boolValue
            align = json["align"]?.stringValue
            valign = json["valign"]?.stringValue
            lineHeight = number(json["lineHeight"])
            letterSpacing = number(json["letterSpacing"])
            color = json["color"]?.stringValue
            fill = json["fill"]?.stringValue
        }

        var fields: [String: JSONValue] {
            var fields: [String: JSONValue] = ["type": .string("text"), "text": .string(text)]
            if let role { fields["role"] = .string(role) }
            if let font { fields["font"] = .string(font) }
            if let fontSize { fields["fontSize"] = .number(fontSize) }
            if let fontWeight { fields["fontWeight"] = .number(Double(fontWeight)) }
            if let italic { fields["italic"] = .bool(italic) }
            if let align { fields["align"] = .string(align) }
            if let valign { fields["valign"] = .string(valign) }
            if let lineHeight { fields["lineHeight"] = .number(lineHeight) }
            if let letterSpacing { fields["letterSpacing"] = .number(letterSpacing) }
            if let color { fields["color"] = .string(color) }
            if let fill { fields["fill"] = .string(fill) }
            return fields
        }

        /// Default type size by role, in points at a 960 pt slide width. Same table as the web renderer.
        var resolvedSize: Double {
            if let fontSize, fontSize > 0 { return fontSize }
            switch role {
            case "title": return 28
            case "number": return 64
            case "subtitle": return 20
            case "caption", "kicker": return 12
            default: return 16
            }
        }

        /// Theme font slot: explicit, else display for titles and numbers.
        var resolvedSlot: String {
            if let font { return font }
            return role == "title" || role == "number" ? "display" : "body"
        }

        var resolvedWeight: Int {
            fontWeight ?? (role == "title" || role == "number" ? 650 : 400)
        }

        var resolvedLineHeight: Double {
            lineHeight ?? (resolvedSlot == "display" ? 1.05 : 1.3)
        }
    }

    struct Shape: Hashable, Sendable {
        var shape: String?
        var fill: String?
        var stroke: AlbatrossDeckStroke?
        var radius: Double?

        static let known: Set<String> = ["shape", "fill", "stroke", "radius"]

        init(shape: String? = nil, fill: String? = nil, stroke: AlbatrossDeckStroke? = nil, radius: Double? = nil) {
            self.shape = shape
            self.fill = fill
            self.stroke = stroke
            self.radius = radius
        }

        init(json: JSONValue) {
            shape = json["shape"]?.stringValue
            fill = json["fill"]?.stringValue
            stroke = AlbatrossDeckStroke(json: json["stroke"])
            radius = number(json["radius"])
        }

        var fields: [String: JSONValue] {
            var fields: [String: JSONValue] = ["type": .string("shape")]
            if let shape { fields["shape"] = .string(shape) }
            if let fill { fields["fill"] = .string(fill) }
            if let stroke { fields["stroke"] = stroke.json }
            if let radius { fields["radius"] = .number(radius) }
            return fields
        }
    }

    struct Line: Hashable, Sendable {
        var flip: Bool?
        var stroke: AlbatrossDeckStroke?

        static let known: Set<String> = ["flip", "stroke"]

        init(flip: Bool? = nil, stroke: AlbatrossDeckStroke?) {
            self.flip = flip
            self.stroke = stroke
        }

        init(json: JSONValue) {
            flip = json["flip"]?.boolValue
            stroke = AlbatrossDeckStroke(json: json["stroke"])
        }

        var fields: [String: JSONValue] {
            var fields: [String: JSONValue] = ["type": .string("line")]
            if let flip { fields["flip"] = .bool(flip) }
            if let stroke { fields["stroke"] = stroke.json }
            return fields
        }
    }

    struct Image: Hashable, Sendable {
        var assetID: String
        var src: String?
        var alt: String
        var fit: String?
        var focal: AlbatrossDeckFocal?
        var aspect: Double?
        var radius: Double?
        var source: String?
        var decorative: Bool?

        static let known: Set<String> = ["assetId", "src", "alt", "fit", "focal", "aspect", "radius", "source", "decorative"]

        init(assetID: String, src: String? = nil, alt: String) {
            self.assetID = assetID
            self.src = src
            self.alt = alt
        }

        init(json: JSONValue) {
            assetID = json["assetId"]?.stringValue ?? ""
            src = json["src"]?.stringValue
            alt = json["alt"]?.stringValue ?? ""
            fit = json["fit"]?.stringValue
            focal = AlbatrossDeckFocal(json: json["focal"])
            aspect = number(json["aspect"])
            radius = number(json["radius"])
            source = json["source"]?.stringValue
            decorative = json["decorative"]?.boolValue
        }

        var fields: [String: JSONValue] {
            var fields: [String: JSONValue] = ["type": .string("image"), "assetId": .string(assetID), "alt": .string(alt)]
            if let src { fields["src"] = .string(src) }
            if let fit { fields["fit"] = .string(fit) }
            if let focal { fields["focal"] = focal.json }
            if let aspect { fields["aspect"] = .number(aspect) }
            if let radius { fields["radius"] = .number(radius) }
            if let source { fields["source"] = .string(source) }
            if let decorative { fields["decorative"] = .bool(decorative) }
            return fields
        }
    }

    struct Chart: Hashable, Sendable {
        var chart: String
        var categories: [String]
        var series: [AlbatrossDeckChartSeries]
        var colors: [String]?
        var legend: Bool?
        var values: Bool?
        var unit: String?
        var source: String?

        static let known: Set<String> = ["chart", "categories", "series", "colors", "legend", "values", "unit", "source"]
        static let kinds = ["bar", "column", "line", "pie", "doughnut"]

        init(chart: String, categories: [String], series: [AlbatrossDeckChartSeries]) {
            self.chart = chart
            self.categories = categories
            self.series = series
        }

        init(json: JSONValue) {
            chart = json["chart"]?.stringValue ?? "column"
            categories = (json["categories"]?.arrayValue ?? []).compactMap(\.stringValue)
            series = (json["series"]?.arrayValue ?? []).compactMap(AlbatrossDeckChartSeries.init)
            colors = json["colors"]?.arrayValue.map { $0.compactMap(\.stringValue) }
            legend = json["legend"]?.boolValue
            values = json["values"]?.boolValue
            unit = json["unit"]?.stringValue
            source = json["source"]?.stringValue
        }

        var fields: [String: JSONValue] {
            var fields: [String: JSONValue] = [
                "type": .string("chart"),
                "chart": .string(chart),
                "categories": .strings(categories),
                "series": .array(series.map(\.json)),
            ]
            if let colors { fields["colors"] = .strings(colors) }
            if let legend { fields["legend"] = .bool(legend) }
            if let values { fields["values"] = .bool(values) }
            if let unit { fields["unit"] = .string(unit) }
            if let source { fields["source"] = .string(source) }
            return fields
        }

        var showsLegend: Bool { legend ?? (series.count > 1) }
    }

    var typeName: String {
        switch self {
        case .text: "text"
        case .shape: "shape"
        case .line: "line"
        case .image: "image"
        case .chart: "chart"
        case .unknown(let type): type
        }
    }

    fileprivate var knownKeys: Set<String> {
        switch self {
        case .text: Text.known
        case .shape: Shape.known
        case .line: Line.known
        case .image: Image.known
        case .chart: Chart.known
        case .unknown: []
        }
    }

    fileprivate var fields: [String: JSONValue] {
        switch self {
        case .text(let text): text.fields
        case .shape(let shape): shape.fields
        case .line(let line): line.fields
        case .image(let image): image.fields
        case .chart(let chart): chart.fields
        case .unknown(let type): ["type": .string(type)]
        }
    }
}

struct AlbatrossDeckElementV2: Identifiable, Hashable, Sendable {
    var id: String
    var x: Double
    var y: Double
    var width: Double
    var height: Double
    var rotation: Double?
    var opacity: Double?
    var locked: Bool?
    var groupID: String?
    var name: String?
    var overlapAllowed: Bool?
    var content: AlbatrossDeckElementContent
    var extra: [String: JSONValue] = [:]

    private static let known: Set<String> = [
        "id", "type", "x", "y", "width", "height", "rotation", "opacity", "locked", "groupId", "name", "overlapAllowed",
    ]

    init(
        id: String = UUID().uuidString,
        x: Double,
        y: Double,
        width: Double,
        height: Double,
        content: AlbatrossDeckElementContent
    ) {
        self.id = id
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.content = content
    }

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue,
              let type = json["type"]?.stringValue,
              let x = number(json["x"]),
              let y = number(json["y"]),
              let width = number(json["width"]),
              let height = number(json["height"]) else { return nil }
        self.id = id
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        rotation = number(json["rotation"])
        opacity = number(json["opacity"])
        locked = json["locked"]?.boolValue
        groupID = json["groupId"]?.stringValue
        name = json["name"]?.stringValue
        overlapAllowed = json["overlapAllowed"]?.boolValue
        switch type {
        case "text": content = .text(.init(json: json))
        case "shape": content = .shape(.init(json: json))
        case "line": content = .line(.init(json: json))
        case "image": content = .image(.init(json: json))
        case "chart": content = .chart(.init(json: json))
        default: content = .unknown(type: type)
        }
        extra = bag(json, without: Self.known.union(content.knownKeys))
    }

    var json: JSONValue {
        var fields = content.fields
        fields["id"] = .string(id)
        fields["x"] = .number(x)
        fields["y"] = .number(y)
        fields["width"] = .number(width)
        fields["height"] = .number(height)
        if let rotation { fields["rotation"] = .number(rotation) }
        if let opacity { fields["opacity"] = .number(opacity) }
        if let locked { fields["locked"] = .bool(locked) }
        if let groupID { fields["groupId"] = .string(groupID) }
        if let name { fields["name"] = .string(name) }
        if let overlapAllowed { fields["overlapAllowed"] = .bool(overlapAllowed) }
        return merged(extra, fields)
    }

    var isLine: Bool {
        if case .line = content { return true }
        return false
    }

    var isLocked: Bool { locked ?? false }

    /// Readable text for search and the filmstrip: text runs, image alt, chart data.
    var readableText: String {
        switch content {
        case .text(let text): text.text
        case .image(let image): image.alt
        case .chart(let chart):
            chart.series.map { series in
                let pairs = zip(chart.categories, series.values).map { "\($0) \($1.formatted())" }
                return "\(series.name): \(pairs.joined(separator: ", "))"
            }.joined(separator: "\n")
        default: ""
        }
    }

    /// A short label for the inspector and the layer list.
    var label: String {
        if let name, !name.isEmpty { return name }
        switch content {
        case .text(let text): return text.role.map { $0.prefix(1).uppercased() + $0.dropFirst() } ?? "Text"
        case .shape(let shape):
            switch shape.shape {
            case "ellipse": return "Ellipse"
            case "roundRect": return "Rounded rectangle"
            default: return "Rectangle"
            }
        case .line: return "Line"
        case .image: return "Image"
        case .chart(let chart): return chart.chart.prefix(1).uppercased() + chart.chart.dropFirst() + " chart"
        case .unknown(let type): return type
        }
    }
}

struct AlbatrossDeckBackgroundImage: Hashable, Sendable {
    var assetID: String
    var src: String?
    var opacity: Double?
    var focal: AlbatrossDeckFocal?
    var extra: [String: JSONValue] = [:]

    private static let known: Set<String> = ["assetId", "src", "opacity", "focal"]

    init?(json: JSONValue?) {
        guard let json, json.objectValue != nil else { return nil }
        assetID = json["assetId"]?.stringValue ?? ""
        src = json["src"]?.stringValue
        opacity = number(json["opacity"])
        focal = AlbatrossDeckFocal(json: json["focal"])
        extra = bag(json, without: Self.known)
    }

    var json: JSONValue {
        var fields: [String: JSONValue] = ["assetId": .string(assetID)]
        if let src { fields["src"] = .string(src) }
        if let opacity { fields["opacity"] = .number(opacity) }
        if let focal { fields["focal"] = focal.json }
        return merged(extra, fields)
    }
}

struct AlbatrossDeckSlideV2: Identifiable, Hashable, Sendable {
    var id: String
    var title: String
    var notes: String?
    var background: String?
    var backgroundImage: AlbatrossDeckBackgroundImage?
    var elements: [AlbatrossDeckElementV2]
    var extra: [String: JSONValue] = [:]

    private static let known: Set<String> = ["id", "title", "notes", "background", "backgroundImage", "elements"]

    init(id: String = UUID().uuidString, title: String, notes: String? = nil, elements: [AlbatrossDeckElementV2] = []) {
        self.id = id
        self.title = title
        self.notes = notes
        self.elements = elements
    }

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue else { return nil }
        var elements: [AlbatrossDeckElementV2] = []
        for raw in json["elements"]?.arrayValue ?? [] {
            guard let element = AlbatrossDeckElementV2(json: raw) else { return nil }
            elements.append(element)
        }
        self.id = id
        title = json["title"]?.stringValue ?? ""
        notes = json["notes"]?.stringValue
        background = json["background"]?.stringValue
        backgroundImage = AlbatrossDeckBackgroundImage(json: json["backgroundImage"])
        self.elements = elements
        extra = bag(json, without: Self.known)
    }

    var json: JSONValue {
        var fields: [String: JSONValue] = [
            "id": .string(id),
            "title": .string(title),
            "elements": .array(elements.map(\.json)),
        ]
        if let notes { fields["notes"] = .string(notes) }
        if let background { fields["background"] = .string(background) }
        if let backgroundImage { fields["backgroundImage"] = backgroundImage.json }
        return merged(extra, fields)
    }

    /// The slide with new element ids, for duplication.
    func copy() -> AlbatrossDeckSlideV2 {
        var copy = self
        copy.id = UUID().uuidString
        copy.elements = elements.map { element in
            var element = element
            element.id = UUID().uuidString
            return element
        }
        return copy
    }
}

struct AlbatrossDeckV2: Hashable, Sendable {
    var activeSlideID: String
    var theme: AlbatrossDeckTheme
    var slides: [AlbatrossDeckSlideV2]
    var extra: [String: JSONValue] = [:]

    private static let known: Set<String> = ["kind", "version", "activeSlideId", "theme", "slides"]

    init(activeSlideID: String, theme: AlbatrossDeckTheme, slides: [AlbatrossDeckSlideV2]) {
        self.activeSlideID = activeSlideID
        self.theme = theme
        self.slides = slides
    }

    init?(json: JSONValue) {
        guard json["kind"]?.stringValue == "deck",
              json["version"]?.doubleValue == 2,
              let theme = AlbatrossDeckTheme(json: json["theme"]),
              let rawSlides = json["slides"]?.arrayValue,
              !rawSlides.isEmpty else { return nil }
        var slides: [AlbatrossDeckSlideV2] = []
        var seen: Set<String> = []
        for raw in rawSlides {
            // Duplicate slide ids break list identity and pickers; refuse the deck.
            guard let slide = AlbatrossDeckSlideV2(json: raw), seen.insert(slide.id).inserted else { return nil }
            slides.append(slide)
        }
        self.theme = theme
        self.slides = slides
        activeSlideID = json["activeSlideId"]?.stringValue ?? slides[0].id
        extra = bag(json, without: Self.known)
    }

    var json: JSONValue {
        merged(extra, [
            "kind": .string("deck"),
            "version": .number(2),
            "activeSlideId": .string(activeSlideID),
            "theme": theme.json,
            "slides": .array(slides.map(\.json)),
        ])
    }

    var activeIndex: Int {
        slides.firstIndex { $0.id == activeSlideID } ?? 0
    }

    var activeSlide: AlbatrossDeckSlideV2 { slides[activeIndex] }

    // MARK: - Edits

    /// Apply a change to one element on the active slide. Other elements are untouched.
    mutating func updateElement(_ id: String, _ change: (inout AlbatrossDeckElementV2) -> Void) {
        let slideIndex = activeIndex
        guard let index = slides[slideIndex].elements.firstIndex(where: { $0.id == id }) else { return }
        change(&slides[slideIndex].elements[index])
    }

    mutating func updateActiveSlide(_ change: (inout AlbatrossDeckSlideV2) -> Void) {
        change(&slides[activeIndex])
    }

    mutating func appendElement(_ element: AlbatrossDeckElementV2) {
        slides[activeIndex].elements.append(element)
    }

    mutating func removeElement(_ id: String) {
        slides[activeIndex].elements.removeAll { $0.id == id }
    }

    /// Move an element one step toward the front (`+1`) or the back (`-1`) of the slide.
    mutating func moveElement(_ id: String, by step: Int) {
        let slideIndex = activeIndex
        guard let index = slides[slideIndex].elements.firstIndex(where: { $0.id == id }) else { return }
        let target = index + step
        guard slides[slideIndex].elements.indices.contains(target) else { return }
        slides[slideIndex].elements.swapAt(index, target)
    }

    mutating func addSlide(after id: String? = nil) -> String {
        let count = slides.count + 1
        var slide = AlbatrossDeckSlideV2(title: "Slide \(count)")
        slide.elements = [
            AlbatrossDeckElementV2(x: 6, y: 16, width: 60, height: 18, content: .text(.init(text: "", role: "title", fontSize: 34))),
            AlbatrossDeckElementV2(x: 6, y: 40, width: 60, height: 30, content: .text(.init(text: "", role: "body", fontSize: 16))),
        ]
        let index = (slides.firstIndex { $0.id == (id ?? activeSlideID) } ?? slides.count - 1) + 1
        slides.insert(slide, at: min(index, slides.count))
        activeSlideID = slide.id
        return slide.id
    }

    mutating func duplicateSlide(_ id: String) {
        guard let index = slides.firstIndex(where: { $0.id == id }) else { return }
        let copy = slides[index].copy()
        slides.insert(copy, at: index + 1)
        activeSlideID = copy.id
    }

    /// Remove a slide. The deck always keeps one slide.
    mutating func deleteSlide(_ id: String) {
        guard slides.count > 1, let index = slides.firstIndex(where: { $0.id == id }) else { return }
        slides.remove(at: index)
        if activeSlideID == id { activeSlideID = slides[min(index, slides.count - 1)].id }
    }

    mutating func moveSlide(_ id: String, by step: Int) {
        guard let index = slides.firstIndex(where: { $0.id == id }) else { return }
        let target = index + step
        guard slides.indices.contains(target) else { return }
        slides.swapAt(index, target)
    }
}

// MARK: - Geometry

/// Pure geometry for the canvas. All positions are percent of the slide; sizes
/// authored in points refer to a 960 pt wide slide.
enum DeckGeometry {
    static let referenceWidth: Double = 960
    static let referenceHeight: Double = 540
    static let aspect: Double = 16.0 / 9.0
    static let minimumSize: Double = 1

    struct Bounds: Equatable, Sendable {
        var x: Double
        var y: Double
        var width: Double
        var height: Double
    }

    enum Corner: CaseIterable, Sendable {
        case topLeading, topTrailing, bottomLeading, bottomTrailing
    }

    private static func round2(_ value: Double) -> Double {
        (value * 100).rounded() / 100
    }

    /// Scale factor from reference points to the drawn slide.
    static func scale(slideWidth: Double) -> Double {
        slideWidth > 0 ? slideWidth / referenceWidth : 0
    }

    /// Reference points to drawn points.
    static func points(_ value: Double, slideWidth: Double) -> Double {
        value * scale(slideWidth: slideWidth)
    }

    /// Drawn points to percent of a slide dimension.
    static func percent(_ points: Double, of dimension: Double) -> Double {
        dimension > 0 ? points / dimension * 100 : 0
    }

    /// Element bounds in drawn points.
    static func rect(for bounds: Bounds, in size: CGSize) -> CGRect {
        CGRect(
            x: size.width * bounds.x / 100,
            y: size.height * bounds.y / 100,
            width: size.width * bounds.width / 100,
            height: size.height * bounds.height / 100
        )
    }

    /// Keep an element inside the slide with a usable minimum size. Lines may be flat (minimum 0).
    static func clamp(_ bounds: Bounds, minimumSize: Double = minimumSize) -> Bounds {
        let width = round2(min(100, max(minimumSize, bounds.width.isFinite ? bounds.width : minimumSize)))
        let height = round2(min(100, max(minimumSize, bounds.height.isFinite ? bounds.height : minimumSize)))
        let x = min(100 - width, max(0, bounds.x.isFinite ? bounds.x : 0))
        let y = min(100 - height, max(0, bounds.y.isFinite ? bounds.y : 0))
        return Bounds(x: round2(x), y: round2(y), width: width, height: height)
    }

    /// Move by a drag translation measured in drawn points.
    static func moved(_ bounds: Bounds, by translation: CGSize, in size: CGSize, minimumSize: Double = minimumSize) -> Bounds {
        var next = bounds
        next.x += percent(translation.width, of: size.width)
        next.y += percent(translation.height, of: size.height)
        return clamp(next, minimumSize: minimumSize)
    }

    /// Resize from one corner by a drag translation in drawn points. The opposite corner stays fixed.
    static func resized(
        _ bounds: Bounds,
        corner: Corner,
        by translation: CGSize,
        in size: CGSize,
        minimumSize: Double = minimumSize
    ) -> Bounds {
        let dx = percent(translation.width, of: size.width)
        let dy = percent(translation.height, of: size.height)
        var left = bounds.x
        var top = bounds.y
        var right = bounds.x + bounds.width
        var bottom = bounds.y + bounds.height
        switch corner {
        case .topLeading:
            left += dx
            top += dy
        case .topTrailing:
            right += dx
            top += dy
        case .bottomLeading:
            left += dx
            bottom += dy
        case .bottomTrailing:
            right += dx
            bottom += dy
        }
        left = min(max(0, left), 100)
        top = min(max(0, top), 100)
        right = min(max(0, right), 100)
        bottom = min(max(0, bottom), 100)
        // The dragged edge never crosses the fixed edge.
        switch corner {
        case .topLeading:
            left = min(left, right - minimumSize)
            top = min(top, bottom - minimumSize)
        case .topTrailing:
            right = max(right, left + minimumSize)
            top = min(top, bottom - minimumSize)
        case .bottomLeading:
            left = min(left, right - minimumSize)
            bottom = max(bottom, top + minimumSize)
        case .bottomTrailing:
            right = max(right, left + minimumSize)
            bottom = max(bottom, top + minimumSize)
        }
        return clamp(Bounds(x: left, y: top, width: right - left, height: bottom - top), minimumSize: minimumSize)
    }

    static func clampFontSize(_ value: Double) -> Double {
        min(240, max(8, value.isFinite ? value.rounded() : 16))
    }
}

extension AlbatrossDeckElementV2 {
    var bounds: DeckGeometry.Bounds {
        get { DeckGeometry.Bounds(x: x, y: y, width: width, height: height) }
        set {
            x = newValue.x
            y = newValue.y
            width = newValue.width
            height = newValue.height
        }
    }
}

// MARK: - Colors

enum DeckColor {
    /// The bounded six-digit hex subset the export accepts; anything else is nil.
    static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let hex = trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed
        guard hex.count == 6, hex.allSatisfy(\.isHexDigit) else { return nil }
        return "#" + hex
    }

    static func components(_ value: String?) -> (red: Double, green: Double, blue: Double)? {
        guard let hex = normalized(value)?.dropFirst(), let number = UInt32(hex, radix: 16) else { return nil }
        return (
            Double((number >> 16) & 0xFF) / 255,
            Double((number >> 8) & 0xFF) / 255,
            Double(number & 0xFF) / 255
        )
    }
}
