import Foundation
import UniformTypeIdentifiers

enum AssistantDraftFileReader {
    enum Failure: LocalizedError {
        case tooLarge
        case unreadable(String)
        var errorDescription: String? {
            switch self {
            case .tooLarge: "Attachments must total 25 MB or less. No files were attached."
            case .unreadable(let name): "Couldn’t read \(name). No files were attached. Try selecting the files again."
            }
        }
    }

    /// Reads outside the main actor and bounds actual bytes, not only metadata
    /// (a selected file can change size after its metadata was read).
    static func read(_ urls: [URL], byteLimit: Int = AssistantDraftStore.attachmentByteLimit) async throws -> [ComposeAttachment] {
        try await Task.detached(priority: .userInitiated) {
            var files: [ComposeAttachment] = []
            var remaining = min(AssistantDraftStore.attachmentByteLimit, max(0, byteLimit))
            for url in urls {
                let secured = url.startAccessingSecurityScopedResource()
                defer { if secured { url.stopAccessingSecurityScopedResource() } }
                do {
                    let metadata = try url.resourceValues(forKeys: [.contentTypeKey, .nameKey, .fileSizeKey, .isRegularFileKey])
                    guard metadata.isRegularFile == true else { throw Failure.unreadable(url.lastPathComponent) }
                    if let size = metadata.fileSize, size > remaining { throw Failure.tooLarge }
                    let handle = try FileHandle(forReadingFrom: url)
                    defer { try? handle.close() }
                    var data = Data()
                    while let chunk = try handle.read(upToCount: min(65_536, remaining + 1)), !chunk.isEmpty {
                        guard chunk.count <= remaining else { throw Failure.tooLarge }
                        data.append(chunk)
                        remaining -= chunk.count
                    }
                    files.append(ComposeAttachment(
                        filename: metadata.name ?? url.lastPathComponent,
                        contentType: metadata.contentType?.preferredMIMEType ?? "application/octet-stream",
                        data: data
                    ))
                } catch let failure as Failure {
                    throw failure
                } catch {
                    throw Failure.unreadable(url.lastPathComponent)
                }
            }
            return files
        }.value
    }
}
