import Foundation

struct AppConfiguration: Sendable {
    let apiBaseURL: URL?
    let clerkPublishableKey: String?
    let convexDeploymentURL: String?

    static let current = AppConfiguration(bundle: .main)

    init(bundle: Bundle) {
        let api = bundle.configuredString(for: "LAB86_API_BASE_URL")
        apiBaseURL = api.flatMap(URL.init(string:))
        clerkPublishableKey = bundle.configuredString(for: "CLERK_PUBLISHABLE_KEY")
        convexDeploymentURL = bundle.configuredString(for: "CONVEX_DEPLOYMENT_URL")
    }

    var missingKeys: [String] {
        var keys: [String] = []
        if apiBaseURL == nil { keys.append("LAB86_API_BASE_URL") }
        if clerkPublishableKey == nil { keys.append("CLERK_PUBLISHABLE_KEY") }
        if convexDeploymentURL == nil { keys.append("CONVEX_DEPLOYMENT_URL") }
        return keys
    }

    var isReady: Bool { missingKeys.isEmpty }
}

private extension Bundle {
    func configuredString(for key: String) -> String? {
        guard let raw = object(forInfoDictionaryKey: key) as? String else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !value.contains("$(") else { return nil }
        return value
    }
}

