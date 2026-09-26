import MobileAPI
import SwiftUI

// Editorial editions (2026-09-23 on) are built from `tool_ui` components and
// `live_section` modules. This file renders both natively: the authored text,
// the source rows with their actions, and the live personal modules in place.
// Interactive components that have no native view yet link to the web.

/// The live modules a document may place in its body. Nil turns them off,
/// which is the rule for history editions and area briefs.
struct BriefLiveSections {
    let narrative: NarrativeBriefStore
    let backend: BackendClient
}

/// Owner-supplied context for the recursive node renderer.
struct BriefRenderContext {
    var liveSections: BriefLiveSections?
    var webURL: URL?

    /// The web page for this edition. The `/brief` route forwards to the
    /// shell with the edition selected.
    static func webURL(base: URL?, reportID: String?) -> URL? {
        guard let base else { return nil }
        var components = URLComponents()
        if let reportID, !reportID.isEmpty {
            components.path = "/brief"
            components.queryItems = [URLQueryItem(name: "id", value: reportID)]
        } else {
            components.path = "/"
            components.queryItems = [URLQueryItem(name: "view", value: "today")]
        }
        return components.url(relativeTo: base)?.absoluteURL
    }
}

private struct BriefRenderContextKey: EnvironmentKey {
    static let defaultValue = BriefRenderContext()
}

extension EnvironmentValues {
    var briefRenderContext: BriefRenderContext {
        get { self[BriefRenderContextKey.self] }
        set { self[BriefRenderContextKey.self] = newValue }
    }
}

/// The pure reading of one `tool_ui` node, so the view stays thin and the
/// rules are testable.
struct BriefToolUIPresentation: Equatable {
    // Mirrors `interactiveBriefComponents` in lib/brief/component-catalog.ts.
    static let interactiveComponents: Set<String> = [
        "approval-card", "option-list", "parameter-slider", "preferences-panel",
        "question-flow", "item-carousel", "message-draft",
    ]

    let component: String
    let heading: String?
    let body: String?
    let role: String?
    let isInteractive: Bool
    /// True when this client cannot draw the component itself.
    let needsWeb: Bool
    let sources: [BriefToolSource]
    let sourcesStartExpanded: Bool

    init(node: BriefNode, hiddenRefs: Set<String>) {
        let component = node.component ?? ""
        let props = node.props ?? [:]
        let summary = node.summary?.nilIfBlank
        self.component = component
        isInteractive = Self.interactiveComponents.contains(component)
        if component == "editorial-text" {
            heading = props["title"]?.stringValue?.nilIfBlank
            body = props["text"]?.stringValue?.nilIfBlank ?? summary
            role = props["role"]?.stringValue
            needsWeb = false
        } else {
            let title = props["title"]?.stringValue?.nilIfBlank
            heading = title ?? summary
            let detail = ["description", "body", "text"]
                .lazy
                .compactMap { props[$0]?.stringValue?.nilIfBlank }
                .first
            body = detail ?? (title != nil ? summary : nil)
            role = nil
            needsWeb = true
        }
        sources = (node.toolSources ?? []).filter { !hiddenRefs.contains($0.ref.key) }
        // The web opens the list when a row can do more than open something.
        sourcesStartExpanded = sources.contains { source in
            source.actions.contains { !$0.action.hasPrefix("open_") }
        }
    }

    var sourcesTitle: String {
        sources.count == 1 ? "Source and actions" : "\(sources.count) sources and actions"
    }
}

struct BriefToolUINodeView: View {
    let node: BriefNode
    let hiddenRefs: Set<String>
    let onAction: (BriefDocumentAction, BriefSourceRef?) async -> Void

    @Environment(\.briefRenderContext) private var context
    @Environment(\.openURL) private var openURL
    @State private var sourcesExpanded: Bool?

    var body: some View {
        let presentation = BriefToolUIPresentation(node: node, hiddenRefs: hiddenRefs)
        VStack(alignment: .leading, spacing: 10) {
            if let heading = presentation.heading {
                Text(heading)
                    .font(presentation.role == "lede" ? .title2.weight(.semibold) : .title3.weight(.semibold))
                    .fontDesign(.serif)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
            }
            if let text = presentation.body {
                Text(markdown(text))
                    .font(presentation.role == "aside" ? .callout.italic() : .body)
                    .foregroundStyle(presentation.role == "aside" ? .secondary : .primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if presentation.needsWeb, let url = context.webURL {
                HStack(spacing: 10) {
                    Text(presentation.isInteractive
                        ? "Answer this part of the brief on the web."
                        : "The full view of this part is on the web.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    Button("Open on the web") { openURL(url) }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
            if !presentation.sources.isEmpty {
                DisclosureGroup(
                    isExpanded: Binding(
                        get: { sourcesExpanded ?? presentation.sourcesStartExpanded },
                        set: { sourcesExpanded = $0 }
                    )
                ) {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(presentation.sources, id: \.ref.key) { source in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(source.ref.label ?? source.ref.id)
                                    .font(.subheadline)
                                    .fixedSize(horizontal: false, vertical: true)
                                BriefActionFlow(actions: source.actions, sourceRef: source.ref, onAction: onAction)
                            }
                        }
                    }
                    .padding(.top, 6)
                } label: {
                    Text(presentation.sourcesTitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(text)
    }
}

/// A private module the document places at this point. It renders only when
/// the owner supplies live sections (the latest daily edition).
struct BriefLiveSectionNodeView: View {
    let node: BriefNode
    @Environment(\.briefRenderContext) private var context

    var body: some View {
        if let live = context.liveSections {
            switch node.section {
            case "narrative":
                NarrativeBriefView(memory: live.narrative, backend: live.backend)
            case "prepared_work":
                PreparedWorkSection()
            default:
                EmptyView()
            }
        }
    }
}

/// What the owner surface mounts around a native document. A section that
/// the document places in its body is never mounted a second time.
enum BriefOwnerMounts {
    static func mountsNarrative(_ document: BriefDocumentV2?) -> Bool {
        !(document?.hasLiveSection("narrative") ?? false)
    }

    /// The summary lede stands in for the narrative. An editorial page
    /// carries its own lede, as on the web.
    static func mountsLede(_ document: BriefDocumentV2, narrativeLoaded: Bool) -> Bool {
        !narrativeLoaded && !document.isEditorial && mountsNarrative(document)
    }

    static func mountsPreparedWork(_ document: BriefDocumentV2, hasArtifact: Bool, showsLatest: Bool) -> Bool {
        PreparedWorkPolicy.mounts(hasArtifact: hasArtifact, showsLatest: showsLatest)
            && !document.hasLiveSection("prepared_work")
    }

    /// Live modules belong only to the latest daily edition.
    @MainActor
    static func liveSections(
        showsLatest: Bool,
        narrative: NarrativeBriefStore,
        backend: BackendClient
    ) -> BriefLiveSections? {
        showsLatest ? BriefLiveSections(narrative: narrative, backend: backend) : nil
    }
}
