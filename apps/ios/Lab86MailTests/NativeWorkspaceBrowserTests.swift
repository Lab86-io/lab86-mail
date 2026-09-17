import Foundation
import Network
import Testing
@preconcurrency import WebKit
#if os(iOS)
import UIKit
#else
import AppKit
#endif
@testable import Lab86Mail

/// Exercises the real WKWebView, native bearer transport and bridge together.
/// The loopback server is synthetic; no Clerk user or production data is used.
@MainActor
struct NativeWorkspaceBrowserTests {
    @Test func opensTheRequestedFileHandlesDialogsDownloadsAndRevokesOnlyItsBrowserSession() async throws {
        let server = try WorkspaceFixtureServer()
        defer { server.stop() }
        let base = try await server.start()
        let backend = BackendClient(baseURL: base, tokenProvider: { "synthetic-native-token" })
        let browser = NativeWorkspaceBrowser()
        defer { browser.close() }
        var external: [URL] = []
        await browser.open(destination: .document("sample"), baseURL: base, ownerID: "synthetic-owner", backend: backend,
                           authorization: WebAuthenticationCoordinator(backend: backend), openExternal: { external.append($0) })
        let view = try #require(browser.webView)
        #if os(iOS)
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        let controller = UIViewController()
        controller.view = view
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        #else
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 650), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = view
        window.makeKeyAndOrderFront(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        #endif
        try await eventually { browser.isReady || browser.error != nil }
        #expect(browser.error == nil)
        #expect(browser.isReady)
        #expect(view.url?.path == "/native/files")
        #expect(view.url?.query?.contains("document=sample") == true)
        #expect(!view.configuration.websiteDataStore.isPersistent)
        await browser.refreshAccessIfNeeded()
        #expect(server.requests.filter { $0.hasPrefix("PATCH /api/native/web-session") }.count == 1)
        let cookies = await view.configuration.websiteDataStore.httpCookieStore.allCookies()
        #expect(cookies.first { $0.name == "lab86_native_browser" }?.value == "renewed-access")
        try await eventually { browser.hasUnsavedChanges == false }
        _ = try await view.evaluateJavaScript("window.webkit.messageHandlers.albatrossEditor.postMessage({type:'editorState',dirty:true}); true")
        try await eventually { browser.hasUnsavedChanges == true }

        let confirmation = Task { try await view.evaluateJavaScript("window.confirm('Restore revision?')") as? Bool }
        try await eventually { browser.dialog != nil }
        #expect(browser.dialog?.message == "Restore revision?")
        browser.completeDialog("")
        #expect(try await confirmation.value == true)

        _ = try await view.evaluateJavaScript("window.location.href = 'https://external.invalid'; true")
        try await eventually { external.count == 1 }
        #expect(external.first?.host == "external.invalid")
        #expect(view.url?.path == "/native/files")

        _ = try await view.evaluateJavaScript("document.getElementById('download').click(); true")
        try await eventually { browser.download != nil || browser.downloadError != nil }
        #expect(browser.error == nil)
        let download = try #require(browser.download)
        #expect(download.lastPathComponent == "fixture.csv")
        #expect(try String(contentsOf: download, encoding: .utf8) == "name,value\nexample,42\n")
        try? FileManager.default.removeItem(at: download.deletingLastPathComponent())
        _ = try await view.evaluateJavaScript("""
          const blob = URL.createObjectURL(new Blob(['blob export'], {type: 'text/csv'}));
          const link = document.createElement('a'); link.href = blob; link.download = 'blob.csv';
          document.body.append(link); link.click(); link.remove(); true;
          """)
        try await eventually { browser.download?.lastPathComponent == "blob.csv" || browser.downloadError != nil }
        let blobFile = try #require(browser.download)
        #expect(blobFile.lastPathComponent == "blob.csv")
        #expect(try String(contentsOf: blobFile, encoding: .utf8) == "blob export")
        #expect(browser.error == nil)
        try? FileManager.default.removeItem(at: blobFile.deletingLastPathComponent())
        #expect(external.count == 1)
        browser.close()
        try await eventually { server.requests.contains(where: { $0.hasPrefix("DELETE /api/native/web-session") }) }
        #expect(server.requests.filter { $0.hasPrefix("POST /api/native/web-session") }.count == 1)
        #expect(server.bodies.contains(where: { $0.contains("sess_browserfixture") }))
        #expect(browser.webView == nil)
    }

    private func eventually(line: Int = #line, _ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<750 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw WorkspaceFixtureError.timeout(line)
    }
}

private enum WorkspaceFixtureError: Error { case timeout(Int), missingPort }

private final class WorkspaceFixtureServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "native-workspace-fixture")
    private let lock = NSLock()
    private var recordedRequests: [String] = []
    private var recordedBodies: [String] = []
    var requests: [String] { lock.withLock { recordedRequests } }
    var bodies: [String] { lock.withLock { recordedBodies } }

    init() throws { listener = try NWListener(using: .tcp, on: .any) }
    func stop() { listener.cancel() }
    func start() async throws -> URL {
        listener.newConnectionHandler = { [weak self] connection in
            connection.start(queue: self?.queue ?? .global())
            self?.receive(connection, previous: Data())
        }
        return try await withCheckedThrowingContinuation { continuation in
            listener.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    guard let port = self?.listener.port else { continuation.resume(throwing: WorkspaceFixtureError.missingPort); return }
                    self?.listener.stateUpdateHandler = nil
                    continuation.resume(returning: URL(string: "http://127.0.0.1:\(port.rawValue)")!)
                case .failed(let error):
                    self?.listener.stateUpdateHandler = nil
                    continuation.resume(throwing: error)
                default: break
                }
            }
            listener.start(queue: queue)
        }
    }

    private func receive(_ connection: NWConnection, previous: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, _ in
            guard let self, let data else { connection.cancel(); return }
            let accumulated = previous + data
            let text = String(decoding: accumulated, as: UTF8.self)
            guard let end = text.range(of: "\r\n\r\n") else {
                if !done { self.receive(connection, previous: accumulated) } else { connection.cancel() }
                return
            }
            let header = String(text[..<end.lowerBound])
            let body = String(text[end.upperBound...])
            let length = header.components(separatedBy: "\r\n").first(where: { $0.lowercased().hasPrefix("content-length:") })
                .flatMap { Int($0.split(separator: ":", maxSplits: 1).last?.trimmingCharacters(in: .whitespaces) ?? "") } ?? 0
            if body.utf8.count < length && !done { self.receive(connection, previous: accumulated); return }
            let line = header.components(separatedBy: "\r\n")[0]
            self.lock.withLock { self.recordedRequests.append(line); self.recordedBodies.append(body) }
            var mime = "text/html"
            var disposition = ""
            let result: String
            if line.hasPrefix("POST /api/native/web-session") {
                mime = "application/json"
                result = "{\"ok\":true,\"ticket\":\"synthetic-ticket\",\"userId\":\"synthetic-owner\",\"access\":{\"value\":\"initial-access\",\"expiresAt\":\(Date().timeIntervalSince1970 + 300)}}"
            } else if line.hasPrefix("PATCH /api/native/web-session") {
                mime = "application/json"
                result = "{\"ok\":true,\"userId\":\"synthetic-owner\",\"access\":{\"value\":\"renewed-access\",\"expiresAt\":\(Date().timeIntervalSince1970 + 3600)}}"
            } else if line.hasPrefix("DELETE /api/native/web-session") {
                mime = "application/json"
                result = #"{"ok":true}"#
            } else if line.hasPrefix("GET /native/session") {
                result = """
                <!doctype html><html><body><script>
                window.lab86OpenEditor = input => {
                  if (input.ticket !== 'synthetic-ticket' || input.userId !== 'synthetic-owner') throw Error('Wrong fixture identity');
                  window.webkit.messageHandlers.albatrossEditor.postMessage({type:'session',sessionId:'sess_browserfixture'});
                  location.replace(input.destination);
                };
                window.webkit.messageHandlers.albatrossEditor.postMessage({type:'ready'});
                </script></body></html>
                """
            } else if line.hasPrefix("GET /download") {
                mime = "text/csv"
                disposition = "Content-Disposition: attachment; filename=fixture.csv\r\n"
                result = "name,value\nexample,42\n"
            } else {
                result = """
                <!doctype html><html><body><h1>Full editor</h1><a id="download" href="/download" download>Export</a>
                <script>window.webkit.messageHandlers.albatrossEditor.postMessage({type:'editorState',dirty:false});</script>
                </body></html>
                """
            }
            let response = "HTTP/1.1 200 OK\r\nContent-Type: \(mime)\r\n\(disposition)Content-Length: \(result.utf8.count)\r\nConnection: close\r\n\r\n\(result)"
            connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
        }
    }
}
