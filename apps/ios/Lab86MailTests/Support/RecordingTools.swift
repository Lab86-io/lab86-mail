import Foundation
@testable import Lab86Mail

// A tool invoker that records every call and answers from a closure. Shared
// by the audit-fix tests (2026-09-26).
actor RecordingTools: ToolInvoking {
    private(set) var calls: [(name: String, arguments: [String: JSONValue])] = []
    private let responder: @Sendable (String, [String: JSONValue]) -> JSONValue

    init(responder: @escaping @Sendable (String, [String: JSONValue]) -> JSONValue = { _, _ in .object([:]) }) {
        self.responder = responder
    }

    func invoke(_ name: String, arguments: [String: JSONValue]) async throws -> JSONValue {
        calls.append((name, arguments))
        return responder(name, arguments)
    }

    func arguments(of name: String) -> [[String: JSONValue]] {
        calls.filter { $0.name == name }.map(\.arguments)
    }
}
