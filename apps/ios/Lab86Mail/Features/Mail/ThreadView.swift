import Combine
import ConvexMobile
import Kingfisher
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
        // The subject is the page's own title: it starts large and collapses
        // into the navigation bar with the native transition. Long subjects
        // truncate only in the compact bar state — the full text stays
        // available through the lead row (VoiceOver + copy).
        .navigationTitle(pageTitle)
        .navigationBarTitleDisplayMode(.large)
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
    }

    private var pageTitle: String {
        let subject = detail?.subject ?? summary?.subject ?? ""
        return subject.isEmpty ? "No subject" : subject
    }

    // The lead block under the large title: message count and latest activity,
    // then machine summary and linked tasks when present. Carries the complete
    // subject for VoiceOver and copy, since the bar truncates long titles once
    // collapsed.
    private func threadLead(_ detail: MailThreadDetail) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(metaLine(detail))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .accessibilityLabel("\(pageTitle). \(metaLine(detail))")
                .contextMenu {
                    Button("Copy Subject", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = pageTitle
                    }
                }
            if let modelSummary {
                summaryCard(modelSummary)
            }
            if !linkedTasks.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Linked tasks")
                        .font(.headline)
                    ForEach(linkedTasks) { task in
                        Button {
                            openTask = task
                        } label: {
                            HStack {
                                Image(systemName: task.completed ? "checkmark.circle.fill" : "circle")
                                Text(task.title)
                                    .foregroundStyle(.primary)
                                Spacer()
                                Image(systemName: "chevron.forward")
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(12)
                            .background(.thinMaterial, in: .rect(cornerRadius: 12))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 2)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func metaLine(_ detail: MailThreadDetail) -> String {
        let count = detail.messages.count
        var parts = ["\(count) message\(count == 1 ? "" : "s")"]
        if let sender = detail.messages.last?.sender, !sender.isEmpty {
            parts.append(sender)
        }
        if let date = detail.messages.last?.date {
            parts.append(date.formatted(date: .abbreviated, time: .shortened))
        }
        return parts.joined(separator: " · ")
    }

    // Machine text is quarantined from real messages: accent-washed card with
    // a left accent rail and a display-italic label — never mistakable for a
    // human message.
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
        .padding(.leading, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            environment.theme.accentSoftColor,
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
        .overlay(alignment: .leading) {
            UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: 16)
                .fill(environment.theme.accentColor)
                .frame(width: 3)
        }
        .padding(.bottom, 2)
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
        } label: {
            Label("More", systemImage: "ellipsis.circle")
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            detail = try await environment.store.loadThread(route)
            if expandedMessageID == nil { expandedMessageID = detail?.messages.last?.id }
            if let summary, summary.unread { await environment.store.markRead(summary) }
            linkedTasks = await environment.store.tasksForThread(route.threadID)
            await resolveSenderPhotos()
        } catch {
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
                    detail = updated
                    if expandedMessageID == nil { expandedMessageID = updated.messages.last?.id }
                }
            }
        } catch is CancellationError {
            return
        } catch {
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
            errorMessage = error.localizedDescription
        }
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
// state — pinning and unpinning triggers no requests or mutations.
private struct MessageSenderHeader: View {
    @Environment(AppEnvironment.self) private var environment
    let message: MailMessage
    let accountID: String
    @Binding var expandedMessageID: String?

    private var isExpanded: Bool { expandedMessageID == message.id }

    var body: some View {
        Button {
            withAnimation(.snappy) {
                expandedMessageID = isExpanded ? nil : message.id
            }
        } label: {
            HStack(alignment: .center, spacing: 10) {
                senderAvatar
                VStack(alignment: .leading, spacing: 2) {
                    Text(message.sender)
                        .font(environment.theme.displayType.displayFont(size: 15))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    if !message.recipients.isEmpty {
                        Text("to \(message.recipients)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer()
                Text(message.date, format: .dateTime.month().day().hour().minute())
                    .font(.caption)
                    .foregroundStyle(.secondary)
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
        // Opaque paper background so pinned headers read cleanly over the
        // message content scrolling beneath them.
        .background(environment.theme.paperColor)
        .overlay(alignment: .bottom) {
            Divider().opacity(0.6)
        }
        .contextMenu {
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

    // Provider photo when the identity store has one cached, initials
    // otherwise — identical 30pt geometry either way.
    @ViewBuilder
    private var senderAvatar: some View {
        if let url = environment.mailIdentity.photoURL(for: message.fromEmail) {
            KFImage(url)
                .placeholder { InitialsAvatar(name: message.sender, size: 30) }
                .fade(duration: 0.15)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: 30, height: 30)
                .clipShape(Circle())
        } else {
            InitialsAvatar(name: message.sender, size: 30)
        }
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
                }
                if !message.attachments.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(message.attachments) { attachment in
                            Button {
                                Task { await openAttachment(attachment) }
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "paperclip")
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(attachment.filename).lineLimit(1)
                                        if attachment.size > 0 {
                                            Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file))
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer()
                                    if downloadingAttachmentID == attachment.id {
                                        ProgressView()
                                    } else {
                                        Image(systemName: "arrow.down.circle")
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                            .buttonStyle(.bordered)
                            .disabled(downloadingAttachmentID != nil)
                        }
                        if let attachmentError {
                            Text(attachmentError)
                                .font(.caption)
                                .foregroundStyle(.red)
                        }
                    }
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
        } catch { errorMessage = error.localizedDescription }
    }
}
