import SwiftUI

// The live page under the painting (docs/research/today-live-2026-11-04.md):
// the note, the Needs you list, the day's schedule, and at most two short
// facts. It reads the Needs you store and the calendar, so it is current, and
// the list acts in place: Done, Later, Reply with the prepared draft, Copy,
// Accept and Decline, Undo. The rules and the words live in `TodayPage`. A wide
// page puts the schedule beside the list; a narrow one stacks them.

/// The text sizes of the page. The Mac's text styles run smaller than the
/// phone's, so each platform names its own.
private enum TodayType {
    static var name: Font {
        #if os(macOS)
        .callout.weight(.medium)
        #else
        .footnote.weight(.medium)
        #endif
    }

    static var detail: Font {
        #if os(macOS)
        .callout
        #else
        .footnote
        #endif
    }

    static var line: Font {
        #if os(macOS)
        .body.weight(.medium)
        #else
        .subheadline.weight(.medium)
        #endif
    }

    static var day: Font {
        #if os(macOS)
        .title3
        #else
        .subheadline
        #endif
    }
}

struct TodayLivePage: View {
    @Environment(AppEnvironment.self) private var environment
    @ScaledMetric(relativeTo: .body) private var scaledAsideWidth: CGFloat = TodayPage.asideWidth
    let now: Date
    let worthKnowing: [WorthKnowingFact]
    let onRetryCalendar: () async -> Void

    @State private var pageWidth: CGFloat = 0

    /// The room for the page on a wide window, as on the web.
    static let maxWidth: CGFloat = 1_096
    private static let margin: CGFloat = TodayLiveMasthead.pageMargin

    private var needsYou: NeedsYouStore { environment.needsYou }
    private var store: ProductStore { environment.store }
    private var nowMillis: ObligationMillis { NeedsYouClock.millis(now) }
    private var asideWidth: CGFloat { min(scaledAsideWidth, 380) }

    private var list: TodayRows {
        let extras = NeedsYouPresentation.extras(questions: store.pendingQuestions, approvals: store.approvals)
        return TodayPage.rows(groups: needsYou.groups(now: now, extras: extras))
    }

    private var events: [TodayScheduleEvent] {
        store.todaysEvents.map(TodayScheduleEvent.init(summary:))
    }

    var body: some View {
        let list = list
        let events = events
        let lines = TodayPage.scheduleLines(events, now: nowMillis)
        let showsList = !list.rows.isEmpty || needsYou.undo != nil
        let columns = TodayPage.usesColumns(pageWidth: pageWidth) && (showsList || !needsYou.loaded)
        let layout = columns
            ? AnyLayout(HStackLayout(alignment: .top, spacing: TodayPage.columnGap))
            : AnyLayout(VStackLayout(alignment: .leading, spacing: 32))

        VStack(alignment: .leading, spacing: 24) {
            note(list: list, lines: lines)
            // One layout value, so a turn of the device keeps a reply in
            // progress and the row in its Undo window.
            layout {
                if showsList || !needsYou.loaded {
                    needsYouColumn(list: list, width: pageWidth)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                VStack(alignment: .leading, spacing: 32) {
                    TodayScheduleSection(
                        events: events,
                        lines: lines,
                        onRetry: onRetryCalendar
                    )
                    TodayWorthKnowingSection(facts: worthKnowing)
                }
                .frame(
                    minWidth: columns ? asideWidth : 0,
                    maxWidth: columns ? asideWidth : .infinity,
                    alignment: .leading
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Self.margin)
        .padding(.top, 20)
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.width
        } action: { newWidth in
            pageWidth = max(0, newWidth - 2 * Self.margin)
        }
    }

    // The lead waits for the first read of the list, and the day line for the
    // first read of the calendar, so neither says "nothing" before it knows.
    private func note(list: TodayRows, lines: [TodayScheduleLine]) -> some View {
        let words = TodayPage.note(
            rows: list.rows,
            open: list.open,
            dueToday: list.dueToday,
            lines: lines,
            now: nowMillis,
            timezone: needsYou.timezone
        )
        return TodayNoteView(
            lead: needsYou.loaded ? words.lead : nil,
            day: store.calendarDidLoad ? words.day : nil,
            wide: TodayPage.usesColumns(pageWidth: pageWidth)
        )
    }

    @ViewBuilder private func needsYouColumn(list: TodayRows, width: CGFloat) -> some View {
        if !needsYou.loaded, let error = needsYou.loadError {
            TodayProblemLine(message: "Needs you did not load.", detail: error) {
                await needsYou.load(environment.backend, force: true)
            }
        } else if !needsYou.loaded {
            BriefPlaceholderBars()
                .padding(.vertical, 8)
        } else {
            TodayNeedsYouSection(
                list: list,
                now: now,
                listWidth: TodayPage.listWidth(pageWidth: width, asideWidth: asideWidth)
            )
        }
    }
}

// MARK: - The note

/// The first line is the one to read, in the display face. The day is a plain
/// line under it, one step back. The space stays while the words load, so the
/// list does not jump when they arrive.
private struct TodayNoteView: View {
    @Environment(AppEnvironment.self) private var environment
    let lead: String?
    let day: String?
    let wide: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let lead {
                Text(lead)
                    .font(environment.theme.displayType.displayFont(size: wide ? 28 : 24, weight: .regular))
                    .lineSpacing(2)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let day {
                Text(day)
                    .font(TodayType.day)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: 736, minHeight: 60, alignment: .topLeading)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - A section head

/// The heading in the display face, one text action, and the rule under them.
private struct TodayLiveHead: View {
    @Environment(AppEnvironment.self) private var environment
    let title: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(title)
                    .font(environment.theme.displayType.displayFont(size: 17, weight: .medium))
                    .foregroundStyle(.primary)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                if let actionTitle, let action {
                    Button(actionTitle, action: action)
                        .buttonStyle(.plain)
                        .font(TodayType.name)
                        .foregroundStyle(environment.theme.accentColor)
                }
            }
            Divider()
        }
    }
}

// MARK: - Needs you

/// A failed action, under the row it belongs to.
private struct TodayRowFailure: Equatable {
    let rowID: String
    let text: String
}

/// The prepared reply of one row, while the card is open.
private struct TodayReplyDraft: Equatable {
    enum Status: Equatable {
        case loading
        case ready
        case failed
    }

    var status: Status
    var body: String
}

private struct TodayNeedsYouSection: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let list: TodayRows
    let now: Date
    let listWidth: CGFloat

    @State private var leaving: TodayLeavingRow?
    @State private var failure: TodayRowFailure?
    @State private var replyID: String?
    @State private var drafts: [String: TodayReplyDraft] = [:]
    @State private var sendingID: String?
    @State private var copiedID: String?

    private var store: NeedsYouStore { environment.needsYou }

    /// The row keeps its place while the Undo offer names it.
    private var activeLeaving: TodayLeavingRow? {
        guard let leaving, store.undo?.obligationID == leaving.row.id else { return nil }
        return leaving
    }

    private var rows: [TodayRow] { TodayPage.rowsInView(list.rows, leaving: activeLeaving) }

    private var actionsBeside: Bool {
        TodayPage.actionsBeside(listWidth: listWidth, isAccessibilitySize: dynamicTypeSize.isAccessibilitySize)
    }

    var body: some View {
        let rows = rows
        VStack(alignment: .leading, spacing: 0) {
            TodayLiveHead(
                title: "Needs you",
                actionTitle: list.more > 0 ? "View all \(list.open)" : nil,
                action: { environment.navigation.openNeedsYou() }
            )
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    rowBlock(row, index: index)
                    Divider()
                }
            }
            .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: rows.map(\.id))
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Needs you")
    }

    @ViewBuilder private func rowBlock(_ row: TodayRow, index: Int) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            TodayNeedsYouRow(
                row: row,
                words: TodayPage.words(for: row, now: NeedsYouClock.millis(now), timezone: store.timezone),
                buttons: TodayPage.buttons(for: row.entry, copied: copiedID == row.id),
                isLead: index == 0,
                isQuiet: index > 0 && !row.urgent,
                isBusy: isBusy(row),
                beside: actionsBeside,
                leavingWord: activeLeaving?.row.id == row.id ? activeLeaving?.word : nil,
                laterOptions: NeedsYouGrouping.laterOptions(now: NeedsYouClock.millis(now), timezone: store.timezone),
                onOpen: { open(row) },
                onAction: { action in run(action, on: row, index: index) },
                onLater: { until in
                    close(row, index: index, action: .later(until: until), word: "Later")
                },
                onNotMine: {
                    close(row, index: index, action: .notMine, word: "Not mine")
                },
                onUndo: { undo(row) }
            )
            if let failure, failure.rowID == row.id {
                Text(failure.text)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, TodayNeedsYouRow.textInset)
                    .padding(.bottom, 8)
            }
            if replyID == row.id, let obligation = row.entry.obligation {
                TodayReplyCard(
                    obligation: obligation,
                    draft: drafts[row.id],
                    isSending: sendingID == row.id,
                    text: draftBinding(row.id),
                    onSend: { send(obligation, row: row, index: index) },
                    onCancel: { replyID = nil }
                )
                .padding(.leading, TodayNeedsYouRow.textInset)
                .padding(.bottom, 12)
            }
        }
    }

    private func isBusy(_ row: TodayRow) -> Bool {
        guard let busyID = store.busyID else { return sendingID == row.id }
        return busyID == row.id || row.otherIDs.contains(busyID) || sendingID == row.id
    }

    // MARK: - Actions

    /// The row itself: the item on the Needs you page, or the Albatross.
    private func open(_ row: TodayRow) {
        switch row.entry {
        case .obligation(let obligation):
            environment.navigation.openNeedsYou(.id(obligation.id))
        case .albatross(let extra):
            if let workID = extra.workID {
                environment.navigation.openWork(id: workID, title: extra.title)
            } else {
                environment.navigation.sheet = .activity
            }
        }
    }

    private func run(_ action: TodayRowAction, on row: TodayRow, index: Int) {
        switch action {
        case .open, .answer:
            open(row)
        case .done:
            close(row, index: index, action: .done, word: "Done")
        case .accept:
            close(row, index: index, action: .rsvp(.yes), word: "Accepted")
        case .decline:
            close(row, index: index, action: .rsvp(.no), word: "Declined")
        case .copy:
            copy(row)
        case .reply:
            toggleReply(row)
        case .startInAlbatross:
            start(row)
        }
    }

    /// A bundled row acts on all of its notices. It leaves only when the lead
    /// closes, so a failed notice stays on the list under its own row.
    private func close(_ row: TodayRow, index: Int, action: ObligationAction, word: String) {
        guard let obligation = row.entry.obligation else { return }
        failure = nil
        Task {
            let closed = await store.act(
                action,
                on: obligation.id,
                others: row.otherIDs,
                transport: environment.backend
            )
            takeFailure(for: row.id)
            guard closed else { return }
            if replyID == row.id { replyID = nil }
            leaving = TodayLeavingRow(row: row, index: index, word: word)
        }
    }

    private func undo(_ row: TodayRow) {
        failure = nil
        Task {
            await store.undoLast(transport: environment.backend)
            takeFailure(for: row.id)
        }
    }

    private func copy(_ row: TodayRow) {
        guard let value = row.entry.obligation?.code?.value else { return }
        PlatformPasteboard.copy(value.filter { !$0.isWhitespace })
        PlatformAccessibility.announce("Copied")
        copiedID = row.id
        Task {
            try? await Task.sleep(for: .seconds(2))
            if copiedID == row.id { copiedID = nil }
        }
    }

    private func start(_ row: TodayRow) {
        guard let obligation = row.entry.obligation else { return }
        failure = nil
        Task {
            let result = await store.startAlbatross(id: obligation.id, transport: environment.backend)
            takeFailure(for: row.id)
            guard let result else { return }
            environment.navigation.openWork(id: result.workID, title: obligation.workTitle)
        }
    }

    private func toggleReply(_ row: TodayRow) {
        guard let obligation = row.entry.obligation else { return }
        guard replyID != row.id else {
            replyID = nil
            return
        }
        replyID = row.id
        guard drafts[row.id] == nil else { return }
        drafts[row.id] = TodayReplyDraft(status: .loading, body: "")
        Task {
            let prepared = await store.prepareDraft(id: obligation.id, transport: environment.backend)
            // The card says it in place: the person can still write the reply.
            store.clearActionError()
            guard drafts[row.id]?.status == .loading else { return }
            if let prepared {
                drafts[row.id] = TodayReplyDraft(status: .ready, body: prepared.body)
            } else {
                drafts[row.id] = TodayReplyDraft(status: .failed, body: "")
            }
        }
    }

    private func send(_ obligation: ObligationView, row: TodayRow, index: Int) {
        guard let body = drafts[row.id]?.body else { return }
        failure = nil
        sendingID = row.id
        Task {
            let sent = await store.sendReply(id: obligation.id, body: body, transport: environment.backend)
            sendingID = nil
            takeFailure(for: row.id)
            guard sent else { return }
            replyID = nil
            drafts[row.id] = nil
            leaving = TodayLeavingRow(row: row, index: index, word: "Replied")
        }
    }

    /// The store's line moves to the row, so the Needs you page does not show
    /// an old failure as an alert later.
    private func takeFailure(for rowID: String) {
        guard let text = store.actionError else { return }
        failure = TodayRowFailure(rowID: rowID, text: text)
        store.clearActionError()
    }

    private func draftBinding(_ rowID: String) -> Binding<String> {
        Binding(
            get: { drafts[rowID]?.body ?? "" },
            set: { drafts[rowID] = TodayReplyDraft(status: .ready, body: $0) }
        )
    }
}

/// One row. The text opens the item. The actions sit in fixed columns, so they
/// line up from row to row: under the text on a narrow list, at the trailing
/// edge on a wide one. Only the first row's first action is solid.
private struct TodayNeedsYouRow: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .subheadline) private var primaryWidth: CGFloat = 92
    @ScaledMetric(relativeTo: .subheadline) private var quietWidth: CGFloat = 64
    let row: TodayRow
    let words: TodayRowWords
    let buttons: [TodayRowButton]
    let isLead: Bool
    /// A row that is not due today: its first action stays neutral.
    let isQuiet: Bool
    let isBusy: Bool
    let beside: Bool
    let leavingWord: String?
    let laterOptions: [NeedsYouLaterOption]
    let onOpen: () -> Void
    let onAction: (TodayRowAction) -> Void
    let onLater: (ObligationMillis) -> Void
    let onNotMine: () -> Void
    let onUndo: () -> Void

    /// The avatar and the room after it. The actions on a narrow list and the
    /// reply card start at the text.
    static let textInset: CGFloat = 44

    var body: some View {
        Group {
            if beside {
                HStack(alignment: .center, spacing: 16) {
                    textButton
                    actions
                }
                .padding(.vertical, 12)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    textButton
                    actions
                        .padding(.leading, Self.textInset)
                }
                .padding(.top, 12)
                .padding(.bottom, 12)
            }
        }
        .transition(.opacity)
    }

    private var textButton: some View {
        Button(action: onOpen) {
            HStack(alignment: .top, spacing: 12) {
                lead
                VStack(alignment: .leading, spacing: 2) {
                    nameLine
                    if let code = words.code {
                        codeLine(code)
                    } else {
                        Text(words.line)
                            .font(TodayType.line)
                            .foregroundStyle(.primary)
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? 6 : 2)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
            .opacity(leavingWord == nil ? 1 : 0.6)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(TodayPage.accessibilityLabel(words))
        .accessibilityHint("Opens the item")
        .accessibilityAddTraits(.isButton)
        .contextMenu { menu }
    }

    @ViewBuilder private var menu: some View {
        if let obligation = row.entry.obligation, !obligation.isClosed, leavingWord == nil {
            Button("Not mine", action: onNotMine)
            if obligation.hasMailThread, let accountID = obligation.accountID, let threadID = obligation.threadID {
                Button("Open in Mail") {
                    environment.navigation.openThread(accountID: accountID, threadID: threadID)
                }
            }
        }
    }

    private var lead: some View {
        NeedsYouLeadView(lead: TodayPage.lead(for: row.entry))
            .overlay(alignment: .bottomTrailing) {
                if let badge = TodayPage.sourceBadge(for: row.entry) {
                    Image(systemName: badge)
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.secondary)
                        .frame(width: 18, height: 18)
                        .background(Circle().fill(environment.theme.paperColor))
                        .overlay(Circle().strokeBorder(environment.theme.hairlineColor, lineWidth: 1))
                        .offset(x: 5, y: 4)
                        .accessibilityHidden(true)
                }
            }
    }

    // One line while it fits. A long place puts the status on a line of its own.
    private var nameLine: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                nameAndPlace
                status
            }
            VStack(alignment: .leading, spacing: 2) {
                nameAndPlace
                status
            }
        }
    }

    private var nameAndPlace: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(words.name)
                .font(TodayType.name)
                .foregroundStyle(.primary)
                .lineLimit(1)
                .layoutPriority(1)
            if !words.place.isEmpty {
                Text(words.place)
                    .font(TodayType.detail)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    @ViewBuilder private var status: some View {
        if !words.status.isEmpty {
            switch words.statusTone {
            case .tag:
                Text(words.status)
                    .font(TodayType.name)
                    .foregroundStyle(environment.theme.accent2Color)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(
                        environment.theme.accent2Color.opacity(0.14),
                        in: RoundedRectangle(cornerRadius: 5, style: .continuous)
                    )
                    .fixedSize()
            case .hot:
                Text(words.status)
                    .font(TodayType.name)
                    .foregroundStyle(environment.theme.accent2Color)
                    .fixedSize()
            case .plain:
                Text(words.status)
                    .font(TodayType.detail)
                    .foregroundStyle(.secondary)
                    .fixedSize()
            }
        }
    }

    private func codeLine(_ code: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(code)
                .font(.title2.weight(.medium).monospacedDigit())
                .kerning(1.5)
                .foregroundStyle(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text("Verification code")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - The actions

    @ViewBuilder private var actions: some View {
        if let leavingWord {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(leavingWord)
                    .font(TodayType.detail)
                    .foregroundStyle(.secondary)
                Button("Undo", action: onUndo)
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.roundedRectangle(radius: 8))
                    .tint(environment.theme.accentColor)
                    .disabled(isBusy)
            }
        } else {
            // At the largest text sizes the three buttons stack.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 4) { actionButtons }
                VStack(alignment: .leading, spacing: 8) { actionButtons }
            }
            .disabled(isBusy)
        }
    }

    @ViewBuilder private var actionButtons: some View {
        ForEach(buttons) { button in
            if button.isPrimary {
                primaryButton(button)
            } else {
                quietButton(button.title) { onAction(button.action) }
            }
        }
        if TodayPage.showsLater(row.entry) {
            Menu {
                ForEach(laterOptions) { option in
                    Button(option.label) { onLater(option.until) }
                }
            } label: {
                quietLabel("Later")
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(.plain)
            .fixedSize()
        }
    }

    @ViewBuilder private func primaryButton(_ button: TodayRowButton) -> some View {
        let label = Text(button.title)
            .font(TodayType.name)
            .lineLimit(1)
            .frame(minWidth: primaryWidth, minHeight: 28)
        if isLead {
            Button { onAction(button.action) } label: { label }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.roundedRectangle(radius: 8))
                .tint(environment.theme.accentColor)
                .fixedSize()
        } else {
            Button { onAction(button.action) } label: { label }
                .buttonStyle(.bordered)
                .buttonBorderShape(.roundedRectangle(radius: 8))
                .tint(isQuiet ? Color.primary : environment.theme.accentColor)
                .fixedSize()
        }
    }

    private func quietButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { quietLabel(title) }
            .buttonStyle(.plain)
            .fixedSize()
    }

    private func quietLabel(_ title: String) -> some View {
        Text(title)
            .font(TodayType.name)
            .foregroundStyle(Color.primary.opacity(0.78))
            .lineLimit(1)
            .frame(minWidth: quietWidth, minHeight: 44)
            .contentShape(.rect)
    }
}

/// The prepared draft under the row: a plain field, Send reply, Cancel.
private struct TodayReplyCard: View {
    @Environment(AppEnvironment.self) private var environment
    let obligation: ObligationView
    let draft: TodayReplyDraft?
    let isSending: Bool
    @Binding var text: String
    let onSend: () -> Void
    let onCancel: () -> Void

    private var isLoading: Bool { draft == nil || draft?.status == .loading }
    private var isBlank: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Draft reply")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(environment.theme.accentColor)
                Text("To \(obligation.asker)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            Divider()
            VStack(alignment: .leading, spacing: 10) {
                if isLoading {
                    Text("Preparing a draft…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    if draft?.status == .failed {
                        Text("Could not prepare a draft. Write the reply here.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    TextEditor(text: $text)
                        .font(.body)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 96)
                        .accessibilityLabel("Draft reply")
                }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) {
                        controls
                        Spacer(minLength: 0)
                        footnote
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 10) { controls }
                        footnote
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
        }
        .background(environment.theme.elevatedColor, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(environment.theme.hairlineColor, lineWidth: 1)
        }
    }

    @ViewBuilder private var controls: some View {
        Button("Send reply", action: onSend)
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.roundedRectangle(radius: 8))
            .tint(environment.theme.accentColor)
            .disabled(isSending || isLoading || isBlank)
        Button("Cancel", action: onCancel)
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .disabled(isSending)
    }

    private var footnote: some View {
        Text("Sends in the thread. Undo for 10 seconds.")
            .font(.caption)
            .foregroundStyle(.secondary)
    }
}

// MARK: - The schedule

/// The day as a short list: what passed, what runs, what is next, and the open
/// room between. Only what runs now has a fill.
private struct TodayScheduleSection: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .footnote) private var timeWidth: CGFloat = 66
    let events: [TodayScheduleEvent]
    let lines: [TodayScheduleLine]
    let onRetry: () async -> Void

    private var store: ProductStore { environment.store }
    private var timezone: String? { environment.needsYou.timezone }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TodayLiveHead(title: "Schedule", actionTitle: "Open calendar") {
                environment.navigation.openPrimaryView("calendar")
            }
            content
                .padding(.top, 8)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Schedule")
    }

    // Three states, never a spinner over an empty line: loading rows until the
    // first calendar read ends, the failure with a retry, else the day.
    @ViewBuilder private var content: some View {
        if let error = store.calendarError, !store.calendarDidLoad {
            TodayProblemLine(message: "Your calendar did not load.", detail: error, retry: onRetry)
        } else if !store.calendarDidLoad {
            BriefPlaceholderBars()
                .padding(.vertical, 8)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(TodayPage.allDayEvents(events)) { event in
                    Text(event.title)
                        .font(TodayType.detail)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 4)
                }
                if lines.isEmpty {
                    Text("Nothing is scheduled today.")
                        .font(TodayType.detail)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 6)
                }
                ForEach(lines) { line in
                    switch line {
                    case .open(_, let until):
                        openLine(until: until)
                    case .event(let event, let state):
                        eventLine(event, state: state)
                    }
                }
            }
        }
    }

    private func openLine(until: ObligationMillis) -> some View {
        HStack(spacing: 8) {
            Text("Free until \(TodayPage.clockLabel(until, timezone: timezone))")
                .font(TodayType.detail)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .fixedSize()
            Rectangle()
                .fill(environment.theme.hairlineColor)
                .frame(height: 1)
                .accessibilityHidden(true)
        }
        .padding(.vertical, 8)
    }

    private func eventLine(_ event: TodayScheduleEvent, state: TodayScheduleState) -> some View {
        Button {
            if let summary = event.summary { environment.navigation.openEvent(summary) }
        } label: {
            eventLabel(event, state: state)
                .padding(.vertical, state == .past ? 3 : 6)
                .padding(.horizontal, state == .now ? 8 : 0)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background {
                    if state == .now {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(environment.theme.accentSoftColor)
                    }
                }
                // The text stays on the column edge; the fill hangs outside it.
                .padding(.horizontal, state == .now ? -8 : 0)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel(event, state: state))
        .accessibilityAddTraits(.isButton)
    }

    // At accessibility sizes the time sits over the title.
    @ViewBuilder private func eventLabel(_ event: TodayScheduleEvent, state: TodayScheduleState) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 2) {
                timeColumn(event, state: state)
                titleColumn(event, state: state)
            }
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                timeColumn(event, state: state)
                    .frame(minWidth: timeWidth, alignment: .leading)
                titleColumn(event, state: state)
                Spacer(minLength: 0)
            }
        }
    }

    @ViewBuilder private func timeColumn(_ event: TodayScheduleEvent, state: TodayScheduleState) -> some View {
        let clock = TodayPage.clockLabel(event.startAt, timezone: timezone)
        switch state {
        case .now, .next:
            VStack(alignment: .leading, spacing: 0) {
                Text(state == .now ? "Now" : "Next")
                    .font(TodayType.name)
                    .foregroundStyle(state == .now ? environment.theme.accentColor : Color.primary)
                Text(clock)
                    .font(TodayType.detail.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .fixedSize()
        case .past, .later:
            Text(clock)
                .font(TodayType.detail.monospacedDigit())
                .foregroundStyle(.secondary)
                .fixedSize()
        }
    }

    private func titleColumn(_ event: TodayScheduleEvent, state: TodayScheduleState) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(event.title)
                .font(state == .past ? TodayType.detail : TodayType.line)
                .foregroundStyle(state == .past ? Color.secondary : Color.primary)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
            if let detail = detailLine(event, state: state) {
                Text(detail)
                    .font(TodayType.detail)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    private func detailLine(_ event: TodayScheduleEvent, state: TodayScheduleState) -> String? {
        switch state {
        case .now:
            return "Ends \(TodayPage.clockLabel(event.endAt, timezone: timezone))"
        case .next:
            return event.location ?? "Ends \(TodayPage.clockLabel(event.endAt, timezone: timezone))"
        case .past, .later:
            return nil
        }
    }

    private func accessibilityLabel(_ event: TodayScheduleEvent, state: TodayScheduleState) -> String {
        let clock = TodayPage.clockLabel(event.startAt, timezone: timezone)
        var parts = [event.title, clock]
        switch state {
        case .now: parts.insert("Now", at: 0)
        case .next: parts.insert("Next", at: 0)
        case .past, .later: break
        }
        if let detail = detailLine(event, state: state) { parts.append(detail) }
        return parts.joined(separator: ", ")
    }
}

// MARK: - Worth knowing

/// At most two short facts from the morning. Most days can have none, and then
/// this takes no space.
private struct TodayWorthKnowingSection: View {
    let facts: [WorthKnowingFact]

    var body: some View {
        let shown = Array(facts.prefix(TodayPage.worthKnowingLimit))
        if !shown.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                TodayLiveHead(title: "Worth knowing")
                ForEach(shown) { fact in
                    Text("\(Text(fact.title).fontWeight(.medium).foregroundStyle(.primary)) \(fact.line)")
                        .font(TodayType.detail)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .contain)
        }
    }
}
