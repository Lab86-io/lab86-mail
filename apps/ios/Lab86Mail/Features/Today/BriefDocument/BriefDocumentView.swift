import Charts
import MobileAPI
import SwiftUI

// Content-only region renderer. Owner surfaces (Today, Area, Work) supply
// their own chrome — masthead, titles, footers, and the Regenerate control
// live with the owner, never inside the shared document.
struct BriefDocumentView: View {
    let document: BriefDocumentV2
    let isComposing: Bool
    var scopeAreaID: String? = nil
    let onReview: (ArtifactReviewRequest) -> Void

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    @State private var entities: [String: BriefHydratedEntity] = [:]
    @State private var hiddenRefs: Set<String> = []
    @State private var completedRefs: [String: Bool] = [:]
    @State private var hydrationFailed = false
    @State private var undo: BriefUndo?
    @State private var actionError: String?

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 22) {
            statusLine
            ForEach(document.regions, id: \.id) { region in
                BriefNodeView(
                    node: region.tree,
                    regionSummary: region.summary,
                    entities: entities,
                    hiddenRefs: hiddenRefs,
                    completedRefs: completedRefs,
                    onAction: perform
                )
                .id(region.id)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 18)
        .task(id: document.generatedAt) { await hydratePinnedRefs() }
        .safeAreaInset(edge: .bottom) {
            if let undo {
                HStack(spacing: 12) {
                    Text(undo.message)
                        .font(.footnote)
                        .lineLimit(2)
                    Spacer(minLength: 8)
                    Button("Undo") { Task { await applyUndo(undo) } }
                        .font(.footnote.weight(.semibold))
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(.regularMaterial, in: Capsule())
                .padding(.horizontal)
                .padding(.bottom, 6)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .accessibilityElement(children: .combine)
            }
        }
        .animation(.snappy, value: undo?.id)
        .alert("Couldn’t update the brief", isPresented: errorBinding) {
            Button("OK", role: .cancel) { actionError = nil }
        } message: {
            Text(actionError ?? "Try again.")
        }
    }

    // The only chrome the shared renderer keeps: transient status that belongs
    // to the document body itself (still composing, or hydration fell back to
    // saved details). The former title/date/Regenerate header is owner chrome.
    @ViewBuilder private var statusLine: some View {
        switch BriefDocumentStatus.make(isComposing: isComposing, hydrationFailed: hydrationFailed) {
        case .composing:
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text("Adding regions…")
            }
            .font(.caption2.weight(.medium))
            .textCase(.uppercase)
            .foregroundStyle(.secondary)
        case .savedDetails:
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle")
                Text("Saved details")
            }
            .font(.caption2.weight(.medium))
            .textCase(.uppercase)
            .foregroundStyle(.secondary)
        case nil:
            EmptyView()
        }
    }

    private var errorBinding: Binding<Bool> {
        Binding(
            get: { actionError != nil },
            set: { if !$0 { actionError = nil } }
        )
    }
}

// The document's transient body status, decided in one pure place so the
// precedence (composing beats saved-details, nothing when live) is testable.
enum BriefDocumentStatus: Equatable {
    case composing
    case savedDetails

    static func make(isComposing: Bool, hydrationFailed: Bool) -> BriefDocumentStatus? {
        if isComposing { return .composing }
        if hydrationFailed { return .savedDetails }
        return nil
    }
}

extension BriefDocumentView {
    private func hydratePinnedRefs() async {
        guard let client = environment.briefHydration else { return }
        let refs = collectRefs()
        guard !refs.isEmpty else { return }
        do {
            let hydrated = try await client.resolve(Array(refs.prefix(100)))
            entities = Dictionary(uniqueKeysWithValues: hydrated.map { ($0.key, $0) })
            hydrationFailed = false
        } catch {
            hydrationFailed = true
        }
    }

    private func collectRefs() -> [BriefSourceRef] {
        var refs: [String: BriefSourceRef] = [:]
        func add(_ ref: BriefSourceRef?) {
            guard let ref, ["thread", "task", "event", "card", "work"].contains(ref.kind) else { return }
            refs[ref.key] = ref
        }
        func visit(_ node: BriefNode) {
            node.items?.forEach {
                add($0.ref)
                $0.handoff?.recommendations?.forEach { add($0.ref) }
                $0.handoff?.evidence.forEach { add($0.ref) }
            }
            node.timelineItems?.forEach { add($0.ref) }
            node.checklistItems?.forEach { add($0.ref) }
            node.collectionItems?.forEach { add($0.ref) }
            node.sourceRefs?.forEach(add)
            node.children?.forEach(visit)
        }
        document.regions.forEach { visit($0.tree) }
        return Array(refs.values)
    }

    @MainActor
    private func perform(_ action: BriefDocumentAction, _ sourceRef: BriefSourceRef?) async {
        guard BriefActionPolicy.known.contains(action.action) else { return }
        var payload = BriefActionPayload(action: action, sourceRef: sourceRef)
        if payload.areaID == nil { payload.areaID = scopeAreaID }
        switch BriefActionPolicy.tier(action.action) {
        case .navigation:
            navigate(action.action, payload)
        case .review:
            onReview(
                ArtifactReviewRequest(
                    action: action.action,
                    payload: payload,
                    source: document.title
                )
            )
        case .immediate:
            await applyImmediate(action.action, payload, sourceRef: sourceRef)
        }
    }

    @MainActor
    private func applyImmediate(
        _ action: String,
        _ payload: BriefActionPayload,
        sourceRef: BriefSourceRef?
    ) async {
        let key = sourceRef?.key ?? payload.refKey
        let previousCompleted = key.flatMap { completedRefs[$0] }
        let hides = ["dismiss_task", "resolve_thread", "dismiss_thread", "archive_thread"].contains(action)
        if hides, let key { hiddenRefs.insert(key) }
        if action == "toggle_task", let key, let completed = payload.completed {
            completedRefs[key] = completed
        }
        do {
            try await executeImmediate(action, payload)
            undo = BriefUndo(
                action: action,
                payload: payload,
                sourceRefKey: key,
                previousCompleted: previousCompleted,
                message: immediateMessage(action, payload)
            )
            await environment.store.refreshToday()
        } catch {
            if hides, let key { hiddenRefs.remove(key) }
            if action == "toggle_task", let key {
                completedRefs[key] = previousCompleted
            }
            actionError = error.localizedDescription
        }
    }

    private func executeImmediate(_ action: String, _ payload: BriefActionPayload) async throws {
        switch action {
        case "toggle_task":
            guard let ownerID = environment.sessionStore.ownerID,
                  let cardID = payload.cardID,
                  let completed = payload.completed else {
                throw BackendError.server(status: 400, message: "The brief omitted the task state.")
            }
            _ = try await environment.commandOutbox.enqueue(
                ownerID: ownerID,
                command: .taskSetCompleted(
                    TaskCompletionCommandPayload(cardID: cardID, completed: completed)
                )
            )
            if completed {
                _ = try? await environment.tools.invoke(
                    "dismiss_daily_report_task",
                    arguments: [
                        "cardId": .string(cardID),
                        "title": payload.title.map(JSONValue.string) ?? .null,
                    ]
                )
            } else {
                _ = try? await environment.tools.invoke(
                    "restore_daily_report_task",
                    arguments: ["cardId": .string(cardID)]
                )
            }
            _ = await environment.flushCommandOutbox(ownerID: ownerID)
        case "dismiss_task":
            guard let cardID = payload.cardID else {
                throw BackendError.server(status: 400, message: "The brief omitted the task identifier.")
            }
            _ = try await environment.tools.invoke(
                "dismiss_daily_report_task",
                arguments: [
                    "cardId": .string(cardID),
                    "title": payload.title.map(JSONValue.string) ?? .null,
                ]
            )
        case "resolve_thread", "dismiss_thread":
            try await dismissThread(payload, resolved: action == "resolve_thread")
            if action == "resolve_thread", let trackedID = payload.trackedThreadID {
                _ = try await environment.tools.invoke(
                    "resolve_tracked_thread",
                    arguments: ["id": .string(trackedID)]
                )
            }
        case "archive_thread":
            guard let ownerID = environment.sessionStore.ownerID,
                  let account = payload.account,
                  let threadID = payload.threadID else {
                throw BackendError.server(status: 400, message: "The brief omitted the mail identity.")
            }
            _ = try await environment.commandOutbox.enqueue(
                ownerID: ownerID,
                command: .mailArchive(
                    MailThreadCommandTarget(accountID: account, threadID: threadID)
                )
            )
            try await dismissThread(payload, resolved: false)
            _ = await environment.flushCommandOutbox(ownerID: ownerID)
        default:
            break
        }
    }

    private func dismissThread(_ payload: BriefActionPayload, resolved: Bool) async throws {
        guard let account = payload.account, let threadID = payload.threadID else {
            throw BackendError.server(status: 400, message: "The brief omitted the conversation identity.")
        }
        _ = try await environment.tools.invoke(
            "dismiss_daily_report_thread",
            arguments: [
                "account": .string(account),
                "threadId": .string(threadID),
                "subject": payload.subject.map(JSONValue.string) ?? .null,
                "receivedAt": payload.receivedAt.map(JSONValue.number) ?? .null,
                "action": .string(resolved ? "resolved" : "dismissed"),
            ]
        )
    }

    @MainActor
    private func applyUndo(_ item: BriefUndo) async {
        undo = nil
        do {
            let payload = item.payload
            switch item.action {
            case "toggle_task":
                guard let ownerID = environment.sessionStore.ownerID,
                      let cardID = payload.cardID,
                      let completed = payload.completed else { return }
                _ = try await environment.commandOutbox.enqueue(
                    ownerID: ownerID,
                    command: .taskSetCompleted(
                        TaskCompletionCommandPayload(cardID: cardID, completed: !completed)
                    )
                )
                if completed {
                    _ = try await environment.tools.invoke(
                        "restore_daily_report_task",
                        arguments: ["cardId": .string(cardID)]
                    )
                }
                _ = await environment.flushCommandOutbox(ownerID: ownerID)
            case "dismiss_task":
                guard let cardID = payload.cardID else { return }
                _ = try await environment.tools.invoke(
                    "restore_daily_report_task",
                    arguments: ["cardId": .string(cardID)]
                )
            case "resolve_thread", "dismiss_thread":
                try await restoreThread(payload)
                if item.action == "resolve_thread", let trackedID = payload.trackedThreadID {
                    _ = try await environment.tools.invoke(
                        "update_tracked_thread",
                        arguments: [
                            "id": .string(trackedID),
                            "status": .string(payload.previousStatus ?? "open"),
                        ]
                    )
                }
            case "archive_thread":
                guard let account = payload.account, let threadID = payload.threadID else { return }
                _ = try await environment.tools.invoke(
                    "restore_from_trash",
                    arguments: ["account": .string(account), "threadId": .string(threadID)]
                )
                try await restoreThread(payload)
            default:
                return
            }
            if let key = item.sourceRefKey {
                hiddenRefs.remove(key)
                completedRefs[key] = item.previousCompleted
            }
            await environment.store.refreshToday()
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func restoreThread(_ payload: BriefActionPayload) async throws {
        guard let account = payload.account, let threadID = payload.threadID else { return }
        _ = try await environment.tools.invoke(
            "restore_daily_report_thread",
            arguments: ["account": .string(account), "threadId": .string(threadID)]
        )
    }

    private func navigate(_ action: String, _ payload: BriefActionPayload) {
        if let intent = TodayBriefNavigationIntent.resolve(action: action, payload: payload) {
            switch intent {
            case .work(let workID, let areaID, let title):
                if let areaID {
                    environment.navigation.openArea(id: areaID, name: nil)
                }
                environment.navigation.openWork(id: workID, title: title)
            case .primaryView(let view):
                environment.navigation.openPrimaryView(view)
            case .externalURL(let url):
                openURL(url)
            }
            return
        }

        switch action {
        case "open_thread":
            if let account = payload.account, let threadID = payload.threadID {
                environment.navigation.openThread(accountID: account, threadID: threadID)
            }
        case "open_event":
            if let account = payload.account, let eventID = payload.eventID {
                let preview = environment.store.events.first {
                    $0.id == eventID && $0.accountID == account
                }
                environment.navigation.openEvent(
                    accountID: account,
                    eventID: eventID,
                    calendarID: preview?.calendarID ?? payload.calendarID,
                    preview: preview
                )
            }
        case "open_area":
            if let areaID = payload.areaID {
                let name = environment.store.areas.first { $0.id == areaID }?.name
                environment.navigation.openArea(id: areaID, name: name)
            }
        case "discuss_area":
            if let areaID = payload.areaID {
                environment.startAssistantChat(
                    scope: AssistantChatScope(kind: .area, contextID: areaID, label: nil)
                )
            }
        default:
            break
        }
    }

    private func immediateMessage(_ action: String, _ payload: BriefActionPayload) -> String {
        switch action {
        case "toggle_task": payload.completed == true ? "Task completed" : "Task reopened"
        case "dismiss_task": "Removed from future briefs"
        case "resolve_thread": "Conversation resolved"
        case "dismiss_thread": "Conversation removed"
        case "archive_thread": "Conversation archived"
        default: "Updated"
        }
    }
}

private struct BriefUndo: Identifiable {
    let id = UUID()
    let action: String
    let payload: BriefActionPayload
    let sourceRefKey: String?
    let previousCompleted: Bool?
    let message: String
}

private enum BriefActionPolicy {
    enum Tier { case immediate, review, navigation }

    static let immediate: Set<String> = [
        "toggle_task", "dismiss_task", "resolve_thread", "dismiss_thread", "archive_thread",
    ]
    static let review: Set<String> = [
        "rsvp_event", "create_task", "create_event", "draft_reply", "capture_intent", "answer_question",
    ]
    static let navigation: Set<String> = [
        "open_thread", "open_view", "open_event", "open_area", "open_work", "discuss_area", "open_url",
    ]
    static let known = immediate.union(review).union(navigation)

    static func tier(_ action: String) -> Tier {
        if immediate.contains(action) { return .immediate }
        if review.contains(action) { return .review }
        return .navigation
    }
}

private struct BriefNodeView: View {
    let node: BriefNode
    let regionSummary: String
    let entities: [String: BriefHydratedEntity]
    let hiddenRefs: Set<String>
    let completedRefs: [String: Bool]
    let onAction: (BriefDocumentAction, BriefSourceRef?) async -> Void

    @ViewBuilder var body: some View {
        switch node.kind {
        case "stack":
            VStack(alignment: .leading, spacing: stackSpacing) { children }
        case "grid":
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 170), spacing: 12)],
                alignment: .leading,
                spacing: 12
            ) { children }
        case "split":
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 16) { children }
                VStack(alignment: .leading, spacing: 16) { children }
            }
        case "hero":
            VStack(alignment: .leading, spacing: 12) { children }
                .padding(20)
                .briefSurface(node.surface, cornerRadius: 22)
        case "group":
            BriefGroupView(
                node: node,
                content: AnyView(
                    VStack(alignment: .leading, spacing: 12) { children }
                )
            )
        case "text":
            BriefTextView(node: node)
        case "actions":
            actionFlow(node.actions ?? [], sourceRef: nil)
        case "prompt":
            BriefPromptView(node: node, onAction: onAction)
        case "divider":
            divider
        case "entity_list":
            BriefEntityListView(
                title: node.title,
                items: node.items ?? [],
                variant: node.variant ?? "rows",
                emptyText: node.emptyText,
                entities: entities,
                hiddenRefs: hiddenRefs,
                completedRefs: completedRefs,
                onAction: onAction
            )
        case "query_list":
            BriefQueryListView(
                node: node,
                hiddenRefs: hiddenRefs,
                completedRefs: completedRefs,
                onAction: onAction
            )
        case "stat":
            BriefStatView(node: node)
        case "chart":
            BriefChartView(node: node)
        case "timeline":
            BriefTimelineView(node: node, onAction: onAction)
        case "checklist":
            BriefChecklistView(
                node: node,
                completedRefs: completedRefs,
                onAction: onAction
            )
        case "collection":
            BriefCollectionView(node: node, onAction: onAction)
        case "canvas":
            BriefCanvasNodeView(node: node, regionSummary: regionSummary, onAction: onAction)
        default:
            Text(node.fallbackText ?? regionSummary)
                .font(.body)
                .padding()
                .surfaceCard(cornerRadius: 16)
        }
    }

    @ViewBuilder private var children: some View {
        ForEach(Array((node.children ?? []).enumerated()), id: \.offset) { _, child in
            BriefNodeView(
                node: child,
                regionSummary: regionSummary,
                entities: entities,
                hiddenRefs: hiddenRefs,
                completedRefs: completedRefs,
                onAction: onAction
            )
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private var divider: some View {
        switch node.variant {
        case "space": Color.clear.frame(height: 12)
        case "flourish":
            Text("✦")
                .font(.body)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity)
        default: Divider()
        }
    }

    private var stackSpacing: CGFloat {
        switch node.density {
        case "airy": 22
        case "dense": 8
        default: 14
        }
    }

    private func actionFlow(
        _ actions: [BriefDocumentAction],
        sourceRef: BriefSourceRef?
    ) -> some View {
        BriefActionFlow(actions: actions, sourceRef: sourceRef, onAction: onAction)
    }
}

private struct BriefGroupView: View {
    let node: BriefNode
    let content: AnyView
    @State private var expanded = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                if node.collapsible == true { expanded.toggle() }
            } label: {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 3) {
                        if let kicker = node.kicker {
                            Text(kicker)
                                .font(.caption2.weight(.semibold))
                                .textCase(.uppercase)
                                .foregroundStyle(.tint)
                        }
                        Text(node.title ?? "Brief")
                            .font(.title3.weight(.semibold))
                            .fontDesign(.serif)
                            .foregroundStyle(.primary)
                    }
                    Spacer()
                    if node.collapsible == true {
                        Image(systemName: "chevron.down")
                            .rotationEffect(.degrees(expanded ? 0 : -90))
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isHeader)
            if expanded { content }
        }
        .padding(16)
        .briefSurface(node.surface, cornerRadius: 18)
    }
}

private struct BriefTextView: View {
    let node: BriefNode

    var body: some View {
        Text(attributed)
            .font(font)
            .fontDesign(node.role == "lede" ? .serif : .default)
            .foregroundStyle(node.role == "caption" ? .secondary : .primary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var attributed: AttributedString {
        (try? AttributedString(markdown: node.text ?? "")) ?? AttributedString(node.text ?? "")
    }

    private var font: Font {
        switch node.role {
        case "lede": .title2.weight(.semibold)
        case "kicker": .caption.weight(.semibold)
        case "aside": .callout.italic()
        case "caption": .caption
        default: .body
        }
    }
}

private struct BriefActionFlow: View {
    let actions: [BriefDocumentAction]
    let sourceRef: BriefSourceRef?
    let onAction: (BriefDocumentAction, BriefSourceRef?) async -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                actionButtons
            }
            VStack(alignment: .leading, spacing: 8) {
                actionButtons
            }
        }
    }

    @ViewBuilder private var actionButtons: some View {
        ForEach(Array(actions.enumerated()), id: \.offset) { _, action in
            if BriefActionPolicy.known.contains(action.action) {
                Button(action.label) { Task { await onAction(action, sourceRef) } }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .tint(action.style == "danger" ? Color.red : Color.accentColor)
            }
        }
    }
}

private struct BriefEntityListView: View {
    let title: String?
    let items: [BriefEntityItem]
    let variant: String
    let emptyText: String?
    let entities: [String: BriefHydratedEntity]
    let hiddenRefs: Set<String>
    let completedRefs: [String: Bool]
    let onAction: (BriefDocumentAction, BriefSourceRef?) async -> Void

    var body: some View {
        let visible = items.filter { !hiddenRefs.contains($0.ref.key) }
        VStack(alignment: .leading, spacing: 8) {
            if let title {
                Text(title).font(.title3.weight(.semibold)).fontDesign(.serif)
            }
            if visible.isEmpty {
                if let emptyText {
                    Text(emptyText)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .overlay {
                            RoundedRectangle(cornerRadius: 14)
                                .stroke(.quaternary, style: StrokeStyle(dash: [5]))
                        }
                }
            } else {
                ForEach(visible, id: \.ref.key) { item in
                    BriefEntityRow(
                        item: item,
                        entity: entities[item.ref.key],
                        completed: completedRefs[item.ref.key],
                        card: variant == "cards",
                        onAction: onAction
                    )
                }
            }
        }
    }
}

private struct BriefEntityRow: View {
    let item: BriefEntityItem
    let entity: BriefHydratedEntity?
    let completed: Bool?
    let card: Bool
    let onAction: (BriefDocumentAction, BriefSourceRef?) async -> Void
    @State private var whyExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if let lane = item.framing?.lane {
                Text(lane)
                    .font(.caption2.weight(.semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(.tint)
            }
            Text(entity?.title ?? item.ref.label ?? "Unavailable item")
                .font(.subheadline.weight(.medium))
                .strikethrough(entity?.gone == true || (completed ?? entity?.completed ?? false))
                .foregroundStyle(entity?.gone == true ? .secondary : .primary)
            if let handoff = item.handoff {
                handoffSummary(handoff)
                BriefActionFlow(
                    actions: item.actions ?? [],
                    sourceRef: actionStateRef,
                    onAction: onAction
                )
                handoffDisclosure(handoff)
            } else {
                let detail = [
                    item.framing?.reason,
                    item.framing?.prep,
                    entity?.subtitle,
                    entity?.gone == true ? "This item is no longer available." : entity?.status,
                ].compactMap { $0 }.joined(separator: " · ")
                if !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                BriefActionFlow(
                    actions: item.actions ?? [],
                    sourceRef: actionStateRef,
                    onAction: onAction
                )
            }
        }
        .padding(card ? 13 : 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(card ? AnyShapeStyle(.thinMaterial) : AnyShapeStyle(.clear), in: RoundedRectangle(cornerRadius: 14))
        .overlay {
            if card {
                RoundedRectangle(cornerRadius: 14).stroke(.quaternary)
            }
        }
    }

    private var actionStateRef: BriefSourceRef {
        guard let handoff = item.handoff,
              (handoff.itemCount ?? 1) > 1,
              let handoffID = handoff.handoffId
        else {
            return item.ref
        }
        return BriefSourceRef(
            kind: "derived",
            id: handoffID,
            label: handoff.situation
        )
    }

    private func handoffSummary(_ handoff: BriefEntityHandoff) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            (Text("My read: ").fontWeight(.semibold) + Text(handoff.assessment))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 3) {
                Text((handoff.recommendations?.count ?? 0) > 1 ? "Your moves" : "Your move")
                    .font(.caption2.weight(.semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(.secondary)
                if let recommendations = handoff.recommendations, recommendations.count > 1 {
                    ForEach(Array(recommendations.enumerated()), id: \.offset) { index, move in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("\(index + 1).")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text(move.label)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(.primary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                } else {
                    Text(handoff.recommendation)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private func handoffDisclosure(_ handoff: BriefEntityHandoff) -> some View {
        DisclosureGroup(isExpanded: $whyExpanded) {
            VStack(alignment: .leading, spacing: 9) {
                labeledDetail("Why now", value: handoff.situation)
                if !handoff.background.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Relevant trail").fontWeight(.semibold).foregroundStyle(.primary)
                        ForEach(handoff.background, id: \.self) { item in
                            Label(item, systemImage: "circle.fill")
                                .labelStyle(.titleAndIcon)
                                .symbolRenderingMode(.monochrome)
                                .imageScale(.small)
                        }
                    }
                }
                if !handoff.evidence.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Evidence").fontWeight(.semibold).foregroundStyle(.primary)
                        ForEach(Array(handoff.evidence.enumerated()), id: \.offset) { _, evidence in
                            Text(evidence.label)
                        }
                    }
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.top, 5)
            .padding(.leading, 2)
            .fixedSize(horizontal: false, vertical: true)
        } label: {
            Text("Why this?")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tint)
                .frame(minHeight: 44, alignment: .leading)
        }
        .accessibilityHint(whyExpanded ? "Hides the supporting trail." : "Shows why this conversation surfaced.")
    }

    private func labeledDetail(_ label: String, value: String) -> some View {
        (Text("\(label): ").fontWeight(.semibold).foregroundStyle(.primary) + Text(value))
    }
}

private struct BriefQueryListView: View {
    let node: BriefNode
    let hiddenRefs: Set<String>
    let completedRefs: [String: Bool]
    let onAction: (BriefDocumentAction, BriefSourceRef?) async -> Void

    @Environment(AppEnvironment.self) private var environment
    @State private var result: BriefQueryResult?
    @State private var loading = true

    var body: some View {
        Group {
            if loading {
                ProgressView().frame(maxWidth: .infinity, minHeight: 72)
            } else {
                BriefEntityListView(
                    title: node.title,
                    items: (result?.items ?? []).map(entityItem),
                    variant: node.variant ?? "rows",
                    emptyText: node.emptyText ?? "Nothing here right now.",
                    entities: Dictionary(uniqueKeysWithValues: (result?.items ?? []).map { ($0.key, $0) }),
                    hiddenRefs: hiddenRefs,
                    completedRefs: completedRefs,
                    onAction: onAction
                )
            }
        }
        .task(id: node.query) {
            guard let query = node.query, let client = environment.briefHydration else {
                loading = false
                return
            }
            result = try? await client.query(query, limit: node.limit ?? 12)
            loading = false
        }
    }

    private func entityItem(_ entity: BriefHydratedEntity) -> BriefEntityItem {
        let ref = BriefSourceRef(kind: entity.kind, id: entity.id, account: entity.account)
        let action: BriefDocumentAction?
        if ["task", "card"].contains(entity.kind) {
            action = BriefDocumentAction(
                action: "toggle_task",
                label: entity.completed == true ? "Reopen" : "Complete",
                payload: ["completed": .bool(entity.completed != true)],
                style: "quiet"
            )
        } else if entity.kind == "thread" {
            action = BriefDocumentAction(action: "open_thread", label: "Open", payload: [:], style: "quiet")
        } else if entity.kind == "event" {
            action = BriefDocumentAction(action: "open_event", label: "Open", payload: [:], style: "quiet")
        } else if entity.kind == "work" {
            action = BriefDocumentAction(action: "open_work", label: "Open", payload: [:], style: "quiet")
        } else {
            action = nil
        }
        return BriefEntityItem(
            ref: ref,
            framing: nil,
            actions: action.map { [$0] }
        )
    }
}

private struct BriefStatView: View {
    let node: BriefNode
    @Environment(AppEnvironment.self) private var environment
    @State private var queryCount: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(node.label ?? "Total")
                .font(.caption.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(displayValue)
                    .font(.largeTitle.weight(.semibold))
                    .fontDesign(.serif)
                if let unit = node.unit {
                    Text(unit).font(.subheadline).foregroundStyle(.secondary)
                }
            }
            if let delta = node.delta {
                Text(delta).font(.caption).foregroundStyle(.tint)
            }
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .task(id: node.queryValue) {
            guard let query = node.queryValue, let client = environment.briefHydration else { return }
            queryCount = try? await client.query(query, limit: 48).count
        }
    }

    private var displayValue: String {
        if node.queryValue != nil { return queryCount.map(String.init) ?? "—" }
        switch node.value {
        case .some(.string(let value)): return value
        case .some(.number(let value)): return value.formatted()
        default: return "—"
        }
    }
}

private struct BriefChartView: View {
    let node: BriefNode

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(node.title ?? "Chart").font(.headline)
            if let description = node.description {
                Text(description).font(.caption).foregroundStyle(.secondary)
            }
            Chart(node.data ?? [], id: \.label) { point in
                if node.variant == "line" {
                    LineMark(
                        x: .value("Label", point.label),
                        y: .value("Value", point.value)
                    )
                    .foregroundStyle(.tint)
                    PointMark(
                        x: .value("Label", point.label),
                        y: .value("Value", point.value)
                    )
                    .foregroundStyle(.tint)
                } else {
                    BarMark(
                        x: .value("Label", point.label),
                        y: .value("Value", point.value)
                    )
                    .foregroundStyle(.tint)
                    .cornerRadius(4)
                }
            }
            .chartYAxis { AxisMarks(position: .leading) }
            .frame(height: 190)
            .accessibilityLabel(node.title ?? "Chart")
        }
        .padding(15)
        .surfaceCard(cornerRadius: 16)
    }
}

private struct BriefTimelineView: View {
    let node: BriefNode
    let onAction: (BriefDocumentAction, BriefSourceRef?) async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(node.title ?? "Timeline").font(.title3.weight(.semibold)).fontDesign(.serif)
            ForEach(Array((node.timelineItems ?? []).enumerated()), id: \.offset) { index, item in
                HStack(alignment: .top, spacing: 10) {
                    VStack(spacing: 4) {
                        Image(systemName: "clock").font(.caption).foregroundStyle(.tint)
                        if index < (node.timelineItems?.count ?? 0) - 1 {
                            Rectangle().fill(.quaternary).frame(width: 1, height: 36)
                        }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(item.label).font(.subheadline.weight(.medium))
                            Spacer()
                            if let at = item.at {
                                Text(Date(timeIntervalSince1970: at / 1_000).formatted(date: .omitted, time: .shortened))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        if let detail = item.detail {
                            Text(detail).font(.caption).foregroundStyle(.secondary)
                        }
                        BriefActionFlow(
                            actions: item.actions ?? [],
                            sourceRef: item.ref,
                            onAction: onAction
                        )
                    }
                }
            }
        }
    }
}

private struct BriefChecklistView: View {
    let node: BriefNode
    let completedRefs: [String: Bool]
    let onAction: (BriefDocumentAction, BriefSourceRef?) async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(node.title ?? "Checklist").font(.title3.weight(.semibold)).fontDesign(.serif)
            ForEach(Array((node.checklistItems ?? []).enumerated()), id: \.offset) { _, item in
                let checked = item.ref.flatMap { completedRefs[$0.key] } ?? item.checked ?? false
                let iconName = checked ? "checkmark.circle.fill" : "circle"
                let iconColor = checked ? Color.accentColor : Color.secondary
                Button {
                    guard let action = item.action else { return }
                    let updated = BriefDocumentAction(
                        action: action.action,
                        label: action.label,
                        payload: action.payload.merging(["completed": .bool(!checked)]) { _, new in new },
                        style: action.style
                    )
                    Task { await onAction(updated, item.ref) }
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: iconName)
                            .foregroundStyle(iconColor)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.label)
                                .strikethrough(checked)
                                .foregroundStyle(.primary)
                            if let detail = item.detail {
                                Text(detail).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                    }
                }
                .buttonStyle(.plain)
                .disabled(item.action == nil)
                Divider()
            }
        }
    }
}

private struct BriefCollectionView: View {
    let node: BriefNode
    let onAction: (BriefDocumentAction, BriefSourceRef?) async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title = node.title {
                Text(title).font(.title3.weight(.semibold)).fontDesign(.serif)
            }
            if node.variant == "shelf" {
                ScrollView(.horizontal) {
                    LazyHStack(alignment: .top, spacing: 12) {
                        collectionItems
                    }
                }
                .scrollIndicators(.hidden)
            } else {
                LazyVStack(spacing: 10) { collectionItems }
            }
        }
    }

    @ViewBuilder private var collectionItems: some View {
        ForEach(Array((node.collectionItems ?? []).enumerated()), id: \.offset) { _, item in
            VStack(alignment: .leading, spacing: 7) {
                if let image = item.image {
                    AsyncImage(url: image) { image in
                        image.resizable().scaledToFill()
                    } placeholder: {
                        Rectangle().fill(.quaternary)
                    }
                    .frame(height: 110)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                if let badge = item.badge {
                    Text(badge)
                        .font(.caption2.weight(.semibold))
                        .textCase(.uppercase)
                        .foregroundStyle(.tint)
                }
                Text(item.title).font(.subheadline.weight(.medium))
                if let meta = item.meta {
                    Text(meta).font(.caption).foregroundStyle(.secondary)
                }
                BriefActionFlow(
                    actions: item.actions ?? [],
                    sourceRef: item.ref,
                    onAction: onAction
                )
            }
            .padding(12)
            .frame(width: node.variant == "shelf" ? 230 : nil, alignment: .leading)
            .frame(maxWidth: node.variant == "shelf" ? nil : .infinity, alignment: .leading)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 15))
        }
    }
}

private struct BriefPromptView: View {
    let node: BriefNode
    let onAction: (BriefDocumentAction, BriefSourceRef?) async -> Void
    @State private var value = ""

    var body: some View {
        HStack(spacing: 8) {
            TextField(node.placeholder ?? "Add a thought…", text: $value)
                .textFieldStyle(.plain)
                .submitLabel(.send)
                .onSubmit(submit)
            Button(node.variant == "question" ? "Answer" : "Capture", action: submit)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(10)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 15))
    }

    private func submit() {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let action = BriefDocumentAction(
            action: node.variant == "question" ? "answer_question" : "capture_intent",
            label: node.variant == "question" ? "Submit answer" : "Capture",
            payload: [
                "text": .string(text),
                "questionId": node.questionId.map(BriefJSONValue.string) ?? .null,
            ],
            style: "primary"
        )
        Task {
            await onAction(action, nil)
            await MainActor.run { value = "" }
        }
    }
}

private struct BriefCanvasNodeView: View {
    let node: BriefNode
    let regionSummary: String
    let onAction: (BriefDocumentAction, BriefSourceRef?) async -> Void
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    @State private var contentHeight: CGFloat = 200
    @State private var nonce = UUID().uuidString

    var body: some View {
        if let html = node.html, !html.isEmpty {
            BriefArtifactWebView(
                html: BriefArtifactDocument.make(
                    from: html,
                    nonce: nonce,
                    themeCSS: environment.theme.briefThemeCSS
                ),
                contentHeight: $contentHeight,
                onAction: handle,
                onOpenURL: { openURL($0) }
            )
            .frame(height: min(contentHeight, maximumHeight))
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay { RoundedRectangle(cornerRadius: 16).stroke(.quaternary) }
        } else {
            Text(node.fallbackText ?? regionSummary)
                .font(.body)
                .padding()
                .surfaceCard(cornerRadius: 16)
        }
    }

    private var maximumHeight: CGFloat {
        switch node.height {
        case "compact": 220
        case "tall": 520
        default: 340
        }
    }

    private func handle(_ action: String, _ payload: BriefActionPayload) {
        guard (node.allowedActions ?? []).contains(action),
              BriefActionPolicy.known.contains(action) else { return }
        let documentAction = BriefDocumentAction(
            action: action,
            label: action.replacingOccurrences(of: "_", with: " ").capitalized,
            payload: payload.documentPayload,
            style: "secondary"
        )
        Task { await onAction(documentAction, nil) }
    }
}

private extension View {
    @ViewBuilder
    func briefSurface(_ surface: String?, cornerRadius: CGFloat) -> some View {
        switch surface {
        case "glass":
            // Liquid Glass is reserved for controls/navigation; content uses a
            // standard material so hierarchy and readability remain stable.
            background(.regularMaterial, in: RoundedRectangle(cornerRadius: cornerRadius))
                .overlay { RoundedRectangle(cornerRadius: cornerRadius).stroke(.quaternary) }
        case "elevated":
            surfaceCard(cornerRadius: cornerRadius)
        default:
            overlay { RoundedRectangle(cornerRadius: cornerRadius).stroke(.quaternary) }
        }
    }
}

private extension BriefActionPayload {
    init(action: BriefDocumentAction, sourceRef: BriefSourceRef?) {
        func string(_ key: String) -> String? { action.payload[key]?.stringValue }
        func number(_ key: String) -> Double? { action.payload[key]?.doubleValue }
        func bool(_ key: String) -> Bool? { action.payload[key]?.boolValue }
        let account = string("account") ?? string("accountId") ?? sourceRef?.account
        let threadID = string("threadId") ?? (sourceRef?.kind == "thread" ? sourceRef?.id : nil)
        let eventID = string("eventId") ?? (sourceRef?.kind == "event" ? sourceRef?.id : nil)
        let cardID = string("cardId") ?? (["card", "task"].contains(sourceRef?.kind ?? "") ? sourceRef?.id : nil)
        let areaID = string("areaId") ?? (sourceRef?.kind == "area" ? sourceRef?.id : nil)
        let workID = string("workId") ?? (sourceRef?.kind == "work" ? sourceRef?.id : nil)
        self.init(
            account: account,
            threadID: threadID,
            eventID: eventID,
            areaID: areaID,
            workID: workID,
            calendarID: string("calendarId"),
            view: string("view"),
            url: string("url"),
            cardID: cardID,
            title: string("title") ?? sourceRef?.label,
            subject: string("subject") ?? sourceRef?.label,
            body: string("body"),
            status: string("status"),
            trackedThreadID: string("trackedThreadId"),
            previousStatus: string("previousStatus"),
            text: string("text"),
            questionID: string("questionId"),
            answeredOptionID: string("answeredOptionId"),
            completed: bool("completed"),
            receivedAt: number("receivedAt"),
            dueAt: number("dueAt"),
            startAt: number("startAt"),
            endAt: number("endAt"),
            allDay: bool("allDay"),
            location: string("location"),
            description: string("description")
        )
    }

    var refKey: String? {
        if let threadID { return "thread:\(account ?? ""):\(threadID)" }
        if let cardID { return "card::\(cardID)" }
        if let eventID { return "event:\(account ?? ""):\(eventID)" }
        if let workID { return "work::\(workID)" }
        return nil
    }

    var documentPayload: [String: BriefJSONValue] {
        var value: [String: BriefJSONValue] = [:]
        func set(_ key: String, _ item: String?) { if let item { value[key] = .string(item) } }
        set("account", account)
        set("threadId", threadID)
        set("eventId", eventID)
        set("areaId", areaID)
        set("workId", workID)
        set("calendarId", calendarID)
        set("view", view)
        set("cardId", cardID)
        set("title", title)
        set("subject", subject)
        set("body", body)
        set("status", status)
        if let completed { value["completed"] = .bool(completed) }
        if let startAt { value["startAt"] = .number(startAt) }
        if let endAt { value["endAt"] = .number(endAt) }
        return value
    }
}
