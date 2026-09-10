import Foundation

/// Lossless storage with a deliberately read-only native projection. Formula
/// results are not guessed: the cell list displays stored values or formulas.
struct AlbatrossWorkbookSnapshot: Hashable, Sendable {
    let json: JSONValue
    let sheets: [Sheet]
    let activeSheetID: String

    func hash(into hasher: inout Hasher) {
        // Equality still compares the entire raw JSON, including engine
        // extensions. Hashing the visible projection is sufficient and does
        // not require changing the shared JSONValue contract.
        hasher.combine(sheets)
        hasher.combine(activeSheetID)
    }

    struct Cell: Identifiable, Hashable, Sendable {
        let address: String
        let content: String
        var id: String { address }
        var isFormula: Bool { content.hasPrefix("=") }
    }

    struct Sheet: Identifiable, Hashable, Sendable {
        let id: String
        let name: String
        let rowCount: Int
        let columnCount: Int
        let cells: [Cell]
    }

    init?(json: JSONValue) {
        guard json["kind"]?.stringValue == "sheet",
              json["version"]?.doubleValue == 2,
              json["engine"]?.stringValue == "o-spreadsheet",
              let entries = json["workbook"]?["sheets"]?.arrayValue,
              !entries.isEmpty else { return nil }
        var parsed: [Sheet] = []
        for entry in entries {
            guard let id = entry["id"]?.stringValue, let name = entry["name"]?.stringValue else { return nil }
            let cells = (entry["cells"]?.objectValue ?? [:]).compactMap { address, value -> Cell? in
                let content: String
                switch value {
                case .string(let text): content = text
                case .number(let number): content = String(number)
                case .bool(let boolean): content = boolean ? "TRUE" : "FALSE"
                case .object:
                    guard let text = value["content"]?.stringValue else { return nil }
                    content = text
                default: return nil
                }
                guard !content.isEmpty else { return nil }
                return Cell(address: address, content: content)
            }.sorted { Self.addressOrder($0.address) < Self.addressOrder($1.address) }
            parsed.append(Sheet(
                id: id, name: name,
                rowCount: Self.dimension(entry["rowNumber"]?.doubleValue),
                columnCount: Self.dimension(entry["colNumber"]?.doubleValue),
                cells: cells
            ))
        }
        guard Set(parsed.map(\.id)).count == parsed.count else { return nil }
        self.json = json
        sheets = parsed
        let requested = json["activeSheetId"]?.stringValue
        activeSheetID = parsed.first(where: { $0.id == requested })?.id ?? parsed[0].id
    }

    private static func dimension(_ raw: Double?) -> Int {
        guard let raw, raw.isFinite, let integer = Int(exactly: raw) else { return 0 }
        return max(0, integer)
    }

    private static func addressOrder(_ address: String) -> (Int, Int, String) {
        var column = 0
        var digits = ""
        for scalar in address.uppercased().unicodeScalars {
            if (65...90).contains(scalar.value), digits.isEmpty {
                // Reject implausibly long columns without integer overflow.
                guard column < 1_000_000 else { return (Int.max, Int.max, address) }
                column = column * 26 + Int(scalar.value - 64)
            } else if (48...57).contains(scalar.value) {
                digits.unicodeScalars.append(scalar)
            } else { return (Int.max, Int.max, address) }
        }
        return (Int(digits) ?? Int.max, column, address)
    }
}
