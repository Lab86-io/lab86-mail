import SwiftUI
import WebKit

// The Daily Report artifact — the same self-contained editorial HTML the desktop
// renders — shown in a dedicated sandboxed WKWebView inside a native SwiftUI
// shell. The stored/model-authored HTML is untrusted: every script and dangerous
// element/handler is stripped, and the ONLY script that runs is a nonce-scoped
// native click bridge that posts a message solely from a real user click on a
// `data-action` element. Actions never mutate a provider directly — read-only
// open_* routes navigate; everything else is handed back to the caller.

struct DailyBriefView: View {
    let report: DailyReportModel
    let lastRefresh: Date?
    let isOffline: Bool
    let onAction: (String, BriefActionPayload) -> Void
    let onRegenerate: () -> Void

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    @State private var artifactHeight: CGFloat = 360
    // A fresh nonce per rendered edition; only the injected bridge carries it, so
    // any other inline/remote script is refused by the CSP.
    @State private var nonce = UUID().uuidString

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            statusStrip
            // The web view exposes the artifact's headings, text, and action
            // buttons to VoiceOver via its DOM — no wrapper label that would
            // collapse it into a single element.
            BriefArtifactWebView(
                html: BriefArtifactDocument.make(
                    from: report.html ?? "",
                    nonce: nonce,
                    themeCSS: environment.theme.briefThemeCSS
                ),
                contentHeight: $artifactHeight,
                onAction: onAction,
                onOpenURL: { openURL($0) }
            )
            .frame(height: artifactHeight)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(report.title))
    }

    @ViewBuilder private var statusStrip: some View {
        HStack(spacing: 8) {
            if report.isGenerating {
                ProgressView().controlSize(.small)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Putting today’s brief together…")
                        .font(.footnote.weight(.medium))
                    if let progress = report.progress, progress.total > 0 {
                        ProgressView(value: progress.fraction)
                            .frame(maxWidth: 200)
                    }
                }
            } else {
                Image(systemName: isOffline ? "wifi.slash" : "checkmark.seal")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text(freshnessText)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if !report.isGenerating {
                Button("Regenerate", action: onRegenerate)
                    .font(.footnote.weight(.medium))
                    .buttonStyle(.plain)
                    .foregroundStyle(.tint)
                    .accessibilityHint("Builds a fresh edition of today’s brief")
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }

    private var freshnessText: String {
        if isOffline { return "Showing your last saved brief." }
        guard let lastRefresh else { return report.title }
        return "Updated \(lastRefresh.formatted(date: .omitted, time: .shortened))"
    }
}

// Typed, Sendable projection of a `data-action` payload. Only the fields native
// routing needs are read; nothing model-authored is trusted beyond these strings.
struct BriefActionPayload: Hashable, Sendable {
    var account: String?
    var threadID: String?
    var eventID: String?
    var areaID: String?
    var calendarID: String?
    var view: String?

    init(
        account: String? = nil,
        threadID: String? = nil,
        eventID: String? = nil,
        areaID: String? = nil,
        calendarID: String? = nil,
        view: String? = nil
    ) {
        self.account = account
        self.threadID = threadID
        self.eventID = eventID
        self.areaID = areaID
        self.calendarID = calendarID
        self.view = view
    }

    init(rawMessageBody: Any?) {
        let dict = (rawMessageBody as? [String: Any]) ?? [:]
        func string(_ keys: String...) -> String? {
            for key in keys {
                if let value = dict[key] as? String, !value.isEmpty { return value }
            }
            return nil
        }
        account = string("account", "accountId")
        threadID = string("threadId", "thread")
        eventID = string("eventId", "event")
        areaID = string("areaId", "area")
        calendarID = string("calendarId", "calendar")
        view = string("view")
    }
}

enum BriefArtifactDocument {
    // Strip every script/handler/dangerous element from the untrusted artifact,
    // then inject a strict CSP (whose only allowed script is our nonce) plus the
    // trusted click bridge. Idempotence is not required — a fresh nonce/document
    // is produced per render.
    static func make(from rawHTML: String, nonce: String, themeCSS: String = "") -> String {
        var html = rawHTML

        html = html.replacingOccurrences(
            of: #"<script\b[^>]*>[\s\S]*?</script\s*>"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
        html = html.replacingOccurrences(
            // Keep ordinary buttons: the report artifact deliberately uses
            // <button data-action=...> for its native-routed controls. Forms,
            // inputs, model scripts, and inline handlers are removed, while
            // CSP `form-action 'none'` provides defense in depth.
            of: #"<(?:script|iframe|object|embed|form|input|base)\b[^>]*/?>"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
        html = html.replacingOccurrences(
            of: #"<meta\b[^>]*http-equiv\s*=\s*['"]?refresh['"]?[^>]*>"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
        // Inline event handlers and srcdoc — the model must not smuggle script in.
        html = html.replacingOccurrences(
            of: #"\s(?:on[a-z]+|srcdoc)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
        // Neutralize javascript: URLs (defense in depth; link policy also blocks them).
        html = html.replacingOccurrences(
            of: #"(href|src)\s*=\s*(['"])\s*javascript:[^'"]*(['"])"#,
            with: "$1=$2#$3",
            options: [.regularExpression, .caseInsensitive]
        )

        let head = securityHead(nonce: nonce)
        let bridge = "<script nonce=\"\(nonce)\">\(bridgeJS)</script>"

        if let headRange = html.range(of: #"<head\b[^>]*>"#, options: [.regularExpression, .caseInsensitive]) {
            html.insert(contentsOf: head, at: headRange.upperBound)
        } else if let htmlRange = html.range(of: #"<html\b[^>]*>"#, options: [.regularExpression, .caseInsensitive]) {
            html.insert(contentsOf: "<head>\(head)</head>", at: htmlRange.upperBound)
        } else {
            html = "<!doctype html><html><head>\(head)</head><body>\(html)</body></html>"
        }

        // Theme tokens go at the END of the head so they override the
        // artifact's own :root declarations — the same precedence the desktop
        // host achieves by posting resolved variables into the live document.
        if !themeCSS.isEmpty {
            let themedStyle = "<style data-host-theme>\(themeCSS)</style>"
            if let headClose = html.range(of: "</head>", options: [.caseInsensitive]) {
                html.insert(contentsOf: themedStyle, at: headClose.lowerBound)
            } else {
                html = themedStyle + html
            }
        }

        if let bodyClose = html.range(of: "</body>", options: [.caseInsensitive, .backwards]) {
            html.insert(contentsOf: bridge, at: bodyClose.lowerBound)
        } else {
            html += bridge
        }
        return html
    }

    private static func securityHead(nonce: String) -> String {
        """
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: https: http:; style-src 'unsafe-inline' https:; font-src data: https:; script-src 'nonce-\(nonce)'; connect-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'">
        <meta name="referrer" content="no-referrer">
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=6">
        <style>
        /* Mobile correction for stored editions: this webview grows to its
           content, so vh-based masthead sizing resolves against the full
           artifact height and blows the painting up to several screens tall.
           Editions have used both `.hero > .masthead` and `header.masthead`
           vocabularies — pin either container to a fixed editorial height. */
        @media (max-width: 700px) {
            .hero, header.masthead {
                height: 300px !important;
                min-height: 240px !important;
                max-height: 340px !important;
                overflow: hidden !important;
            }
            .masthead { min-height: 0 !important; padding: 1.5rem !important; }
            .masthead-title { padding: 1.25rem !important; }
            .masthead h1, .masthead-title h1 { font-size: clamp(2.4rem, 12vw, 4rem) !important; }
            .spine { display: none !important; }
        }
        </style>
        """
    }

    // The whole trusted surface: report height, and forward a click on a
    // `data-action` element — only when the event is user-generated.
    static let bridgeJS = """
    (function(){
      function post(name, body){ try { window.webkit.messageHandlers[name].postMessage(body); } catch (e) {} }
      function reportHeight(){ post('briefHeight', Math.ceil(document.documentElement.scrollHeight || document.body.scrollHeight || 0)); }
      document.addEventListener('click', function(e){
        if (!e.isTrusted) { return; }
        var el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
        if (!el) { return; }
        var action = el.getAttribute('data-action') || '';
        if (!action) { return; }
        var payload = {};
        try { payload = JSON.parse(el.getAttribute('data-payload') || '{}') || {}; } catch (_) { payload = {}; }
        e.preventDefault();
        post('briefAction', { action: action, payload: payload });
      }, false);
      if (document.readyState !== 'loading') { reportHeight(); }
      window.addEventListener('load', reportHeight);
      window.addEventListener('resize', reportHeight);
      if (window.ResizeObserver && document.body) {
        try { new ResizeObserver(reportHeight).observe(document.body); } catch (_) {}
      }
    })();
    """
}

struct BriefArtifactWebView: UIViewRepresentable {
    static let minimumHeight: CGFloat = 200
    static let maximumHeight: CGFloat = 20_000

    let html: String
    @Binding var contentHeight: CGFloat
    let onAction: (String, BriefActionPayload) -> Void
    let onOpenURL: (URL) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "briefAction")
        controller.add(context.coordinator, name: "briefHeight")

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController = controller
        // JS is required for the nonce bridge; the CSP allows nothing else.
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .clear
        // The outer SwiftUI ScrollView owns scrolling; the artifact sizes to content.
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.showsVerticalScrollIndicator = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        context.coordinator.load(html, in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.load(html, in: webView)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: "briefAction")
        controller.removeScriptMessageHandler(forName: "briefHeight")
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var parent: BriefArtifactWebView
        private var loadedDocument: String?

        init(parent: BriefArtifactWebView) {
            self.parent = parent
        }

        func load(_ document: String, in webView: WKWebView) {
            guard loadedDocument != document else { return }
            loadedDocument = document
            #if DEBUG
            // Diagnostics for development installs: persist the composed
            // document so it can be pulled from the app container.
            try? document.write(
                to: FileManager.default.temporaryDirectory.appendingPathComponent("brief-debug.html"),
                atomically: true,
                encoding: .utf8
            )
            #endif
            webView.loadHTMLString(document, baseURL: nil)
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            switch message.name {
            case "briefHeight":
                guard let value = (message.body as? NSNumber)?.doubleValue else { return }
                let bounded = min(
                    max(CGFloat(value), BriefArtifactWebView.minimumHeight),
                    BriefArtifactWebView.maximumHeight
                )
                if abs(parent.contentHeight - bounded) > 1 { parent.contentHeight = bounded }
            case "briefAction":
                guard let dictionary = message.body as? [String: Any] else { return }
                let action = (dictionary["action"] as? String) ?? ""
                guard !action.isEmpty else { return }
                parent.onAction(action, BriefActionPayload(rawMessageBody: dictionary["payload"]))
            default:
                break
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            guard navigationAction.navigationType == .linkActivated,
                  let url = navigationAction.request.url else {
                return .allow
            }
            guard EmailLinkPolicy.canOpen(url) else { return .cancel }
            parent.onOpenURL(url)
            return .cancel
        }
    }
}
