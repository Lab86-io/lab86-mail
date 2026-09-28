import Foundation
import Testing
@testable import Lab86Mail

struct NativeWorkspaceTests {
    private let base = URL(string: "https://mail.lab86.io")!

    @Test func documentAndGoogleRoutesKeepOpaqueIDsAndNeverUseProviderURLs() throws {
        let id = "a&office=other/#?"
        let destination = NativeWorkspaceDestination.document(id)
        let url = try #require(URL(string: destination.path, relativeTo: base)?.absoluteURL)
        let items = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
        #expect(url.path == "/native/files")
        #expect(items.first(where: { $0.name == "document" })?.value == id)
        #expect(!items.contains(where: { $0.name == "office" }))
        let route = GoogleDocumentRoute(connectionID: "c&x", fileID: "f?x", mimeType: "application/vnd.google-apps.spreadsheet", webURL: URL(string: "https://docs.google.com/unsafe"))
        let google = NativeWorkspaceDestination.google(route)
        #expect(!google.path.contains("docs.google.com"))
        let values = try #require(URLComponents(string: google.path)?.queryItems)
        #expect(values.first(where: { $0.name == "connection" })?.value == route.connectionID)
        #expect(values.first(where: { $0.name == "file" })?.value == route.fileID)
    }

    // The web sheet is only for surfaces with no native form. "All tools",
    // which opened a web copy of the screen already on show, is gone: no
    // destination may point at the web shell's own screens.
    @Test func theWebSheetOnlyOpensSurfacesWithNoNativeForm() throws {
        let route = GoogleDocumentRoute(connectionID: "c", fileID: "f", mimeType: "application/vnd.google-apps.document", webURL: nil)
        let destinations: [NativeWorkspaceDestination] = [.files, .settings, .document("doc"), .google(route)]
        for destination in destinations {
            let url = try #require(URL(string: destination.path, relativeTo: base)?.absoluteURL)
            #expect(url.path == "/native/files" || url.path == "/settings", "Unexpected web surface: \(destination.path)")
            #expect(!destination.title.contains("All tools"))
        }
        #expect(NativeWorkspaceDestination.settings.title == "All settings")
    }

    @Test func bridgeOnlyAcceptsTheTrustedMainFrameBootstrap() {
        #expect(NativeWorkspacePolicy.acceptsBridgeMessage(url: base.appending(path: "native/session"), base: base, isMainFrame: true))
        for value in ["https://evil.test/native/session", "https://mail.lab86.io.evil.test/native/session", "http://mail.lab86.io/native/session", "https://mail.lab86.io:8443/native/session", "https://mail.lab86.io/native/files", "https://user:password@mail.lab86.io/native/session"] {
            #expect(!NativeWorkspacePolicy.acceptsBridgeMessage(url: URL(string: value), base: base, isMainFrame: true))
        }
        #expect(!NativeWorkspacePolicy.acceptsBridgeMessage(url: base.appending(path: "native/session"), base: base, isMainFrame: false))
        #expect(!NativeWorkspacePolicy.acceptsBridgeMessage(url: nil, base: base, isMainFrame: true))
        #expect(NativeWorkspacePolicy.sameOrigin(URL(string: "https://mail.lab86.io:443/settings")!, base))
    }

    @Test func credentialsNeverTravelToAnInsecureRemoteServer() {
        #expect(NativeWorkspacePolicy.acceptsBaseURL(base))
        for value in ["http://mail.lab86.io", "file:///tmp/editor", "https://user:pass@mail.lab86.io"] {
            #expect(!NativeWorkspacePolicy.acceptsBaseURL(URL(string: value)!))
        }
    }

    @Test func downloadsUseOnlyTheTrustedBrowserOrigin() {
        #expect(NativeWorkspacePolicy.acceptsDownloadURL(base.appending(path: "export"), base: base))
        #expect(NativeWorkspacePolicy.acceptsDownloadURL(URL(string: "blob:https://mail.lab86.io/abc")!, base: base))
        for value in ["https://external.invalid/export", "blob:https://external.invalid/abc", "blob:null/abc", "file:///tmp/test", "data:text/plain,test"] {
            #expect(!NativeWorkspacePolicy.acceptsDownloadURL(URL(string: value)!, base: base))
        }
    }

    @Test func downloadsCannotEscapeTheirPrivateDirectory() {
        #expect(NativeWorkspacePolicy.safeDownloadName("../../private/plan.pptx") == "plan.pptx")
        #expect(NativeWorkspacePolicy.safeDownloadName("C:\\private\\budget.xlsx") == "budget.xlsx")
        #expect(NativeWorkspacePolicy.safeDownloadName("..") == "Download")
        #expect(NativeWorkspacePolicy.safeDownloadName("\n\r") == "Download")
        #expect(NativeWorkspacePolicy.safeDownloadName("Deck.pptx") == "Deck.pptx")
    }

    @MainActor @Test func browserImplementsWebKitDelegatesAtRuntime() {
        let browser = NativeWorkspaceBrowser()
        for name in [
            "webView:decidePolicyForNavigationAction:decisionHandler:",
            "webView:decidePolicyForNavigationResponse:decisionHandler:",
            "webView:navigationAction:didBecomeDownload:",
            "webView:navigationResponse:didBecomeDownload:",
            "download:decideDestinationUsingResponse:suggestedFilename:completionHandler:",
            "downloadDidFinish:",
            "webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:"
        ] {
            #expect(browser.responds(to: NSSelectorFromString(name)), "Missing WebKit delegate: \(name)")
        }
        #if os(macOS)
        #expect(browser.responds(to: NSSelectorFromString("webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:")))
        #endif
    }

    @MainActor @Test func providerAuthorizationUsesTheNativeOAuthCoordinator() {
        #expect(NativeWorkspaceBrowser.authorizationRequest(URL(string: "https://mail.lab86.io/api/files/oauth/start?provider=google_drive")!)?.kind == "files")
        #expect(NativeWorkspaceBrowser.authorizationRequest(URL(string: "https://mail.lab86.io/api/nylas/connect?provider=google")!)?.kind == "mail")
        #expect(NativeWorkspaceBrowser.authorizationRequest(URL(string: "https://mail.lab86.io/api/mcp/oauth/start?server=granola")!)?.value == "granola")
        #expect(NativeWorkspaceBrowser.authorizationRequest(URL(string: "https://mail.lab86.io/api/files/oauth/start")!) == nil)
    }
}
