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

    var body: some View {
        Group {
            if let detail {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        threadHeader(detail)
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
                        ForEach(detail.messages) { message in
                            MessageView(
                                message: message,
                                accountID: route.accountID,
                                expandedMessageID: $expandedMessageID
                            )
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.top, 8)
                    .padding(.bottom, 24)
                }
                .background(environment.theme.paperColor)
                .safeAreaInset(edge: .bottom, spacing: 0) { replyCapsule }
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
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    Task { await summarize() }
                } label: {
                    if isSummarizing { ProgressView() } else { Label("Summarize", systemImage: "text.append") }
                }
                .disabled(detail == nil || isSummarizing)

                actionsMenu
            }
        }
        .task(id: route) { await load() }
        .task(id: "live:\(route.accountID):\(route.threadID)") { await followLiveThread() }
        .sheet(isPresented: $showsEventReview) {
            CommitmentReviewView(route: route, suggestedTitle: detail?.subject ?? summary?.subject ?? "New event")
        }
        .sheet(item: $openTask) { TaskDetailView(task: $0) }
    }

    // The subject as the document's own headline — the thread reads as a page,
    // not a bar title.
    private func threadHeader(_ detail: MailThreadDetail) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(detail.subject.isEmpty ? "No subject" : detail.subject)
                .font(environment.theme.displayType.displayFont(size: 23))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Text(metaLine(detail))
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 4)
        .padding(.top, 4)
        .padding(.bottom, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
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

    // The thread's named actions in one floating glass dock where the thumb
    // is; rarer verbs stay in the toolbar menu.
    private var replyCapsule: some View {
        HStack(spacing: 4) {
            Button {
                openComposer(mode: "reply")
            } label: {
                Text("Reply")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 9)
                    .background(Capsule().fill(environment.theme.accentColor))
            }
            .buttonStyle(.plain)
            Button("Reply all") { openComposer(mode: "reply", replyAll: true) }
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.primary)
                .buttonStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
            Button("Forward") { openComposer(mode: "forward") }
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.primary)
                .buttonStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
            if let summary {
                Spacer(minLength: 0)
                Button("Archive") {
                    Task {
                        await environment.store.archive(summary)
                        environment.navigation.threadRoute = nil
                    }
                }
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
                .buttonStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
            }
        }
        .padding(6)
        .glassEffect(.regular.interactive(), in: .capsule)
        .padding(.horizontal, 14)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .disabled(detail == nil)
    }

    private var actionsMenu: some View {
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
            Label("Actions", systemImage: "ellipsis.circle")
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
        } catch {
            errorMessage = error.localizedDescription
        }
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

// Each message is a one-elevation-step card: identity header, collapsed
// snippet or full body — the desktop MessageCard article.
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
            Button {
                withAnimation(.snappy) {
                    expandedMessageID = isExpanded ? nil : message.id
                }
            } label: {
                HStack(alignment: .center, spacing: 10) {
                    InitialsAvatar(name: message.sender, size: 30)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(message.sender)
                            .font(environment.theme.displayType.displayFont(size: 15))
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
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
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

            if isExpanded {
                Divider()
                    .padding(.horizontal, 14)
                    .padding(.bottom, 4)
                if let html = message.htmlBody {
                    // Rich body and normal remote images render immediately; the
                    // sanitizer strips tracking beacons and sets no-referrer.
                    EmailHTMLView(
                        html: html,
                        allowRemoteContent: true,
                        onOpenURL: openLink
                    )
                    .padding(.horizontal, 10)
                    .padding(.bottom, 14)
                } else {
                    Text(message.body)
                        .textSelection(.enabled)
                        .font(.body)
                        .padding(.horizontal, 14)
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
                    .padding(.horizontal, 14)
                    .padding(.bottom, 14)
                }
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    Text(message.snippet.isEmpty ? message.body : message.snippet)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 12)
            }
        }
        .surfaceCard(cornerRadius: 16)
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

    private var contactAddress: String {
        let raw = message.sender
        if let start = raw.lastIndex(of: "<"), let end = raw.lastIndex(of: ">"), start < end {
            return String(raw[raw.index(after: start)..<end])
        }
        return raw
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
