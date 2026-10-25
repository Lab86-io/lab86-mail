import Foundation
import Kingfisher

/// Which image requests carry the app's bearer token (M7). Company logos come
/// back from `resolve_photos` as `/api/logos/<domain>`, a route behind Clerk,
/// so a plain image request gets a sign-in redirect and the avatar never
/// loads. Only requests to the app's own API origin get the token; provider
/// photo hosts never see it.
enum APIImageAuthorization {
    static func shouldAuthorize(_ url: URL?, apiBaseURL: URL?) -> Bool {
        guard let url, let apiBaseURL,
              let host = url.host?.lowercased(),
              let apiHost = apiBaseURL.host?.lowercased(),
              host == apiHost else { return false }
        guard url.scheme?.lowercased() == apiBaseURL.scheme?.lowercased() else { return false }
        return url.port == apiBaseURL.port
    }

    static func authorized(_ request: URLRequest, token: String) -> URLRequest {
        var authorized = request
        authorized.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return authorized
    }
}

/// The Kingfisher request step. Installed once on the shared manager, so
/// every `KFImage` in the app goes through it.
final class APIImageRequestModifier: AsyncImageDownloadRequestModifier, Sendable {
    private let apiBaseURL: URL?
    private let tokenProvider: @Sendable () async throws -> String

    init(apiBaseURL: URL?, tokenProvider: @escaping @Sendable () async throws -> String) {
        self.apiBaseURL = apiBaseURL
        self.tokenProvider = tokenProvider
    }

    func modified(for request: URLRequest, reportModified: @escaping @Sendable (URLRequest?) -> Void) {
        guard APIImageAuthorization.shouldAuthorize(request.url, apiBaseURL: apiBaseURL) else {
            reportModified(request)
            return
        }
        let tokenProvider = self.tokenProvider
        Task.detached {
            // Without a token the request still goes out; the server answers
            // with its redirect and the view shows its initials fallback.
            guard let token = try? await tokenProvider() else {
                reportModified(request)
                return
            }
            reportModified(APIImageAuthorization.authorized(request, token: token))
        }
    }

    var onDownloadTaskStarted: (@Sendable (DownloadTask?) -> Void)? { nil }

    /// Installs the modifier as a default option of the shared manager.
    static func install(apiBaseURL: URL?, tokenProvider: @escaping @Sendable () async throws -> String) {
        let modifier = APIImageRequestModifier(apiBaseURL: apiBaseURL, tokenProvider: tokenProvider)
        KingfisherManager.shared.defaultOptions.append(.requestModifier(modifier))
    }
}
