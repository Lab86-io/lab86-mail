import SwiftUI

// The trailing pane of the Albatross thread on the Mac: the page, or the
// details. One pane, one width band; the page displaces the details
// (decision 14). The page part wraps the shared `PagePaneView` and adds the
// hover hint; the details part wraps the shared `WorkDetailsBody` under its
// own header. Design note:
// docs/research/albatross-thread-macos-design-2026-10-07.md, section 5.

/// The words of the pane that only the Mac uses.
enum MacThreadPaneCopy {
    static let detailsTitle = "Details"
    static let closeDetails = "Close the details"
    static let noDetails = "No details yet."
    static let hint = "Albatross still has the page. Press Take over to act yourself."
}

struct MacThreadPane: View {
    @Environment(AppEnvironment.self) private var environment
    let mode: MacThreadPaneMode
    let detail: WorkDetail?
    let runs: [ThreadRunView]
    let pageRun: ThreadRunView?
    let session: WorkBrowserSessionPayload?
    let followed: Bool
    let tookOver: Bool
    let checking: Bool
    let busy: Bool
    let onTakeOver: () -> Void
    let onDone: () -> Void
    let onEnlarge: () -> Void
    let onClose: () -> Void
    let onReload: () async -> Void
    let onArtifact: (StepRunView.Artifact) -> Void

    var body: some View {
        Group {
            switch mode {
            case .page:
                if let pageRun {
                    MacPagePane(
                        run: pageRun.run,
                        session: session,
                        followed: followed,
                        tookOver: tookOver,
                        checking: checking,
                        busy: busy,
                        onTakeOver: onTakeOver,
                        onDone: onDone,
                        onEnlarge: onEnlarge
                    )
                } else {
                    MacDetailsPane(detail: detail, runs: runs, onClose: onClose, onReload: onReload, onArtifact: onArtifact)
                }
            case .details:
                MacDetailsPane(detail: detail, runs: runs, onClose: onClose, onReload: onReload, onArtifact: onArtifact)
            case .none:
                EmptyView()
            }
        }
        // Opaque paper: a translucent material behind a web view flickers on
        // scroll, and the tour cannot draw it.
        .background(environment.theme.paperColor)
    }
}

/// The page beside the conversation. The run owns the session; the pane
/// never starts or ends one. The first time the pointer enters the page
/// while Albatross has it, one line says who has the page.
struct MacPagePane: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let run: StepRunView
    let session: WorkBrowserSessionPayload?
    let followed: Bool
    let tookOver: Bool
    let checking: Bool
    let busy: Bool
    let onTakeOver: () -> Void
    let onDone: () -> Void
    let onEnlarge: () -> Void

    @State private var hinted = false
    @State private var showsHint = false

    static let hintSeconds: Duration = .seconds(3)

    private var agentHasPage: Bool {
        session?.agentHasPage == true && !tookOver
    }

    var body: some View {
        PagePaneView(
            run: run,
            session: session,
            followed: followed,
            tookOver: tookOver,
            checking: checking,
            busy: busy,
            onTakeOver: onTakeOver,
            onDone: onDone,
            onEnlarge: onEnlarge
        )
        .overlay(alignment: .bottom) {
            if showsHint {
                Text(MacThreadPaneCopy.hint)
                    .font(.footnote)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        environment.theme.elevatedColor,
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                    )
                    .overlay {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(environment.theme.hairlineColor, lineWidth: 1)
                    }
                    .padding(16)
                    .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            }
        }
        .onHover { inside in
            guard inside, agentHasPage, !hinted else { return }
            hinted = true
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { showsHint = true }
            Task {
                try? await Task.sleep(for: Self.hintSeconds)
                withAnimation(reduceMotion ? nil : .easeIn(duration: 0.2)) { showsHint = false }
            }
        }
        .onChange(of: agentHasPage) { _, hasPage in
            // The hint arms again for the next time Albatross takes the page.
            if !hasPage {
                hinted = false
                showsHint = false
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Shared browser")
    }
}

/// The details beside the conversation: a header with a close control, then
/// the shared details body.
struct MacDetailsPane: View {
    @Environment(AppEnvironment.self) private var environment
    let detail: WorkDetail?
    let runs: [ThreadRunView]
    let onClose: () -> Void
    let onReload: () async -> Void
    let onArtifact: (StepRunView.Artifact) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text(MacThreadPaneCopy.detailsTitle)
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .semibold))
                        .frame(width: 24, height: 24)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .help("\(MacThreadPaneCopy.closeDetails) (Control-Command-I)")
                .accessibilityLabel(MacThreadPaneCopy.closeDetails)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            Divider()
            if let detail {
                ScrollView {
                    WorkDetailsBody(detail: detail, runs: runs, onReload: onReload, onArtifact: onArtifact)
                }
            } else {
                Text(MacThreadPaneCopy.noDetails)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}
