import Foundation
import Testing
@testable import Lab86Mail

// The saved-file viewer's loader (docs/albatross-goal-runs.md, G5): it asks
// `GET /api/files/saved/<fileId>`, keeps the downloaded file, reads a 403 as
// the identity check, and reads any other failure as the unavailable line.
@MainActor
struct SavedFileLoaderTests {
    @Test func aSavedFileLoadsFromItsRoute() async throws {
        let server = StubBackendServer()
        server.routes["/api/files/saved/file_w9"] = .object(["ok": .bool(true)])
        let loader = SavedFileLoader()
        await loader.load(fileID: "file_w9", backend: server.backend)
        guard case .loaded(let url, _) = loader.state else {
            Issue.record("expected a loaded file, got \(loader.state)")
            return
        }
        #expect(FileManager.default.fileExists(atPath: url.path(percentEncoded: false)))
        #expect(server.requests.contains("/api/files/saved/file_w9?preview=1"))
        // A second load of the same file does not ask again.
        await loader.load(fileID: "file_w9", backend: server.backend)
        #expect(server.requests.filter { $0 == "/api/files/saved/file_w9?preview=1" }.count == 1)
        loader.reset()
        #expect(loader.state == .idle)
        #expect(!FileManager.default.fileExists(atPath: url.path(percentEncoded: false)))
    }

    @Test func aNewFileRemovesTheDownloadOfTheLastOne() async throws {
        let server = StubBackendServer()
        server.routes["/api/files/saved/file_a"] = .object(["ok": .bool(true)])
        server.routes["/api/files/saved/file_b"] = .object(["ok": .bool(true)])
        let loader = SavedFileLoader()
        await loader.load(fileID: "file_a", backend: server.backend)
        guard case .loaded(let first, _) = loader.state else {
            Issue.record("expected a loaded file, got \(loader.state)")
            return
        }
        await loader.load(fileID: "file_b", backend: server.backend)
        guard case .loaded(let second, _) = loader.state else {
            Issue.record("expected a loaded file, got \(loader.state)")
            return
        }
        #expect(!FileManager.default.fileExists(atPath: first.path(percentEncoded: false)))
        #expect(FileManager.default.fileExists(atPath: second.path(percentEncoded: false)))
        loader.reset()
        #expect(!FileManager.default.fileExists(atPath: second.path(percentEncoded: false)))
    }

    @Test func aSealedFileNeedsTheIdentityCheck() async {
        let server = StubBackendServer()
        server.routes["/api/files/saved/file_w9"] = .object(["ok": .bool(false), "error": .string("Verify your identity."), "code": .string("verify_identity")])
        server.statuses["/api/files/saved/file_w9"] = 403
        let loader = SavedFileLoader()
        await loader.load(fileID: "file_w9", backend: server.backend)
        #expect(loader.state == .needsIdentity)
    }

    @Test func aMissingFileReadsAsUnavailable() async {
        let server = StubBackendServer()
        let loader = SavedFileLoader()
        await loader.load(fileID: "file_gone", backend: server.backend)
        #expect(loader.state == .failed(SavedFileCopy.unavailable))
    }

    @Test func aPDFIsKnownByTypeOrByName() {
        let pdf = URL(fileURLWithPath: "/tmp/download")
        #expect(SavedFileCopy.isPDF(contentType: "application/pdf", url: pdf))
        #expect(SavedFileCopy.isPDF(contentType: "APPLICATION/PDF; charset=binary", url: pdf))
        #expect(!SavedFileCopy.isPDF(contentType: "image/png", url: pdf))
        #expect(SavedFileCopy.isPDF(contentType: nil, url: URL(fileURLWithPath: "/tmp/Form W-9.PDF")))
        #expect(!SavedFileCopy.isPDF(contentType: nil, url: pdf))
    }

    @Test func theCopyHasNoIngForms() {
        for word in [SavedFileCopy.unavailable, SavedFileCopy.tryAgain, SavedFileCopy.openPreview, SavedFileCopy.otherType,
                     GoalRunCopy.fileNeedsIdentity, GoalRunCopy.sendNeedsAllow, GoalRunCopy.sealedGenericComposerLine,
                     DraftItemCopy.editAndSend, DraftItemCopy.noSubject, DraftItemCopy.unavailable] {
            for token in word.split(separator: " ") {
                #expect(!token.lowercased().hasSuffix("ing"), "\(word)")
            }
        }
    }
}
