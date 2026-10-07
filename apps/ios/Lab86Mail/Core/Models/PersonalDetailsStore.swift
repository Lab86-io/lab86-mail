import Foundation
import Observation

// The user's personal details on this device: one read-through store for the
// form cards (which prefill from it) and the settings page (which edits it).
// Values live in memory only; nothing is written to disk.

@MainActor
@Observable
final class PersonalDetailsStore {
    static let path = PersonalDetailsResponse.path
    /// A read is good for this long. A form that arrives inside the window
    /// uses the cached values.
    static let cacheLife: TimeInterval = 60

    private(set) var details: [PersonalDetailView] = []
    private(set) var missing: [PersonalDetailKey] = []
    private(set) var loaded = false
    private(set) var loadError: String?
    private var loadedAt: Date?
    private var revision = 0

    /// The details by key, for a prefill.
    var byKey: [PersonalDetailKey: PersonalDetailView] {
        Dictionary(details.map { ($0.key, $0) }, uniquingKeysWith: { _, last in last })
    }

    func detail(_ key: PersonalDetailKey) -> PersonalDetailView? {
        details.first { $0.key == key }
    }

    /// The custom details the user added, in the server's order.
    var customDetails: [PersonalDetailView] {
        details.filter { $0.key.isCustom }
    }

    func clear() {
        revision += 1
        details = []
        missing = []
        loaded = false
        loadError = nil
        loadedAt = nil
    }

    /// Reads the details. A fresh read within `cacheLife` is kept unless
    /// `force` is true.
    func load(_ transport: any BackendExchanging, force: Bool = false, now: Date = .now) async {
        if !force, loaded, let loadedAt, now.timeIntervalSince(loadedAt) < Self.cacheLife { return }
        revision += 1
        let requestRevision = revision
        do {
            let exchange = try await transport.exchange(method: "GET", path: Self.path, body: nil)
            guard revision == requestRevision, !Task.isCancelled else { return }
            guard exchange.isSuccess, let body = exchange.body else {
                loadError = exchange.errorMessage
                loaded = true
                return
            }
            let response = PersonalDetailsResponse(json: body)
            details = response.details
            missing = response.missing
            loadError = nil
            loaded = true
            loadedAt = now
        } catch {
            guard revision == requestRevision, !Task.isCancelled else { return }
            loaded = true
            loadError = error.localizedDescription
        }
    }

    /// Saves one detail. A new custom detail uses key `custom` and a label.
    /// Throws a `PersonalDetailSaveError` with the line the user reads.
    func save(
        key: PersonalDetailKey?,
        value: JSONValue,
        label: String? = nil,
        transport: any BackendExchanging
    ) async throws {
        var body: [String: JSONValue] = [
            "key": .string(key?.wire ?? "custom"),
            "value": value,
        ]
        if let label = label?.nilIfBlank { body["label"] = .string(label) }
        let exchange: BackendExchange
        do {
            exchange = try await transport.exchange(method: "PUT", path: Self.path, body: .object(body))
        } catch {
            throw PersonalDetailSaveError.other(error.localizedDescription)
        }
        guard exchange.isSuccess else {
            throw PersonalDetailSaveError.from(status: exchange.status, body: exchange.body)
        }
        await load(transport, force: true)
    }

    /// Deletes one detail. An account default comes back as "From your account".
    func delete(key: PersonalDetailKey, transport: any BackendExchanging) async throws {
        let encoded = key.wire.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? key.wire
        let exchange = try await transport.exchange(method: "DELETE", path: "\(Self.path)?key=\(encoded)", body: .object([:]))
        guard exchange.isSuccess else {
            throw BackendError.server(status: exchange.status, message: exchange.errorMessage)
        }
        await load(transport, force: true)
    }

    /// Puts the details back as they were before a save ("Undo" on a receipt).
    /// Throws when the server undid nothing (the one-day window ended, or a
    /// save from Settings came after), so a receipt never claims a false Undo.
    func undo(keys: [String], transport: any BackendExchanging) async throws {
        var undoneAny = false
        for key in keys {
            let exchange = try await transport.exchange(
                method: "POST",
                path: Self.path,
                body: .object(["action": .string("undo"), "key": .string(key)])
            )
            guard exchange.isSuccess else {
                throw BackendError.server(status: exchange.status, message: exchange.errorMessage)
            }
            let undone = exchange.body?["undone"]?.stringValue
            if undone == "restored" || undone == "removed" { undoneAny = true }
        }
        await load(transport, force: true)
        guard undoneAny else {
            throw BackendError.server(status: 409, message: Self.nothingToUndo)
        }
    }

    static let nothingToUndo = "There is nothing to undo now."


    /// The labels of keys on the wire, for a receipt line.
    static func labels(for keys: [String]) -> [String] {
        keys.map { key in
            PersonalDetailKey(wire: key)?.fixedLabel ?? key.replacingOccurrences(of: PersonalDetailKey.customPrefix, with: "")
        }
    }
}
