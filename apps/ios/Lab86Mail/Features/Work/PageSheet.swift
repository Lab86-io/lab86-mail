import SwiftUI
import WebKit

// The page of a run (docs/albatross-thread.md, S7, S12, S13): the live
// remote page, one status line that says who has it, and one control. The
// run owns the session: this view never starts or ends one. While the status
// is `agent`, Albatross drives the page and "Take over" stops the run. At a
// handoff the status is `user`: the bar shows the handoff detail, and the
// done label ("I paid", "I signed in", else "Continue") resumes the run.
// Passwords go to the site only; Albatross never sees them.

/// Follows the live session row of one Work
/// (`albatrossBrowserSessions:activeSessionForWork`), as the web pane does.
@MainActor
@Observable
final class PageSessionFollower {
    private(set) var session: WorkBrowserSessionPayload?
    private(set) var followed = false

    func follow(workID: String, environment: AppEnvironment) async {
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
            // The bar says the page is closed; the done label still works.
            followed = true
        }
    }
}

/// The words of the page pane.
enum PagePaneCopy {
    static let checking = "Albatross checks the page…"
    static let takeOver = "Take over"
    static let takeOverBusy = "Stopping…"
    static let closedDetail = "Press Continue. Albatross opens a new page when the step needs it."
    static let loadFailed = "The page could not load."
    static let largerView = "Larger view"
}

/// The one control of the page: "Take over" while Albatross has the page,
/// the done label on the user's turn, nothing while Albatross checks. iOS
/// puts it in the sheet's toolbar; the Mac pane keeps it in the bar.
struct PagePaneControl: View {
    let presentation: StepRunBrowserPresentation
    let next: StepRunView.Next?
    var checking = false
    var busy = false
    let onTakeOver: () -> Void
    let onDone: () -> Void

    var body: some View {
        if checking {
            Button(RunBlockCopy.continueButton) {}
                .disabled(true)
        } else if presentation.agentHasPage {
            Button(busy ? PagePaneCopy.takeOverBusy : PagePaneCopy.takeOver, action: onTakeOver)
                .disabled(busy)
                .stopShortcut()
                .help("Albatross stops. The page is yours.")
        } else if presentation.showsContinue {
            Button(busy ? RunBlockCopy.continueBusy : RunBlockCopy.doneLabel(next), action: onDone)
                .disabled(busy)
                .help("Albatross goes on from the page as it is now.")
        }
    }
}

/// The bar, the live view, and the placeholder states. No fixed height: the
/// sheet or the inspector gives it.
struct PagePaneView: View {
    @Environment(AppEnvironment.self) private var environment
    let run: StepRunView
    let session: WorkBrowserSessionPayload?
    let followed: Bool
    var tookOver = false
    var checking = false
    var busy = false
    let onTakeOver: () -> Void
    let onDone: () -> Void
    /// The Mac pane offers the sheet as a larger view. Nil on the phone.
    var onEnlarge: (() -> Void)? = nil

    private var presentation: StepRunBrowserPresentation {
        StepRunBrowserPresentation(session: session, run: run, followed: followed, tookOver: tookOver)
    }

    var body: some View {
        VStack(spacing: 0) {
            bar
            Divider()
            surface
        }
    }

    private var bar: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(presentation.agentHasPage || checking ? environment.theme.accent2Color : environment.theme.accentColor)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)
            Text(checking ? PagePaneCopy.checking : presentation.statusLine)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            #if os(macOS)
            PagePaneControl(
                presentation: presentation,
                next: run.next,
                checking: checking,
                busy: busy,
                onTakeOver: onTakeOver,
                onDone: onDone
            )
            if let onEnlarge {
                Button(PagePaneCopy.largerView, action: onEnlarge)
                    .buttonStyle(.plain)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(environment.theme.accentColor)
                    .help("Opens the page in a larger sheet.")
            }
            #endif
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .accessibilityElement(children: Self.barChildren)
    }

    /// The phone's bar is one line: one element. The Mac's bar holds the
    /// control too, which Full Keyboard Access must reach on its own.
    private static var barChildren: AccessibilityChildBehavior {
        #if os(macOS)
        return .contain
        #else
        return .combine
        #endif
    }

    @ViewBuilder private var surface: some View {
        if let liveViewURL = presentation.liveViewURL {
            LiveViewWebView(urlString: liveViewURL)
                .ignoresSafeArea(edges: .bottom)
        } else if followed {
            ContentUnavailableView(
                "The page is closed.",
                systemImage: "network.slash",
                description: Text(PagePaneCopy.closedDetail)
            )
        } else {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// The page as a sheet on the phone. It follows the session row, keeps the
/// thread readable at the medium detent, and opens large on the user's turn.
struct PageSheet: View {
    let workID: String
    let run: ThreadRunView
    var busy = false
    let onTakeOver: (ThreadRunView) async -> Bool
    let onDone: (ThreadRunView) async -> Void

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State private var follower = PageSessionFollower()
    @State private var tookOver = false
    @State private var checking = false
    @State private var acting = false
    #if os(iOS)
    @State private var detent: PresentationDetent = .medium
    #endif

    private var presentation: StepRunBrowserPresentation {
        StepRunBrowserPresentation(session: follower.session, run: run.run, followed: follower.followed, tookOver: tookOver)
    }

    var body: some View {
        NavigationStack {
            PagePaneView(
                run: run.run,
                session: follower.session,
                followed: follower.followed,
                tookOver: tookOver,
                checking: checking,
                busy: acting || busy,
                onTakeOver: { Task { await takeOver() } },
                onDone: { Task { await done() } }
            )
            .navigationTitle(Self.title(session: follower.session, run: run.run))
            #if os(iOS)
            .navigationSubtitle(run.run.stepTitle)
            #endif
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                #if os(iOS)
                ToolbarItem(placement: .confirmationAction) {
                    PagePaneControl(
                        presentation: presentation,
                        next: run.run.next,
                        checking: checking,
                        busy: acting || busy,
                        onTakeOver: { Task { await takeOver() } },
                        onDone: { Task { await done() } }
                    )
                }
                #endif
            }
        }
        .interactiveDismissDisabled(acting)
        .task(id: run.id) {
            checking = false
            await follower.follow(workID: workID, environment: environment)
        }
        #if os(iOS)
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationBackgroundInteraction(.enabled(upThrough: .medium))
        .onChange(of: presentation.agentHasPage, initial: true) { _, agentHasPage in
            detent = agentHasPage ? .medium : .large
        }
        #endif
    }

    /// The site host when the page is open, else the step title.
    static func title(session: WorkBrowserSessionPayload?, run: StepRunView) -> String {
        if let raw = run.artifacts.first(where: { $0.kind == .page })?.url ?? run.next?.target?.url,
           let host = URL(string: raw)?.host() {
            return host
        }
        return session == nil ? run.stepTitle : "The page"
    }

    private func takeOver() async {
        acting = true
        defer { acting = false }
        if await onTakeOver(run) { tookOver = true }
    }

    private func done() async {
        acting = true
        checking = true
        defer { acting = false }
        await onDone(run)
        tookOver = false
    }
}

/// A minimal wrapper: the live view URL is a self-contained remote-browser
/// client, so the web view needs no navigation chrome of its own.
struct LiveViewWebView: UIViewRepresentable {
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
        // A resumed run can bring a new session: a new address reloads.
        guard let url = secureURL, webView.url?.absoluteString != url.absoluteString else { return }
        webView.load(URLRequest(url: url))
    }
}
