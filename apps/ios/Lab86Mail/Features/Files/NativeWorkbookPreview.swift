import SwiftUI

/// A native inspection view, not a second spreadsheet engine. Tab selection
/// belongs to this view and never rewrites the persisted engine snapshot.
struct NativeWorkbookPreview: View {
    let snapshot: AlbatrossWorkbookSnapshot
    let webEditorURL: URL?
    @State private var selectedSheetID: String?

    private var sheet: AlbatrossWorkbookSnapshot.Sheet {
        snapshot.sheets.first { $0.id == (selectedSheetID ?? snapshot.activeSheetID) }
            ?? snapshot.sheets[0]
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Label("Workbook preview", systemImage: "tablecells")
                    .font(.headline)
                Text("Stored cell values and formulas are shown here. Use the full editor for charts, layout, calculated results, AI edits and export options. Your workbook is preserved unchanged.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let webEditorURL {
                    Link("Open full editor", destination: webEditorURL)
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("files.workbook.openWeb")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
            Picker("Sheet", selection: Binding(
                get: { sheet.id },
                set: { selectedSheetID = $0 }
            )) {
                ForEach(snapshot.sheets) { Text($0.name).tag($0.id) }
            }
            .pickerStyle(.menu)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal)
            .accessibilityIdentifier("files.workbook.sheet")
            List {
                Section {
                    ForEach(Array(sheet.cells.prefix(500))) { cell in
                        HStack(alignment: .top, spacing: 12) {
                            Text(cell.address)
                                .font(.caption.monospaced().weight(.semibold))
                                .foregroundStyle(.secondary)
                                .frame(width: 58, alignment: .leading)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(cell.content)
                                    .font(cell.isFormula ? .body.monospaced() : .body)
                                    .textSelection(.enabled)
                                if cell.isFormula {
                                    Text("Formula · not calculated in this preview")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                    if sheet.cells.isEmpty {
                        Text("No stored cell text in this sheet. Open the full editor to view other workbook content.")
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("\(sheet.name) · \(sheet.rowCount) rows × \(sheet.columnCount) columns")
                } footer: {
                    if sheet.cells.count > 500 {
                        Text("Showing the first 500 populated cells. The full workbook is available in the web editor.")
                    }
                }
            }
        }
        .accessibilityIdentifier("files.workbook.preview")
    }
}

enum AlbatrossDocumentWebLink {
    static func url(baseURL: URL?, documentID: String) -> URL? {
        guard let baseURL, ["http", "https"].contains(baseURL.scheme?.lowercased() ?? ""),
              var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/"
        components.queryItems = [URLQueryItem(name: "view", value: "files"), URLQueryItem(name: "document", value: documentID)]
        components.fragment = nil
        return components.url
    }
}
