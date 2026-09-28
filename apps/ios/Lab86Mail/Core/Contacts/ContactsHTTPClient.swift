import Foundation

/// The contacts endpoints of mobile v1 over the plain backend client. It reads
/// the contract JSON directly, so it works before the generated MobileAPI
/// client has the contacts operations.
actor ContactsHTTPClient: RecipientSearching, ContactStatusServing {
    private let backend: BackendClient

    init(backend: BackendClient) {
        self.backend = backend
    }

    func searchRecipients(_ request: RecipientSearchRequest) async throws -> RecipientSuggestionPage {
        let response = try await backend.get(path: Self.recipientsPath(for: request))
        guard let page = RecipientSuggestionPage(json: response) else { throw BackendError.invalidResponse }
        return page
    }

    func fetchContactStatus() async throws -> ContactStatusPage {
        let response = try await backend.get(path: "/api/mobile/v1/contacts/status")
        guard let page = ContactStatusPage(json: response) else { throw BackendError.invalidResponse }
        return page
    }

    func resyncContacts(accountID: String) async throws -> ContactResyncReceipt {
        let response = try await backend.post(
            path: "/api/mobile/v1/contacts/resync",
            body: .object(["accountID": .string(accountID)])
        )
        guard let receipt = ContactResyncReceipt(json: response) else { throw BackendError.invalidResponse }
        return receipt
    }

    /// `q`, `fromAccountID`, `limit`, and one `exclude` for each address.
    nonisolated static func recipientsPath(for request: RecipientSearchRequest) -> String {
        var components = URLComponents()
        components.path = "/api/mobile/v1/contacts/recipients"
        var items = [URLQueryItem(name: "q", value: request.query)]
        if let account = request.fromAccountID {
            items.append(URLQueryItem(name: "fromAccountID", value: account))
        }
        items.append(URLQueryItem(name: "limit", value: String(request.limit)))
        items += request.exclude.map { URLQueryItem(name: "exclude", value: $0) }
        components.queryItems = items
        // `+` is legal in a query but a server can read it as a space.
        components.percentEncodedQuery = components.percentEncodedQuery?
            .replacingOccurrences(of: "+", with: "%2B")
        return components.string ?? "/api/mobile/v1/contacts/recipients"
    }
}
