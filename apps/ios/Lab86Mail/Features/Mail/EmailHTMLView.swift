import SwiftUI
import WebKit

struct EmailHTMLView: View {
    let html: String
    let allowRemoteContent: Bool
    let onOpenURL: (URL) -> Void
    @State private var contentHeight: CGFloat = 120

    var body: some View {
        EmailWebView(
            document: EmailHTMLDocument.make(from: html, allowRemoteContent: allowRemoteContent),
            contentHeight: $contentHeight,
            onOpenURL: onOpenURL
        )
        .frame(maxWidth: .infinity)
        .frame(height: contentHeight)
        .accessibilityLabel("Email message body")
    }
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
