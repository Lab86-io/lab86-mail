import Foundation

enum BackendError: LocalizedError, Sendable {
    case configuration
    case unauthorized
    case invalidResponse
    case server(status: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .configuration: "The Lab86 server is not configured."
        case .unauthorized: "Sign in again to continue."
        case .invalidResponse: "The server returned an unreadable response."
        case .server(_, let message): message
        }
    }
}

struct MultipartFile: Sendable {
    let fieldName: String
    let filename: String
    let contentType: String
    let data: Data
}

struct ComposeAttachment: Identifiable, Hashable, Sendable {
    let id: UUID
    let filename: String
    let contentType: String
    let data: Data

    init(id: UUID = UUID(), filename: String, contentType: String, data: Data) {
        self.id = id
        self.filename = filename
        self.contentType = contentType
        self.data = data
    }

    var multipart: MultipartFile {
        MultipartFile(fieldName: "attachments", filename: filename, contentType: contentType, data: data)
    }
}

struct DownloadedFile: Sendable {
    let url: URL
    let contentType: String?
}

actor BackendClient {
    private let baseURL: URL?
    private let session: URLSession
    private let tokenProvider: @Sendable () async throws -> String

    init(
        baseURL: URL?,
        session: URLSession = .shared,
        tokenProvider: @escaping @Sendable () async throws -> String = {
            try await ClerkSessionAccess.activeToken()
        }
    ) {
        self.baseURL = baseURL
        self.session = session
        self.tokenProvider = tokenProvider
    }

    func get(path: String) async throws -> JSONValue {
        try await request(method: "GET", path: path, body: nil)
    }

    func post(path: String, body: JSONValue) async throws -> JSONValue {
        try await request(method: "POST", path: path, body: body)
    }

    func delete(path: String, body: JSONValue) async throws -> JSONValue {
        try await request(method: "DELETE", path: path, body: body)
    }

    func put(path: String, body: JSONValue) async throws -> JSONValue {
        try await request(method: "PUT", path: path, body: body)
    }

    func patch(path: String, body: JSONValue) async throws -> JSONValue {
        try await request(method: "PATCH", path: path, body: body)
    }

    func download(path: String) async throws -> DownloadedFile {
        guard let baseURL, let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw BackendError.configuration
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue(TimeZone.current.identifier, forHTTPHeaderField: "x-user-timezone")
        try await authenticate(&request)
        let (temporaryURL, response) = try await session.download(for: request)
        guard let http = response as? HTTPURLResponse else { throw BackendError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw BackendError.unauthorized }
            throw BackendError.server(
                status: http.statusCode,
                message: HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            )
        }
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "AlbatrossDownloads", directoryHint: .isDirectory)
            .appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
        )
        let stagedURL = directory.appending(path: "download")
        do {
            try FileManager.default.moveItem(at: temporaryURL, to: stagedURL)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
        return DownloadedFile(url: stagedURL, contentType: http.value(forHTTPHeaderField: "Content-Type"))
    }

    func postMultipart(path: String, fields: [String: String], files: [MultipartFile]) async throws -> JSONValue {
        guard let baseURL, let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw BackendError.configuration
        }
        let boundary = "Albatross-\(UUID().uuidString)"
        var body = Data()
        for (name, value) in fields {
            body.appendUTF8("--\(boundary)\r\n")
            body.appendUTF8("Content-Disposition: form-data; name=\"\(Self.headerValue(name))\"\r\n\r\n")
            body.appendUTF8(value)
            body.appendUTF8("\r\n")
        }
        for file in files {
            body.appendUTF8("--\(boundary)\r\n")
            body.appendUTF8(
                "Content-Disposition: form-data; name=\"\(Self.headerValue(file.fieldName))\"; filename=\"\(Self.headerValue(file.filename))\"\r\n"
            )
            body.appendUTF8("Content-Type: \(Self.headerValue(file.contentType))\r\n\r\n")
            body.append(file.data)
            body.appendUTF8("\r\n")
        }
        body.appendUTF8("--\(boundary)--\r\n")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue(TimeZone.current.identifier, forHTTPHeaderField: "x-user-timezone")
        try await authenticate(&request)
        request.httpBody = body
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw BackendError.invalidResponse }
        let decoded = try? JSONDecoder().decode(JSONValue.self, from: data)
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw BackendError.unauthorized }
            let message = decoded?["error"]?.stringValue ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            throw BackendError.server(status: http.statusCode, message: message)
        }
        guard let decoded else { throw BackendError.invalidResponse }
        return decoded
    }

    private func request(method: String, path: String, body: JSONValue?) async throws -> JSONValue {
        guard let baseURL, let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw BackendError.configuration
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(TimeZone.current.identifier, forHTTPHeaderField: "x-user-timezone")
        try await authenticate(&request)
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw BackendError.invalidResponse }
        let decoded = try? JSONDecoder().decode(JSONValue.self, from: data)
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw BackendError.unauthorized }
            let message = decoded?["error"]?.stringValue ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            throw BackendError.server(status: http.statusCode, message: message)
        }
        guard let decoded else { throw BackendError.invalidResponse }
        return decoded
    }

    private func authenticate(_ request: inout URLRequest) async throws {
        let token = try await tokenProvider()
        guard !token.isEmpty else { throw SessionAuthenticationError.tokenUnavailable }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }

    private static func headerValue(_ value: String) -> String {
        value.replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\"", with: "'")
    }
}

protocol ToolInvoking: Sendable {
    func invoke(_ name: String, arguments: [String: JSONValue]) async throws -> JSONValue
}

extension ToolInvoking {
    func invoke(_ name: String) async throws -> JSONValue {
        try await invoke(name, arguments: [:])
    }
}

actor ToolClient: ToolInvoking {
    private let backend: BackendClient

    init(backend: BackendClient) { self.backend = backend }

    func invoke(_ name: String, arguments: [String: JSONValue]) async throws -> JSONValue {
        let envelope = try await backend.post(
            path: "/api/tools/\(name)",
            body: .object(arguments)
        )
        guard envelope["ok"]?.boolValue == true else {
            throw BackendError.server(status: 500, message: envelope["error"]?.stringValue ?? "Tool \(name) failed.")
        }
        return envelope["result"] ?? .null
    }
}

private extension Data {
    mutating func appendUTF8(_ value: String) {
        append(contentsOf: value.utf8)
    }
}
