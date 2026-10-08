#if os(macOS)
import Foundation
import Testing
@testable import Lab86Mail

// Document mode of the Albatross thread on the Mac
// (docs/albatross-document-handoff.md, D5): the room the split needs, the
// column's width, the header title, the step line of the "Your part" card,
// and the View menu item. The shared rules (which editor a target names, the
// handoff a document belongs to) are in DocumentHandoffTests.
@MainActor
struct MacDocumentModeTests {
    // MARK: - Fixtures: hours for the Harbor Design studio

    private static func run(
        id: String,
        stepKey: String = "step-hours",
        stepTitle: String = "Make the hours summary",
        state: StepRunView.State = .handedOff,
        outcome: StepRunView.Outcome? = .readyForYou,
        artifacts: [StepRunView.Artifact] = []
    ) -> ThreadRunView {
        ThreadRunView(run: StepRunView(
            id: id,
            workID: "work_hours",
            stepKey: stepKey,
            stepTitle: stepTitle,
            state: state,
            outcome: outcome,
            artifacts: artifacts
        ))
    }

    private static let hoursSheet = StepRunView.Artifact(
        kind: .document,
        referenceID: "doc_hours",
        title: "September hours, Harbor Design",
        url: "/?view=files&office=doc_hours"
    )

    private static let target = DocumentTarget(provider: .office, id: "doc_hours")

    // MARK: - The room and the column

    @Test func theSplitNeedsTheDocumentAndTheColumn() {
        #expect(MacThreadLayout.documentMinimumWidth == 860)
        #expect(MacThreadLayout.documentRoom(windowWidth: 1_440, sidebarShown: true) == .pane)
        // The window holds the split only without the source list.
        #expect(MacThreadLayout.documentRoom(windowWidth: 1_000, sidebarShown: true) == .collapseSidebarFirst)
        #expect(MacThreadLayout.documentRoom(windowWidth: 1_000, sidebarShown: false) == .pane)
        // A narrow window shows the split squeezed as it is.
        #expect(MacThreadLayout.documentRoom(windowWidth: 800, sidebarShown: true) == .none)
        #expect(MacThreadLayout.documentRoom(windowWidth: 800, sidebarShown: false) == .none)
    }

    @Test func theColumnIsAboutAThirdWithinItsBand() {
        #expect(MacThreadLayout.documentColumnWidth(for: 860) == MacThreadLayout.documentColumnMinWidth)
        #expect(MacThreadLayout.documentColumnWidth(for: 1_100) == 396)
        #expect(MacThreadLayout.documentColumnWidth(for: 1_600) == MacThreadLayout.documentColumnIdealMax)
        #expect(MacThreadLayout.documentColumnMinWidth == 380)
        #expect(MacThreadLayout.documentColumnIdealMax == 440)
        #expect(MacThreadLayout.documentColumnIdealMax < MacThreadLayout.documentColumnMaxWidth)
    }

    // MARK: - The header title

    @Test func theTitleIsTheNewestArtifactThatNamesTheDocument() {
        let older = Self.run(id: "r1", state: .closed, artifacts: [
            StepRunView.Artifact(kind: .document, referenceID: "doc_hours", title: "Hours, first draft", url: nil),
        ])
        let newer = Self.run(id: "r2", artifacts: [Self.hoursSheet])
        let other = Self.run(id: "r3", artifacts: [
            StepRunView.Artifact(kind: .document, referenceID: "doc_else", title: "Invoice", url: nil),
        ])
        #expect(MacDocumentMode.title(runs: [older, newer, other], target: Self.target) == "September hours, Harbor Design")
        #expect(MacDocumentMode.title(runs: [older], target: Self.target) == "Hours, first draft")
        #expect(MacDocumentMode.title(runs: [other], target: Self.target) == "Document")
        #expect(MacDocumentMode.title(runs: [], target: Self.target) == "Document")
        // A draft artifact with the same id is not the document.
        let draft = Self.run(id: "r4", artifacts: [
            StepRunView.Artifact(kind: .draft, referenceID: "doc_hours", title: "A draft", url: nil),
        ])
        #expect(MacDocumentMode.title(runs: [draft], target: Self.target) == "Document")
    }

    // MARK: - The step line of the card

    @Test func theStepLineNamesThePlanPosition() {
        let detail = WorkDetail(json: .object([
            "work": .object(["_id": .string("work_hours"), "title": .string("Send monthly hours")]),
            "execution": .object([
                "guideSteps": .array([
                    .object(["key": .string("step-find"), "kind": .string("agent_does"), "title": .string("Find the rate"), "done": .bool(true)]),
                    .object(["key": .string("step-hours"), "kind": .string("agent_drafts"), "title": .string("Make the hours summary"), "done": .bool(false)]),
                ]),
            ]),
        ]))
        #expect(detail?.execution.guideSteps.count == 2)
        let handoff = Self.run(id: "r2")
        #expect(MacDocumentMode.stepLabel(detail: detail, run: handoff) == "Step 2 · Make the hours summary")
        // No plan position: the title alone.
        #expect(MacDocumentMode.stepLabel(detail: nil, run: handoff) == "Make the hours summary")
        let unknown = Self.run(id: "r5", stepKey: "step-else")
        #expect(MacDocumentMode.stepLabel(detail: detail, run: unknown) == "Make the hours summary")
        // No handoff: no line.
        #expect(MacDocumentMode.stepLabel(detail: detail, run: nil) == nil)
        let blank = Self.run(id: "r6", stepTitle: "  ")
        #expect(MacDocumentMode.stepLabel(detail: nil, run: blank) == nil)
        #expect(MacDocumentMode.stepLabel(detail: detail, run: blank) == "Step 2")
    }

    // MARK: - The View menu and the words

    @Test func closeDocumentWorksOnlyWithADocumentOpen() {
        #expect(MacThreadCommandState.closeDocument == "Close Document")
        #expect(MacThreadCommandState.closeDocumentEnabled(threadOpen: true, documentOpen: true))
        #expect(!MacThreadCommandState.closeDocumentEnabled(threadOpen: true, documentOpen: false))
        #expect(!MacThreadCommandState.closeDocumentEnabled(threadOpen: false, documentOpen: true))
    }

    @Test func theMenuRequestCountsUp() {
        let requests = MacRequests(defaults: UserDefaults(suiteName: "MacDocumentModeTests-\(UUID().uuidString)")!)
        #expect(requests.closeDocumentToken == 0)
        #expect(!requests.threadDocumentOpen)
        requests.requestCloseDocument()
        requests.requestCloseDocument()
        #expect(requests.closeDocumentToken == 2)
    }

    @Test func theCopyHasNoIngForms() {
        for word in [MacDocumentModeCopy.document, DocumentHandoffCopy.close, MacThreadCommandState.closeDocument] {
            #expect(!word.lowercased().contains("ing "), "\(word)")
            #expect(!word.hasSuffix("ing"), "\(word)")
        }
        #expect(DocumentHandoffCopy.close == "Close")
    }
}
#endif
