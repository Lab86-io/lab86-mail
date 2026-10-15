import Foundation
import Testing
@testable import Lab86Mail

// Document mode with several items (docs/albatross-goal-runs.md, G3): the
// set a package row opens, the lone item of an older run, which handoff an
// item belongs to, the selection, and the chat context. Sample data is
// invented: the Harbor Design invoice package.
@MainActor
struct DocumentModeItemsTests {
    // MARK: - Fixtures

    private static let draft = HandoffItem(
        kind: .draft, referenceID: "draft_7", accountID: "acct_1", title: "Draft to Priya Shah", state: .check, note: "2 files attached"
    )
    private static let invoice = HandoffItem(
        kind: .document, referenceID: "doc_inv", url: "/?view=files&office=doc_inv",
        title: "Invoice 2026-10 for Harbor Design", state: .blanks, blanks: ["hours for September", "hourly rate"]
    )
    private static let w9 = HandoffItem(
        kind: .file, referenceID: "file_w9", url: "/?view=files&file=file_w9",
        title: "Form W-9", state: .check, note: "The tax ID fills in when you send."
    )
    private static let portal = HandoffItem(kind: .page, url: "https://harbordesign.example/portal", title: "Client portal")

    private static let invoiceTarget = DocumentTarget(provider: .office, id: "doc_inv")

    private static func run(
        id: String,
        state: StepRunView.State = .handedOff,
        outcome: StepRunView.Outcome? = .readyForYou,
        goal: Bool = true,
        next: StepRunView.Next? = nil,
        items: [HandoffItem] = [],
        artifacts: [StepRunView.Artifact] = []
    ) -> ThreadRunView {
        ThreadRunView(run: StepRunView(
            id: id,
            workID: "work_invoice",
            stepKey: goal ? GoalRun.stepKey : "step-hours",
            stepTitle: goal ? "Bill Harbor Design for the quarter" : "Fill in the hours",
            state: state,
            outcome: outcome,
            next: next,
            artifacts: artifacts,
            goal: goal,
            items: items
        ))
    }

    private static let package = run(id: "r_package", items: [draft, invoice, w9, portal])

    // MARK: - The set

    @Test func aPackageRowOpensAllItsItemsWithTheRowSelected() {
        let set = DocumentModeItems.set(opening: .document(Self.invoiceTarget), title: nil, runs: [Self.package])
        #expect(set.runID == "r_package")
        // The page item is not a tab.
        #expect(set.items.map(\.kind) == [.draft, .document, .file])
        #expect(set.selected.title == "Invoice 2026-10 for Harbor Design")
        #expect(set.selected.blanks == ["hours for September", "hourly rate"])
        #expect(set.index == 1)
        #expect(set.count == 3)
        #expect(set.showsSwitcher)
        let file = DocumentModeItems.set(opening: .file(fileID: "file_w9"), title: nil, runs: [Self.package])
        #expect(file.selected.kind == .file)
        #expect(file.selected.isSealed)
        #expect(file.selected.fileID == "file_w9")
        let draft = DocumentModeItems.set(opening: .draft(id: "draft_7", accountID: "acct_1"), title: nil, runs: [Self.package])
        #expect(draft.selected.kind == .draft)
        #expect(!draft.selected.isSealed)
    }

    @Test func anOlderRunOpensOneItemWithTheHandoffBlanks() {
        let next = StepRunView.Next(
            kind: .reviewDocument, label: "Fill in hours", detail: "Fill in the hours.",
            target: StepRunView.Target(kind: .document, id: "doc_inv", url: "/?view=files&office=doc_inv"),
            blanks: ["hours"]
        )
        let sheet = StepRunView.Artifact(kind: .document, referenceID: "doc_inv", title: "September hours", url: "/?view=files&office=doc_inv")
        let older = Self.run(id: "r_old", goal: false, next: next, artifacts: [sheet])
        let set = DocumentModeItems.set(opening: .document(Self.invoiceTarget), title: nil, runs: [older])
        #expect(set.runID == "r_old")
        #expect(set.count == 1)
        #expect(!set.showsSwitcher)
        #expect(set.selected.blanks == ["hours"])
        #expect(set.selected.state == .blanks)
        // The title comes from the artifact that names the document.
        #expect(set.selected.title == "September hours")
    }

    @Test func noHandoffOpensTheItemAlone() {
        let set = DocumentModeItems.set(opening: .document(Self.invoiceTarget), title: "Invoice", runs: [])
        #expect(set.runID == nil)
        #expect(set.count == 1)
        #expect(set.selected.title == "Invoice")
        #expect(set.selected.kind == .document)
        let file = DocumentModeItems.set(opening: .file(fileID: "file_2"), title: nil, runs: [])
        #expect(file.selected.title == "File")
        #expect(file.selected.id == "file:file_2")
    }

    @Test func theSelectionMovesAndWraps() {
        var set = DocumentModeItems.set(opening: .document(Self.invoiceTarget), title: nil, runs: [Self.package])
        set.select(step: 1)
        #expect(set.selected.kind == .file)
        set.select(step: 1)
        #expect(set.selected.kind == .draft)
        set.select(step: -1)
        #expect(set.selected.kind == .file)
        set.select(id: "nope")
        #expect(set.selected.kind == .file)
        set.select(id: Self.draft.id)
        #expect(set.selected.kind == .draft)
        #expect(set.index == 0)
    }

    @Test func theChatContextFollowsADocumentAndIsNilOnAFileOrADraft() {
        let set = DocumentModeItems.set(opening: .document(Self.invoiceTarget), title: nil, runs: [Self.package])
        #expect(set.selected.documentAttachment == DocumentContextAttachment(id: "doc_inv", provider: .office))
        #expect(set.selected.workspaceDestination == NativeWorkspaceDestination.officeDocument("doc_inv"))
        var moved = set
        moved.select(step: 1)
        #expect(moved.selected.documentAttachment == nil)
        #expect(moved.selected.workspaceDestination == nil)
        moved.select(step: 1)
        #expect(moved.selected.documentAttachment == nil)
    }

    // MARK: - The handoff an item belongs to

    @Test func theHandoffOwnsItsItemsByIDAndByLink() {
        let closed = Self.run(id: "r_closed", state: .closed, items: [Self.invoice])
        let asked = Self.run(id: "r_asked", outcome: .needsAnswer, items: [Self.invoice])
        #expect(DocumentHandoff.run(for: [closed, asked, Self.package], content: .document(Self.invoiceTarget))?.id == "r_package")
        #expect(DocumentHandoff.run(for: [Self.package], content: .file(fileID: "file_w9"))?.id == "r_package")
        #expect(DocumentHandoff.run(for: [Self.package], content: .draft(id: "draft_7", accountID: nil))?.id == "r_package")
        #expect(DocumentHandoff.run(for: [Self.package], content: .file(fileID: "file_else")) == nil)
        #expect(DocumentHandoff.run(for: [closed, asked], content: .document(Self.invoiceTarget)) == nil)
    }

    @Test func aFileItemNamedByLinkAloneStillOpens() {
        let byLink = HandoffItem(kind: .file, url: "/?view=files&file=file_lease", title: "Lease")
        let run = Self.run(id: "r_lease", items: [byLink])
        let item = DocumentModeItems.item(from: byLink, artifacts: [])
        #expect(item?.fileID == "file_lease")
        #expect(DocumentHandoff.run(for: [run], content: .file(fileID: "file_lease"))?.id == "r_lease")
        #expect(DocumentModeItems.item(from: Self.portal, artifacts: []) == nil)
    }

    #if os(macOS)
    @Test func theMacTitleIsTheSelectedItemAndAGoalRunHasNoStepLine() {
        let set = DocumentModeItems.set(opening: .file(fileID: "file_w9"), title: nil, runs: [Self.package])
        #expect(MacDocumentMode.title(set: set) == "Form W-9")
        #expect(MacDocumentMode.stepLabel(detail: nil, run: Self.package) == nil)
        let step = Self.run(id: "r_step", goal: false)
        #expect(MacDocumentMode.stepLabel(detail: nil, run: step) == "Fill in the hours")
        #expect(MacDocumentModeLayout.listWidth(for: 1_400) == MacDocumentModeLayout.listIdealWidth)
        #expect(MacDocumentModeLayout.showsList(itemCount: 1, windowWidth: 1_400, sidebarShown: true) == false)
        #expect(MacDocumentModeLayout.showsList(itemCount: 3, windowWidth: 1_400, sidebarShown: true))
        #expect(MacDocumentModeLayout.showsList(itemCount: 3, windowWidth: 980, sidebarShown: false) == false)
    }
    #endif
}
