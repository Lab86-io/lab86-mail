import Foundation
import Observation

private func exactInt(_ value: Double?) -> Int? {
    guard let value, value.isFinite else { return nil }
    return Int(exactly: value)
}

private func boundedInt(_ value: Double?, fallback: Int, range: ClosedRange<Int>) -> Int {
    guard let converted = exactInt(value) else { return fallback }
    return min(max(converted, range.lowerBound), range.upperBound)
}

private enum DocumentSectionLoadResult {
    case success(JSONValue)
    case failure(String)
}

enum AlbatrossDocumentKind: String, CaseIterable, Identifiable, Hashable, Sendable {
    case doc
    case sheet
    case deck

    var id: Self { self }

    var title: String {
        switch self {
        case .doc: "Document"
        case .sheet: "Spreadsheet"
        case .deck: "Presentation"
        }
    }

    var symbol: String {
        switch self {
        case .doc: "doc.text"
        case .sheet: "tablecells"
        case .deck: "rectangle.on.rectangle.angled"
        }
    }

    var fileExtension: String {
        switch self {
        case .doc: "docx"
        case .sheet: "xlsx"
        case .deck: "pptx"
        }
    }
}

struct AlbatrossDocBlock: Identifiable, Hashable, Sendable {
    var id: String
    var type: String
    var text: String
    var level: Int?

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue,
              let type = json["type"]?.stringValue else { return nil }
        self.id = id
        self.type = type
        text = json["text"]?.stringValue ?? ""
        level = exactInt(json["level"]?.doubleValue)
    }

    init(id: String = UUID().uuidString, type: String = "paragraph", text: String = "", level: Int? = nil) {
        self.id = id
        self.type = type
        self.text = text
        self.level = level
    }

    var json: JSONValue {
        .object([
            "id": .string(id),
            "type": .string(type),
            "text": .string(text),
            "level": level.map { .number(Double($0)) } ?? .null,
        ])
    }
}

enum AlbatrossCellValue: Hashable, Sendable {
    case text(String)
    case number(Double)
    case bool(Bool)

    init?(json: JSONValue) {
        switch json {
        case .string(let value): self = .text(value)
        case .number(let value): self = .number(value)
        case .bool(let value): self = .bool(value)
        default: return nil
        }
    }

    var display: String {
        switch self {
        case .text(let value): value
        case .number(let value):
            if value.rounded() == value, let integer = exactInt(value) {
                String(integer)
            } else {
                String(value)
            }
        case .bool(let value): value ? "TRUE" : "FALSE"
        }
    }

    var json: JSONValue {
        switch self {
        case .text(let value): .string(value)
        case .number(let value): .number(value)
        case .bool(let value): .bool(value)
        }
    }
}

struct AlbatrossSheetCell: Hashable, Sendable {
    var value: AlbatrossCellValue?
    var formula: String?
    var format: String?

    init(value: AlbatrossCellValue? = nil, formula: String? = nil, format: String? = nil) {
        self.value = value
        self.formula = formula
        self.format = format
    }

    init(json: JSONValue) {
        value = json["value"].flatMap { AlbatrossCellValue(json: $0) }
        formula = json["formula"]?.stringValue
        format = json["format"]?.stringValue
    }

    var display: String { formula.map { "=\($0)" } ?? value?.display ?? "" }

    var json: JSONValue {
        .object([
            "value": value?.json ?? .null,
            "formula": formula.map(JSONValue.string) ?? .null,
            "format": format.map(JSONValue.string) ?? .null,
        ])
    }
}

struct AlbatrossSheetTab: Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var rowCount: Int
    var columnCount: Int
    var cells: [String: AlbatrossSheetCell]

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue,
              let name = json["name"]?.stringValue else { return nil }
        self.id = id
        self.name = name
        rowCount = boundedInt(json["rowCount"]?.doubleValue, fallback: 100, range: 1 ... 10_000)
        columnCount = boundedInt(json["columnCount"]?.doubleValue, fallback: 26, range: 1 ... 500)
        cells = Dictionary(
            uniqueKeysWithValues: (json["cells"]?.objectValue ?? [:]).map {
                ($0.key, AlbatrossSheetCell(json: $0.value))
            }
        )
    }

    init(
        id: String = UUID().uuidString,
        name: String = "Sheet 1",
        rowCount: Int = 100,
        columnCount: Int = 26,
        cells: [String: AlbatrossSheetCell] = [:]
    ) {
        self.id = id
        self.name = name
        self.rowCount = rowCount
        self.columnCount = columnCount
        self.cells = cells
    }

    var json: JSONValue {
        .object([
            "id": .string(id),
            "name": .string(name),
            "rowCount": .number(Double(rowCount)),
            "columnCount": .number(Double(columnCount)),
            "cells": .object(cells.mapValues(\.json)),
        ])
    }
}

struct AlbatrossDeckElement: Identifiable, Hashable, Sendable {
    var id: String
    var type: String
    var x: Double
    var y: Double
    var width: Double
    var height: Double
    var text: String
    var role: String?
    var fill: String?
    var color: String?
    var fontSize: Double?

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue,
              let type = json["type"]?.stringValue else { return nil }
        self.id = id
        self.type = type
        x = json["x"]?.doubleValue ?? 0
        y = json["y"]?.doubleValue ?? 0
        width = json["width"]?.doubleValue ?? 20
        height = json["height"]?.doubleValue ?? 10
        text = json["text"]?.stringValue ?? ""
        role = json["role"]?.stringValue
        fill = json["fill"]?.stringValue
        color = json["color"]?.stringValue
        fontSize = json["fontSize"]?.doubleValue
    }

    init(
        id: String = UUID().uuidString,
        type: String = "text",
        x: Double = 10,
        y: Double = 20,
        width: Double = 80,
        height: Double = 16,
        text: String = "",
        role: String? = "body",
        fill: String? = nil,
        color: String? = nil,
        fontSize: Double? = 18
    ) {
        self.id = id
        self.type = type
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.text = text
        self.role = role
        self.fill = fill
        self.color = color
        self.fontSize = fontSize
    }

    var json: JSONValue {
        .object([
            "id": .string(id),
            "type": .string(type),
            "x": .number(x),
            "y": .number(y),
            "width": .number(width),
            "height": .number(height),
            "text": .string(text),
            "role": role.map(JSONValue.string) ?? .null,
            "fill": fill.map(JSONValue.string) ?? .null,
            "color": color.map(JSONValue.string) ?? .null,
            "fontSize": fontSize.map(JSONValue.number) ?? .null,
        ])
    }
}

struct AlbatrossDeckSlide: Identifiable, Hashable, Sendable {
    var id: String
    var title: String
    var notes: String
    var background: String?
    var elements: [AlbatrossDeckElement]

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue else { return nil }
        self.id = id
        title = json["title"]?.stringValue ?? "Untitled slide"
        notes = json["notes"]?.stringValue ?? ""
        background = json["background"]?.stringValue
        elements = (json["elements"]?.arrayValue ?? []).compactMap(AlbatrossDeckElement.init)
    }

    init(
        id: String = UUID().uuidString,
        title: String = "Untitled slide",
        notes: String = "",
        background: String? = nil,
        elements: [AlbatrossDeckElement] = []
    ) {
        self.id = id
        self.title = title
        self.notes = notes
        self.background = background
        self.elements = elements
    }

    var json: JSONValue {
        .object([
            "id": .string(id),
            "title": .string(title),
            "notes": .string(notes),
            "background": background.map(JSONValue.string) ?? .null,
            "elements": .array(elements.map(\.json)),
        ])
    }
}

enum AlbatrossDocumentModel: Hashable, Sendable {
    case doc(blocks: [AlbatrossDocBlock])
    case sheet(activeSheetID: String, sheets: [AlbatrossSheetTab])
    case deck(activeSlideID: String, slides: [AlbatrossDeckSlide])

    init?(json: JSONValue) {
        switch json["kind"]?.stringValue {
        case "doc":
            self = .doc(blocks: (json["blocks"]?.arrayValue ?? []).compactMap(AlbatrossDocBlock.init))
        case "sheet":
            let sheets = (json["sheets"]?.arrayValue ?? []).compactMap(AlbatrossSheetTab.init)
            guard let first = sheets.first else { return nil }
            self = .sheet(
                activeSheetID: json["activeSheetId"]?.stringValue ?? first.id,
                sheets: sheets
            )
        case "deck":
            let slides = (json["slides"]?.arrayValue ?? []).compactMap(AlbatrossDeckSlide.init)
            guard let first = slides.first else { return nil }
            self = .deck(
                activeSlideID: json["activeSlideId"]?.stringValue ?? first.id,
                slides: slides
            )
        default:
            return nil
        }
    }

    var kind: AlbatrossDocumentKind {
        switch self {
        case .doc: .doc
        case .sheet: .sheet
        case .deck: .deck
        }
    }

    var json: JSONValue {
        switch self {
        case .doc(let blocks):
            .object([
                "kind": .string("doc"),
                "version": .number(1),
                "blocks": .array(blocks.map(\.json)),
            ])
        case .sheet(let activeSheetID, let sheets):
            .object([
                "kind": .string("sheet"),
                "version": .number(1),
                "activeSheetId": .string(activeSheetID),
                "sheets": .array(sheets.map(\.json)),
            ])
        case .deck(let activeSlideID, let slides):
            .object([
                "kind": .string("deck"),
                "version": .number(1),
                "activeSlideId": .string(activeSlideID),
                "slides": .array(slides.map(\.json)),
            ])
        }
    }
}

struct AlbatrossGoogleDocumentLink: Hashable, Sendable {
    let connectionID: String
    let fileID: String
    let mimeType: String
    let webURL: URL?
    let syncedRevision: Int

    init?(json: JSONValue?) {
        guard let json,
              let connectionID = json["connectionId"]?.stringValue,
              let fileID = json["fileId"]?.stringValue else { return nil }
        self.connectionID = connectionID
        self.fileID = fileID
        mimeType = json["mimeType"]?.stringValue ?? ""
        webURL = json["webUrl"]?.stringValue.flatMap { URL(string: $0) }
        syncedRevision = boundedInt(
            json["syncedRevision"]?.doubleValue,
            fallback: 0,
            range: 0 ... Int.max
        )
    }
}

struct AlbatrossDocumentSuggestion: Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let description: String
    let proposedModel: AlbatrossDocumentModel

    init?(json: JSONValue) {
        guard let id = json["suggestionId"]?.stringValue,
              let modelJSON = json["proposedModel"],
              let proposedModel = AlbatrossDocumentModel(json: modelJSON) else { return nil }
        self.id = id
        title = json["title"]?.stringValue ?? "Suggested edit"
        description = json["description"]?.stringValue ?? ""
        self.proposedModel = proposedModel
    }
}

struct AlbatrossDocument: Identifiable, Hashable, Sendable {
    let id: String
    var kind: AlbatrossDocumentKind
    var title: String
    var model: AlbatrossDocumentModel
    var revision: Int
    var google: AlbatrossGoogleDocumentLink?
    var suggestions: [AlbatrossDocumentSuggestion]
    var createdAt: Date
    var updatedAt: Date

    init?(json: JSONValue) {
        guard let id = json["documentId"]?.stringValue,
              let rawKind = json["kind"]?.stringValue,
              let kind = AlbatrossDocumentKind(rawValue: rawKind),
              let modelJSON = json["model"],
              let model = AlbatrossDocumentModel(json: modelJSON) else { return nil }
        self.id = id
        self.kind = kind
        title = json["title"]?.stringValue ?? "Untitled \(kind.title)"
        self.model = model
        revision = boundedInt(
            json["currentRevision"]?.doubleValue,
            fallback: 1,
            range: 1 ... Int.max
        )
        google = AlbatrossGoogleDocumentLink(json: json["google"])
        suggestions = (json["suggestions"]?.arrayValue ?? []).compactMap(AlbatrossDocumentSuggestion.init)
        createdAt = Self.date(json["createdAt"]?.doubleValue)
        updatedAt = Self.date(json["updatedAt"]?.doubleValue)
    }

    private static func date(_ value: Double?) -> Date {
        guard let value else { return .now }
        return Date(timeIntervalSince1970: value > 10_000_000_000 ? value / 1_000 : value)
    }
}

struct CloudFileConnection: Identifiable, Hashable, Sendable {
    let id: String
    let provider: String
    let label: String
    let status: String
    let error: String?

    init?(json: JSONValue) {
        guard let id = json["connectionId"]?.stringValue,
              let provider = json["provider"]?.stringValue else { return nil }
        self.id = id
        self.provider = provider
        label = json["accountEmail"]?.stringValue
            ?? json["displayName"]?.stringValue
            ?? (provider == "google_drive" ? "Google Drive" : "OneDrive")
        status = json["status"]?.stringValue ?? "connected"
        error = json["error"]?.stringValue
    }
}

struct CloudFileItem: Identifiable, Hashable, Sendable {
    let id: String
    let connectionID: String?
    let provider: String
    let name: String
    let mimeType: String?
    let size: Int?
    let modifiedAt: Date?
    let webURL: URL?
    let isFolder: Bool

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue,
              let name = json["name"]?.stringValue else { return nil }
        self.id = id
        connectionID = json["connectionId"]?.stringValue
        provider = json["provider"]?.stringValue ?? "albatross"
        self.name = name
        mimeType = json["mimeType"]?.stringValue
        size = exactInt(json["size"]?.doubleValue).map { max(0, $0) }
        if let timestamp = json["modifiedAt"]?.doubleValue ?? json["createdAt"]?.doubleValue {
            modifiedAt = Date(timeIntervalSince1970: timestamp > 10_000_000_000 ? timestamp / 1_000 : timestamp)
        } else {
            modifiedAt = nil
        }
        webURL = (json["webUrl"]?.stringValue ?? json["url"]?.stringValue).flatMap {
            URL(string: $0)
        }
        isFolder = json["isFolder"]?.boolValue ?? false
    }
}

@MainActor
@Observable
final class DocumentStore {
    private let backend: BackendClient

    private(set) var documents: [AlbatrossDocument] = []
    private(set) var connections: [CloudFileConnection] = []
    private(set) var uploads: [CloudFileItem] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?

    init(backend: BackendClient) {
        self.backend = backend
    }

    func clearError() {
        errorMessage = nil
    }

    func loadFiles() async {
        isLoading = true
        defer { isLoading = false }
        async let documentEnvelope = loadSection(path: "/api/documents")
        async let statusEnvelope = loadSection(path: "/api/files/status")
        async let uploadEnvelope = loadSection(path: "/api/agent/uploads")
        let (documentResult, statusResult, uploadResult) = await (
            documentEnvelope,
            statusEnvelope,
            uploadEnvelope
        )
        var failures: [String] = []
        switch documentResult {
        case .success(let result):
            documents = (result["documents"]?.arrayValue ?? [])
                .compactMap(AlbatrossDocument.init)
                .sorted { $0.updatedAt > $1.updatedAt }
        case .failure(let message):
            failures.append("Albatross files: \(message)")
        }
        switch statusResult {
        case .success(let result):
            connections = (result["connections"]?.arrayValue ?? []).compactMap(CloudFileConnection.init)
        case .failure(let message):
            failures.append("Connected drives: \(message)")
        }
        switch uploadResult {
        case .success(let result):
            uploads = (result["files"]?.arrayValue ?? []).compactMap(CloudFileItem.init)
        case .failure(let message):
            failures.append("Uploads: \(message)")
        }
        errorMessage = failures.isEmpty ? nil : failures.joined(separator: "\n")
    }

    private func loadSection(path: String) async -> DocumentSectionLoadResult {
        do {
            return .success(try await backend.get(path: path))
        } catch {
            return .failure(error.localizedDescription)
        }
    }

    func fetchDocument(id: String) async throws -> AlbatrossDocument {
        let result = try await backend.get(path: "/api/documents/\(id.pathEncoded)")
        guard let json = result["document"], let document = AlbatrossDocument(json: json) else {
            throw BackendError.invalidResponse
        }
        replace(document)
        return document
    }

    func create(
        kind: AlbatrossDocumentKind,
        title: String? = nil,
        instructions: String? = nil,
        sourceContext: String? = nil
    ) async throws -> AlbatrossDocument {
        var body: [String: JSONValue] = ["kind": .string(kind.rawValue)]
        if let title, !title.isEmpty { body["title"] = .string(title) }
        if let instructions, !instructions.isEmpty { body["instructions"] = .string(instructions) }
        if let sourceContext, !sourceContext.isEmpty { body["sourceContext"] = .string(sourceContext) }
        let result = try await backend.post(path: "/api/documents", body: .object(body))
        guard let json = result["document"], let document = AlbatrossDocument(json: json) else {
            throw BackendError.invalidResponse
        }
        replace(document)
        return document
    }

    func save(_ document: AlbatrossDocument) async throws -> AlbatrossDocument {
        let result = try await backend.patch(
            path: "/api/documents/\(document.id.pathEncoded)",
            body: .object([
                "expectedRevision": .number(Double(document.revision)),
                "title": .string(document.title),
                "model": document.model.json,
                "reason": .string("ios_inline_edit"),
            ])
        )
        guard let json = result["document"], var saved = AlbatrossDocument(json: json) else {
            throw BackendError.invalidResponse
        }
        saved.suggestions = document.suggestions
        replace(saved)
        return saved
    }

    func suggest(documentID: String, instruction: String) async throws -> AlbatrossDocumentSuggestion {
        let result = try await backend.post(
            path: "/api/documents/\(documentID.pathEncoded)/ai",
            body: .object([
                "instruction": .string(instruction),
                "mode": .string("suggest"),
            ])
        )
        guard let json = result["suggestion"],
              let suggestion = AlbatrossDocumentSuggestion(json: json) else {
            throw BackendError.invalidResponse
        }
        if let index = documents.firstIndex(where: { $0.id == documentID }) {
            documents[index].suggestions.insert(suggestion, at: 0)
        }
        return suggestion
    }

    func resolveSuggestion(
        documentID: String,
        suggestionID: String,
        apply: Bool
    ) async throws -> AlbatrossDocument {
        _ = try await backend.post(
            path: "/api/documents/\(documentID.pathEncoded)/suggestions/\(suggestionID.pathEncoded)",
            body: .object(["decision": .string(apply ? "apply" : "dismiss")])
        )
        return try await fetchDocument(id: documentID)
    }

    func publishToGoogle(documentID: String) async throws -> URL? {
        let result = try await backend.post(
            path: "/api/documents/\(documentID.pathEncoded)/google",
            body: .object([:])
        )
        let url = result["google"]?["webUrl"]?.stringValue.flatMap { URL(string: $0) }
        _ = try await fetchDocument(id: documentID)
        return url
    }

    func browse(connectionID: String, query: String = "", folderID: String? = nil) async throws -> [CloudFileItem] {
        var components = URLComponents()
        components.path = "/api/files/browse"
        components.queryItems = [
            URLQueryItem(name: "connectionId", value: connectionID),
            query.isEmpty ? nil : URLQueryItem(name: "q", value: query),
            folderID.map { URLQueryItem(name: "folderId", value: $0) },
        ].compactMap { $0 }
        let result = try await backend.get(path: components.string ?? "/api/files/browse")
        return (result["items"]?.arrayValue ?? []).compactMap(CloudFileItem.init)
    }

    func importGoogle(_ item: CloudFileItem) async throws -> AlbatrossDocument {
        guard let connectionID = item.connectionID, let mimeType = item.mimeType else {
            throw BackendError.server(status: 400, message: "Google file details are incomplete.")
        }
        let result = try await backend.post(
            path: "/api/files/google/import",
            body: .object([
                "connectionId": .string(connectionID),
                "fileId": .string(item.id),
                "mimeType": .string(mimeType),
                "webUrl": item.webURL.map { .string($0.absoluteString) } ?? .null,
            ])
        )
        guard let json = result["document"], let document = AlbatrossDocument(json: json) else {
            throw BackendError.invalidResponse
        }
        replace(document)
        return document
    }

    func refreshFromGoogle(_ document: AlbatrossDocument) async throws -> AlbatrossDocument {
        guard let google = document.google else {
            throw BackendError.server(status: 400, message: "This file is not linked to Google.")
        }
        let mimeType = google.mimeType.isEmpty ? Self.googleMimeType(document.kind) : google.mimeType
        let result = try await backend.post(
            path: "/api/files/google/import",
            body: .object([
                "connectionId": .string(google.connectionID),
                "fileId": .string(google.fileID),
                "mimeType": .string(mimeType),
                "webUrl": google.webURL.map { .string($0.absoluteString) } ?? .null,
                "mode": .string("refresh"),
            ])
        )
        guard let json = result["document"], let refreshed = AlbatrossDocument(json: json) else {
            throw BackendError.invalidResponse
        }
        replace(refreshed)
        return refreshed
    }

    func upload(data: Data, name: String, contentType: String) async throws {
        _ = try await backend.postMultipart(
            path: "/api/agent/uploads",
            fields: [:],
            files: [
                MultipartFile(
                    fieldName: "files",
                    filename: name,
                    contentType: contentType,
                    data: data
                ),
            ]
        )
        await loadFiles()
    }

    func export(document: AlbatrossDocument) async throws -> URL {
        let downloaded = try await backend.download(
            path: "/api/documents/\(document.id.pathEncoded)/export"
        )
        let target = downloaded.url
            .deletingLastPathComponent()
            .appending(path: "\(document.title.sanitizedFilename).\(document.kind.fileExtension)")
        if FileManager.default.fileExists(atPath: target.path) {
            try FileManager.default.removeItem(at: target)
        }
        try FileManager.default.moveItem(at: downloaded.url, to: target)
        return target
    }

    private func replace(_ document: AlbatrossDocument) {
        if let index = documents.firstIndex(where: { $0.id == document.id }) {
            documents[index] = document
        } else {
            documents.insert(document, at: 0)
        }
        documents.sort { $0.updatedAt > $1.updatedAt }
    }

    private static func googleMimeType(_ kind: AlbatrossDocumentKind) -> String {
        switch kind {
        case .doc: "application/vnd.google-apps.document"
        case .sheet: "application/vnd.google-apps.spreadsheet"
        case .deck: "application/vnd.google-apps.presentation"
        }
    }
}

private extension String {
    var pathEncoded: String {
        addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? self
    }

    var sanitizedFilename: String {
        let invalid = CharacterSet(charactersIn: "/:\\?%*|\"<>")
        let cleaned = components(separatedBy: invalid).joined(separator: "-")
        return cleaned.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Untitled" : cleaned
    }
}
