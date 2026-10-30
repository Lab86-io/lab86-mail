import SwiftUI

// Needs you (docs/needs-you.md, phase 5): the detail of one item. One shape
// for every kind: the source line, the obligation as one sentence in the
// display face, "Why this needs you" with a rule in the second accent, the
// source excerpt, the prepared draft or the code, the Albatross card, and
// the action row at the foot. The first button names the prepared step;
// Done, Later, and Not mine follow it. One quiet line says what the action
// does. The item is read live from the store, so an action here changes the
// row in the list behind it.

struct ObligationDetailView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss
    let id: String

    @State private var draft: ObligationDraft?
    @State private var draftText = ""
    @State private var draftRequested = false
    @State private var copied = false
    @State private var clock: Date = .now

    private var store: NeedsYouStore { environment.needsYou }
    private var nowMillis: ObligationMillis { NeedsYouClock.millis(clock) }
    private var timezone: String? { store.timezone }

    private var obligation: ObligationView? {
        store.settledItems(now: clock).first { $0.id == id }
    }

    var body: some View {
        Group {
            if let obligation {
                ObligationDetailBody(
                    obligation: obligation,
                    draft: draft,
                    draftText: $draftText,
                    copied: copied,
                    clock: clock,
                    onOpenSource: { openSource(obligation) },
                    onOpenWork: { openWork(obligation) }
                )
                .safeAreaInset(edge: .bottom) {
                    ObligationActionBar(
                        obligation: obligation,
                        busy: store.busyID == obligation.id,
                        copied: copied,
                        onPrimary: { Task { await runPrimary(obligation) } },
                        onDone: { Task { await act(.done, on: obligation) } },
                        onLater: { until in Task { await act(.later(until: until), on: obligation) } },
                        onNotMine: { Task { await act(.notMine, on: obligation) } },
                        onRSVP: { answer in Task { await act(.rsvp(answer), on: obligation) } },
                        onStartInAlbatross: { Task { await startInAlbatross(obligation) } },
                        onOpenSource: { openSource(obligation) },
                        onUndo: undoAction(for: obligation)
                    )
                }
                .task(id: obligation.draftReady) { await loadDraft(obligation) }
            } else {
                ContentUnavailableView {
                    Text("This item is no longer on your list")
                } description: {
                    Text("It closed, or it was handled somewhere else.")
                }
            }
        }
        .navigationTitle("")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task { await tick() }
    }

    // MARK: - Actions

    private func runPrimary(_ obligation: ObligationView) async {
        switch NeedsYouPresentation.primaryAction(obligation) {
        case .sendReply:
            if await store.sendReply(id: obligation.id, body: draftText, transport: environment.backend) {
                dismiss()
            }
        case .copyCode:
            guard let code = obligation.code else { return }
            PlatformPasteboard.copy(code.value)
            PlatformAccessibility.announce("Copied")
            copied = true
            try? await Task.sleep(for: .seconds(2))
            copied = false
        case .startInAlbatross:
            await startInAlbatross(obligation)
        case .done:
            await act(.done, on: obligation)
        case nil:
            break
        }
    }

    private func act(_ action: ObligationAction, on obligation: ObligationView) async {
        if await store.act(action, on: obligation.id, transport: environment.backend) {
            dismiss()
        }
    }

    /// Undo, while the window of this item is open.
    private func undoAction(for obligation: ObligationView) -> (() -> Void)? {
        guard store.undo?.obligationID == obligation.id else { return nil }
        let store = store
        let transport = environment.backend
        return { Task { await store.undoLast(transport: transport) } }
    }

    private func startInAlbatross(_ obligation: ObligationView) async {
        guard let result = await store.startAlbatross(id: obligation.id, transport: environment.backend) else { return }
        environment.navigation.openWork(id: result.workID, title: obligation.workTitle)
    }

    private func openSource(_ obligation: ObligationView) {
        if let accountID = obligation.accountID, let threadID = obligation.threadID {
            environment.navigation.openThread(accountID: accountID, threadID: threadID)
        } else if let url = obligation.url {
            openURL(url)
        }
    }

    private func openWork(_ obligation: ObligationView) {
        guard let workID = obligation.workID else { return }
        environment.navigation.openWork(id: workID, title: obligation.workTitle)
    }

    private func loadDraft(_ obligation: ObligationView) async {
        guard obligation.kind == .reply, obligation.draftReady, !obligation.isClosed, !draftRequested else { return }
        draftRequested = true
        guard let prepared = await store.prepareDraft(id: obligation.id, transport: environment.backend) else { return }
        draft = prepared
        if draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            draftText = prepared.body
        }
    }

    private func tick() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled else { return }
            clock = .now
        }
    }
}

// MARK: - The body

private struct ObligationDetailBody: View {
    @Environment(AppEnvironment.self) private var environment
    let obligation: ObligationView
    let draft: ObligationDraft?
    @Binding var draftText: String
    let copied: Bool
    let clock: Date
    let onOpenSource: () -> Void
    let onOpenWork: () -> Void

    private var nowMillis: ObligationMillis { NeedsYouClock.millis(clock) }
    private var timezone: String? { environment.needsYou.timezone }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                sourceLine
                sentence
                if obligation.kind == .code, let code = obligation.code {
                    ObligationCodeBlock(obligation: obligation, code: code, now: nowMillis)
                }
                if let why = obligation.why { whyBlock(why) }
                if obligation.excerpt != nil || obligation.askerAddress != nil {
                    ObligationExcerptCard(obligation: obligation, onOpen: onOpenSource)
                }
                if obligation.kind == .reply, !obligation.isClosed {
                    ObligationDraftCard(obligation: obligation, draft: draft, text: $draftText)
                }
                if obligation.workTitle != nil || obligation.workID != nil {
                    ObligationAlbatrossCard(obligation: obligation, onOpen: onOpenWork)
                }
                if obligation.isClosed {
                    Text(NeedsYouPresentation.closedLine(obligation, now: nowMillis, timezone: timezone))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 12)
            .frame(maxWidth: 680, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        #if os(iOS)
        .scrollDismissesKeyboard(.interactively)
        #endif
    }

    private var sourceLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(NeedsYouPresentation.detailSourceLine(obligation, now: nowMillis, timezone: timezone))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Text(NeedsYouLabels.whenLabel(obligation.createdAt, now: nowMillis, timezone: timezone))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .fixedSize()
        }
    }

    private var sentence: some View {
        Text(NeedsYouLabels.sentence(obligation))
            .font(environment.theme.displayType.displayFont(size: 22, weight: .regular))
            .lineSpacing(3)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .accessibilityAddTraits(.isHeader)
    }

    private func whyBlock(_ why: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Rectangle()
                .fill(environment.theme.accent2Color)
                .frame(width: 2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text("Why this needs you")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(environment.theme.accent2Color)
                Text(why)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - The code

/// The code in 44 pt tabular digits, a small ring that empties with the
/// time, the time left, and where else the code is.
private struct ObligationCodeBlock: View {
    @Environment(AppEnvironment.self) private var environment
    let obligation: ObligationView
    let code: ObligationCode
    let now: ObligationMillis

    private var fraction: Double {
        NeedsYouLabels.expiryFraction(createdAt: obligation.createdAt, code: code, now: now)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(NeedsYouLabels.spacedCode(code.value))
                .font(.system(size: 44, weight: .medium).monospacedDigit())
                .kerning(2)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .textSelection(.enabled)
                .accessibilityLabel("Code \(code.value.map { String($0) }.joined(separator: " "))")
            HStack(spacing: 8) {
                if let expiresAt = code.expiresAt {
                    ring
                    Text(expiryText(expiresAt))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if !obligation.isClosed {
                    Text("Also in AutoFill on this device.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func expiryText(_ expiresAt: ObligationMillis) -> String {
        let left = NeedsYouLabels.expiryLabel(expiresAt: expiresAt, now: now)
        return left == "Expired" ? "Expired." : "Expires in \(left)."
    }

    private var ring: some View {
        ZStack {
            Circle()
                .stroke(environment.theme.hairlineColor, lineWidth: 2)
            Circle()
                .trim(from: 0, to: fraction)
                .stroke(environment.theme.accent2Color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 14, height: 14)
        .accessibilityHidden(true)
    }
}

// MARK: - The excerpt

/// "From the mail", the address, "Open in Mail", and the excerpt.
private struct ObligationExcerptCard: View {
    let obligation: ObligationView
    let onOpen: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(NeedsYouPresentation.excerptHeading(obligation))
                    .font(.caption.weight(.semibold))
                if let address = obligation.askerAddress {
                    Text(address)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                if let label = NeedsYouPresentation.openInLabel(obligation) {
                    Button(label, action: onOpen)
                        .buttonStyle(.plain)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.tint)
                        .fixedSize()
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            if let excerpt = obligation.excerpt {
                Divider()
                Text(excerpt)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
            }
        }
        .insetPanel(cornerRadius: 14)
    }
}

// MARK: - The draft

/// The prepared reply in an accent-bordered card. The text is a field from
/// the start; the head says "Edited" once the words change.
private struct ObligationDraftCard: View {
    @Environment(AppEnvironment.self) private var environment
    let obligation: ObligationView
    let draft: ObligationDraft?
    @Binding var text: String

    private var edited: Bool { draft != nil && text != draft?.body }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(NeedsYouPresentation.draftHeading(draft, obligation: obligation, edited: edited))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(environment.theme.accentColor)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if draft == nil, obligation.draftReady {
                    ProgressView()
                        .controlSize(.small)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            Divider()
            ZStack(alignment: .topLeading) {
                if text.isEmpty {
                    Text(obligation.draftReady ? "Preparing the reply" : "Write a reply")
                        .font(.body)
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .accessibilityHidden(true)
                }
                TextEditor(text: $text)
                    .font(.body)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 120)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .accessibilityLabel("Reply")
            }
        }
        .background(environment.theme.elevatedColor, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(environment.theme.accentColor.opacity(0.55), lineWidth: 1)
        }
    }
}

// MARK: - The Albatross

/// The Albatross the item belongs to: a status dot, the title, "Open thread".
private struct ObligationAlbatrossCard: View {
    @Environment(AppEnvironment.self) private var environment
    let obligation: ObligationView
    let onOpen: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Circle()
                .fill(environment.theme.accentColor)
                .frame(width: 7, height: 7)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(obligation.workTitle ?? "Albatross")
                    .font(environment.theme.displayType.displayFont(size: 15))
                    .lineLimit(2)
                Text("Belongs to this Albatross")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if obligation.workID != nil {
                Button("Open thread", action: onOpen)
                    .buttonStyle(.plain)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.tint)
                    .fixedSize()
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .insetPanel(cornerRadius: 14)
    }
}

// MARK: - The actions

/// The action row: the first button, then Done, Later, Not mine; a quiet
/// row of links; and one line that says what the action does. At large text
/// sizes the buttons stack.
private struct ObligationActionBar: View {
    @Environment(AppEnvironment.self) private var environment
    let obligation: ObligationView
    let busy: Bool
    let copied: Bool
    let onPrimary: () -> Void
    let onDone: () -> Void
    let onLater: (ObligationMillis) -> Void
    let onNotMine: () -> Void
    let onRSVP: (ObligationAction.RSVPResponse) -> Void
    let onStartInAlbatross: () -> Void
    let onOpenSource: () -> Void
    let onUndo: (() -> Void)?

    private var primary: NeedsYouPrimaryAction? { NeedsYouPresentation.primaryAction(obligation) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if obligation.isClosed {
                closedRow
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 18) { buttons }
                    VStack(alignment: .leading, spacing: 12) { buttons }
                }
                quietLinks
                Text(NeedsYouLabels.actionNote(kind: obligation.kind))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal)
        .padding(.top, 12)
        .padding(.bottom, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
        .disabled(busy)
    }

    @ViewBuilder private var buttons: some View {
        if obligation.kind == .rsvp {
            ForEach(ObligationAction.RSVPResponse.allCases, id: \.self) { answer in
                Button(answer.label) { onRSVP(answer) }
                    .buttonStyle(.bordered)
                    .tint(environment.theme.accentColor)
            }
        } else if let primary {
            Button(copied && primary == .copyCode ? "Copied" : primary.label, action: onPrimary)
                .buttonStyle(.borderedProminent)
                .tint(environment.theme.accentColor)
        }
        if NeedsYouPresentation.showsDone(obligation) {
            Button("Done", action: onDone)
                .buttonStyle(.plain)
                .foregroundStyle(.tint)
        }
        if NeedsYouPresentation.showsLater(obligation) {
            laterMenu
        }
        Button("Not mine", action: onNotMine)
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
    }

    private var laterMenu: some View {
        Menu("Later") {
            ForEach(NeedsYouGrouping.laterOptions(now: NeedsYouClock.millis(.now), timezone: environment.needsYou.timezone)) { option in
                Button(option.label) { onLater(option.until) }
            }
        }
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .foregroundStyle(.tint)
        .fixedSize()
    }

    @ViewBuilder private var quietLinks: some View {
        let showsAlbatross = NeedsYouPresentation.showsStartInAlbatross(obligation)
        let openLabel = NeedsYouPresentation.openInLabel(obligation)
        if showsAlbatross || openLabel != nil {
            HStack(spacing: 18) {
                if showsAlbatross {
                    Button("Start in Albatross", action: onStartInAlbatross)
                        .buttonStyle(.plain)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.tint)
                }
                if let openLabel {
                    Button(openLabel, action: onOpenSource)
                        .buttonStyle(.plain)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var closedRow: some View {
        HStack(spacing: 18) {
            Text(NeedsYouLabels.closeReasonLabel(obligation.closeReason))
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if let onUndo {
                Button("Undo", action: onUndo)
                    .buttonStyle(.bordered)
                    .tint(environment.theme.accentColor)
            }
            Spacer(minLength: 0)
            if let openLabel = NeedsYouPresentation.openInLabel(obligation) {
                Button(openLabel, action: onOpenSource)
                    .buttonStyle(.plain)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
    }
}
