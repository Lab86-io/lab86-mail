import Foundation

/// A one-time code lifted out of mail, as stored for AutoFill.
///
/// This type is compiled into both the app and the AutoFill extension, so it is
/// deliberately free of UIKit and of any app-level dependency: the extension is
/// a separate, memory-constrained process and must not drag the app's object
/// graph in behind it.
struct StoredOneTimeCode: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let code: String
    let label: String
    let issuer: String
    /// Domains this code may be offered for, most specific first.
    let serviceIdentifiers: [String]
    let receivedAt: Date
    let expiresAt: Date

    func isActive(at moment: Date = .now) -> Bool {
        expiresAt > moment
    }
}

/// A code the extension handed to AutoFill but could not report to the server.
struct PendingCodeConsumption: Codable, Sendable, Equatable {
    let codeID: String
    let cleanup: String
    let recordedAt: Date
}

private struct VaultContents: Codable, Sendable {
    var codes: [StoredOneTimeCode] = []
    var pendingConsumptions: [PendingCodeConsumption] = []
    /// Consume-scoped bearer token, valid for far less than a session.
    var consumeToken: String?
    var cleanupMode: String = "none"
    var apiBaseURL: String?
}

/// Shared storage for one-time codes, backed by the app group container.
///
/// The app writes; the extension reads and appends consumption records. Access
/// is serialised through a coordinated file rather than `UserDefaults` because
/// two processes genuinely contend here — an AutoFill request can land while a
/// background push is writing a freshly arrived code.
struct OneTimeCodeVault: Sendable {
    static let appGroupIdentifier = "group.io.lab86.mail"

    private let fileURL: URL?

    init(appGroupIdentifier: String = OneTimeCodeVault.appGroupIdentifier) {
        fileURL = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)?
            .appendingPathComponent("one-time-codes.json", isDirectory: false)
    }

    /// Test seam: a vault backed by an arbitrary file rather than the container.
    init(fileURL: URL?) {
        self.fileURL = fileURL
    }

    var isAvailable: Bool { fileURL != nil }

    // MARK: - Reading

    func activeCodes(at moment: Date = .now) -> [StoredOneTimeCode] {
        load().codes.filter { $0.isActive(at: moment) }
    }

    /// Codes appropriate for a requesting service.
    ///
    /// AutoFill hands over the domain of the site or the bundle identifier of
    /// the app asking. A code matches when its own domain is that domain or a
    /// parent of it, so a code issued for `google.com` fills on
    /// `accounts.google.com` but a code for `evil-google.com` never does.
    func codes(forServiceIdentifier identifier: String, at moment: Date = .now) -> [StoredOneTimeCode] {
        let host = Self.normalizedHost(identifier)
        guard !host.isEmpty else { return [] }
        return activeCodes(at: moment)
            .filter { candidate in
                candidate.serviceIdentifiers.contains { Self.host(host, matches: $0) }
            }
            .sorted { $0.receivedAt > $1.receivedAt }
    }

    static func normalizedHost(_ identifier: String) -> String {
        var value = identifier.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let url = URL(string: value), let host = url.host, value.contains("://") {
            value = host
        }
        if let slash = value.firstIndex(of: "/") { value = String(value[value.startIndex..<slash]) }
        if let colon = value.firstIndex(of: ":") { value = String(value[value.startIndex..<colon]) }
        while value.hasPrefix(".") { value.removeFirst() }
        while value.hasSuffix(".") { value.removeLast() }
        return value
    }

    static func host(_ host: String, matches serviceIdentifier: String) -> Bool {
        let candidate = normalizedHost(serviceIdentifier)
        guard !candidate.isEmpty else { return false }
        if host == candidate { return true }
        // Suffix matching has to be label-aligned. A plain `hasSuffix` would let
        // `notgoogle.com` match a code issued for `google.com`.
        return host.hasSuffix("." + candidate)
    }

    var consumeToken: String? { load().consumeToken }
    var cleanupMode: String { load().cleanupMode }
    var apiBaseURL: String? { load().apiBaseURL }

    func pendingConsumptions() -> [PendingCodeConsumption] {
        load().pendingConsumptions
    }

    // MARK: - Writing

    /// Replaces the stored codes with the server's current set.
    ///
    /// Replacement rather than merge: the server is authoritative about which
    /// codes are still live, and a code it has dropped is one that must stop
    /// being offered.
    func replace(
        codes: [StoredOneTimeCode],
        consumeToken: String?,
        cleanupMode: String,
        apiBaseURL: String?
    ) {
        mutate { contents in
            contents.codes = codes
            contents.consumeToken = consumeToken
            contents.cleanupMode = cleanupMode
            contents.apiBaseURL = apiBaseURL
        }
    }

    /// Removes a code and queues its consumption for reporting.
    ///
    /// The code is dropped locally first so it can never be offered twice, even
    /// if the report never reaches the server.
    func consume(codeID: String, cleanup: String, at moment: Date = .now) {
        mutate { contents in
            contents.codes.removeAll { $0.id == codeID }
            guard !contents.pendingConsumptions.contains(where: { $0.codeID == codeID }) else { return }
            contents.pendingConsumptions.append(
                PendingCodeConsumption(codeID: codeID, cleanup: cleanup, recordedAt: moment)
            )
        }
    }

    func clearPendingConsumption(codeID: String) {
        mutate { contents in
            contents.pendingConsumptions.removeAll { $0.codeID == codeID }
        }
    }

    /// Drops everything. Used on sign-out: codes belong to the signed-in user.
    func clear() {
        mutate { contents in contents = VaultContents() }
    }

    func removeExpired(at moment: Date = .now) {
        mutate { contents in
            contents.codes.removeAll { !$0.isActive(at: moment) }
            // A consumption that could not be reported in a day never will be;
            // the code is long dead and the mail is no longer worth filing.
            contents.pendingConsumptions.removeAll { moment.timeIntervalSince($0.recordedAt) > 86_400 }
        }
    }

    // MARK: - Storage

    private func load() -> VaultContents {
        guard let fileURL, let data = try? Data(contentsOf: fileURL) else { return VaultContents() }
        return (try? JSONDecoder().decode(VaultContents.self, from: data)) ?? VaultContents()
    }

    private func mutate(_ transform: (inout VaultContents) -> Void) {
        guard let fileURL else { return }
        var contents = load()
        transform(&contents)
        guard let data = try? JSONEncoder().encode(contents) else { return }
        try? FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        // `.completeUntilFirstUserAuthentication` rather than `.complete`:
        // codes arrive by background push, which can land while the device is
        // locked, and a write that fails there would lose the code entirely.
        // AutoFill itself only ever runs unlocked.
        try? data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
