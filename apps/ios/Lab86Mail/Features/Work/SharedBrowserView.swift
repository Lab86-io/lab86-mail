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
    @State private var ended = false

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
        .onDisappear {
            // A swipe-down dismissal must release the remote browser too, not
            // only the Close button.
            Task { await endSessionIfNeeded() }
        }
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

    private func endSessionIfNeeded() async {
        guard let session, !ended else { return }
        ended = true
        await environment.store.endWorkSession(workID, sessionID: session.sessionID)
    }

    private func close() async {
        await endSessionIfNeeded()
        dismiss()
    }
}

/// The sheet request for a run's shared browser, keyed on the run.
struct StepRunBrowserRequest: Identifiable {
    let run: StepRunView
    var id: String { run.id }
}

/// The shared browser while a step run owns or hands over the page.
///
/// The run owns the session: this sheet never starts or ends one. It follows
/// the live session row (`albatrossBrowserSessions:activeSessionForWork`).
/// While the status is `agent`, Albatross drives the page and "Take over"
/// cancels the run. At a handoff the status is `user`: the bar shows the
/// handoff detail, and "Continue" resumes the run. Passwords go to the site
/// only; Albatross never sees them.
struct StepRunBrowserSheet: View {
    let workID: String
    let run: StepRunView
    let onTakeOver: () async -> Void
    let onContinue: () async -> Void

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State private var session: WorkBrowserSessionPayload?
    @State private var followed = false
    @State private var tookOver = false
    @State private var busy = false

    private var presentation: StepRunBrowserPresentation {
        StepRunBrowserPresentation(session: session, run: run, followed: followed, tookOver: tookOver)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Circle()
                        .fill(presentation.agentHasPage ? environment.theme.accent2Color : environment.theme.accentColor)
                        .frame(width: 8, height: 8)
                    Text(presentation.statusLine)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .accessibilityElement(children: .combine)
                Divider()
                if let liveViewURL = presentation.liveViewURL {
                    LiveViewWebView(urlString: liveViewURL)
                        .ignoresSafeArea(edges: .bottom)
                } else if followed {
                    ContentUnavailableView(
                        "The shared browser is closed.",
                        systemImage: "network.slash",
                        description: Text("Press Continue. Albatross opens a new one when the step needs it.")
                    )
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle(run.stepTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if presentation.agentHasPage {
                        Button(busy ? "Stopping…" : "Take over") {
                            Task { await takeOver() }
                        }
                        .disabled(busy)
                    } else if presentation.showsContinue {
                        Button(busy ? "Continuing…" : "Continue") {
                            Task { await proceed() }
                        }
                        .disabled(busy)
                    }
                }
            }
        }
        .interactiveDismissDisabled(busy)
        .task { await follow() }
    }

    /// The live session row of this Work, as the web pane subscribes to it.
    private func follow() async {
        guard let convex = environment.convex else {
            followed = true
            return
        }
        do {
            let updates = convex.subscribe(
                to: "albatrossBrowserSessions:activeSessionForWork",
                with: ["workId": workID],
                yielding: Optional<WorkBrowserSessionPayload>.self
            ).values
            for try await payload in updates {
                guard !Task.isCancelled else { return }
                session = payload
                followed = true
            }
        } catch is CancellationError {
            return
        } catch {
            // The bar says the browser is closed; "Continue" still works.
            followed = true
        }
    }

    private func takeOver() async {
        busy = true
        defer { busy = false }
        await onTakeOver()
        tookOver = true
    }

    private func proceed() async {
        busy = true
        defer { busy = false }
        await onContinue()
        tookOver = false
    }
}

/// A minimal wrapper: the live view URL is a self-contained remote-browser
/// client, so the web view needs no navigation chrome of its own.
private struct LiveViewWebView: UIViewRepresentable {
    #if os(macOS)
    // Associated-type inference does not cross the shim protocol when there is
    // no makeCoordinator; spell the witnesses out.
    typealias UIViewType = WKWebView
    typealias NSViewType = WKWebView
    typealias Coordinator = Void
    #endif
    let urlString: String

    private var secureURL: URL? {
        guard let url = URL(string: urlString), url.scheme?.lowercased() == "https" else { return nil }
        return url
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        #if os(iOS)
        configuration.allowsInlineMediaPlayback = true
        #endif
        let webView = WKWebView(frame: .zero, configuration: configuration)
        #if os(iOS)
        webView.isOpaque = false
        #endif
        if let url = secureURL {
            webView.load(URLRequest(url: url))
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard let url = secureURL, webView.url == nil else { return }
        webView.load(URLRequest(url: url))
    }
}
