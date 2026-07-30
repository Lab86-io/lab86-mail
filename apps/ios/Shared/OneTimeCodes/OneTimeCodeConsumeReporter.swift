import Foundation

/// Reports a used one-time code to the server so the mail that carried it can
/// be filed.
///
/// Shared by the app and the AutoFill extension. The extension has no session,
/// so this speaks only the consume-scoped token protocol — deliberately the
/// smallest possible surface, since it runs in the least trusted process.
struct OneTimeCodeConsumeReporter: Sendable {
    enum ReportError: Error {
        case notConfigured
        case rejected(status: Int)
    }

    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    /// Sends one consumption. Throws so the caller can leave it queued.
    func report(
        codeID: String,
        cleanup: String,
        baseURL: String?,
        consumeToken: String?
    ) async throws {
        guard let baseURL,
              let consumeToken,
              !consumeToken.isEmpty,
              let url = URL(string: "/api/mobile/one-time-codes/consume", relativeTo: URL(string: baseURL))
        else { throw ReportError.notConfigured }

        var request = URLRequest(url: url.absoluteURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(consumeToken, forHTTPHeaderField: "x-lab86-consume-token")
        // The extension is killed shortly after it returns a credential, so a
        // slow network must not hold it open waiting.
        request.timeoutInterval = 10
        request.httpBody = try JSONSerialization.data(
            withJSONObject: ["codeId": codeID, "cleanup": cleanup]
        )

        let (_, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        // 404 means the server no longer knows this code; retrying will not
        // help, so it counts as settled rather than as a failure to retry.
        guard (200..<300).contains(status) || status == 404 else {
            throw ReportError.rejected(status: status)
        }
    }
}
