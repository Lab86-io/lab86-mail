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

    var body: some View {
        Group {
            if let detail {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(detail.messages) { message in
                        MessageView(
                            message: message,
                            accountID: route.accountID,
                            expandedMessageID: $expandedMessageID
                        )
                    }
                    }
                }
                .safeAreaInset(edge: .top, spacing: 0) {
                    // The on-device summary floats over the thread as a glass
                    // element rather than consuming document space.
                    if let modelSummary {
                        summaryCard(modelSummary)
                    }
                }
            } else if isLoading {
                ProgressView("Opening thread…")
            } else {
                ContentUnavailableView(
                    "Couldn’t open this email",
                    systemImage: "exclamationmark.triangle",
                    description: Text(errorMessage ?? "Try again.")
                )
            }
        }
        .navigationTitle(detail?.subject ?? summary?.subject ?? "Email")
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
    }

    private func summaryCard(_ answer: ModelAnswer) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Summary")
                    .font(.footnote.weight(.semibold))
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
        .glassEffect(.regular, in: .rect(cornerRadius: 18))
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    private var actionsMenu: some View {
        Menu {
            Button("Reply", systemImage: "arrowshape.turn.up.left") { openComposer(mode: "reply") }
            Button("Reply All", systemImage: "arrowshape.turn.up.left.2") { openComposer(mode: "reply", replyAll: true) }
            Button("Forward", systemImage: "arrowshape.turn.up.right") { openComposer(mode: "forward") }
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
                Button("Archive", systemImage: "archivebox") {
                    Task {
                        await environment.store.archive(summary)
                        environment.navigation.threadRoute = nil
                    }
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
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(message.sender).font(.headline)
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
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)

            if isExpanded {
                if let html = message.htmlBody {
                    // Rich body and normal remote images render immediately; the
                    // sanitizer strips tracking beacons and sets no-referrer.
                    EmailHTMLView(
                        html: html,
                        allowRemoteContent: true,
                        onOpenURL: openLink
                    )
                    .padding(.horizontal, 12)
                    .padding(.bottom, 16)
                } else {
                    Text(message.body)
                        .textSelection(.enabled)
                        .font(.body)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 16)
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
                    .padding(.bottom, 16)
                }
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    Text(message.snippet.isEmpty ? message.body : message.snippet)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 14)
            }
            Divider()
        }
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
