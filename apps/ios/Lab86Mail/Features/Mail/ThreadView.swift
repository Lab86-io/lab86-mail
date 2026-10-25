import Combine
import ConvexMobile
import QuickLook
import SwiftUI

struct ThreadView: View {
    @Environment(AppEnvironment.self) private var environment
    let route: ThreadRoute
    let summary: MailThreadSummary?

    @State private var detail: MailThreadDetail?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var modelSummary: ModelAnswer?
    @State private var summaryExpanded = false
    @State private var isSummarizing = false
    @State private var showsEventReview = false
    @State private var expandedMessageID: String?
    @State private var linkedTasks: [TaskSummary] = []
    @State private var openTask: TaskSummary?
    @State private var proofCandidates: [WorkProofCandidate] = []
    @State private var attachedProofTitle: String?
    @State private var isAttachingProof = false
    @State private var proofError: String?
    @State private var showsProofChoices = false
    @State private var dismissedProofOffer = false
    // Round 2 (FEATURES item 13): unsubscribe asks first; block has Undo.
    @State private var unsubscribe: UnsubscribeFlowModel?
    // The subject is the page's headline in the content, where it can wrap.
    // The bar shows it only after the headline scrolls away.
    @State private var headlineScrolledAway = false
    @ScaledMetric(relativeTo: .title) private var scaledHeadline: CGFloat = 28

    var body: some View {
        Group {
            if let detail {
                ScrollView {
                    // Each message is its own section with a pinned sender
                    // header: as the next message reaches the bar, its sender
                    // pushes the previous one out — the inbox's dateline
                    // behavior, applied to authors.
                    LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                        threadLead(detail)
                        ForEach(Array(detail.messages.enumerated()), id: \.element.id) { index, message in
                            Section {
                                MessageView(
                                    message: message,
                                    accountID: route.accountID,
                                    expandedMessageID: $expandedMessageID
                                )
                                if index < detail.messages.count - 1 {
                                    Divider()
                                        .padding(.horizontal, 16)
                                        .padding(.vertical, 2)
                                }
                            } header: {
                                MessageSenderHeader(
                                    message: message,
                                    accountID: route.accountID,
                                    expandedMessageID: $expandedMessageID
                                )
                            }
                        }
                    }
                    .padding(.bottom, 24)
                    // The reading column: 680 pt at most, centered on wide
                    // screens (D23). Phones keep the full width.
                    .frame(maxWidth: ThreadReaderMetrics.maxWidth)
                    .frame(maxWidth: .infinity)
                }
                .onScrollGeometryChange(for: Bool.self) { geometry in
                    geometry.contentOffset.y + geometry.contentInsets.top > 64
                } action: { _, scrolledAway in
                    headlineScrolledAway = scrolledAway
                }
                .background(environment.theme.paperColor)
            } else if isLoading {
                ProgressView("Opening thread…")
            } else {
                ContentUnavailableView {
                    Label("Couldn’t open this email", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(errorMessage ?? "Try again.")
                } actions: {
                    Button("Try Again") { Task { await load() } }
                }
            }
        }
        // A system large title never wraps, so a long subject read
        // "Offsite venue: final he…". The subject is the headline at the top
        // of the content instead, and the inline bar title shows it once the
        // headline has scrolled away. The Mac pane keeps its title.
        #if os(iOS)
        .navigationTitle(headlineScrolledAway ? pageTitle : "")
        #else
        .navigationTitle(pageTitle)
        #endif
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { await summarize() }
                } label: {
                    if isSummarizing { ProgressView() } else { Label("Summarize", systemImage: "text.append") }
                }
                .disabled(detail == nil || isSummarizing)
            }
            // The thread's actions live in a native bottom bar with proper
            // safe-area handling — Reply is the primary verb, Reply All and
            // Forward sit one menu away, Archive keeps its own button, and
            // everything else is under More.
            ToolbarItem(placement: .bottomBar) {
                Button {
                    openComposer(mode: "reply")
                } label: {
                    Label("Reply", systemImage: "arrowshape.turn.up.left")
                }
                .buttonStyle(.borderedProminent)
                .disabled(detail == nil)
            }
            ToolbarItem(placement: .bottomBar) {
                Menu {
                    Button("Reply All", systemImage: "arrowshape.turn.up.left.2") {
                        openComposer(mode: "reply", replyAll: true)
                    }
                    Button("Forward", systemImage: "arrowshape.turn.up.right") {
                        openComposer(mode: "forward")
                    }
                } label: {
                    Label("Reply options", systemImage: "ellipsis.bubble")
                }
                .disabled(detail == nil)
            }
            ToolbarSpacer(.flexible, placement: .bottomBar)
            if let summary {
                ToolbarItem(placement: .bottomBar) {
                    Button("Archive", systemImage: "archivebox") {
                        Task {
                            await environment.store.archive(summary)
                            environment.navigation.threadRoute = nil
                        }
                    }
                }
            }
            ToolbarItem(placement: .bottomBar) {
                moreMenu
            }
        }
        .task(id: route) { await load() }
        .task(id: "live:\(route.accountID):\(route.threadID)") { await followLiveThread() }
        .sheet(isPresented: $showsEventReview) {
            CommitmentReviewView(route: route, suggestedTitle: detail?.subject ?? summary?.subject ?? "New event")
        }
        .sheet(item: $openTask) { TaskDetailView(task: $0) }
        .modifier(OptionalUnsubscribeFlow(model: unsubscribe) {
            environment.navigation.threadRoute = nil
        })
    }

    private var senderTarget: SenderTarget {
        SenderTarget(
            accountID: route.accountID,
            threadID: route.threadID,
            sender: summary?.sender,
            mailbox: environment.store.accounts.first { $0.id == route.accountID }?.email
        )
    }

    private var pageTitle: String {
        let subject = detail?.subject ?? summary?.subject ?? ""
        return subject.isEmpty ? "No subject" : subject
    }

    // The lead block: the subject as the headline, one italic line (the
    // machine's voice) with the count and the newest date, then the summary,
    // the proof offer, and linked tasks when present, each a flat insert.
    private func threadLead(_ detail: MailThreadDetail) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(pageTitle)
                .font(environment.theme.displayType.displayFont(size: min(scaledHeadline, 40)))
                .lineLimit(5)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .accessibilityAddTraits(.isHeader)
            Text(leadLine(detail))
                .font(environment.theme.displayType.displayItalicFont(size: 15))
                .foregroundStyle(.secondary)
                .accessibilityLabel(leadLine(detail))
                .contextMenu {
                    Button("Copy Subject", systemImage: "doc.on.doc") {
                        PlatformPasteboard.copy(pageTitle)
                    }
                }
            if let modelSummary {
                summaryCard(modelSummary)
            }
            if let attachedProofTitle {
                Text("Filed as proof for \(attachedProofTitle).")
                    .font(.subheadline)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .insetPanel()
            } else if !dismissedProofOffer, let candidate = proofCandidates.first {
                proofOffer(candidate, detail: detail)
            }
            if !linkedTasks.isEmpty {
                linkedTasksInsert
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 2)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func leadLine(_ detail: MailThreadDetail) -> String {
        ThreadLeadCopy.line(messageCount: detail.messages.count, lastDate: detail.messages.last?.date)
    }

    // Tasks that cite this thread: an italic label and plain rows in one
    // insert. A finished task says so in words.
    private var linkedTasksInsert: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Linked tasks")
                .font(environment.theme.displayType.displayItalicFont(size: 15))
                .foregroundStyle(.secondary)
            VStack(spacing: 0) {
                ForEach(linkedTasks) { task in
                    linkedTaskRow(task)
                    if task.id != linkedTasks.last?.id {
                        Divider().padding(.leading, 12)
                    }
                }
            }
            .insetPanel()
        }
    }

    private func linkedTaskRow(_ task: TaskSummary) -> some View {
        Button {
            openTask = task
        } label: {
            HStack(spacing: 10) {
                Text(task.title)
                    .foregroundStyle(task.completed ? .secondary : .primary)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                if task.completed {
                    Text("Done")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Image(systemName: "chevron.forward")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .padding(12)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(task.completed ? "\(task.title), done" : task.title)
    }

    private func proofOffer(_ candidate: WorkProofCandidate, detail: MailThreadDetail) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Does this settle something you are carrying?")
                .font(.headline)
            Text(
                candidate.proofWhat.map { "Albatross matched this to “\($0)” for \(candidate.workTitle)." }
                    ?? "Albatross matched this to the outcome for \(candidate.workTitle)."
            )
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { proofOfferActions(candidate, detail: detail) }
                VStack(alignment: .leading, spacing: 8) { proofOfferActions(candidate, detail: detail) }
            }

            if showsProofChoices, proofCandidates.count > 1 {
                Divider()
                VStack(alignment: .leading, spacing: 8) {
                    Text("Choose another Albatross")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    ForEach(proofCandidates.dropFirst()) { alternate in
                        Button(alternate.workTitle) {
                            Task { await attachProof(alternate, detail: detail) }
                        }
                        .buttonStyle(.bordered)
                        .disabled(isAttachingProof)
                        .frame(minHeight: 44)
                    }
                }
            }
            if let proofError {
                Text(proofError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .insetPanel()
    }

    @ViewBuilder
    private func proofOfferActions(_ candidate: WorkProofCandidate, detail: MailThreadDetail) -> some View {
        // A soft fill: Reply is the one filled control on this screen.
        Button(isAttachingProof ? "Filing proof…" : "Yes, use as proof") {
            Task { await attachProof(candidate, detail: detail) }
        }
        .buttonStyle(.bordered)
        .tint(environment.theme.accentColor)
        .disabled(isAttachingProof)
        .frame(minHeight: 44)

        if proofCandidates.count > 1 {
            Button(showsProofChoices ? "Never mind" : "Choose another") {
                showsProofChoices.toggle()
            }
            .buttonStyle(.bordered)
            .disabled(isAttachingProof)
            .frame(minHeight: 44)
        }

        Button {
            dismissedProofOffer = true
            // Kept on the server for each Work the offer showed, so the
            // offer does not come back here or on another device.
            let workIDs = proofCandidates.map(\.workID)
            Task {
                await environment.store.dismissProofOffer(
                    accountID: route.accountID,
                    threadID: route.threadID,
                    workIDs: workIDs
                )
            }
        } label: {
            Text("Not related").underline()
        }
            .buttonStyle(.plain)
            .disabled(isAttachingProof)
            .frame(minHeight: 44)
    }

    // Machine text is quarantined from real messages: a flat insert with a
    // display-italic label in the accent, never mistakable for a human
    // message.
    private func summaryCard(_ answer: ModelAnswer) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Summary")
                    .font(environment.theme.displayType.displayItalicFont(size: 15))
                    .foregroundStyle(environment.theme.accentColor)
                Spacer()
                Text(answer.source.rawValue)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                Button {
                    withAnimation(.snappy(duration: 0.2)) { summaryExpanded.toggle() }
                } label: {
                    Image(systemName: summaryExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 26, height: 26)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(summaryExpanded ? "Collapse summary" : "Expand summary")
            }
            Text(answer.text)
                .font(.subheadline)
                .lineLimit(summaryExpanded ? nil : 3)
                .textSelection(.enabled)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .insetPanel()
    }

    private var moreMenu: some View {
        Menu {
            Button("Add to Calendar", systemImage: "calendar.badge.plus") { showsEventReview = true }
            if let summary {
                Divider()
                Button(summary.unread ? "Mark Read" : "Mark Unread", systemImage: summary.unread ? "envelope.open" : "envelope.badge") {
                    Task {
                        if summary.unread { await environment.store.markRead(summary) }
                        else { await environment.store.markUnread(summary) }
                    }
                }
                Button(summary.starred ? "Unstar" : "Star", systemImage: summary.starred ? "star.slash" : "star") {
                    Task { await environment.store.setStarred(!summary.starred, thread: summary) }
                }
                Button("Move to Trash", systemImage: "trash", role: .destructive) {
                    Task {
                        await environment.store.trash(summary)
                        environment.navigation.threadRoute = nil
                    }
                }
            }
            Divider()
            Button("Unsubscribe…", systemImage: "envelope.badge.shield.half.filled") {
                let model = UnsubscribeFlowModel(client: SenderToolsClient(tools: environment.tools))
                unsubscribe = model
                Task { await model.begin(senderTarget) }
            }
            Button("Block sender", systemImage: "hand.raised") {
                Task {
                    if await SenderBlocking.block(senderTarget, environment: environment) != nil {
                        environment.navigation.threadRoute = nil
                    }
                }
            }
        } label: {
            Label("More", systemImage: "ellipsis.circle")
        }
    }

    private func load() async {
        isLoading = true
        proofError = nil
        proofCandidates = []
        defer { isLoading = false }
        do {
            detail = try await environment.store.loadThread(route)
            if expandedMessageID == nil { expandedMessageID = detail?.messages.last?.id }
            if let summary, summary.unread { await environment.store.markRead(summary) }
            linkedTasks = await environment.store.tasksForThread(route.threadID)
            if let detail { await refreshProofCandidates(for: detail) }
            await resolveSenderPhotos()
        } catch {
            // A read the view gave up on is not a failure.
            guard !error.isCancellation else { return }
            errorMessage = error.localizedDescription
        }
    }

    // One resolve pass per loaded thread; the store dedupes against its cache,
    // and pinned-header transitions never re-trigger this (headers only read
    // the already-cached URL).
    private func resolveSenderPhotos() async {
        guard let detail else { return }
        let entries = detail.messages.compactMap { message -> (email: String, account: String)? in
            guard let email = message.fromEmail else { return nil }
            return (email: email, account: route.accountID)
        }
        await environment.mailIdentity.resolve(entries: entries)
    }

    private func followLiveThread() async {
        guard let convex = environment.convex else { return }
        do {
            let updates = convex.subscribe(
                to: "liveMail:getThread",
                with: ["account": route.accountID, "threadId": route.threadID],
                yielding: Optional<LiveMailThreadDetailPayload>.self
            ).values
            for try await payload in updates {
                guard !Task.isCancelled else { return }
                if let payload {
                    let updated = MailThreadDetail(payload: payload)
                    let previousLatest = detail?.messages.last
                    detail = updated
                    if expandedMessageID == nil { expandedMessageID = updated.messages.last?.id }
                    let latest = updated.messages.last
                    if previousLatest?.id != latest?.id || previousLatest?.body != latest?.body {
                        proofCandidates = []
                        proofError = nil
                        await refreshProofCandidates(for: updated)
                    }
                }
            }
        } catch {
            if error.isCancellation { return }
            // The authenticated HTTP load remains the fallback. A transient
            // websocket failure should not replace a readable message with an error.
            if detail == nil { errorMessage = error.localizedDescription }
        }
    }

    private func summarize() async {
        guard let detail else { return }
        isSummarizing = true
        defer { isSummarizing = false }
        do {
            let content = detail.messages.map { "From: \($0.sender)\n\($0.body)" }.joined(separator: "\n\n")
            modelSummary = try await environment.modelRouter.summarize(thread: route, content: content)
        } catch {
            guard !error.isCancellation else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func attachProof(_ candidate: WorkProofCandidate, detail: MailThreadDetail) async {
        isAttachingProof = true
        proofError = nil
        defer { isAttachingProof = false }
        let attached = await environment.store.attachMailProof(
            candidate,
            route: route,
            subject: detail.subject,
            snippet: candidate.matchedContent ?? ""
        )
        if attached {
            attachedProofTitle = candidate.workTitle
            proofCandidates = []
        } else {
            proofError = environment.store.workError ?? "This proof could not be attached."
        }
    }

    private func refreshProofCandidates(for detail: MailThreadDetail) async {
        guard let latest = detail.messages.last else {
            proofCandidates = []
            return
        }
        let messageID = latest.id
        let messageBody = latest.body
        let matches = await environment.store.proofMatches(
            subject: detail.subject,
            snippet: messageBody,
            messageID: messageID,
            accountID: route.accountID,
            providerThreadID: route.threadID
        )
        guard let current = self.detail?.messages.last,
              current.id == messageID,
              current.body == messageBody else { return }
        proofCandidates = matches
    }

    private func openComposer(mode: String, replyAll: Bool = false) {
        guard let message = detail?.messages.last else { return }
        let originalSubject = detail?.subject ?? summary?.subject ?? ""
        let subject: String
        if mode == "forward" {
            subject = originalSubject.lowercased().hasPrefix("fwd:") ? originalSubject : "Fwd: \(originalSubject)"
        } else {
            subject = originalSubject.lowercased().hasPrefix("re:") ? originalSubject : "Re: \(originalSubject)"
        }
        let recipient: String
        if mode == "forward" {
            recipient = ""
        } else if replyAll {
            recipient = [message.sender, message.recipients]
                .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                .joined(separator: ", ")
        } else {
            recipient = message.sender
        }
        environment.navigation.pendingCompose = ComposePrefill(
            recipient: recipient,
            cc: "",
            bcc: "",
            subject: subject,
            body: "",
            mode: mode,
            accountID: route.accountID,
            threadID: route.threadID,
            messageID: message.id,
            replyAll: replyAll,
            attachmentsKey: nil,
            draftID: nil
        )
        environment.navigation.sheet = .compose
    }
}

// The message's identity row, pinned as its section header: as the reader
// scrolls, the current author stays visible beneath the navigation bar until
// the next message's header pushes it out. Pure presentation over cached
// state — pinning and unpinning triggers no requests or mutations. The row
// prints names; the address is in the accessibility label and the menu.
private struct MessageSenderHeader: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let message: MailMessage
    let accountID: String
    @Binding var expandedMessageID: String?

    private var isExpanded: Bool { expandedMessageID == message.id }
    private var stacksMeta: Bool { dynamicTypeSize.isAccessibilitySize }
    private var senderName: String { EmailTextNormalizer.displayName(from: message.sender) ?? message.sender }

    var body: some View {
        Button {
            withAnimation(.snappy) {
                expandedMessageID = isExpanded ? nil : message.id
            }
        } label: {
            HStack(alignment: .center, spacing: 10) {
                SenderAvatar(name: message.sender, email: message.fromEmail, baseSize: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text(senderName)
                        .font(environment.theme.displayType.displayFont(size: 15))
                        .foregroundStyle(.primary)
                        .lineLimit(stacksMeta ? 2 : 1)
                    if !message.recipients.isEmpty {
                        Text("to \(RecipientNames.line(from: message.recipients))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if stacksMeta { dateText }
                }
                Spacer()
                if !stacksMeta { dateText }
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityText)
        // Opaque paper background so pinned headers read cleanly over the
        // message content scrolling beneath them.
        .background(environment.theme.paperColor)
        .overlay(alignment: .bottom) {
            Divider().opacity(0.6)
        }
        .contextMenu {
            Button("Copy Address", systemImage: "doc.on.doc") {
                PlatformPasteboard.copy(contactAddress)
            }
            Button("Show Emails With Them", systemImage: "magnifyingglass") {
                environment.navigation.threadRoute = nil
                environment.navigation.selectPrimary(.mail)
                environment.navigation.pendingMailSearch = contactAddress
            }
            Button("New Email", systemImage: "square.and.pencil") {
                environment.navigation.pendingCompose = ComposePrefill(
                    recipient: contactAddress,
                    cc: "",
                    bcc: "",
                    subject: "",
                    body: "",
                    mode: "new",
                    accountID: accountID,
                    threadID: nil,
                    messageID: nil,
                    replyAll: false,
                    attachmentsKey: nil,
                    draftID: nil
                )
                environment.navigation.sheet = .compose
            }
        }
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
    }

    private var dateText: some View {
        Text(message.date, format: .dateTime.month().day().hour().minute())
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    private var accessibilityText: String {
        var parts = [senderName]
        if contactAddress != senderName { parts.append(contactAddress) }
        if !message.recipients.isEmpty { parts.append("to \(RecipientNames.line(from: message.recipients))") }
        parts.append(message.date.formatted(date: .abbreviated, time: .shortened))
        return parts.joined(separator: ", ")
    }

    private var contactAddress: String {
        if let email = message.fromEmail { return email }
        let raw = message.sender
        if let start = raw.lastIndex(of: "<"), let end = raw.lastIndex(of: ">"), start < end {
            return String(raw[raw.index(after: start)..<end])
        }
        return raw
    }
}

// The message content at full reader width: no outer card, border, or shadow —
// just readable internal padding, with messages separated by spacing and a
// hairline. The identity row lives in MessageSenderHeader.
private struct MessageView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    let message: MailMessage
    let accountID: String
    @Binding var expandedMessageID: String?
    @State private var downloadingAttachmentID: String?
    @State private var attachmentPreviewURL: URL?
    @State private var attachmentError: String?

    private var isExpanded: Bool { expandedMessageID == message.id }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if isExpanded {
                if let html = message.htmlBody {
                    // Rich body and normal remote images render immediately; the
                    // sanitizer strips tracking beacons and sets no-referrer.
                    // Full safe content width — the reader owns the screen.
                    EmailHTMLView(
                        html: html,
                        allowRemoteContent: true,
                        onOpenURL: openLink
                    )
                    .padding(.horizontal, 12)
                    .padding(.bottom, 14)
                } else {
                    Text(message.body)
                        .textSelection(.enabled)
                        .font(.body)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !message.attachments.isEmpty {
                    attachmentsInsert
                        .padding(.horizontal, 16)
                        .padding(.bottom, 14)
                }
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    Text(message.snippet.isEmpty ? message.body : message.snippet)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 12)
            }
        }
        .padding(.top, isExpanded ? 8 : 0)
        .quickLookPreview($attachmentPreviewURL)
        .onChange(of: attachmentPreviewURL) { previous, current in
            if current == nil, let previous {
                try? FileManager.default.removeItem(at: previous.deletingLastPathComponent())
            }
        }
        .onDisappear {
            if let attachmentPreviewURL {
                try? FileManager.default.removeItem(at: attachmentPreviewURL.deletingLastPathComponent())
            }
        }
    }

    // The files of a message as plain rows in one insert: the name, the
    // size, and a download mark after the text.
    private var attachmentsInsert: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(spacing: 0) {
                ForEach(message.attachments) { attachment in
                    attachmentRow(attachment)
                    if attachment.id != message.attachments.last?.id {
                        Divider().padding(.leading, 12)
                    }
                }
            }
            .insetPanel()
            if let attachmentError {
                Text(attachmentError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func attachmentRow(_ attachment: MailAttachment) -> some View {
        Button {
            Task { await openAttachment(attachment) }
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(attachment.filename)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    if attachment.size > 0 {
                        Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                if downloadingAttachmentID == attachment.id {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: "arrow.down.circle")
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(downloadingAttachmentID != nil)
        .accessibilityLabel("Open \(attachment.filename)")
    }

    private func openLink(_ url: URL) {
        if url.scheme?.lowercased() == "mailto" {
            environment.navigation.open(url)
        } else {
            openURL(url)
        }
    }

    private func openAttachment(_ attachment: MailAttachment) async {
        downloadingAttachmentID = attachment.id
        attachmentError = nil
        defer { downloadingAttachmentID = nil }
        do {
            attachmentPreviewURL = try await environment.store.downloadAttachment(
                accountID: accountID,
                messageID: message.id,
                attachment: attachment
            )
        } catch {
            guard !error.isCancellation else { return }
            attachmentError = error.localizedDescription
        }
    }
}

private struct CommitmentReviewView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    let route: ThreadRoute
    @State private var title: String
    @State private var start: Date
    @State private var end: Date
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(route: ThreadRoute, suggestedTitle: String) {
        self.route = route
        _title = State(initialValue: suggestedTitle)
        let nextHour = Calendar.autoupdatingCurrent.nextDate(
            after: .now,
            matching: DateComponents(minute: 0),
            matchingPolicy: .nextTime
        ) ?? .now.addingTimeInterval(3_600)
        _start = State(initialValue: nextHour)
        _end = State(initialValue: nextHour.addingTimeInterval(3_600))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("From this email") { TextField("Event title", text: $title) }
                Section("When") {
                    DatePicker("Starts", selection: $start)
                    DatePicker("Ends", selection: $end, in: start...)
                }
                Section {
                    Label("Nothing is created until you tap Add. The operation is recorded and remains undoable.", systemImage: "checkmark.shield")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
            }
            .navigationTitle("Add to Calendar")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { Task { await save() } }
                        .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || end <= start || isSaving)
                }
            }
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        do {
            try await environment.store.createEvent(
                accountID: route.accountID,
                title: title,
                start: start,
                end: end,
                sourceThread: route
            )
            dismiss()
        } catch {
            guard !error.isCancellation else { return }
            errorMessage = error.localizedDescription
        }
    }
}
