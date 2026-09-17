import SwiftUI
import Observation
@preconcurrency import WebKit
#if os(macOS)
import AppKit
#endif

/// Full product capabilities use the same engines and saved data as the web
/// app, within the native shell. Its browser session is isolated from Safari
/// and from the app's Clerk session, and is revoked when this view closes.
struct NativeWorkspaceView: View {
    let destination: NativeWorkspaceDestination
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var browser = NativeWorkspaceBrowser()
    @State private var confirmsClose = false
    @State private var openedOwnerID: String?

    var body: some View {
        NavigationStack {
            ZStack {
                if let webView = browser.webView {
                    NativeBrowserSurface(webView: webView)
                }
                if let error = browser.error {
                    ContentUnavailableView {
                        Label("Couldn’t open the workspace", systemImage: "network.slash")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Try again") { Task { await open() } }
                    }
                    .background(.background)
                } else if browser.isLoading {
                    ProgressView("Opening \(destination.title.lowercased())…")
                        .padding(20)
                        .background(.regularMaterial, in: .rect(cornerRadius: 14))
                }
            }
            .navigationTitle(destination.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        if browser.isReady && browser.hasUnsavedChanges != false { confirmsClose = true } else { dismiss() }
                    }
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button("Back", systemImage: "chevron.left") { browser.webView?.goBack() }
                        .disabled(!browser.canGoBack)
                    if let download = browser.download {
                        ShareLink(item: download) { Label("Share download", systemImage: "square.and.arrow.up") }
                    }
                }
            }
            .confirmationDialog("Close the workspace?", isPresented: $confirmsClose, titleVisibility: .visible) {
                Button("Close workspace") { dismiss() }
                Button("Keep editing", role: .cancel) {}
            } message: {
                Text(browser.hasUnsavedChanges == true ? "There are changes that have not finished saving. Keep editing to let them save." : "Wait for the editor to finish saving before closing.")
            }
            .alert("Download", isPresented: Binding(get: { browser.downloadError != nil }, set: { if !$0 { browser.downloadError = nil } })) {
                Button("OK") { browser.downloadError = nil }
            } message: { Text(browser.downloadError ?? "The file could not be downloaded.") }
            .alert(browser.dialog?.title ?? "Albatross", isPresented: Binding(
                get: { browser.dialog != nil },
                set: { if !$0 { browser.completeDialog(nil) } }
            )) {
                if browser.dialog?.kind == .prompt { TextField("Response", text: $browser.dialogText) }
                if browser.dialog?.kind != .alert { Button("Cancel", role: .cancel) { browser.completeDialog(nil) } }
                Button("OK") { browser.completeDialog(browser.dialogText) }
            } message: { Text(browser.dialog?.message ?? "") }
        }
        .interactiveDismissDisabled(browser.isReady)
        .task { openedOwnerID = environment.sessionStore.ownerID; await open() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await browser.refreshAccessIfNeeded() } }
        }
        .onChange(of: environment.sessionStore.ownerID) { _, _ in dismiss() }
        .onDisappear {
            browser.close()
            Task {
                guard let openedOwnerID, openedOwnerID == environment.sessionStore.ownerID else { return }
                if destination.path.hasPrefix("/native/files") {
                    await environment.documents.loadFiles()
                } else {
                    _ = await environment.refreshAccounts(ownerID: openedOwnerID)
                    guard openedOwnerID == environment.sessionStore.ownerID else { return }
                    await environment.store.bootstrap(cacheOwner: openedOwnerID)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 900, minHeight: 650)
        #endif
    }

    private func open() async {
        await browser.open(
            destination: destination,
            baseURL: environment.configuration.apiBaseURL,
            ownerID: environment.sessionStore.ownerID,
            backend: environment.backend,
            authorization: environment.webAuthentication,
            openExternal: { openURL($0) }
        )
    }
}

@MainActor
@Observable
final class NativeWorkspaceBrowser: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
    struct Dialog {
        enum Kind { case alert, confirm, prompt }
        let title: String
        let message: String
        let kind: Kind
    }
    private(set) var webView: WKWebView?
    private(set) var isLoading = true
    private(set) var isReady = false
    private(set) var canGoBack = false
    private(set) var hasUnsavedChanges: Bool?
    private(set) var error: String?
    private(set) var download: URL?
    var downloadError: String?
    private(set) var dialog: Dialog?
    var dialogText = ""
    @ObservationIgnored private var dialogCompletion: ((String?) -> Void)?
    @ObservationIgnored private var baseURL: URL?
    @ObservationIgnored private var backend: BackendClient?
    @ObservationIgnored private var authorization: WebAuthenticationCoordinator?
    @ObservationIgnored private var openExternal: ((URL) -> Void)?
    @ObservationIgnored private var payload: [String: String]?
    @ObservationIgnored private var browserSessionID: String?
    @ObservationIgnored private var accessExpiry: Date?
    @ObservationIgnored private var ownerID: String?
    @ObservationIgnored private var refresh: Task<Void, Never>?
    @ObservationIgnored private var timeout: Task<Void, Never>?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var downloads: [ObjectIdentifier: URL] = [:]
    @ObservationIgnored private var activeDownloads: [ObjectIdentifier: WKDownload] = [:]
    @ObservationIgnored private var downloadNames: [ObjectIdentifier: String] = [:]

    func open(destination: NativeWorkspaceDestination, baseURL: URL?, ownerID: String?, backend: BackendClient, authorization: WebAuthenticationCoordinator, openExternal: @escaping (URL) -> Void) async {
        close()
        let run = UUID()
        generation = run
        error = nil
        isLoading = true
        isReady = false
        guard let baseURL, NativeWorkspacePolicy.acceptsBaseURL(baseURL), let ownerID else {
            fail("Sign in to Albatross to open this workspace.")
            return
        }
        self.ownerID = ownerID
        self.baseURL = baseURL
        self.backend = backend
        self.authorization = authorization
        self.openExternal = openExternal
        do {
            let response = try await backend.post(path: "/api/native/web-session", body: .object([:]))
            guard run == generation, !Task.isCancelled else { return }
            guard let ticket = response["ticket"]?.stringValue,
                  response["userId"]?.stringValue == ownerID else { throw BackendError.invalidResponse }
            payload = ["ticket": ticket, "userId": ownerID, "destination": destination.path]
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            configuration.userContentController.add(self, name: "albatrossEditor")
            // Odoo and the document exporters create an anchor after async
            // work. Forward download anchors to WKDownload without depending
            // on a DOM click retaining transient browser user activation.
            configuration.userContentController.addUserScript(WKUserScript(source: """
                document.addEventListener('click', event => {
                  const anchor = event.target?.closest?.('a[download]');
                  if (!anchor) return;
                  const url = new URL(anchor.href, location.href);
                  if (url.origin !== location.origin && !url.href.startsWith('blob:' + location.origin + '/')) return;
                  if (!['https:', 'http:', 'blob:'].includes(url.protocol)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  window.webkit.messageHandlers.albatrossEditor.postMessage({type: 'download', url: url.href, name: anchor.download});
                }, true);
                """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            #if os(iOS)
            configuration.allowsInlineMediaPlayback = true
            #endif
            let view = WKWebView(frame: .zero, configuration: configuration)
            view.navigationDelegate = self
            view.uiDelegate = self
            view.allowsBackForwardNavigationGestures = true
            webView = view
            try await installAccess(response["access"], view: view, baseURL: baseURL)
            guard run == generation else { return }
            view.load(URLRequest(url: URL(string: "/native/session", relativeTo: baseURL)!.absoluteURL))
            timeout = Task { [weak self] in
                try? await Task.sleep(for: .seconds(45))
                guard !Task.isCancelled, let self, self.generation == run, !self.isReady else { return }
                self.fail("The workspace took too long to open. Check your connection and try again.")
            }
        } catch { if run == generation { fail(error.localizedDescription) } }
    }

    func close() {
        generation = UUID()
        timeout?.cancel()
        timeout = nil
        refresh?.cancel()
        refresh = nil
        accessExpiry = nil
        payload = nil
        completeDialog(nil)
        webView?.stopLoading()
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "albatrossEditor")
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
        webView = nil
        for transfer in activeDownloads.values { transfer.delegate = nil; transfer.cancel(nil) }
        activeDownloads.removeAll()
        downloadNames.removeAll()
        for url in downloads.values { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        downloads.removeAll()
        if let browserSessionID, let backend {
            Task { _ = try? await backend.delete(path: "/api/native/web-session", body: .object(["sessionId": .string(browserSessionID)])) }
        }
        browserSessionID = nil
        isReady = false
        canGoBack = false
        hasUnsavedChanges = nil
    }

    private func installAccess(_ access: JSONValue?, view: WKWebView, baseURL: URL) async throws {
        guard let access, let value = access["value"]?.stringValue,
              let expires = access["expiresAt"]?.doubleValue, let host = baseURL.host else { return }
        let properties: [HTTPCookiePropertyKey: Any] = [
            .name: "lab86_native_browser", .value: value, .domain: host, .path: "/",
            .secure: baseURL.scheme == "https" ? "TRUE" : "FALSE",
            .expires: Date(timeIntervalSince1970: expires),
            HTTPCookiePropertyKey("HttpOnly"): "TRUE", HTTPCookiePropertyKey("SameSite"): "Strict",
        ]
        guard let cookie = HTTPCookie(properties: properties) else { throw BackendError.invalidResponse }
        await view.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
        guard view === webView else { return }
        accessExpiry = Date(timeIntervalSince1970: expires)
        scheduleRefresh()
    }

    private func scheduleRefresh() {
        refresh?.cancel()
        refresh = Task { [weak self] in
            try? await Task.sleep(for: .seconds(60))
            guard !Task.isCancelled else { return }
            await self?.refreshAccessIfNeeded()
        }
    }

    func refreshAccessIfNeeded() async {
        guard let accessExpiry, let backend, let baseURL, let view = webView else { return }
        defer { if view === webView { scheduleRefresh() } }
        guard accessExpiry.timeIntervalSinceNow < 600 else { return }
        let run = generation
        do {
            let response = try await backend.patch(path: "/api/native/web-session", body: .object([:]))
            guard run == generation, response["userId"]?.stringValue == ownerID else { return }
            try await installAccess(response["access"], view: view, baseURL: baseURL)
        } catch {
            // Keep the live editor and its unsaved work. A temporary network
            // failure retries on the next minute or when the app foregrounds.
        }
    }

    private func fail(_ message: String) {
        payload = nil
        timeout?.cancel()
        isLoading = false
        error = message
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let baseURL, message.webView === webView, message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url, NativeWorkspacePolicy.sameOrigin(url, baseURL),
              let body = message.body as? [String: Any] else { return }
        if body["type"] as? String == "download", let raw = body["url"] as? String,
           let target = URL(string: raw), NativeWorkspacePolicy.acceptsDownloadURL(target, base: baseURL) {
            Task { [weak self] in await self?.startDownload(target, name: body["name"] as? String) }
            return
        }
        if body["type"] as? String == "editorState", url.path == "/native/files" {
            hasUnsavedChanges = body["dirty"] as? Bool
            return
        }
        guard NativeWorkspacePolicy.acceptsBridgeMessage(url: url, base: baseURL, isMainFrame: true) else { return }
        switch body["type"] as? String {
        case "ready":
            guard let payload, let view = webView else { return }
            self.payload = nil
            let run = generation
            Task { [weak self] in
                do {
                    _ = try await view.callAsyncJavaScript(
                        "if (!window.lab86OpenEditor) throw new Error('Editor is not ready'); void window.lab86OpenEditor(input); return true;",
                        arguments: ["input": payload], in: nil, contentWorld: .page
                    )
                } catch {
                    guard self?.generation == run else { return }
                    self?.fail("The editor could not sign in. Try again.")
                }
            }
        case "session":
            if let id = body["sessionId"] as? String, id.range(of: "^sess_[a-zA-Z0-9]+$", options: .regularExpression) != nil { browserSessionID = id }
        case "error": fail("The editor could not sign in. Close it and try again.")
        default: break
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        navigationPolicy(for: action, in: webView)
    }

    private func navigationPolicy(for action: WKNavigationAction, in webView: WKWebView) -> WKNavigationActionPolicy {
        guard let url = action.request.url, let baseURL else { return .cancel }
        if action.shouldPerformDownload { return .download }
        // Office frames and blob downloads run in their own origins; no native
        // credential or bridge message is ever granted to those frames.
        if action.targetFrame?.isMainFrame == false { return ["https", "http", "about", "blob"].contains(url.scheme ?? "") ? .allow : .cancel }
        if url.scheme == "blob", let current = webView.url, NativeWorkspacePolicy.sameOrigin(current, baseURL) { return .allow }
        if NativeWorkspacePolicy.sameOrigin(url, baseURL) {
            if let kind = Self.authorizationRequest(url) {
                Task { [weak self] in await self?.authorize(kind) }
                return .cancel
            }
            if url.path.hasPrefix("/sign-in") || url.path.hasPrefix("/sign-up") {
                fail("Your editor session expired. Close it and open it again.")
                return .cancel
            }
            if url.path != "/native/files" { hasUnsavedChanges = nil }
            if action.targetFrame == nil { webView.load(action.request); return .cancel }
            return .allow
        }
        if ["https", "http", "mailto", "tel"].contains(url.scheme ?? "") { openExternal?(url) }
        return .cancel
    }

    static func authorizationRequest(_ url: URL) -> (kind: String, value: String)? {
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let queries = components?.queryItems ?? []
        switch url.path {
        case "/api/files/oauth/start": return queries.first(where: { $0.name == "provider" })?.value.map { ("files", $0) }
        case "/api/nylas/connect": return queries.first(where: { $0.name == "provider" })?.value.map { ("mail", $0) }
        case "/api/mcp/oauth/start": return queries.first(where: { $0.name == "server" })?.value.map { ("mcp", $0) }
        default: return nil
        }
    }

    private func authorize(_ request: (kind: String, value: String)) async {
        guard let authorization else { return }
        do {
            switch request.kind {
            case "files": try await authorization.connectCloudFiles(provider: request.value)
            case "mail": try await authorization.connectMailbox(provider: request.value)
            default: try await authorization.connectOAuthSource(server: request.value)
            }
            webView?.reload()
        } catch { downloadError = error.localizedDescription }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        let disposition = (response.response as? HTTPURLResponse)?.allHeaderFields.first {
            String(describing: $0.key).caseInsensitiveCompare("Content-Disposition") == .orderedSame
        }.map { String(describing: $0.value) } ?? ""
        let attachment = disposition.lowercased().contains("attachment")
        return !response.canShowMIMEType || attachment ? .download : .allow
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        canGoBack = webView.canGoBack
        guard let url = webView.url, let baseURL, NativeWorkspacePolicy.sameOrigin(url, baseURL), url.path != "/native/session" else { return }
        timeout?.cancel()
        isReady = true
        isLoading = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleNavigationFailure(error)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { handleNavigationFailure(error) }
    private func handleNavigationFailure(_ error: Error) {
        let failure = error as NSError
        // Turning a navigation into a download or opening it externally ends
        // the frame load by policy. The editor itself remains usable.
        if failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled { return }
        if failure.domain == "WebKitErrorDomain" && failure.code == 102 { return }
        fail(error.localizedDescription)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail("The editor stopped responding. Reopen it to recover the saved file.") }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { attach(download) }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { attach(download) }

    private func startDownload(_ url: URL, name: String?) async {
        guard let view = webView else { return }
        let transfer = await view.startDownload(using: URLRequest(url: url))
        guard view === webView else { transfer.cancel(nil); return }
        if let name, !name.isEmpty { downloadNames[ObjectIdentifier(transfer)] = name }
        attach(transfer)
    }

    private func attach(_ transfer: WKDownload) {
        activeDownloads[ObjectIdentifier(transfer)] = transfer
        transfer.delegate = self
    }

    func completeDialog(_ value: String?) {
        let completion = dialogCompletion
        dialogCompletion = nil
        dialog = nil
        completion?(value)
    }

    private func ask(_ message: String, kind: Dialog.Kind, text: String = "", frame: WKFrameInfo) async -> String? {
        completeDialog(nil)
        return await withCheckedContinuation { continuation in
            dialogText = text
            dialogCompletion = { continuation.resume(returning: $0) }
            dialog = Dialog(title: frame.request.url?.host ?? "Albatross", message: message, kind: kind)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        _ = await ask(message, kind: .alert, frame: frame)
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
        await ask(message, kind: .confirm, frame: frame) != nil
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
        await ask(prompt, kind: .prompt, text: defaultText ?? "", frame: frame)
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
        do {
            let directory = FileManager.default.temporaryDirectory.appending(path: "AlbatrossDownloads").appending(path: UUID().uuidString)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appending(path: NativeWorkspacePolicy.safeDownloadName(downloadNames[ObjectIdentifier(download)] ?? suggestedFilename))
            downloads[ObjectIdentifier(download)] = url
            return url
        } catch { downloadError = error.localizedDescription; return nil }
    }
    func downloadDidFinish(_ download: WKDownload) {
        activeDownloads.removeValue(forKey: ObjectIdentifier(download))
        downloadNames.removeValue(forKey: ObjectIdentifier(download))
        self.download = downloads.removeValue(forKey: ObjectIdentifier(download))
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        activeDownloads.removeValue(forKey: ObjectIdentifier(download))
        downloadNames.removeValue(forKey: ObjectIdentifier(download))
        if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        downloadError = error.localizedDescription
    }

    #if os(macOS)
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        return await withCheckedContinuation { continuation in
            panel.begin { result in continuation.resume(returning: result == .OK ? panel.urls : nil) }
        }
    }
    #endif
}

#if os(iOS)
private struct NativeBrowserSurface: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
#else
private struct NativeBrowserSurface: NSViewRepresentable {
    let webView: WKWebView
    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
#endif
