import SwiftUI

// The "Albatrosses" section of the Mac source list (docs/albatross-threads.md,
// T1, T2, T10, T12; lead decision 3): the primary row as a disclosure header
// with the needs-you count and the filter, the live rows under it, "Show N
// more", the notice after "Stop", the Answer popover, and the inline steer
// field. The rows come from the shared ThreadsStore and the shared
// ThreadRowPresentation rules through MacThreadListLayout; the verbs call
// the shared store. Design note:
// docs/research/albatross-threads-macos-design-2026-10-08.md, sections 2 and 3.
struct MacThreadRows<Header: View>: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// A row whose steer field opens with the section (previews, the tour).
    var initialSteerWorkID: String? = nil
    /// The "Albatrosses" row of the source list, as the disclosure label.
    @ViewBuilder let header: () -> Header

    @State private var showsAll = false
    @State private var clock: Date = .now
    @State private var steer: MacThreadSteerField?
    @State private var answerWorkID: String?
    @State private var notice: StopNotice?
    @State private var noticeTask: Task<Void, Never>?
    @State private var sentLines: [String: String] = [:]
    @State private var archiveTarget: ThreadListRow?
    @State private var lastAnnouncedAt: Date = .distantPast
    @FocusState private var steerFocus: String?

    /// The time labels count from a clock that ticks this often.
    static let clockInterval: Duration = .seconds(30)
    /// The section announces at most one attention line in this window
    /// (lead decision 10).
    static let announcementWindow: TimeInterval = 10

    /// "Stopped {title}" with "Continue", under the rows, for ten seconds.
    struct StopNotice: Equatable {
        let workID: String
        let text: String
    }

    private var requests: MacRequests { MacRequests.shared }
    private var threads: ThreadsStore { environment.threads }

    private var rows: [ThreadListRow] {
        MacThreadListLayout.rows(
            items: environment.store.allWork,
            live: threads.rows,
            filter: requests.threadFilter,
            now: clock
        )
    }

    var body: some View {
        let list = rows
        let visible = MacThreadListLayout.visible(list, showsAll: showsAll)
        return DisclosureGroup(isExpanded: expandedBinding) {
            if list.isEmpty {
                emptyRow
            }
            ForEach(visible.shown) { row in
                threadRow(row)
            }
            if let label = MacThreadListLayout.moreLabel(total: list.count, showsAll: showsAll) {
                moreRow(label, dot: MacThreadListLayout.dot(for: MacThreadListLayout.folded(list, showsAll: showsAll)))
            }
            if let notice {
                noticeRow(notice)
            }
        } label: {
            headerRow(rows: list)
        }
        .task {
            while !Task.isCancelled {
                do { try await Task.sleep(for: Self.clockInterval) } catch { return }
                clock = .now
            }
        }
        .onAppear {
            threads.beginFollowing(environment.backend)
            if let initialSteerWorkID, steer == nil {
                steer = MacThreadSteerField(workID: initialSteerWorkID, redirect: false)
            }
        }
        .onDisappear { threads.endFollowing() }
        .onChange(of: threads.attention?.id) { _, _ in
            announceAttention()
        }
        .confirmationDialog(
            WorkViewCopy.archiveTitle,
            isPresented: Binding(
                get: { archiveTarget != nil },
                set: { if !$0 { archiveTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Archive", role: .destructive) {
                guard let target = archiveTarget else { return }
                archiveTarget = nil
                Task { await setWorkState(target, "archived") }
            }
        } message: {
            Text(WorkViewCopy.archiveMessage)
        }
    }

    // MARK: - The header

    private var expandedBinding: Binding<Bool> {
        Binding(
            get: { requests.threadsExpanded },
            set: { requests.setThreadsExpanded($0) }
        )
    }

    private var filterBinding: Binding<WorkFilter> {
        Binding(
            get: { requests.threadFilter },
            set: { requests.setThreadFilter($0) }
        )
    }

    /// The primary row, then the dot of the folded rows while collapsed, the
    /// needs-you count, and the filter.
    private func headerRow(rows: [ThreadListRow]) -> some View {
        let count = threads.needsYouCount
        return HStack(spacing: 8) {
            header()
            if !requests.threadsExpanded {
                ThreadStatusDot(kind: MacThreadListLayout.dot(for: rows))
            }
            if count > 0 {
                Text("\(count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            filterMenu
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(MacThreadRowsCopy.headerLabel(needsYou: count, expanded: requests.threadsExpanded))
    }

    private var filterMenu: some View {
        Menu {
            Picker("Filter", selection: filterBinding) {
                ForEach(MacThreadListLayout.filters, id: \.self) { filter in
                    Text(filter.label).tag(filter)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            Text(requests.threadFilter.label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help(MacThreadRowsCopy.filterHelp)
        .accessibilityLabel("Filter")
        .accessibilityValue(requests.threadFilter.label)
    }

    // MARK: - The rows

    private func threadRow(_ row: ThreadListRow) -> some View {
        let selected = environment.navigation.selectedTab == .work
            && environment.navigation.workRoute?.workID == row.id
        return MacThreadRow(
            row: row,
            now: clock,
            stale: threads.isStale,
            verbs: MacThreadListLayout.hoverVerbs(row.status),
            steerField: steer?.workID == row.id ? steer : nil,
            note: noteBinding(row),
            sentLine: sentLines[row.id],
            focus: $steerFocus,
            onOpen: { open(row) },
            onVerb: { verb in perform(verb, on: row) },
            onSteerSend: { Task { await sendSteer(row) } },
            onSteerCancel: { closeSteer() }
        )
        .listRowBackground(
            selected
                ? RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.primary.opacity(0.08))
                : nil
        )
        .contextMenu { rowMenu(row) }
        .popover(isPresented: answerBinding(row), arrowEdge: .trailing) {
            MacAnswerPopover(
                row: row,
                onAnswered: {
                    answerWorkID = nil
                    Task { await threads.load(environment.backend) }
                },
                onOpen: {
                    answerWorkID = nil
                    open(row)
                }
            )
        }
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private func noteBinding(_ row: ThreadListRow) -> Binding<String> {
        Binding(
            get: { steer?.workID == row.id ? (steer?.note ?? "") : "" },
            set: { text in
                guard steer?.workID == row.id else { return }
                steer?.note = text
            }
        )
    }

    private func answerBinding(_ row: ThreadListRow) -> Binding<Bool> {
        Binding(
            get: { answerWorkID == row.id },
            set: { shown in if !shown, answerWorkID == row.id { answerWorkID = nil } }
        )
    }

    /// "Show 4 more" / "Show fewer", with the dot of what it folds.
    private func moreRow(_ label: String, dot: ThreadRowDot) -> some View {
        Button {
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { showsAll.toggle() }
        } label: {
            HStack(spacing: 8) {
                ThreadStatusDot(kind: dot)
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private var emptyRow: some View {
        Text(MacThreadListLayout.emptyLine(filter: requests.threadFilter))
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// "Stopped {title}" with "Continue" (lead decision 7). It leaves after
    /// ten seconds.
    private func noticeRow(_ notice: StopNotice) -> some View {
        HStack(spacing: 8) {
            Text(notice.text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 6)
            Button(RunBlockCopy.continueButton) {
                continueRun(notice.workID)
            }
            .buttonStyle(.borderless)
            .font(.caption.weight(.medium))
        }
        .accessibilityElement(children: .contain)
    }

    /// The same verbs as the hover slot, then the Mac's own items. Sentence
    /// case, as the thread's menus are; what does not apply is absent.
    @ViewBuilder private func rowMenu(_ row: ThreadListRow) -> some View {
        Button(MacThreadRowsCopy.open) { open(row) }
        ForEach(ThreadRowPresentation.menuVerbs(row.status)) { verb in
            Button(verb.menuLabel) { perform(verb, on: row) }
        }
        if row.live != nil {
            Button(row.unread ? WorkViewCopy.markRead : WorkViewCopy.markUnread) {
                Task { await toggleUnread(row) }
            }
        }
        if let areaID = row.item.primaryAreaID, let areaName = row.item.areaName {
            Button(MacThreadRowsCopy.showInArea) {
                environment.navigation.openArea(id: areaID, name: areaName)
            }
        }
        Divider()
        if row.item.workState == "paused" {
            Button("Pick it up") { Task { await setWorkState(row, "active") } }
        } else {
            Button("Put it down") { Task { await setWorkState(row, "paused") } }
        }
        Button("Mark done") { Task { await setWorkState(row, "done") } }
        Divider()
        Button("Archive…", role: .destructive) { archiveTarget = row }
    }

    // MARK: - Actions

    private func open(_ row: ThreadListRow) {
        environment.navigation.openWork(id: row.id, title: row.title)
    }

    private func perform(_ verb: ThreadRowVerb, on row: ThreadListRow) {
        guard let live = row.live else { return }
        switch verb {
        case .answer:
            answerWorkID = row.id
        case .openPage:
            environment.navigation.openWork(id: row.id, title: row.title, intent: .openPage)
        case .steer:
            openSteer(row, redirect: false)
        case .stopAndRedirect:
            openSteer(row, redirect: true)
        case .stop, .stopReply:
            Task { await stop(row, live: live) }
        case .continueRun:
            Task { await threads.continueRun(live, transport: environment.backend) }
        }
    }

    private func openSteer(_ row: ThreadListRow, redirect: Bool) {
        steer = MacThreadSteerField(workID: row.id, redirect: redirect)
        steerFocus = row.id
    }

    private func closeSteer() {
        steer = nil
        steerFocus = nil
    }

    /// Return in the field: one note to the run (T10). With redirect, the
    /// run stops and starts again with it, in one call (lead decision 6).
    private func sendSteer(_ row: ThreadListRow) async {
        guard var field = steer, field.workID == row.id, let live = row.live else { return }
        let text = field.note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !field.sending else { return }
        field.sending = true
        field.error = nil
        steer = field
        let outcome = await threads.steer(live, note: text, redirect: field.redirect, transport: environment.backend)
        guard steer?.workID == row.id else { return }
        switch outcome {
        case .sent:
            closeSteer()
            showSentLine(row.id, NoteReceiptPresentation.line(field.redirect ? .redirectSent : .sent))
            await threads.load(environment.backend)
        case .runEnded:
            closeSteer()
            showSentLine(row.id, QuickSteerCopy.runEnded)
        case .failed(let message):
            field.sending = false
            field.error = message.nilIfBlank ?? QuickSteerCopy.sendFailed
            steer = field
        }
    }

    /// The line stands in for the status line for a moment, then the row
    /// reads live again. The thread shows the full receipt.
    private func showSentLine(_ workID: String, _ text: String) {
        sentLines[workID] = text
        Task {
            do { try await Task.sleep(for: MacThreadListLayout.sentLineDuration) } catch { return }
            if sentLines[workID] == text { sentLines[workID] = nil }
        }
    }

    /// "Stop" on a row, no dialog. A stopped run offers "Continue" in a
    /// notice; a stopped reply has nothing to continue.
    private func stop(_ row: ThreadListRow, live: ThreadRow) async {
        guard await threads.stop(live, transport: environment.backend) else { return }
        guard live.status != .answering else { return }
        showNotice(StopNotice(workID: row.id, text: MacThreadRowsCopy.stopped(row.title)))
    }

    private func showNotice(_ next: StopNotice) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { notice = next }
        noticeTask?.cancel()
        noticeTask = Task {
            do { try await Task.sleep(for: MacThreadListLayout.noticeDuration) } catch { return }
            if notice == next {
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { notice = nil }
            }
        }
    }

    /// "Continue" on the notice: the stopped run goes on.
    private func continueRun(_ workID: String) {
        noticeTask?.cancel()
        notice = nil
        guard let live = threads.row(for: workID) else { return }
        Task { await threads.continueRun(live, transport: environment.backend) }
    }

    /// One merged line at most every ten seconds while the Albatrosses page
    /// is not on screen (the page announces for itself): "Renew the car
    /// registration needs your answer."
    private func announceAttention() {
        guard !threads.listVisible, let attention = threads.attention else { return }
        let now = Date()
        guard now.timeIntervalSince(lastAnnouncedAt) >= Self.announcementWindow else { return }
        lastAnnouncedAt = now
        PlatformAccessibility.announce(NeedsYouBannerCopy.announcement(attention.rows))
    }

    private func toggleUnread(_ row: ThreadListRow) async {
        if row.unread {
            await threads.markSeen(workID: row.id, transport: environment.backend)
        } else {
            await threads.markUnread(workID: row.id, transport: environment.backend)
        }
    }

    /// "Put it down", "Pick it up", "Mark done", "Archive". When the row is
    /// the open thread and it leaves the list, the next thread that needs
    /// the user opens (lead decision 4).
    private func setWorkState(_ row: ThreadListRow, _ state: String) async {
        let wasOpen = environment.navigation.workRoute?.workID == row.id
        let before = rows
        guard await environment.store.updateWorkState(row.id, state: state) else { return }
        if wasOpen, state == "done" || state == "archived" {
            if let next = MacThreadListLayout.afterLeaving(row.id, in: before) {
                environment.navigation.openWork(id: next.id, title: next.title)
            } else {
                environment.navigation.workRoute = nil
            }
        }
        async let work: Void = environment.store.refreshWork()
        async let live: Void = threads.load(environment.backend)
        _ = await (work, live)
    }
}
