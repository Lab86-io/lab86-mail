import PDFKit
import SwiftUI

// A saved file in document mode (docs/albatross-goal-runs.md, G5): a PDF in
// a native, read-only PDFKit view; any other type in the system preview. The
// bytes come from `GET /api/files/saved/<fileId>`. A sealed file (a tax ID
// that fills in at send or download time) shows the line that says so and
// "Open on the web", where the identity check lives. iOS and macOS share
// this file.

enum SavedFileCopy {
    static let unavailable = "Albatross could not open the file. Try again."
    static let tryAgain = "Try again"
    static let openPreview = "Open the preview"
    static let otherType = "This file type opens in the system preview."

    /// A PDF by content type, else by the name of the saved file.
    static func isPDF(contentType: String?, url: URL) -> Bool {
        if let contentType, contentType.lowercased().hasPrefix("application/pdf") { return true }
        return url.pathExtension.lowercased() == "pdf"
    }
}

/// Reads the bytes of one saved file into a protected temporary file.
@MainActor
@Observable
final class SavedFileLoader {
    enum State: Equatable {
        case idle
        case inProgress
        case loaded(URL, contentType: String?)
        /// 403 `verify_identity`: the file fills in a sealed field.
        case needsIdentity
        case failed(String)
    }

    private(set) var state: State = .idle
    private var fileID: String?

    func load(fileID: String, backend: BackendClient) async {
        if self.fileID == fileID, case .loaded = state { return }
        self.fileID = fileID
        state = .inProgress
        do {
            let file = try await backend.download(path: DraftAttachmentClient.bytesPath(fileID: fileID))
            guard !Task.isCancelled, self.fileID == fileID else { return }
            state = .loaded(file.url, contentType: file.contentType)
        } catch BackendError.server(let status, _) where status == 403 {
            guard self.fileID == fileID else { return }
            state = .needsIdentity
        } catch {
            guard !Task.isCancelled, self.fileID == fileID else { return }
            state = .failed(SavedFileCopy.unavailable)
        }
    }

    func reset() {
        if case .loaded(let url, _) = state {
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
        }
        state = .idle
        fileID = nil
    }
}

struct SavedFileView: View {
    @Environment(AppEnvironment.self) private var environment
    let fileID: String
    let item: DocumentModeItem
    var onOpenWeb: () -> Void = {}

    @State private var loader = SavedFileLoader()
    @State private var previewURL: URL?

    var body: some View {
        VStack(spacing: 0) {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            if item.isSealed || loader.state == .needsIdentity {
                sealedBar
            }
        }
        .background(environment.theme.paperColor)
        .task(id: fileID) {
            await loader.load(fileID: fileID, backend: environment.backend)
        }
        .onDisappear { loader.reset() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(item.title)
    }

    @ViewBuilder private var content: some View {
        switch loader.state {
        case .idle, .inProgress:
            ProgressView()
        case .loaded(let url, let contentType):
            if SavedFileCopy.isPDF(contentType: contentType, url: url) {
                SavedFilePDFView(url: url)
            } else {
                otherFile(url)
            }
        case .needsIdentity:
            Text(GoalRunCopy.fileNeedsIdentity)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(24)
        case .failed(let line):
            VStack(spacing: 12) {
                Text(line)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button(SavedFileCopy.tryAgain) {
                    Task {
                        loader.reset()
                        await loader.load(fileID: fileID, backend: environment.backend)
                    }
                }
                .buttonStyle(.bordered)
            }
            .padding(24)
        }
    }

    private func otherFile(_ url: URL) -> some View {
        VStack(spacing: 12) {
            Text(SavedFileCopy.otherType)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button(SavedFileCopy.openPreview) { previewURL = url }
                .buttonStyle(.bordered)
        }
        .padding(24)
        .quickLookPreview($previewURL)
    }

    /// The line under a sealed file, and the way to the web.
    private var sealedBar: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider()
            Text(item.note ?? GoalRunCopy.fileNeedsIdentity)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(GoalRunCopy.openOnWeb, action: onOpenWeb)
                .buttonStyle(.bordered)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A read-only PDF page view, on either platform.
struct SavedFilePDFView {
    let url: URL

    @MainActor
    fileprivate func makePDFView() -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.backgroundColor = .clear
        view.document = PDFDocument(url: url)
        return view
    }

    @MainActor
    fileprivate func update(_ view: PDFView) {
        if view.document?.documentURL != url {
            view.document = PDFDocument(url: url)
        }
    }
}

#if os(macOS)
extension SavedFilePDFView: NSViewRepresentable {
    func makeNSView(context: Context) -> PDFView { makePDFView() }
    func updateNSView(_ nsView: PDFView, context: Context) { update(nsView) }
}
#else
extension SavedFilePDFView: UIViewRepresentable {
    func makeUIView(context: Context) -> PDFView { makePDFView() }
    func updateUIView(_ uiView: PDFView, context: Context) { update(uiView) }
}
#endif
