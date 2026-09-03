import AuthenticationServices
import Observation
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

enum WebAuthenticationError: LocalizedError {
    case couldNotStart
    case invalidCallback
    case provider(String)

    var errorDescription: String? {
        switch self {
        case .couldNotStart:
            "Couldn’t open provider authorization."
        case .invalidCallback:
            "The provider returned an unreadable authorization result."
        case .provider(let message):
            message
        }
    }
}

@MainActor
@Observable
final class WebAuthenticationCoordinator: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let backend: BackendClient
    private var session: ASWebAuthenticationSession?
    #if canImport(UIKit)
    // The scene the flow started from; the anchor falls back to it if the
    // key window changes hands while the browser is up.
    private var anchorScene: UIWindowScene?
    #endif
    private(set) var isAuthorizing = false

    init(backend: BackendClient) {
        self.backend = backend
    }

    func connectMailbox(provider: String) async throws {
        let encoded = provider.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? provider
        let response = try await backend.get(
            path: "/api/nylas/connect?provider=\(encoded)&native=1&format=json"
        )
        try await authorize(response: response, successKey: "nylas_connected")
    }

    func connectOAuthSource(server: String) async throws {
        let encoded = server.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? server
        let response = try await backend.get(
            path: "/api/mcp/oauth/start?server=\(encoded)&native=1&format=json"
        )
        try await authorize(response: response, successKey: "mcp_connected")
    }

    func connectCloudFiles(provider: String) async throws {
        let encoded = provider.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? provider
        let response = try await backend.get(
            path: "/api/files/oauth/start?provider=\(encoded)&native=1&format=json"
        )
        try await authorize(
            response: response,
            successKey: "files_connected",
            completionPath: "/api/files/oauth/finalize"
        )
    }

    private func authorize(
        response: JSONValue,
        successKey: String,
        completionPath: String? = nil
    ) async throws {
        guard let value = response["authorizationUrl"]?.stringValue,
              let authorizationURL = URL(string: value) else {
            throw BackendError.invalidResponse
        }
        #if canImport(UIKit)
        // The browser must be anchored to a window the user can see; without
        // a foreground scene it would fail after the round trip instead of now.
        guard let presentingScene = Self.presentingScene() else { throw WebAuthenticationError.couldNotStart }
        anchorScene = presentingScene
        #endif
        isAuthorizing = true
        defer {
            isAuthorizing = false
            session = nil
        }
        let callbackURL = try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<URL, Error>) in
            let browser = ASWebAuthenticationSession(
                url: authorizationURL,
                callbackURLScheme: "lab86"
            ) { callback, error in
                Task { @MainActor in
                    if let error {
                        continuation.resume(throwing: error)
                    } else if let callback {
                        continuation.resume(returning: callback)
                    } else {
                        continuation.resume(throwing: WebAuthenticationError.invalidCallback)
                    }
                }
            }
            browser.presentationContextProvider = self
            browser.prefersEphemeralWebBrowserSession = false
            session = browser
            guard browser.start() else {
                session = nil
                continuation.resume(throwing: WebAuthenticationError.couldNotStart)
                return
            }
        }
        guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false) else {
            throw WebAuthenticationError.invalidCallback
        }
        let values = Dictionary(
            uniqueKeysWithValues: components.queryItems?.compactMap {
                item in item.value.map { (item.name, $0) }
            } ?? []
        )
        if values[successKey] != nil { return }
        if let completionToken = values["files_completion"], let completionPath {
            _ = try await backend.post(
                path: completionPath,
                body: .object(["completionToken": .string(completionToken)])
            )
            return
        }
        let message = values["nylas_error"]
            ?? values["mcp_error"]
            ?? values["files_error"]
            ?? "Authorization was not completed."
        throw WebAuthenticationError.provider(message)
    }

    #if canImport(UIKit)
    private static func anyScene() -> UIWindowScene? {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    }

    // The scene that is actually in front of the user, so a multi-window
    // iPad session never gets its browser sheet on another window.
    private static func presentingScene() -> UIWindowScene? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.first { $0.activationState == .foregroundActive && $0.windows.contains(where: \.isKeyWindow) }
            ?? scenes.first { $0.activationState == .foregroundActive }
            ?? scenes.first { $0.activationState == .foregroundInactive }
    }
    #endif

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if canImport(UIKit)
        // The scene the user is in front of anchors the browser: its key
        // window first, any of its windows next, and a fresh scene-owned
        // window only if it has none yet. `start()` already refused to run
        // without an active scene, so a scene is always here to own it.
        guard let scene = Self.presentingScene() ?? anchorScene ?? Self.anyScene() else {
            // `start()` refused to run without a scene, so this is unreachable
            // short of the app being torn down mid-flow.
            preconditionFailure("Web authentication needs a window scene to present in.")
        }
        return scene.windows.first(where: \.isKeyWindow) ?? scene.windows.first ?? UIWindow(windowScene: scene)
        #else
        return NSApplication.shared.keyWindow
            ?? NSApplication.shared.windows.first(where: \.isVisible)
            ?? ASPresentationAnchor()
        #endif
    }
}
