import Foundation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

// Files in a chat message, as the web does it (components/shell/AIBar.tsx,
// lib/ai/chat-attachments.ts): the files upload to /api/agent/uploads, the
// user message carries one `file` part for each, and the model reads them
// through those parts. The hosts share one attach control with three
// sources: Files, Photos, and the camera on iOS.

/// A file the user sent with a message: a UIMessage `file` part.
struct AssistantFilePart: Identifiable, Equatable, Sendable {
    let id: String
    let filename: String
    let mediaType: String
    /// `/api/agent/uploads/<id>` on the app's API, or a data URL from the web.
    let url: String
    /// Known for a file sent from this device; a reopened conversation has
    /// only the part.
    var size: Int? = nil

    var uploadID: String? { ChatAttachmentRules.uploadID(from: url) }

    /// The part as the web writes it, for the agent request and history.
    var json: JSONValue {
        .object([
            "type": .string("file"),
            "mediaType": .string(mediaType),
            "url": .string(url),
            "filename": .string(filename),
        ])
    }

    /// A saved `file` part. The url is required; the rest has defaults.
    static func decode(_ part: JSONValue, id: String) -> AssistantFilePart? {
        guard let url = part["url"]?.stringValue?.nilIfBlank else { return nil }
        return AssistantFilePart(
            id: id,
            filename: part["filename"]?.stringValue?.nilIfBlank ?? ChatAttachmentRules.defaultFilename,
            mediaType: part["mediaType"]?.stringValue?.nilIfBlank ?? ChatAttachmentRules.defaultMediaType,
            url: url
        )
    }
}

extension AssistantChatMessage {
    /// The files sent with this message, in order.
    var files: [AssistantFilePart] {
        parts.compactMap { part in
            if case .file(let file) = part { return file }
            return nil
        }
    }
}

/// The picker and upload rules, the same as `lib/ai/chat-attachments.ts`.
enum ChatAttachmentRules {
    static let maxFiles = 5
    static let maxBytes = 25 * 1_024 * 1_024
    static let defaultFilename = "Attachment"
    static let defaultMediaType = "application/octet-stream"
    static let uploadContextLead = "Files uploaded in this user turn. To attach one of these files to a task card, call tasks_attach_file with the matching chatUploadId:"

    /// The types the server takes, by extension.
    static let mediaTypes: [String: String] = [
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
        "gif": "image/gif",
        "pdf": "application/pdf",
        "txt": "text/plain",
        "csv": "text/csv",
        "md": "text/markdown",
        "json": "application/json",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]

    /// The server's type for a file: the declared one when the server takes
    /// it, else the one its extension says. Nil for a type the server refuses.
    static func mediaType(filename: String, declared: String?) -> String? {
        if let declared = declared?.lowercased().nilIfBlank, mediaTypes.values.contains(declared) {
            return declared
        }
        guard let dot = filename.lastIndex(of: ".") else { return nil }
        return mediaTypes[String(filename[filename.index(after: dot)...]).lowercased()]
    }

    /// The web's validation message, or nil when the files can go.
    static func validationError(_ files: [ComposeAttachment]) -> String? {
        if files.count > maxFiles { return "Attach at most \(maxFiles) files per message." }
        if files.reduce(0, { $0 + $1.data.count }) > maxBytes { return "Attachments must total 25 MB or less." }
        for file in files {
            if file.data.isEmpty { return "\(file.filename) is empty. Choose a file with content." }
            if mediaType(filename: file.filename, declared: file.contentType) == nil {
                return "\(file.filename) is not supported. Use an image, PDF, text, CSV, DOCX, XLSX, or PPTX file."
            }
        }
        return nil
    }

    static func uploadPath(_ uploadID: String) -> String {
        "/api/agent/uploads/\(uploadID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? uploadID)"
    }

    /// The upload id of an app attachment url, else nil (a data URL, a web link).
    static func uploadID(from url: String) -> String? {
        let prefix = "/api/agent/uploads/"
        guard url.hasPrefix(prefix) else { return nil }
        let id = url.dropFirst(prefix.count)
        guard !id.isEmpty, id.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" }) else { return nil }
        return String(id)
    }

    /// "- notes.txt (text/plain, 1200 bytes): chatUploadId=u1", as the web
    /// writes the system context line.
    static func uploadContextLine(name: String, contentType: String, size: Int, uploadID: String) -> String {
        "- \(name) (\(contentType), \(size) bytes): chatUploadId=\(uploadID)"
    }

    /// "1.2 MB", for the chip in the user's turn.
    static func sizeText(_ bytes: Int) -> String {
        Int64(bytes).formatted(.byteCount(style: .file))
    }
}

/// Local copies of the files in a conversation, for the viewer: the bytes
/// this device sent, and a download through the app's API for the rest.
@MainActor
final class ChatAttachmentCache {
    static let shared = ChatAttachmentCache()

    private var urls: [String: URL] = [:]
    private let directory = FileManager.default.temporaryDirectory
        .appending(path: "albatross-chat-uploads", directoryHint: .isDirectory)

    /// Keeps the bytes of a file this device uploaded. Nil when the disk
    /// refused; the chip then downloads on tap.
    @discardableResult
    func store(_ data: Data, uploadID: String, filename: String) -> URL? {
        let target = location(uploadID: uploadID, filename: filename)
        do {
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: target, options: [.atomic])
        } catch {
            return nil
        }
        urls[uploadID] = target
        return target
    }

    func url(for uploadID: String) -> URL? {
        urls[uploadID]
    }

    /// The local copy of a file part: the stored one, else a download. Nil
    /// for a file that is not an app upload.
    func localURL(
        for file: AssistantFilePart,
        download: (String) async throws -> DownloadedFile
    ) async throws -> URL? {
        guard let uploadID = file.uploadID else { return nil }
        if let url = urls[uploadID], FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) {
            return url
        }
        let downloaded = try await download(ChatAttachmentRules.uploadPath(uploadID))
        let target = location(uploadID: uploadID, filename: file.filename)
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: target)
        try FileManager.default.copyItem(at: downloaded.url, to: target)
        urls[uploadID] = target
        return target
    }

    private func location(uploadID: String, filename: String) -> URL {
        let safeName = filename.replacingOccurrences(of: "/", with: "-").nilIfBlank ?? ChatAttachmentRules.defaultFilename
        return directory
            .appending(path: uploadID, directoryHint: .isDirectory)
            .appending(path: safeName)
    }
}

// MARK: - Photos and the camera

/// A picked photo as an attachment the server takes: its own bytes for a
/// JPEG, PNG, GIF, or WebP; JPEG bytes for anything else (HEIC).
enum PhotoAttachment {
    static let jpegQuality: CGFloat = 0.85

    private static let kept: [(type: UTType, ext: String, mime: String)] = [
        (.jpeg, "jpeg", "image/jpeg"),
        (.png, "png", "image/png"),
        (.gif, "gif", "image/gif"),
        (.webP, "webp", "image/webp"),
    ]

    static func attachment(data: Data, declaredType: UTType?, index: Int) -> ComposeAttachment? {
        if let declaredType, let match = kept.first(where: { declaredType.conforms(to: $0.type) }) {
            return ComposeAttachment(filename: "Photo \(index).\(match.ext)", contentType: match.mime, data: data)
        }
        guard let jpeg = jpegData(from: data) else { return nil }
        return ComposeAttachment(filename: "Photo \(index).jpeg", contentType: "image/jpeg", data: jpeg)
    }

    static func jpegData(from data: Data) -> Data? {
        #if canImport(UIKit)
        return UIImage(data: data)?.jpegData(compressionQuality: jpegQuality)
        #else
        guard let image = NSImage(data: data), let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff) else { return nil }
        return bitmap.representation(using: .jpeg, properties: [.compressionFactor: jpegQuality])
        #endif
    }
}

/// Where an attachment comes from. The composer lists them in this order.
enum ComposerAttachSource: String, CaseIterable, Identifiable, Sendable {
    case files
    case photos
    case camera

    var id: String { rawValue }

    var label: String {
        switch self {
        case .files: "Files"
        case .photos: "Photos"
        case .camera: "Camera"
        }
    }

    /// The sources this device offers. The camera needs hardware and its
    /// usage text in the app's Info.plist.
    @MainActor static var available: [ComposerAttachSource] {
        #if os(iOS)
        return CameraCapture.isAvailable ? [.files, .photos, .camera] : [.files, .photos]
        #else
        return [.files, .photos]
        #endif
    }
}

/// The three pickers behind the attach control. A host sets `request`; the
/// modifier presents the picker and adds the files, within the limits.
struct AttachmentSourcesModifier: ViewModifier {
    @Binding var request: ComposerAttachSource?
    @Binding var files: [ComposeAttachment]
    @State private var showsFileImporter = false
    @State private var showsPhotosPicker = false
    @State private var photoSelection: [PhotosPickerItem] = []
    @State private var showsCamera = false

    func body(content: Content) -> some View {
        content
            .onChange(of: request) { _, next in
                guard let next else { return }
                request = nil
                switch next {
                case .files: showsFileImporter = true
                case .photos: showsPhotosPicker = true
                case .camera: showsCamera = true
                }
            }
            .fileImporter(
                isPresented: $showsFileImporter,
                allowedContentTypes: [.item],
                allowsMultipleSelection: true
            ) { result in
                guard case .success(let urls) = result else { return }
                AssistantComposerFiles.importing(urls, into: &files)
            }
            .photosPicker(
                isPresented: $showsPhotosPicker,
                selection: $photoSelection,
                maxSelectionCount: max(1, AssistantComposerFiles.limit - files.count),
                matching: .images
            )
            .onChange(of: photoSelection) { _, items in
                guard !items.isEmpty else { return }
                photoSelection = []
                Task { await addPhotos(items) }
            }
            .modifier(CameraSheet(isPresented: $showsCamera, files: $files))
    }

    private func addPhotos(_ items: [PhotosPickerItem]) async {
        for item in items {
            guard files.count < AssistantComposerFiles.limit,
                  let data = try? await item.loadTransferable(type: Data.self),
                  let attachment = PhotoAttachment.attachment(
                    data: data,
                    declaredType: item.supportedContentTypes.first,
                    index: files.count + 1
                  ),
                  AssistantComposerFiles.fits(attachment, with: files) else { continue }
            files.append(attachment)
        }
    }
}

extension View {
    func composerAttachmentSources(request: Binding<ComposerAttachSource?>, files: Binding<[ComposeAttachment]>) -> some View {
        modifier(AttachmentSourcesModifier(request: request, files: files))
    }
}

private struct CameraSheet: ViewModifier {
    @Binding var isPresented: Bool
    @Binding var files: [ComposeAttachment]

    func body(content: Content) -> some View {
        #if os(iOS)
        content.fullScreenCover(isPresented: $isPresented) {
            CameraCapture { image in
                isPresented = false
                guard let image, let data = image.jpegData(compressionQuality: PhotoAttachment.jpegQuality),
                      files.count < AssistantComposerFiles.limit else { return }
                let attachment = ComposeAttachment(filename: "Photo \(files.count + 1).jpeg", contentType: "image/jpeg", data: data)
                if AssistantComposerFiles.fits(attachment, with: files) { files.append(attachment) }
            }
            .ignoresSafeArea()
        }
        #else
        content
        #endif
    }
}

#if os(iOS)
/// The system camera. One photo, as a UIImage, or nil on cancel.
struct CameraCapture: UIViewControllerRepresentable {
    let onImage: (UIImage?) -> Void

    /// The device has a camera and the app declares why it uses it.
    @MainActor static var isAvailable: Bool {
        UIImagePickerController.isSourceTypeAvailable(.camera)
            && Bundle.main.object(forInfoDictionaryKey: "NSCameraUsageDescription") != nil
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onImage: onImage)
    }

    @MainActor
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onImage: (UIImage?) -> Void

        init(onImage: @escaping (UIImage?) -> Void) {
            self.onImage = onImage
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            onImage(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onImage(nil)
        }
    }
}
#endif
