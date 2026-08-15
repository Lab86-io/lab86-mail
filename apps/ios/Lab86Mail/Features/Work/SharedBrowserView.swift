import SwiftUI
import WebKit

/// The shared browser for one guided step.
///
/// The web view loads the Browserbase live view, which is the real remote
/// browser — interactive, with the agent alongside. The user acts on the page
/// directly; passwords and payments go to the site, never to Albatross.
/// "Check the page" asks the server to read the page and judge the step's
/// doneWhen; only a satisfied verdict checks the step off, with the session
/// replay bound as observed evidence.
struct SharedBrowserSheet: View {
    let workID: String
    let step: WorkDetail.ExecutionStep
    let onVerified: () async -> Void

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State private var session: ProductStore.WorkBrowserSession?
    @State private var statusLine = "Opening a shared browser…"
    @State private var verifying = false
    @State private var verified = false
    @State private var failed = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Circle()
                        .fill(verified ? Color.green : Color.accentColor)
                        .frame(width: 8, height: 8)
                    Text(statusLine)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                Divider()
                if let session {
                    LiveViewWebView(urlString: session.liveViewURL)
                        .ignoresSafeArea(edges: .bottom)
                } else if failed {
                    ContentUnavailableView(
                        "The shared browser could not open.",
                        systemImage: "network.slash",
                        description: Text("Open the site in Safari and record the step when it is done.")
                    )
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle(step.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { Task { await close() } }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if !verified {
                        Button(verifying ? "Checking…" : "Check the page") {
                            Task { await verify() }
                        }
                        .disabled(verifying || session == nil)
                    }
                }
            }
        }
        .interactiveDismissDisabled(verifying)
        .task { await open() }
    }

    private func open() async {
        guard session == nil, !failed else { return }
        if let opened = await environment.store.startWorkSession(workID, stepKey: step.id) {
            session = opened
            statusLine = "Your turn on the page. Albatross follows along."
        } else {
            failed = true
            statusLine = environment.store.workError ?? "The shared browser could not open."
        }
    }

    private func verify() async {
        guard let session else { return }
        verifying = true
        statusLine = "Checking the page…"
        defer { verifying = false }
        guard let result = await environment.store.verifyWorkSession(
            workID,
            sessionID: session.sessionID,
            stepKey: step.id
        ) else {
            statusLine = "The page could not be checked. Try again."
            return
        }
        if result.satisfied {
            verified = true
            statusLine = "Verified. The step is checked off."
            await onVerified()
        } else {
            statusLine = result.reason.isEmpty
                ? "The page does not show the completion state yet."
                : "Not yet: \(result.reason)"
        }
    }

    private func close() async {
        if let session {
            await environment.store.endWorkSession(workID, sessionID: session.sessionID)
        }
        dismiss()
    }
}

/// A minimal wrapper: the live view URL is a self-contained remote-browser
/// client, so the web view needs no navigation chrome of its own.
private struct LiveViewWebView: UIViewRepresentable {
    let urlString: String

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        if let url = URL(string: urlString) {
            webView.load(URLRequest(url: url))
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard let url = URL(string: urlString), webView.url == nil else { return }
        webView.load(URLRequest(url: url))
    }
}
