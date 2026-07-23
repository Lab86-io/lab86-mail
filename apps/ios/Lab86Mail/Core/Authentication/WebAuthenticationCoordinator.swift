import AuthenticationServices
import Observation
import UIKit

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

    private func authorize(response: JSONValue, successKey: String) async throws {
        guard let value = response["authorizationUrl"]?.stringValue,
              let authorizationURL = URL(string: value) else {
            throw BackendError.invalidResponse
        }
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
        let message = values["nylas_error"] ?? values["mcp_error"] ?? "Authorization was not completed."
        throw WebAuthenticationError.provider(message)
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes
            .flatMap(\.windows)
            .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
}
