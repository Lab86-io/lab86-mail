#if os(macOS)
import Foundation
import Testing
@testable import Lab86Mail

// Export my data on the Mac (round 2, FEATURES item 15): the save panel copy
// replaces the file the user chose, and the staged copy goes away.
@MainActor
struct MacExportTests {
    private static func stagedExport() throws -> URL {
        let download = FileManager.default.temporaryDirectory
            .appending(path: "mac-export-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: download, withIntermediateDirectories: true)
        let file = download.appending(path: "download")
        try Data("PK zip".utf8).write(to: file)
        return try DataExport.stage(DownloadedFile(url: file, contentType: "application/zip"))
    }

    @Test
    func theExportSavesACopyAndReplacesTheFileTheUserChose() throws {
        let staged = try Self.stagedExport()
        let folder = FileManager.default.temporaryDirectory
            .appending(path: "mac-export-destination-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let destination = folder.appending(path: "albatross-export.zip")
        try Data("older export".utf8).write(to: destination)

        try MacExportSavePanel.copy(staged, to: destination)
        #expect(try Data(contentsOf: destination) == Data("PK zip".utf8))
        #expect(MacExportSavePanel.savedLine(destination) == "Your export is saved as albatross-export.zip.")

        MacExportSavePanel.discardStaged(staged)
        #expect(!FileManager.default.fileExists(atPath: staged.path))
        #expect(!FileManager.default.fileExists(atPath: staged.deletingLastPathComponent().path))
        // The saved copy stays.
        #expect(FileManager.default.fileExists(atPath: destination.path))
    }

    @Test
    func discardingAFileOutsideTheExportFolderRemovesOnlyThatFile() throws {
        let folder = FileManager.default.temporaryDirectory
            .appending(path: "mac-export-other-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appending(path: "albatross-export.zip")
        try Data("x".utf8).write(to: file)

        MacExportSavePanel.discardStaged(file)
        #expect(!FileManager.default.fileExists(atPath: file.path))
        #expect(FileManager.default.fileExists(atPath: folder.path))
    }
}
#endif
