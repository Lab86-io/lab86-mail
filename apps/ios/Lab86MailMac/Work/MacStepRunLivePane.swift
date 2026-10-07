import SwiftUI
import WebKit

// The step runner on a wide Mac window: the live browser beside the step.
// The Browserbase run page puts the log at the left and the live view at the
// right; this split does the same inside the "Do this next" section while a
// run owns the page or waits for the user on it. Design note:
// docs/research/step-runner-macos-design-2026-10-07.md.

/// The pure rules of the split: when the live pane shows, and how wide it is.
enum MacStepRunSplitLayout {
    /// The detail column must hold the card and the pane side by side.
    static let minimumWidth: CGFloat = 960
    static let paneMinWidth: CGFloat = 460
    static let paneMaxWidth: CGFloat = 640
    static let paneHeight: CGFloat = 420

    /// An open run with a browser session, or a handoff that waits for the
    /// user on a page. A draft or document handoff has no page to show.
    static func showsLivePane(width: CGFloat, run: StepRunView?) -> Bool {
        guard width >= minimumWidth, let run else { return false }
        if run.state.isOpen { return run.browserSessionID != nil }
        guard run.isHandoff else { return false }
        return StepRunNextBehaviour.from(run.next) == .openBrowser
    }

    /// About half the column, between the pane limits.
    static func paneWidth(for width: CGFloat) -> CGFloat {
        min(paneMaxWidth, max(paneMinWidth, (width * 0.52).rounded()))
    }
}

/// The words of the pane when it has no page to show.
enum MacStepRunLiveCopy {
    static let title = "Shared browser"
    static let opening = "Opening the shared browser…"
    static let noPageYet = "Albatross has not opened a page yet. The live view shows here when it does."
    static let closed = "The shared browser is closed. Press Continue. Albatross opens a new one when the step needs it."

    /// The line under an empty pane: the run still works, or the page is gone.
    static func placeholder(run: StepRunView, followed: Bool) -> String {
        guard followed else { return opening }
        return run.state.isOpen ? noPageYet : closed
    }
}

/// Follows the live session row of one Work, as the sheet does. One object
/// for the pane, so the subscription survives a redraw of the split.
@MainActor
@Observable
final class MacStepRunSessionFollower {
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
            // The bar says the browser is closed; "Continue" still works.
            followed = true
        }
    }
}

/// The step at the left, the live pane at the right, when the window is wide
/// and the run owns a page. Otherwise the step alone, as on iOS.
struct MacStepRunSplit<Content: View>: View {
    let workID: String
    let run: StepRunView?
    let busy: Bool
    let onTakeOver: (StepRunView) async -> Bool
    let onContinue: (StepRunView) async -> Void
    let onEnlarge: (StepRunView) -> Void
    @ViewBuilder let content: () -> Content

    @State private var width: CGFloat = 0

    var body: some View {
        Group {
            if let run, MacStepRunSplitLayout.showsLivePane(width: width, run: run) {
                HStack(alignment: .top, spacing: 24) {
                    content()
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                    MacStepRunLivePane(
                        workID: workID,
                        run: run,
                        busy: busy,
                        onTakeOver: { await onTakeOver(run) },
                        onContinue: { await onContinue(run) },
                        onEnlarge: { onEnlarge(run) }
                    )
                    .frame(width: MacStepRunSplitLayout.paneWidth(for: width))
                }
            } else {
                content()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) { proxy in proxy.size.width } action: { width = $0 }
    }
}

/// The live browser beside the step. The run owns the session: the pane
/// never starts or ends one. Its bar says who has the page and offers one
/// control: "Take over" while Albatross drives, "Continue" after a handoff.
/// "Larger view" opens the sheet.
struct MacStepRunLivePane: View {
    @Environment(AppEnvironment.self) private var environment
    let workID: String
    let run: StepRunView
    let busy: Bool
    let onTakeOver: () async -> Bool
    let onContinue: () async -> Void
    let onEnlarge: () -> Void

    @State private var follower = MacStepRunSessionFollower()
    @State private var tookOver = false
    @State private var acting = false

    private var presentation: StepRunBrowserPresentation {
        StepRunBrowserPresentation(
            session: follower.session,
            run: run,
            followed: follower.followed,
            tookOver: tookOver
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            bar
            Divider()
            surface
        }
        .frame(height: MacStepRunSplitLayout.paneHeight)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .surfaceCard(theme: environment.theme, cornerRadius: 12)
        .task(id: run.id) { await follower.follow(workID: workID, environment: environment) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(MacStepRunLiveCopy.title)
    }

    private var bar: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(presentation.agentHasPage ? environment.theme.accent2Color : environment.theme.accentColor)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)
            Text(presentation.statusLine)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Spacer(minLength: 8)
            if presentation.agentHasPage {
                Button(acting ? "Stopping…" : "Take over") {
                    Task { await takeOver() }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(acting || busy)
                .help("Albatross stops. The page is yours.")
            } else if presentation.showsContinue {
                Button(acting ? "Continuing…" : "Continue") {
                    Task { await proceed() }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(acting || busy)
                .help("Albatross goes on from the page as it is now.")
            }
            Button("Larger view", action: onEnlarge)
                .buttonStyle(.plain)
                .font(.footnote.weight(.medium))
                .foregroundStyle(environment.theme.accentColor)
                .help("Opens the shared browser in a larger sheet.")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var surface: some View {
        if let liveViewURL = presentation.liveViewURL {
            MacLiveViewWebView(urlString: liveViewURL)
        } else {
            VStack(spacing: 10) {
                if !follower.followed {
                    ProgressView()
                        .controlSize(.small)
                }
                Text(MacStepRunLiveCopy.placeholder(run: run, followed: follower.followed))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 320)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(environment.theme.subtleColor)
        }
    }

    private func takeOver() async {
        acting = true
        defer { acting = false }
        if await onTakeOver() { tookOver = true }
    }

    private func proceed() async {
        acting = true
        defer { acting = false }
        await onContinue()
        tookOver = false
    }
}

/// A minimal wrapper: the live view URL is a self-contained remote-browser
/// client, so the web view needs no navigation chrome of its own.
private struct MacLiveViewWebView: NSViewRepresentable {
    let urlString: String

    private var secureURL: URL? {
        guard let url = URL(string: urlString), url.scheme?.lowercased() == "https" else { return nil }
        return url
    }

    /// The address the view loaded last. A resumed run can bring a new
    /// session, and the pane keeps its identity, so a new address reloads.
    final class Coordinator {
        var loaded: String?
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        if let url = secureURL {
            webView.load(URLRequest(url: url))
            context.coordinator.loaded = urlString
        }
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        guard let url = secureURL, context.coordinator.loaded != urlString else { return }
        webView.load(URLRequest(url: url))
        context.coordinator.loaded = urlString
    }
}
