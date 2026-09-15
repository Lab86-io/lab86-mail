import Foundation

/// A version 2 presentation as stored by the web app: a deck-level theme and
/// typed elements (text, shapes, lines, images, charts). The native apps keep
/// the raw JSON unchanged and show a read-only projection; edits happen in the
/// web editor until the native canvas learns the richer model.
struct AlbatrossRichDeckSnapshot: Hashable, Sendable {
    let json: JSONValue
    let activeSlideID: String
    let slides: [Slide]
    let themeName: String?

    func hash(into hasher: inout Hasher) {
        // Equality compares the entire raw JSON so no field is lost; hashing
        // the visible projection is enough.
        hasher.combine(activeSlideID)
        hasher.combine(slides)
    }

    struct Slide: Identifiable, Hashable, Sendable {
        let id: String
        let title: String
        let notes: String
        /// Readable text in slide order: text runs, image alt text and chart data.
        let lines: [String]
        let elementCount: Int
    }

    init?(json: JSONValue) {
        guard json["kind"]?.stringValue == "deck",
              json["version"]?.doubleValue == 2,
              let theme = json["theme"]?.objectValue,
              theme["colors"]?.objectValue != nil,
              let rawSlides = json["slides"]?.arrayValue,
              !rawSlides.isEmpty else { return nil }
        var slides: [Slide] = []
        for raw in rawSlides {
            guard let id = raw["id"]?.stringValue else { return nil }
            let elements = raw["elements"]?.arrayValue ?? []
            var lines: [String] = []
            for element in elements {
                switch element["type"]?.stringValue {
                case "text":
                    if let text = element["text"]?.stringValue, !text.isEmpty { lines.append(text) }
                case "image":
                    if let alt = element["alt"]?.stringValue, !alt.isEmpty { lines.append(alt) }
                case "chart":
                    let categories = (element["categories"]?.arrayValue ?? []).compactMap(\.stringValue)
                    for series in element["series"]?.arrayValue ?? [] {
                        let name = series["name"]?.stringValue ?? "Series"
                        let values = (series["values"]?.arrayValue ?? []).compactMap(\.doubleValue)
                        let pairs = zip(categories, values).map { "\($0) \($1.formatted())" }
                        lines.append("\(name): \(pairs.joined(separator: ", "))")
                    }
                default:
                    continue
                }
            }
            slides.append(Slide(
                id: id,
                title: raw["title"]?.stringValue ?? "Untitled slide",
                notes: raw["notes"]?.stringValue ?? "",
                lines: lines,
                elementCount: elements.count
            ))
        }
        self.json = json
        self.slides = slides
        activeSlideID = json["activeSlideId"]?.stringValue ?? slides[0].id
        themeName = theme["name"]?.stringValue
    }
}
