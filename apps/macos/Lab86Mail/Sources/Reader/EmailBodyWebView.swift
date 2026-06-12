import SwiftUI
import WebKit

// Sandboxed HTML email renderer — the native analog of the web app's isolated
// iframe. Content JavaScript is disabled (native evaluateJavaScript still runs
// for height measurement), scripts are additionally blocked via CSP, and link
// clicks open in the default browser.
struct EmailBodyWebView: NSViewRepresentable {
    let html: String
    @Binding var height: CGFloat

    func makeCoordinator() -> Coordinator {
        Coordinator(height: $height)
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.setValue(false, forKey: "drawsBackground")
        webView.loadHTMLString(Self.wrap(html), baseURL: nil)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        let wrapped = Self.wrap(html)
        if context.coordinator.lastHTML != wrapped {
            context.coordinator.lastHTML = wrapped
            webView.loadHTMLString(wrapped, baseURL: nil)
        }
    }

    static func wrap(_ body: String) -> String {
        """
        <!doctype html>
        <html>
        <head>
        <meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy"
              content="script-src 'none'; frame-src 'none'; object-src 'none';">
        <style>
          :root { color-scheme: light dark; }
          body {
            margin: 12px;
            font: 13px -apple-system, system-ui, sans-serif;
            word-wrap: break-word;
            overflow-wrap: break-word;
          }
          img { max-width: 100% !important; height: auto; }
          table { max-width: 100% !important; }
          pre { white-space: pre-wrap; }
          blockquote { margin-left: 8px; padding-left: 8px; border-left: 2px solid #8884; }
        </style>
        </head>
        <body>\(body)</body>
        </html>
        """
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var heightBinding: Binding<CGFloat>
        var lastHTML: String?

        init(height: Binding<CGFloat>) {
            heightBinding = height
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.evaluateJavaScript("document.body.scrollHeight") { [heightBinding] result, _ in
                if let value = result as? CGFloat, value > 0 {
                    DispatchQueue.main.async {
                        heightBinding.wrappedValue = min(max(value + 24, 60), 4000)
                    }
                }
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if navigationAction.navigationType == .linkActivated,
                let url = navigationAction.request.url
            {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }
}
