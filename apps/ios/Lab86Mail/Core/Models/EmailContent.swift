import Foundation
import SwiftSoup

enum EmailTextNormalizer {
    private static let encodedWordPattern = try! NSRegularExpression(
        pattern: #"=\?([^?]+)\?([bBqQ])\?([^?]*)\?="#
    )
    private static let entityPattern = try! NSRegularExpression(
        pattern: #"&(?:#([0-9]+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));"#
    )

    static func header(_ value: String?) -> String {
        guard let value else { return "" }
        return collapseWhitespace(decodeHTMLEntities(decodeEncodedWords(value)))
    }

    static func preview(_ value: String) -> String {
        let readable = readerText(value)
        return readable.replacingOccurrences(
            of: #"\s*[\[(]?https?://\S+[\])]?"#,
            with: "",
            options: .regularExpression
        )
        .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func readerText(_ value: String) -> String {
        var result = decodeQuotedPrintableIfNeeded(value)
        if result.range(of: #"<(?:!doctype|html|head|body|div|table|p|span|br|style)\b"#, options: [.regularExpression, .caseInsensitive]) != nil {
            result = result
                .replacingOccurrences(of: #"<(?:script|style)\b[^>]*>[\s\S]*?</(?:script|style)>"#, with: " ", options: [.regularExpression, .caseInsensitive])
                .replacingOccurrences(of: #"<br\s*/?>"#, with: "\n", options: [.regularExpression, .caseInsensitive])
                .replacingOccurrences(of: #"</(?:p|div|li|tr|h[1-6])\s*>"#, with: "\n", options: [.regularExpression, .caseInsensitive])
                .replacingOccurrences(of: #"<[^>]+>"#, with: " ", options: .regularExpression)
        }
        result = decodeHTMLEntities(result)
        result = result
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .replacingOccurrences(of: #"[\u{200B}-\u{200D}\u{2060}\u{FEFF}]"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[\t ]+"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\n[\t ]+"#, with: "\n", options: .regularExpression)
            .replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)

        // html-to-text intentionally includes link targets. That is useful for
        // agents, but mail trackers can be hundreds of opaque characters long.
        // Keep ordinary links readable and collapse only obviously generated URLs.
        result = result.replacingOccurrences(
            of: #"([\[(])https?://[^\s\])]{80,}([\])])"#,
            with: "$1link$2",
            options: [.regularExpression, .caseInsensitive]
        )
        result = result.replacingOccurrences(
            of: #"https?://\S{120,}"#,
            with: "link",
            options: [.regularExpression, .caseInsensitive]
        )
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func collapseWhitespace(_ value: String) -> String {
        value.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func decodeEncodedWords(_ value: String) -> String {
        let source = value as NSString
        let matches = encodedWordPattern.matches(in: value, range: NSRange(location: 0, length: source.length))
        guard !matches.isEmpty else { return value }
        var output = value
        for match in matches.reversed() {
            guard let wholeRange = Range(match.range(at: 0), in: output),
                  let charsetRange = Range(match.range(at: 1), in: value),
                  let encodingRange = Range(match.range(at: 2), in: value),
                  let payloadRange = Range(match.range(at: 3), in: value) else { continue }
            let charset = String(value[charsetRange])
            let transferEncoding = String(value[encodingRange]).lowercased()
            let payload = String(value[payloadRange])
            let data = transferEncoding == "b"
                ? Data(base64Encoded: payload)
                : decodeQuotedPrintableData(payload.replacingOccurrences(of: "_", with: " "))
            guard let data, let decoded = decode(data, charset: charset) else { continue }
            output.replaceSubrange(wholeRange, with: decoded)
        }
        return output
    }

    private static func decode(_ data: Data, charset: String) -> String? {
        switch charset.lowercased().replacingOccurrences(of: "_", with: "-") {
        case "utf-8", "utf8":
            return String(data: data, encoding: .utf8)
        case "us-ascii", "ascii":
            return String(data: data, encoding: .ascii)
        case "iso-8859-1", "latin1", "latin-1":
            return String(data: data, encoding: .isoLatin1)
        case "windows-1252", "cp1252":
            return String(data: data, encoding: .windowsCP1252)
        default:
            return String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1)
        }
    }

    private static func decodeQuotedPrintableIfNeeded(_ value: String) -> String {
        let markers = value.matches(of: /=[0-9A-Fa-f]{2}/).count
        guard markers >= 2 || value.contains("=\r\n") || value.contains("=\n") else { return value }
        guard let data = decodeQuotedPrintableData(value) else { return value }
        return String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) ?? value
    }

    private static func decodeQuotedPrintableData(_ value: String) -> Data? {
        let bytes = Array(value.utf8)
        var output = Data()
        var index = 0
        while index < bytes.count {
            if bytes[index] == 61 {
                if index + 1 < bytes.count, bytes[index + 1] == 10 {
                    index += 2
                    continue
                }
                if index + 2 < bytes.count, bytes[index + 1] == 13, bytes[index + 2] == 10 {
                    index += 3
                    continue
                }
                if index + 2 < bytes.count,
                   let high = hex(bytes[index + 1]),
                   let low = hex(bytes[index + 2]) {
                    output.append(high << 4 | low)
                    index += 3
                    continue
                }
            }
            output.append(bytes[index])
            index += 1
        }
        return output
    }

    private static func hex(_ byte: UInt8) -> UInt8? {
        switch byte {
        case 48...57: byte - 48
        case 65...70: byte - 55
        case 97...102: byte - 87
        default: nil
        }
    }

    private static func decodeHTMLEntities(_ value: String) -> String {
        let source = value as NSString
        let matches = entityPattern.matches(in: value, range: NSRange(location: 0, length: source.length))
        guard !matches.isEmpty else { return value }
        var output = value
        for match in matches.reversed() {
            guard let range = Range(match.range(at: 0), in: output) else { continue }
            let token = source.substring(with: match.range(at: 0))
            let replacement: String?
            if token.hasPrefix("&#x") || token.hasPrefix("&#X") {
                replacement = UInt32(token.dropFirst(3).dropLast(), radix: 16).flatMap(UnicodeScalar.init).map(String.init)
            } else if token.hasPrefix("&#") {
                replacement = UInt32(token.dropFirst(2).dropLast()).flatMap(UnicodeScalar.init).map(String.init)
            } else {
                replacement = [
                    "amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " ",
                    "ndash": "–", "mdash": "—", "hellip": "…", "copy": "©", "reg": "®",
                ][String(token.dropFirst().dropLast()).lowercased()]
            }
            if let replacement { output.replaceSubrange(range, with: replacement) }
        }
        return output
    }
}

enum EmailHTMLDocument {
    private static func securityHead(allowRemoteContent: Bool) -> String {
        let imageSources = allowRemoteContent ? "data: blob: cid: https: http:" : "data: blob: cid:"
        return """
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; form-action 'none'; img-src \(imageSources); style-src 'unsafe-inline'; font-src data:">
    <meta name="referrer" content="no-referrer">
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">
    <meta name="color-scheme" content="light">
    <style>
      :root { color-scheme: light; }
      html, body { margin: 0; padding: 0; background: #fff; color: #1c1c1e; font: -apple-system-body; line-height: 1.45; overflow-wrap: anywhere; -webkit-text-size-adjust: 100%; }
      body { padding: 2px; }
      img, video { max-width: 100% !important; height: auto !important; }
      /* Wide desktop tables (data grids and layout tables alike) must stay
         readable on a phone. Bounding them to the viewport (max-width) keeps
         ordinary responsive tables fitting exactly as before, while display:block
         + overflow-x lets an inherently wide table scroll horizontally inside a
         bounded box instead of being crushed. Columns that would not fit scroll;
         they are never squeezed to one character per line. */
      table { max-width: 100% !important; display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; }
      /* Cells keep whole words so a narrow column like "Status" stays on one line
         rather than stacking to "S t a t u s". Long-word recovery still applies to
         ordinary prose via the body-level overflow-wrap: anywhere above. */
      th, td { overflow-wrap: normal; word-break: normal; }
      pre { white-space: pre-wrap; }
      a { color: #0066cc; }
    </style>
    """
    }

    private static func structurallySanitized(_ raw: String) -> String? {
        guard let document = try? SwiftSoup.parse(raw) else { return nil }
        do {
            try document.select("script, iframe, object, embed, form, base").remove()
            for element in try document.getAllElements().array() {
                guard let attributes = element.getAttributes() else { continue }
                for attribute in attributes.asList() {
                    let key = attribute.getKey().lowercased()
                    let value = attribute.getValue().trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                    if key.hasPrefix("on") || key == "srcdoc" {
                        try element.removeAttr(attribute.getKey())
                    } else if ["href", "src", "action", "formaction"].contains(key),
                              value.hasPrefix("javascript:") {
                        try element.removeAttr(attribute.getKey())
                    }
                }
            }
            return try document.html()
        } catch {
            return nil
        }
    }

    // Remote editorial images render immediately — there is no privacy gate that
    // is effectively required to reveal the message. Obvious tracking beacons are
    // removed, no-referrer is set, and script/iframe/form/etc. stay blocked.
    static func make(from rawHTML: String, allowRemoteContent: Bool = true) -> String {
        let securityHead = securityHead(allowRemoteContent: allowRemoteContent)
        // Structural pass with a real HTML parser first; the regex chain below
        // stays as defense in depth. Malformed provider HTML that fails to
        // parse falls through to the original raw string.
        var html = structurallySanitized(rawHTML) ?? rawHTML
        html = stripTrackingPixels(html)
        html = html.replacingOccurrences(
            of: #"<(script|iframe|object|embed|form)\b[^>]*>[\s\S]*?</\1\s*>"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
        html = html.replacingOccurrences(
            of: #"<(?:script|iframe|object|embed|form|input|button|base|link)\b[^>]*\/?>"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
        html = html.replacingOccurrences(
            of: #"<meta\b[^>]*http-equiv\s*=\s*['\"]?refresh['\"]?[^>]*>"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
        html = html.replacingOccurrences(
            of: #"\s(?:on[a-z]+|srcdoc)\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+)"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )

        if let head = html.range(of: #"<head\b[^>]*>"#, options: [.regularExpression, .caseInsensitive]) {
            html.insert(contentsOf: securityHead, at: head.upperBound)
            return html
        }
        if let root = html.range(of: #"<html\b[^>]*>"#, options: [.regularExpression, .caseInsensitive]) {
            html.insert(contentsOf: "<head>\(securityHead)</head>", at: root.upperBound)
            return html
        }
        return "<!doctype html><html><head>\(securityHead)</head><body>\(html)</body></html>"
    }

    // Drop only unambiguous open-pixels/beacons — 1×1 or smaller images, images
    // hidden by inline style, and known open-tracking URL shapes. Ordinary
    // editorial/marketing images (with real dimensions and normal URLs) survive.
    static func stripTrackingPixels(_ html: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: #"<img\b[^>]*>"#, options: [.caseInsensitive]) else {
            return html
        }
        let source = html as NSString
        let matches = regex.matches(in: html, range: NSRange(location: 0, length: source.length))
        guard !matches.isEmpty else { return html }
        var result = ""
        var lastEnd = 0
        for match in matches {
            result += source.substring(with: NSRange(location: lastEnd, length: match.range.location - lastEnd))
            let tag = source.substring(with: match.range)
            if !isTrackingPixel(tag) { result += tag }
            lastEnd = match.range.location + match.range.length
        }
        result += source.substring(from: lastEnd)
        return result
    }

    private static func isTrackingPixel(_ tag: String) -> Bool {
        let lower = tag.lowercased()
        // Tiny declared dimensions (1×1 / 0-size beacons).
        if let width = attributeInt(tag, "width"), let height = attributeInt(tag, "height"),
           width <= 2, height <= 2 {
            return true
        }
        // Hidden via inline style.
        if lower.range(
            of: #"(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|(?:width|height)\s*:\s*(?:0|1px))"#,
            options: .regularExpression
        ) != nil {
            return true
        }
        // Known open-pixel URL shapes (conservative to avoid hiding real images).
        if lower.range(
            of: #"src\s*=\s*['"]?[^'">\s]*(?:/open\b|/o\.gif|open\.aspx|/wf/open|/track(?:ing)?/open|utm_open)"#,
            options: .regularExpression
        ) != nil {
            return true
        }
        return false
    }

    private static func attributeInt(_ tag: String, _ name: String) -> Int? {
        guard let regex = try? NSRegularExpression(
            pattern: "\\b\(name)\\s*=\\s*['\"]?(\\d+)",
            options: [.caseInsensitive]
        ) else { return nil }
        let source = tag as NSString
        guard let match = regex.firstMatch(in: tag, range: NSRange(location: 0, length: source.length)),
              match.numberOfRanges > 1 else { return nil }
        return Int(source.substring(with: match.range(at: 1)))
    }
}
