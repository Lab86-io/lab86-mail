import SwiftUI

// Shell pieces shared by the iOS shell (AppShellView) and the Mac shell
// (MacShellView): the root destination switch, the pending-send/undo status
// overlays, the common toolbar, and notification-action consumption. Kept
// platform-neutral so the two shells stay thin presentations over one model.

struct RootDestinationView: View {
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        switch environment.navigation.selectedTab {
        case .today:
            TodayView()
        case .tasks:
            if let route = environment.navigation.projectRoute {
                ProjectDetailView(project: route.project)
            } else {
                TasksView()
            }
        case .calendar:
            CalendarView()
        case .work:
            if let route = environment.navigation.areaRoute {
                AreaDetailView(route: route)
            } else {
                WorkView()
            }
        case .files:
            if let route = environment.navigation.documentRoute {
                switch route.source {
                case .albatross(let documentID):
                    DocumentEditorView(documentID: documentID)
                case .google(let google):
                    GoogleDocumentEditorView(route: google)
                }
            } else {
                FilesView()
            }
        case .mail:
            MailView()
        case .chat:
            if let chat = environment.assistantChat {
                AssistantChatView(model: chat)
            } else {
                TodayView()
            }
        }
    }
}

// The floating footer: queued sends counting down their undo window, plus the
// undo notice for the last applied operation.
struct ShellStatusOverlay: View {
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        if !environment.pendingSends.records.isEmpty || environment.store.undoNotice != nil {
            VStack(spacing: 8) {
                ForEach(environment.pendingSends.records) { record in
                    PendingSendToast(record: record)
                }
                if let notice = environment.store.undoNotice {
                    HStack(spacing: 12) {
                        Image(systemName: "arrow.uturn.backward.circle")
                            .foregroundStyle(environment.theme.accentColor)
                        Text(notice.summary)
                            .font(.subheadline)
                            .lineLimit(2)
                        Spacer()
                        Button("Undo") {
                            Task { await environment.store.undoLatestOperation() }
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(environment.theme.accentColor)
                        Button("Dismiss") {
                            environment.store.undoNotice = nil
                        }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.plain)
                    }
                    .padding(12)
                    .background(.regularMaterial, in: .rect(cornerRadius: 18))
                }
            }
            .frame(maxWidth: 520)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

struct PendingSendToast: View {
    @Environment(AppEnvironment.self) private var environment
    let record: PendingSendRecord

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            HStack(spacing: 12) {
                Image(systemName: "paperplane")
                    .foregroundStyle(environment.theme.accentColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Sending in \(remainingSeconds(at: context.date))s")
                        .font(.subheadline.weight(.semibold))
                    Text(record.snapshot.subject.isEmpty ? "Message held by the server" : record.snapshot.subject)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Button("Undo Send") {
                    Task {
                        guard let prefill = await environment.pendingSends.undo(record) else { return }
                        environment.navigation.pendingCompose = prefill
                        environment.navigation.sheet = .compose
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(environment.theme.accentColor)
                .disabled(remainingSeconds(at: context.date) <= 0)
            }
            .padding(12)
            .background(.regularMaterial, in: .rect(cornerRadius: 18))
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(Color.primary.opacity(0.1))
            }
        }
        .task(id: record.id) {
            let delay = max(0, record.fireAt.timeIntervalSinceNow)
            try? await Task.sleep(for: .seconds(delay + 0.5))
            await environment.pendingSends.reconcile(ownerID: environment.sessionStore.ownerID)
            await environment.store.refreshMail()
        }
        .accessibilityElement(children: .combine)
    }

    private func remainingSeconds(at date: Date) -> Int {
        max(0, Int(ceil(record.fireAt.timeIntervalSince(date))))
    }
}

// Applies a mail notification action (mark read / archive) that a banner wrote
// down while the shell was away. Shared verbatim between the shells.
enum ShellNotificationActions {
    @MainActor
    static func consumePendingMailAction(
        environment: AppEnvironment,
        defaults: UserDefaults = .standard
    ) async {
        guard let action = defaults.string(forKey: "pendingAlbatrossMailNotificationAction"),
              let accountID = defaults.string(forKey: "pendingAlbatrossMailNotificationAccount"),
              let threadID = defaults.string(forKey: "pendingAlbatrossMailNotificationThread") else { return }
        defaults.removeObject(forKey: "pendingAlbatrossMailNotificationAction")
        defaults.removeObject(forKey: "pendingAlbatrossMailNotificationAccount")
        defaults.removeObject(forKey: "pendingAlbatrossMailNotificationThread")
        await environment.store.performMailNotificationAction(
            action: action,
            accountID: accountID,
            threadID: threadID
        )
    }
}

struct ShellToolbarModifier: ViewModifier {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let includesCompose: Bool

    func body(content: Content) -> some View {
        content
            .toolbar {
                if includesCompose {
                    ToolbarItem(placement: composePlacement) {
                        Button {
                            environment.navigation.sheet = .compose
                        } label: {
                            Label("Compose", systemImage: "square.and.pencil")
                        }
                    }
                    .visibilityPriority(.high)
                }
                #if os(iOS)
                if horizontalSizeClass == .regular {
                    ToolbarOverflowMenu {
                        activityButton
                    }
                } else {
                    ToolbarItem(placement: .topBarTrailing) {
                        activityButton
                    }
                    .visibilityPriority(.low)
                }
                #else
                ToolbarItem(placement: .primaryAction) {
                    activityButton
                }
                #endif
            }
    }

    private var composePlacement: ToolbarItemPlacement {
        #if os(iOS)
        .topBarPinnedTrailing
        #else
        .primaryAction
        #endif
    }

    private var activityButton: some View {
        Button {
            environment.navigation.sheet = .activity
        } label: {
            Label(
                "Activity",
                systemImage: environment.store.approvals.isEmpty
                    && environment.store.suggestions.isEmpty
                    && environment.store.pendingQuestions.isEmpty
                    ? "bell" : "bell.badge"
            )
        }
        .accessibilityLabel(
            environment.store.approvals.isEmpty
                && environment.store.suggestions.isEmpty
                && environment.store.pendingQuestions.isEmpty
                ? "Activity" : "Activity, decisions waiting"
        )
    }
}

extension View {
    func shellToolbar(includesCompose: Bool = false) -> some View {
        modifier(ShellToolbarModifier(includesCompose: includesCompose))
    }
}
