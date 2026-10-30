import Foundation
import Testing
@testable import Lab86Mail

// The pure parts of a Needs you row and detail: the lead, the lines, the
// first button, the quiet links, and the Albatross extras. Invented people
// only.
struct NeedsYouPresentationTests {
    private static let now: ObligationMillis = 1_793_210_700_000
    private static let tz = "America/Los_Angeles"

    private func item(
        kind: ObligationKind = .reply,
        state: ObligationState = .open,
        source: ObligationSource = .mail,
        sourceLabel: String? = nil,
        url: URL? = nil,
        accountID: String? = "acct_1",
        threadID: String? = "thread_1",
        asker: String = "Dana Whitfield",
        askerAddress: String? = "dana@northwindlegal.example.com",
        workID: String? = nil,
        workTitle: String? = nil,
        code: ObligationCode? = nil,
        draftReady: Bool = false,
        createdAt: ObligationMillis = NeedsYouPresentationTests.now - 120_000,
        closedAt: ObligationMillis? = nil,
        closeReason: ObligationCloseReason? = nil
    ) -> ObligationView {
        ObligationView(
            id: "ob",
            kind: kind,
            state: state,
            source: source,
            sourceKey: "key",
            sourceLabel: sourceLabel,
            url: url,
            accountID: accountID,
            threadID: threadID,
            title: "Asks you to confirm the start date.",
            asker: asker,
            askerAddress: askerAddress,
            workID: workID,
            workTitle: workTitle,
            code: code,
            draftReady: draftReady,
            createdAt: createdAt,
            closedAt: closedAt,
            closeReason: closeReason
        )
    }

    @Test func theLeadIsInitialsForAPersonAndAGlyphForASystem() {
        #expect(NeedsYouPresentation.lead(for: item()) == .initials(name: "Dana Whitfield", seed: "dana@northwindlegal.example.com"))
        #expect(NeedsYouPresentation.lead(for: item(source: .slack, askerAddress: nil)) == .initials(name: "Dana Whitfield", seed: "Dana Whitfield"))
        #expect(NeedsYouPresentation.lead(for: item(kind: .code, code: ObligationCode(value: "482913"))) == .glyph("key"))
        #expect(NeedsYouPresentation.lead(for: item(kind: .change)) == .glyph("envelope"))
        #expect(NeedsYouPresentation.lead(for: item(kind: .rsvp, source: .calendar)) == .glyph("calendar"))
        #expect(NeedsYouPresentation.lead(for: item(kind: .action, source: .atlassian)) == .glyph("checkmark.square"))
        #expect(NeedsYouPresentation.lead(for: item(kind: .action, source: .granola)) == .glyph("mic"))
        #expect(NeedsYouPresentation.sourceGlyph(.other("pigeon")) == "tray")
    }

    @Test func theLinesOfARow() {
        #expect(NeedsYouPresentation.sourceLine(item()) == "Mail")
        #expect(NeedsYouPresentation.sourceLine(item(source: .slack, sourceLabel: "#release")) == "Slack · #release")
        #expect(NeedsYouPresentation.metaLine(item(), now: Self.now, timezone: Self.tz) == "11:03 AM · Reply")
        #expect(NeedsYouPresentation.metaLine(item(draftReady: true), now: Self.now, timezone: Self.tz) == "11:03 AM · Reply · Draft ready")
        #expect(NeedsYouPresentation.metaLine(item(kind: .code, code: ObligationCode(value: "482913")), now: Self.now, timezone: Self.tz)
            == "11:03 AM · 2 min ago")
        #expect(NeedsYouPresentation.metaLine(item(state: .done, draftReady: true), now: Self.now, timezone: Self.tz) == "11:03 AM · Reply")
        #expect(NeedsYouPresentation.detailSourceLine(item(sourceLabel: "Northwind Legal"), now: Self.now, timezone: Self.tz)
            == "Mail · Northwind Legal · Dana Whitfield · Reply")
        #expect(NeedsYouPresentation.accessibilityLabel(item(), now: Self.now, timezone: Self.tz)
            == "Dana Whitfield, Mail, Asks you to confirm the start date.")
        #expect(NeedsYouPresentation.accessibilityLabel(
            item(kind: .code, code: ObligationCode(value: "482913", expiresAt: Self.now + 480_000)),
            now: Self.now,
            timezone: Self.tz
        ) == "Dana Whitfield, Mail, Sign-in code 482 913, 8 min expires")
    }

    @Test func theFirstButtonByKind() {
        #expect(NeedsYouPresentation.primaryAction(item()) == .sendReply)
        #expect(NeedsYouPresentation.primaryAction(item(kind: .code)) == .copyCode)
        #expect(NeedsYouPresentation.primaryAction(item(kind: .rsvp)) == nil)
        #expect(NeedsYouPresentation.primaryAction(item(kind: .action)) == .done)
        #expect(NeedsYouPresentation.primaryAction(item(kind: .action, workID: "work_1")) == .startInAlbatross)
        #expect(NeedsYouPresentation.primaryAction(item(kind: .change)) == .done)
        #expect(NeedsYouPresentation.primaryAction(item(kind: .waiting)) == .done)
        #expect(NeedsYouPresentation.primaryAction(item(state: .done, closeReason: .userDone)) == nil)
        #expect(NeedsYouPrimaryAction.sendReply.label == "Send reply")
        #expect(NeedsYouPrimaryAction.copyCode.label == "Copy code")
        #expect(NeedsYouPrimaryAction.startInAlbatross.label == "Start in Albatross")
    }

    @Test func theOtherButtonsAndTheQuietLinks() {
        #expect(NeedsYouPresentation.showsDone(item()))
        #expect(!NeedsYouPresentation.showsDone(item(kind: .action)))
        #expect(NeedsYouPresentation.showsDone(item(kind: .action, workID: "work_1")))
        #expect(!NeedsYouPresentation.showsDone(item(kind: .code)))
        #expect(!NeedsYouPresentation.showsDone(item(kind: .rsvp)))
        #expect(NeedsYouPresentation.showsLater(item()))
        #expect(!NeedsYouPresentation.showsLater(item(kind: .code)))
        #expect(!NeedsYouPresentation.showsLater(item(state: .dismissed)))
        #expect(NeedsYouPresentation.showsStartInAlbatross(item()))
        #expect(!NeedsYouPresentation.showsStartInAlbatross(item(kind: .code)))
        #expect(!NeedsYouPresentation.showsStartInAlbatross(item(kind: .action, workID: "work_1")))
        #expect(!NeedsYouPresentation.showsStartInAlbatross(item(state: .done)))
        #expect(NeedsYouPresentation.openInLabel(item()) == "Open in Mail")
        let link = URL(string: "https://northwind.slack.example.com/archives/C1/p2")
        #expect(NeedsYouPresentation.openInLabel(item(source: .slack, url: link, accountID: nil, threadID: nil)) == "Open in Slack")
        #expect(NeedsYouPresentation.openInLabel(item(source: .granola, accountID: nil, threadID: nil)) == nil)
        #expect(NeedsYouPresentation.excerptHeading(item()) == "From the mail")
        #expect(NeedsYouPresentation.excerptHeading(item(source: .github)) == "From GitHub")
    }

    @Test func theDraftHeadAndTheClosedLine() {
        let draft = ObligationDraft(to: ["dana@northwindlegal.example.com"], subject: "Re: SOW", body: "Hi Dana,")
        #expect(NeedsYouPresentation.draftHeading(draft, obligation: item(), edited: false) == "Draft reply · To dana@northwindlegal.example.com")
        #expect(NeedsYouPresentation.draftHeading(nil, obligation: item(), edited: false) == "Draft reply · To Dana Whitfield")
        #expect(NeedsYouPresentation.draftHeading(draft, obligation: item(), edited: true) == "Edited · To dana@northwindlegal.example.com")
        #expect(NeedsYouPresentation.closedLine(
            item(state: .done, closedAt: Self.now - 3_600_000, closeReason: .sentReply),
            now: Self.now,
            timezone: Self.tz
        ) == "Replied · 10:05 AM")
        #expect(NeedsYouPresentation.closedLine(item(state: .expired, closeReason: .expired), now: Self.now, timezone: Self.tz) == "Expired")
    }

    @Test func theAlbatrossExtrasComeFromTheQuestionsAndApprovals() throws {
        let question = try #require(PendingWorkQuestionSummary(json: .object([
            "question": .object(["_id": .string("q1"), "prompt": .string("Which quarter numbers should the deck use?")]),
            "work": .object(["_id": .string("work_1"), "title": .string("Q3 review deck")]),
        ])))
        let approval = try #require(ApprovalSummary(json: .object([
            "_id": .string("ap1"),
            "title": .string("Send the invoice"),
            "summary": .string("Albatross wants to send invoice 2211."),
        ])))
        let extras = NeedsYouPresentation.extras(questions: [question], approvals: [approval])
        #expect(extras.map(\.id) == ["question:q1", "approval:ap1"])
        #expect(extras[0].kind == .question)
        #expect(extras[0].title == "Q3 review deck")
        #expect(extras[0].line == "Which quarter numbers should the deck use?")
        #expect(extras[0].workID == "work_1")
        #expect(extras[1].kind == .approval)
        #expect(extras[1].title == "Send the invoice")
        #expect(extras[1].workID == nil)
        #expect(NeedsYouPresentation.extraKindLabel(extras[0]) == "Question")
        #expect(NeedsYouPresentation.extraKindLabel(extras[1]) == "Approval")
        let groups = NeedsYouGrouping.groups(items: [], extras: extras, now: Self.now, timezone: Self.tz)
        #expect(groups.map(\.id) == [.now])
        #expect(groups[0].entries.map(\.id) == ["approval:ap1", "question:q1"])
    }
}
