import Foundation
import Observation

// Passwords and IDs on this device: one read-through store for the settings
// list, the detail, the sheets, the allow card, and the ask card. The store
// holds items without values (the server never sends one). Nothing is
// written to disk except one Boolean for each owner: whether the section is
// on, so Settings draws the row at once on the next open.

@MainActor
@Observable
final class SecureDetailsStore {
    static let path = SecureDetailsResponse.path
    /// A read is good for this long.
    static let cacheLife: TimeInterval = 60

    /// Nil until the first read lands.
    private(set) var enabled: Bool?
    private(set) var items: [SecureItemView] = []
    private(set) var loaded = false
    private(set) var loadError: String?
    private var loadedAt: Date?
    private var revision = 0
    private var ownerID: String?
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    static func cacheKey(ownerID: String) -> String { "secureDetails.enabled.\(ownerID)" }

    /// True once the server said the section is on.
    var isEnabled: Bool { enabled == true }

    /// Whether Settings shows the row: the server's answer, else the last
    /// answer for this owner, else hidden.
    func sectionVisible(ownerID: String?) -> Bool {
        if let enabled { return enabled }
        guard let ownerID else { return false }
        return defaults.bool(forKey: Self.cacheKey(ownerID: ownerID))
    }

    /// The items of one kind, by label.
    func items(of kind: SecureItemKind) -> [SecureItemView] {
        items
            .filter { $0.kind == kind }
            .sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
    }

    /// The one date of birth, when saved.
    var dateOfBirth: SecureItemView? { items.first { $0.kind == .dateOfBirth } }

    func item(id: String) -> SecureItemView? { items.first { $0.id == id } }

    /// An item of the kind whose sites cover the host.
    func item(kind: SecureItemKind, covering host: String) -> SecureItemView? {
        items(of: kind).first { $0.covers(host: host) }
    }

    func clear() {
        revision += 1
        enabled = nil
        items = []
        loaded = false
        loadError = nil
        loadedAt = nil
        ownerID = nil
    }

    /// Reads the items. A fresh read within `cacheLife` is kept unless `force` is true.
    func load(_ transport: any BackendExchanging, ownerID: String? = nil, force: Bool = false, now: Date = .now) async {
        if let ownerID { self.ownerID = ownerID }
        if !force, loaded, let loadedAt, now.timeIntervalSince(loadedAt) < Self.cacheLife { return }
        revision += 1
        let requestRevision = revision
        do {
            let exchange = try await transport.exchange(method: "GET", path: Self.path, body: nil)
            guard revision == requestRevision, !Task.isCancelled else { return }
            guard exchange.isSuccess, let body = exchange.body else {
                if exchange.status == 404 || exchange.status == 503 {
                    // The server has no store, or it is off: hide the section.
                    enabled = false
                    remember(enabled: false)
                }
                loadError = exchange.errorMessage
                loaded = true
                return
            }
            let response = SecureDetailsResponse(json: body)
            enabled = response.enabled
            items = response.items
            remember(enabled: response.enabled)
            loadError = nil
            loaded = true
            loadedAt = now
        } catch {
            guard revision == requestRevision, !Task.isCancelled else { return }
            loaded = true
            loadError = error.localizedDescription
        }
    }

    private func remember(enabled: Bool) {
        guard let ownerID else { return }
        defaults.set(enabled, forKey: Self.cacheKey(ownerID: ownerID))
    }

    /// Adds one item. Throws a `SecureSaveError` with the line the user reads.
    @discardableResult
    func create(
        kind: SecureItemKind,
        label: String?,
        sites: [String],
        values: [String: JSONValue],
        transport: any BackendExchanging
    ) async throws -> SecureItemView {
        var body: [String: JSONValue] = ["kind": .string(kind.rawValue), "values": .object(values)]
        if let label = label?.nilIfBlank { body["label"] = .string(label) }
        if !sites.isEmpty { body["sites"] = .array(sites.map(JSONValue.string)) }
        let exchange = try await send(method: "POST", path: Self.path, body: .object(body), transport: transport)
        let item = exchange.body?["item"].flatMap(SecureItemView.init(json:))
        await load(transport, force: true)
        guard let item else { throw SecureSaveError.other(SecureSaveError.saveFailedLine) }
        return item
    }

    /// Replaces values, the site list, or the label of one item. A new site
    /// needs the identity check: the server answers 403 `verify_identity`,
    /// and this throws `.verifyIdentity`.
    @discardableResult
    func update(
        id: String,
        label: String? = nil,
        sites: [String]? = nil,
        values: [String: JSONValue]? = nil,
        transport: any BackendExchanging
    ) async throws -> SecureItemView {
        var body: [String: JSONValue] = [:]
        if let label = label?.nilIfBlank { body["label"] = .string(label) }
        if let sites { body["sites"] = .array(sites.map(JSONValue.string)) }
        if let values { body["values"] = .object(values) }
        let exchange = try await send(method: "PUT", path: "\(Self.path)/\(Self.encoded(id))", body: .object(body), transport: transport)
        let item = exchange.body?["item"].flatMap(SecureItemView.init(json:))
        await load(transport, force: true)
        guard let item = item ?? self.item(id: id) else { throw SecureSaveError.other(SecureSaveError.saveFailedLine) }
        return item
    }

    func delete(id: String, transport: any BackendExchanging) async throws {
        _ = try await send(method: "DELETE", path: "\(Self.path)/\(Self.encoded(id))", body: .object([:]), transport: transport)
        items.removeAll { $0.id == id }
        await load(transport, force: true)
    }

    /// The recent uses of one item, newest first.
    func uses(id: String, transport: any BackendExchanging) async throws -> [SecureUseView] {
        let exchange = try await send(method: "GET", path: "\(Self.path)/\(Self.encoded(id))/uses", body: nil, transport: transport)
        return SecureUseView.list(from: exchange.body ?? .null)
    }

    /// The answer to an `allow_secure` handoff. `once` and `always` need the
    /// identity check (`.verifyIdentity`); a second answer is `.closed`.
    func allow(runID: String, itemID: String, site: String, scope: SecureAllowScope, transport: any BackendExchanging) async throws {
        let body: JSONValue = .object([
            "runId": .string(runID),
            "itemId": .string(itemID),
            "site": .string(site),
            "scope": .string(scope.rawValue),
        ])
        _ = try await send(method: "POST", path: "\(Self.path)/allow", body: body, transport: transport)
        if scope == .always { await load(transport, force: true) }
    }

    // MARK: - Private

    private func send(method: String, path: String, body: JSONValue?, transport: any BackendExchanging) async throws -> BackendExchange {
        let exchange: BackendExchange
        do {
            exchange = try await transport.exchange(method: method, path: path, body: body)
        } catch {
            throw SecureSaveError.other(error.localizedDescription)
        }
        guard exchange.isSuccess else {
            throw SecureSaveError.from(status: exchange.status, body: exchange.body)
        }
        return exchange
    }

    private static func encoded(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
    }
}
