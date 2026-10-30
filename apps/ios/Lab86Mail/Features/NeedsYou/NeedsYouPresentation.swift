import Foundation

// Needs you (docs/needs-you.md, phase 5): the pure parts of a row and a
// detail, so the words and the choices are testable without a view and the
// Mac layout prints the same ones.

/// What leads a row: initials for a person, a glyph in a circle for a
/// system (a bank, an airline, a pipeline, a meeting).
enum NeedsYouLead: Equatable, Sendable {
    case initials(name: String, seed: String)
    case glyph(String)
}

/// The first button of a detail, by kind.
enum NeedsYouPrimaryAction: Equatable, Sendable {
    case sendReply
    case copyCode
    case startInAlbatross
    case done

    var label: String {
        switch self {
        case .sendReply: "Send reply"
        case .copyCode: "Copy code"
        case .startInAlbatross: "Start in Albatross"
        case .done: "Done"
        }
    }
}

enum NeedsYouPresentation {
    /// The SF Symbol of one source, for the lead circle and the source line.
    static func sourceGlyph(_ source: ObligationSource) -> String {
        switch source {
        case .mail: "envelope"
        case .slack: "number"
        case .atlassian: "checkmark.square"
        case .granola: "mic"
        case .drive: "doc"
        case .github: "chevron.left.forwardslash.chevron.right"
        case .bitbucket: "arrow.triangle.branch"
        case .calendar: "calendar"
        case .other: "tray"
        }
    }

    /// A person asks for a reply, an action, or an answer; a system sends a
    /// code, a change, an invitation, or an event.
    static func lead(for obligation: ObligationView) -> NeedsYouLead {
        switch obligation.kind {
        case .code: return .glyph("key")
        case .change: return .glyph(sourceGlyph(obligation.source))
        case .rsvp, .prepare: return .glyph("calendar")
        case .reply, .action, .waiting, .unknown: break
        }
        switch obligation.source {
        case .mail, .slack, .github, .bitbucket, .other:
            return .initials(name: obligation.asker, seed: obligation.askerAddress ?? obligation.asker)
        case .atlassian, .granola, .drive, .calendar:
            return .glyph(sourceGlyph(obligation.source))
        }
    }

    /// "Mail · Northwind Legal", "Slack · #release", "GitHub".
    static func sourceLine(_ obligation: ObligationView) -> String {
        [obligation.source.label, obligation.sourceLabel].compactMap { $0?.nilIfBlank }.joined(separator: " · ")
    }

    /// The small line under the title: when, the kind word, "Draft ready".
    static func metaLine(_ obligation: ObligationView, now: ObligationMillis, timezone: String?) -> String {
        var parts = [
            NeedsYouLabels.whenLabel(obligation.createdAt, now: now, timezone: timezone),
            NeedsYouLabels.kindLabel(obligation),
        ]
        if obligation.kind == .code {
            parts = [
                NeedsYouLabels.whenLabel(obligation.createdAt, now: now, timezone: timezone),
                NeedsYouLabels.agoLabel(obligation.createdAt, now: now),
            ]
        } else if obligation.draftReady, !obligation.isClosed {
            parts.append("Draft ready")
        }
        return parts.joined(separator: " · ")
    }

    /// The source line of the detail: source, place, asker, kind, due.
    static func detailSourceLine(_ obligation: ObligationView, now: ObligationMillis, timezone: String?) -> String {
        [
            obligation.source.label,
            obligation.sourceLabel,
            obligation.asker,
            NeedsYouLabels.kindLabel(obligation),
            NeedsYouLabels.dueSentence(obligation, now: now, timezone: timezone).nilIfBlank,
        ]
        .compactMap { $0?.nilIfBlank }
        .joined(separator: " · ")
    }

    /// A mail reply is the only reply the app sends, with a prepared draft
    /// (`canSendReply`). A Slack, Jira, or GitHub reply opens in its own app.
    static func canSendReply(_ obligation: ObligationView) -> Bool {
        obligation.kind == .reply && obligation.source == .mail
    }

    /// The first button. An RSVP has its three answers instead; a closed
    /// item has none. A reply from another source starts in Albatross or
    /// closes with Done, as the web does.
    static func primaryAction(_ obligation: ObligationView) -> NeedsYouPrimaryAction? {
        if obligation.isClosed { return nil }
        if canSendReply(obligation) { return .sendReply }
        switch obligation.kind {
        case .code: return .copyCode
        case .rsvp: return nil
        case .reply, .action, .change, .prepare, .waiting, .unknown:
            return obligation.workID != nil ? .startInAlbatross : .done
        }
    }

    /// "Start in Albatross" as a quiet second choice: every open kind but a
    /// code, when it is not the first button already.
    static func showsStartInAlbatross(_ obligation: ObligationView) -> Bool {
        guard !obligation.isClosed, obligation.kind != .code else { return false }
        return primaryAction(obligation) != .startInAlbatross
    }

    /// Done beside the first button, for every open kind but a code (a code
    /// closes itself) and an RSVP (the answer closes it).
    static func showsDone(_ obligation: ObligationView) -> Bool {
        guard !obligation.isClosed else { return false }
        if obligation.kind == .code || obligation.kind == .rsvp { return false }
        return primaryAction(obligation) != .done
    }

    /// Later, for every open kind but a code.
    static func showsLater(_ obligation: ObligationView) -> Bool {
        !obligation.isClosed && obligation.kind != .code
    }

    /// "Open in Mail" for a mail thread, "Open in Slack" for a link.
    static func openInLabel(_ obligation: ObligationView) -> String? {
        if obligation.hasMailThread { return "Open in Mail" }
        if obligation.url != nil { return "Open in \(obligation.source.label)" }
        return nil
    }

    /// The head of the excerpt card: "From the mail", "From Slack".
    static func excerptHeading(_ obligation: ObligationView) -> String {
        obligation.source == .mail ? "From the mail" : "From \(obligation.source.label)"
    }

    /// The head of the draft card: "Draft reply · To Dana Whitfield".
    static func draftHeading(_ draft: ObligationDraft?, obligation: ObligationView, edited: Bool) -> String {
        let recipient = draft?.to.first?.nilIfBlank ?? obligation.asker
        return edited ? "Edited · To \(recipient)" : "Draft reply · To \(recipient)"
    }

    /// The closed line of a detail: "Replied · Yesterday 4:48 PM".
    static func closedLine(_ obligation: ObligationView, now: ObligationMillis, timezone: String?) -> String {
        let reason = NeedsYouLabels.closeReasonLabel(obligation.closeReason)
        guard let closedAt = obligation.closedAt else { return reason }
        return "\(reason) · \(NeedsYouLabels.whenLabel(closedAt, now: now, timezone: timezone))"
    }

    /// The Albatross questions and approvals the page lists beside the
    /// obligations, as the web page does.
    static func extras(
        questions: [PendingWorkQuestionSummary],
        approvals: [ApprovalSummary]
    ) -> [NeedsYouExtra] {
        let questionRows = questions.map { item in
            NeedsYouExtra(
                id: "question:\(item.id)",
                kind: .question,
                title: item.workTitle,
                line: item.question.prompt,
                workID: item.workID
            )
        }
        let approvalRows = approvals.map { item in
            NeedsYouExtra(id: "approval:\(item.id)", kind: .approval, title: item.title, line: item.detail)
        }
        return questionRows + approvalRows
    }

    /// The kind word of an Albatross row.
    static func extraKindLabel(_ extra: NeedsYouExtra) -> String {
        switch extra.kind {
        case .question: "Question"
        case .approval: "Approval"
        case .checkin: "Check-in"
        case .update: "Update"
        }
    }

    /// The spoken label of one row.
    static func accessibilityLabel(_ obligation: ObligationView, now: ObligationMillis, timezone: String?) -> String {
        var parts = [obligation.asker, sourceLine(obligation)]
        if obligation.kind == .code, let code = obligation.code {
            parts.append("Sign-in code \(NeedsYouLabels.spacedCode(code.value))")
        } else {
            parts.append(obligation.title)
        }
        let due = NeedsYouLabels.dueLabel(obligation, now: now, timezone: timezone)
        if !due.text.isEmpty { parts.append([due.text, due.sub].compactMap { $0 }.joined(separator: " ")) }
        return parts.filter { !$0.isEmpty }.joined(separator: ", ")
    }
}
