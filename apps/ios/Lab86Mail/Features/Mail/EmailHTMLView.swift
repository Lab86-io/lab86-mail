import SwiftUI
import WebKit

// The sanitized document is built once for each message, off the main
// thread, and kept in a small cache. The sanitizer parses the whole message
// with SwiftSoup; a build inside `body` ran on the main thread again at
// every height change and could freeze the reader (M6).
struct EmailHTMLView: View {
    let html: String
    let allowRemoteContent: Bool
    let onOpenURL: (URL) -> Void
    /// The last built document and the key it was built for. When the html
    /// or the remote-content setting changes, the old document does not
    /// show while the new one builds.
    @State private var built: BuiltEmailDocument?
    @State private var contentHeight: CGFloat = 120

    private var key: EmailDocumentKey {
        EmailDocumentKey(html: html, allowRemoteContent: allowRemoteContent)
    }

    private var document: String? {
        guard let built, built.key == key else { return nil }
        return built.document
    }

    var body: some View {
        Group {
            if let document {
                EmailWebView(
                    document: document,
                    contentHeight: $contentHeight,
                    onOpenURL: onOpenURL
                )
                .frame(maxWidth: .infinity)
                .frame(height: contentHeight)
            } else {
                // The body's place while the document builds; no spinner for
                // a wait that is usually shorter than a frame.
                Color.clear
                    .frame(maxWidth: .infinity)
                    .frame(height: EmailBodyHeight.minimumHeight)
            }
        }
        .accessibilityLabel("Email message body")
        .task(id: key) {
            let requested = key
            let text = await EmailDocumentCache.shared.document(for: html, allowRemoteContent: allowRemoteContent)
            guard !Task.isCancelled else { return }
            built = BuiltEmailDocument(key: requested, document: text)
        }
    }
}

struct BuiltEmailDocument: Equatable {
    let key: EmailDocumentKey
    let document: String
}

/// The cache key of one message body: a stable hash of the html, its length,
/// and the remote-content setting. A hash collision would need the same
/// length too; the sanitized output differs only when the input does.
struct EmailDocumentKey: Hashable, Sendable {
    let hash: UInt64
    let length: Int
    let allowRemoteContent: Bool

    init(html: String, allowRemoteContent: Bool) {
        // FNV-1a over the UTF-8 bytes: stable across runs, unlike hashValue.
        var hash: UInt64 = 0xCBF2_9CE4_8422_2325
        for byte in html.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01B3
        }
        self.hash = hash
        length = html.utf8.count
        self.allowRemoteContent = allowRemoteContent
    }
}

/// Builds sanitized documents away from the main actor and keeps the last
/// few, so a message that is collapsed and expanded again, or a reader that
/// re-measures its height, never parses the same html twice. The cache keeps
/// at most `limit` documents and at most `byteBudget` UTF-8 bytes; the oldest
/// go first, and a document larger than the budget is returned but not kept.
actor EmailDocumentCache {
    typealias Builder = @Sendable (_ html: String, _ allowRemoteContent: Bool) -> String

    static let shared = EmailDocumentCache()

    private let limit: Int
    private let byteBudget: Int
    private let build: Builder
    private var documents: [EmailDocumentKey: String] = [:]
    private var sizes: [EmailDocumentKey: Int] = [:]
    private var order: [EmailDocumentKey] = []
    private(set) var buildCount = 0
    private(set) var byteCount = 0

    init(
        limit: Int = 24,
        byteBudget: Int = 8 * 1_024 * 1_024,
        build: @escaping Builder = { html, allowRemoteContent in
            EmailHTMLDocument.make(from: html, allowRemoteContent: allowRemoteContent)
        }
    ) {
        self.limit = max(limit, 1)
        self.byteBudget = max(byteBudget, 1)
        self.build = build
    }

    func document(for html: String, allowRemoteContent: Bool) -> String {
        let key = EmailDocumentKey(html: html, allowRemoteContent: allowRemoteContent)
        if let cached = documents[key] { return cached }
        let built = build(html, allowRemoteContent)
        buildCount += 1
        let size = built.utf8.count
        // A document larger than the whole budget is returned but not kept,
        // so it does not push out the documents that are already here.
        guard size <= byteBudget else { return built }
        documents[key] = built
        sizes[key] = size
        order.append(key)
        byteCount += size
        while !order.isEmpty, order.count > limit || byteCount > byteBudget {
            let oldest = order.removeFirst()
            documents[oldest] = nil
            byteCount -= sizes.removeValue(forKey: oldest) ?? 0
        }
        return built
    }

    var count: Int { documents.count }
}

// Pure, testable height policy. Ordinary messages size into the outer document
// scroll like Mail; only extreme HTML is bounded to protect memory and prevent a
// single malformed message from creating an unbounded WebKit surface.
enum EmailBodyHeight {
    static let minimumHeight: CGFloat = 64
    static let maximumHeight: CGFloat = 12_000

    static func resolve(forMeasured measured: CGFloat) -> (height: CGFloat, scrollsInternally: Bool) {
        let bounded = min(max(measured, minimumHeight), maximumHeight)
        return (bounded, measured > maximumHeight)
    }

    // AppKit's WKWebView has no scroll view to observe, so after `didFinish`
    // the Mac re-measures the document a few times while allowed remote
    // images (which can finish after the navigation) settle its height.
    static let macRemeasureDelays: [Duration] = [
        .milliseconds(250), .milliseconds(750), .seconds(2), .seconds(5),
    ]

    // A measurement only moves the frame when it actually differs; sub-point
    // jitter between passes must not re-layout the reader.
    static func shouldApply(measured height: CGFloat, current: CGFloat) -> Bool {
        abs(current - height) > 1
    }
}

private struct EmailWebView: UIViewRepresentable {
    let document: String
    @Binding var contentHeight: CGFloat
    let onOpenURL: (URL) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        #if os(iOS)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.alwaysBounceHorizontal = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // Remote/editorial images can finish loading after `didFinish` and grow
        // the content, so height is tracked by observing the scroll view rather
        // than measured once. The observation is torn down in `dismantleUIView`.
        context.coordinator.observeContentSize(of: webView)
        #else
        // AppKit WKWebView exposes no scroll view; the KVC switch is the
        // supported way to keep the page transparent over the app surface.
        webView.setValue(false, forKey: "drawsBackground")
        #endif
        context.coordinator.load(document, in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.load(document, in: webView)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.tearDown()
        webView.navigationDelegate = nil
        webView.stopLoading()
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        var parent: EmailWebView
        private var loadedDocument: String?
        private var heightObservation: NSKeyValueObservation?
        private var remeasureTask: Task<Void, Never>?

        init(parent: EmailWebView) {
            self.parent = parent
        }

        func load(_ document: String, in webView: WKWebView) {
            guard loadedDocument != document else { return }
            loadedDocument = document
            webView.loadHTMLString(document, baseURL: nil)
        }

        // Track late layout growth without injecting JavaScript into email HTML.
        // `contentSize` KVO fires on the main thread during layout; the single
        // observation is retained here and invalidated on teardown, so there is
        // no repeated registration, timer, or observer leak. `[weak self]` avoids
        // a Coordinator -> observation -> Coordinator retain cycle.
        #if os(iOS)
        func observeContentSize(of webView: WKWebView) {
            heightObservation?.invalidate()
            heightObservation = webView.scrollView.observe(
                \.contentSize,
                options: [.new]
            ) { [weak self] scrollView, _ in
                MainActor.assumeIsolated {
                    self?.applyHeight(from: scrollView)
                }
            }
        }
        #endif

        func tearDown() {
            heightObservation?.invalidate()
            heightObservation = nil
            remeasureTask?.cancel()
            remeasureTask = nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
            #if os(iOS)
            applyHeight(from: webView.scrollView)
            #else
            measureHeight(of: webView)
            scheduleRemeasures(of: webView)
            #endif
        }

        #if os(macOS)
        // No scroll view to observe on AppKit; measure the document itself.
        // Content JavaScript is disabled, but app-initiated evaluation is not.
        private func measureHeight(of webView: WKWebView) {
            webView.evaluateJavaScript("document.documentElement.scrollHeight") { [weak self] value, _ in
                MainActor.assumeIsolated {
                    guard let self, let measured = value as? Double, measured > 0 else { return }
                    let resolved = EmailBodyHeight.resolve(forMeasured: ceil(measured))
                    if EmailBodyHeight.shouldApply(measured: resolved.height, current: self.parent.contentHeight) {
                        self.parent.contentHeight = resolved.height
                    }
                }
            }
        }

        // Late-loading remote images grow the document after `didFinish`;
        // a short, bounded series of re-measures tracks that growth. A new
        // navigation or teardown cancels the series.
        private func scheduleRemeasures(of webView: WKWebView) {
            remeasureTask?.cancel()
            remeasureTask = Task { [weak self, weak webView] in
                for delay in EmailBodyHeight.macRemeasureDelays {
                    try? await Task.sleep(for: delay)
                    guard !Task.isCancelled, let self, let webView else { return }
                    self.measureHeight(of: webView)
                }
            }
        }
        #endif

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            guard navigationAction.navigationType == .linkActivated,
                  let url = navigationAction.request.url else {
                return .allow
            }
            guard EmailLinkPolicy.canOpen(url) else {
                return .cancel
            }
            parent.onOpenURL(url)
            return .cancel
        }

        #if os(iOS)
        private func applyHeight(from scrollView: UIScrollView) {
            let measured = ceil(scrollView.contentSize.height)
            let resolved = EmailBodyHeight.resolve(forMeasured: measured)
            if scrollView.isScrollEnabled != resolved.scrollsInternally {
                scrollView.isScrollEnabled = resolved.scrollsInternally
            }
            if EmailBodyHeight.shouldApply(measured: resolved.height, current: parent.contentHeight) {
                parent.contentHeight = resolved.height
            }
        }
        #endif
    }
}

enum EmailLinkPolicy {
    static func canOpen(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return ["https", "http", "mailto", "tel"].contains(scheme)
    }
}
