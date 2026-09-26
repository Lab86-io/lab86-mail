import Foundation
import Observation

/// The account's plan and its optional surfaces, shared by Today, Settings,
/// and the shells (round 2, FEATURES items 2 and 17). The server owns both
/// choices, so web and native agree; the Files choice is cached per owner so
/// the rail draws the right rows before the first answer arrives.
@MainActor
@Observable
final class AccountTrustStore {
    private let backend: BackendClient
    private let defaults: UserDefaults
    private var planLoadedAt: Date?

    private(set) var plan: BillingPlan?
    /// Whether Files shows in the rail. Nil until the owner is known.
    private(set) var filesSurface: Bool?
    private var ownerID: String?

    init(backend: BackendClient, defaults: UserDefaults = .standard) {
        self.backend = backend
        self.defaults = defaults
    }

    /// Files shows until the server says otherwise, so an account with
    /// documents never loses the surface to a slow first read.
    var showsFiles: Bool { filesSurface ?? true }

    static func filesKey(ownerID: String) -> String { "albatross.surfaces.files.\(ownerID)" }

    /// Picks up the cached choice of the signed-in owner.
    func activate(ownerID: String?) {
        guard self.ownerID != ownerID else { return }
        self.ownerID = ownerID
        plan = nil
        planLoadedAt = nil
        guard let ownerID else {
            filesSurface = nil
            return
        }
        let key = Self.filesKey(ownerID: ownerID)
        filesSurface = defaults.object(forKey: key) == nil ? nil : defaults.bool(forKey: key)
    }

    /// Reads the plan at most once in ten minutes unless forced.
    func refreshPlan(force: Bool = false, now: Date = .now) async {
        if !force, let planLoadedAt, now.timeIntervalSince(planLoadedAt) < 600 { return }
        do {
            let json = try await backend.get(path: BillingPlan.path)
            if let plan = BillingPlan(json: json) {
                self.plan = plan
                planLoadedAt = now
            }
        } catch {
            // The plan note is quiet. A failed read shows nothing.
        }
    }

    func refreshSurfaces() async {
        do {
            let json = try await backend.get(path: AccountSurfaces.path)
            if let surfaces = AccountSurfaces(json: json) { store(files: surfaces.files) }
        } catch {
            // The cached choice stays until a read succeeds.
        }
    }

    /// The rail changes only after the server stores the choice.
    func setFilesSurface(_ enabled: Bool) async throws {
        let json = try await backend.post(path: AccountSurfaces.path, body: AccountSurfaces.body(files: enabled))
        guard let surfaces = AccountSurfaces(json: json) else { throw BackendError.invalidResponse }
        store(files: surfaces.files)
    }

    func clear() {
        if let ownerID { defaults.removeObject(forKey: Self.filesKey(ownerID: ownerID)) }
        ownerID = nil
        plan = nil
        planLoadedAt = nil
        filesSurface = nil
    }

    private func store(files: Bool) {
        filesSurface = files
        if let ownerID { defaults.set(files, forKey: Self.filesKey(ownerID: ownerID)) }
    }
}
