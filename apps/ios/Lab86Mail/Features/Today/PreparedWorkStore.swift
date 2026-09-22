import Foundation
import MobileAPI
import Observation

/// The transport behind the "Prepared for you" section, so the store can be
/// exercised against a scripted server in tests. `PreparedWorkClient` is the
/// production conformer.
protocol PreparedWorkTransport: Sendable {
    func list() async throws -> [PreparedItem]
    func act(_ action: PreparedWorkAction) async throws -> PreparedWorkActionResult
}

extension PreparedWorkClient: PreparedWorkTransport {}

/// Pure rules the section follows. The same rules the web pins: the section
/// mounts only under the latest edition (`!selectedId`), and it stays hidden
/// until there is something to say.
enum PreparedWorkPolicy {
    /// The web mounts `<PreparedWork />` only while the latest edition is on
    /// screen. History editions never carry live preparations.
    static func mounts(hasArtifact: Bool, showsLatest: Bool) -> Bool {
        hasArtifact && showsLatest
    }

    /// Hidden until there are items, an error, or a result to report.
    static func visible(itemCount: Int, error: String?, message: String?) -> Bool {
        itemCount > 0 || error != nil || message != nil
    }

    /// The status line under a card title. Mirrors the web word for word.
    static func statusLine(_ item: PreparedItem, now: Date = .now, locale: Locale = .current) -> String {
        var line: String
        if item.needsRefresh {
            line = "Sources changed · refresh before adopting"
        } else if let preparedAt = item.preparedAt {
            let time = preparedAt.formatted(.dateTime.hour().minute().locale(locale))
            line = "Prepared \(time)"
        } else {
            line = "Preparing in the background"
        }
        if item.userFiles != nil { line += " · Your file edits are saved" }
        return line
    }

    /// The label beside the title: the shape, or that the draft extends work
    /// that already exists.
    static func shapeLabel(_ item: PreparedItem) -> String? {
        guard let draft = item.draft else { return nil }
        if item.workID != nil { return "For existing work" }
        return WorkShape.resolve(draft.shape).label
    }

    static func adoptLabel(_ item: PreparedItem) -> String {
        item.workID != nil ? "Add to work" : "Adopt"
    }

    /// Adopt is allowed only for a prepared draft whose sources are current,
    /// with no unsaved notes. The web disables the button under the same rule.
    static func canAdopt(_ item: PreparedItem, busy: Bool, dirty: Bool) -> Bool {
        !busy && item.draft != nil && !item.needsRefresh && !dirty
    }

    static func showsRefresh(_ item: PreparedItem) -> Bool {
        item.needsRefresh || item.error != nil
    }

    /// "12 KB", "840 bytes" — the size the file row prints.
    static func sizeLabel(byteCount: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(byteCount), countStyle: .file)
    }

    /// The temp file a draft is written to for preview and sharing. One
    /// directory per preparation so the same name is never overwritten
    /// underneath an open preview of another item.
    static func temporaryURL(for file: PreparedFile, itemID: String) -> URL {
        let safeName = file.name.replacingOccurrences(of: "/", with: "-")
        return FileManager.default.temporaryDirectory
            .appending(path: "PreparedWork", directoryHint: .isDirectory)
            .appending(path: itemID, directoryHint: .isDirectory)
            .appending(path: safeName)
    }

    /// Preview and share files contain private source material. Protect both
    /// the preparation directory and each atomic replacement while locked.
    static func stageFile(
        _ file: PreparedFile,
        itemID: String,
        fileManager: FileManager = .default,
        write: (Data, URL, Data.WritingOptions) throws -> Void = { data, url, options in
            try data.write(to: url, options: options)
        }
    ) throws -> URL {
        let url = temporaryURL(for: file, itemID: itemID)
        try fileManager.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
        )
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.complete],
            ofItemAtPath: url.deletingLastPathComponent().path
        )
        try write(Data(file.content.utf8), url, [.atomic, .completeFileProtection])
        return url
    }

    /// The message printed after a successful write.
    static func resultMessage(_ result: PreparedWorkActionResult) -> String {
        result.workID != nil ? "Saved to your work." : "Saved."
    }
}

/// Read-through state for the section. Never cached to disk: a preparation
/// is a live server row that can be dismissed, adopted, or refreshed from
/// any client, so the list is only ever what the server last said.
@MainActor
@Observable
final class PreparedWorkStore {
    private(set) var items: [PreparedItem] = []
    private(set) var error: String?
    private(set) var message: String?
    private(set) var busy = false
    private(set) var loaded = false
    private var revision = 0

    var isVisible: Bool { PreparedWorkPolicy.visible(itemCount: items.count, error: error, message: message) }

    func clear() {
        revision += 1
        items = []
        error = nil
        message = nil
        busy = false
        loaded = false
    }

    func load(_ transport: any PreparedWorkTransport) async {
        revision += 1
        let requestRevision = revision
        do {
            let rows = try await transport.list()
            guard revision == requestRevision, !Task.isCancelled else { return }
            items = rows
            error = nil
            loaded = true
        } catch {
            guard revision == requestRevision, !Task.isCancelled else { return }
            loaded = true
            self.error = error.localizedDescription
        }
    }

    /// Performs one write and reloads the list. Dismiss removes the card
    /// first and puts it back on failure. Returns the server result, or nil
    /// when the write failed; the failure text is in `error`.
    @discardableResult
    func perform(
        _ action: PreparedWorkAction,
        transport: any PreparedWorkTransport
    ) async -> PreparedWorkActionResult? {
        guard !busy else { return nil }
        busy = true
        defer { busy = false }
        let snapshot = items
        if action.operation == .dismiss {
            items.removeAll { $0.id == action.id }
        }
        do {
            let result = try await transport.act(action)
            message = PreparedWorkPolicy.resultMessage(result)
            error = nil
            await load(transport)
            return result
        } catch {
            if action.operation == .dismiss { items = snapshot }
            self.error = error.localizedDescription
            return nil
        }
    }
}
