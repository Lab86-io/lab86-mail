import AppKit
import UniformTypeIdentifiers

// Export my data on the Mac (round 2, FEATURES item 15). The ZIP goes where
// the user saves it, through a save panel attached to the sheet that asked
// for it (Settings, or the account deletion sheet). The staged copy goes
// away when the panel closes, saved or not: the export holds all of the
// account's data, and the phone needs its copy only for the share sheet.
@MainActor
enum MacExportSavePanel {
    /// The line to show after the save, or nil when the user cancelled.
    static func save(_ staged: URL) async throws -> String? {
        defer { discardStaged(staged) }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = staged.lastPathComponent
        panel.allowedContentTypes = [.zip]
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false
        panel.message = "Save a copy of your Albatross data."
        let response: NSApplication.ModalResponse
        if let window = NSApp.keyWindow {
            response = await panel.beginSheetModal(for: window)
        } else {
            response = panel.runModal()
        }
        guard response == .OK, let destination = panel.url else { return nil }
        try copy(staged, to: destination)
        return savedLine(destination)
    }

    /// Puts the export at the place the user chose. The panel asked before
    /// it let the user pick a file that exists, so that file is replaced.
    nonisolated static func copy(_ staged: URL, to destination: URL) throws {
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: destination.path) {
            try fileManager.removeItem(at: destination)
        }
        try fileManager.copyItem(at: staged, to: destination)
    }

    nonisolated static func savedLine(_ destination: URL) -> String {
        "Your export is saved as \(destination.lastPathComponent)."
    }

    /// Removes the staging folder that `DataExport.stage` made for this one
    /// export. A file outside that layout loses only the file itself.
    nonisolated static func discardStaged(_ staged: URL) {
        let folder = staged.deletingLastPathComponent()
        if folder.deletingLastPathComponent().lastPathComponent == "AlbatrossExport" {
            try? FileManager.default.removeItem(at: folder)
        } else {
            try? FileManager.default.removeItem(at: staged)
        }
    }
}
