import AppIntents
import Foundation
import UniformTypeIdentifiers

actor MailIntentAttachmentStore {
    static let shared = MailIntentAttachmentStore()

    private struct StoredAttachment: Codable {
        let filename: String
        let typeIdentifier: String?
        let data: Data

        init(_ file: IntentFile) {
            filename = file.filename
            typeIdentifier = file.type?.identifier
            data = file.data
        }

        var intentFile: IntentFile {
            IntentFile(data: data, filename: filename, type: typeIdentifier.flatMap(UTType.init))
        }
    }

    private let directory: URL

    init(directory: URL? = nil) {
        let root = directory
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
                .appending(path: "Albatross/MailIntentAttachments", directoryHint: .isDirectory)
        self.directory = root
    }

    func save(_ files: [IntentFile], draftID: String) throws {
        try prepareDirectory()
        let url = fileURL(draftID: draftID)
        if files.isEmpty {
            try? FileManager.default.removeItem(at: url)
            return
        }
        let data = try JSONEncoder().encode(files.map(StoredAttachment.init))
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func load(draftID: String) throws -> [IntentFile] {
        let url = fileURL(draftID: draftID)
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode([StoredAttachment].self, from: data).map(\.intentFile)
    }

    func loadComposeAttachments(draftID: String) throws -> [ComposeAttachment] {
        try load(draftID: draftID).map {
            ComposeAttachment(
                filename: $0.filename,
                contentType: $0.type?.preferredMIMEType ?? "application/octet-stream",
                data: $0.data
            )
        }
    }

    func remove(draftID: String) throws {
        try? FileManager.default.removeItem(at: fileURL(draftID: draftID))
    }

    private func prepareDirectory() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var directory = directory
        try? directory.setResourceValues(values)
    }

    private func fileURL(draftID: String) -> URL {
        let key = Data(draftID.utf8).base64EncodedString()
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "=", with: "")
        return directory.appending(path: "\(key).json")
    }
}
