import Foundation
import MobileAPI
import Testing
@testable import Lab86Mail

// NAT-1, NAT-7, BRF-11 (audit 2026-09-26): editorial editions decode their
// `tool_ui` and `live_section` nodes, the owner does not mount a live section
// twice, dismiss calls omit missing keys, and history asks for summaries.
struct BriefEditorialTests {
    private static let editorialJSON = """
    {
      "version": 2,
      "title": "Friday",
      "summary": "A quiet day.",
      "generatedAt": 1790000000000,
      "layout": "editorial",
      "regions": [
        {
          "id": "editorial-lede",
          "summary": "The lede.",
          "tree": {
            "kind": "stack",
            "children": [
              {
                "kind": "tool_ui",
                "id": "lede-text",
                "component": "editorial-text",
                "props": { "id": "lede-text", "title": "One thing today", "text": "Reply to **Sam**.", "role": "lede" },
                "summary": "Reply to Sam today.",
                "sources": [
                  {
                    "ref": { "kind": "thread", "id": "t1", "account": "a1", "label": "Lake plans" },
                    "actions": [
                      { "action": "resolve_thread", "label": "Done", "payload": { "account": "a1", "threadId": "t1" } },
                      { "action": "open_thread", "label": "Open", "payload": { "account": "a1", "threadId": "t1" } }
                    ]
                  },
                  { "ref": { "kind": "bogus-kind-with-no-id" } }
                ]
              },
              {
                "kind": "tool_ui",
                "id": "pick",
                "component": "option-list",
                "props": { "id": "pick", "options": [{ "id": "a", "label": "A" }] },
                "summary": "Pick a venue.",
                "sources": []
              },
              { "kind": "live_section", "section": "narrative", "at": 1790000000000 }
            ]
          }
        },
        {
          "id": "prepared-work",
          "summary": "Prepared for you",
          "tree": { "kind": "live_section", "section": "prepared_work", "at": 1790000000000 }
        }
      ]
    }
    """

    private func document() throws -> BriefDocumentV2 {
        try #require(BriefDocumentV2.decode(Data(Self.editorialJSON.utf8)))
    }

    @Test
    func decodesToolUIAndLiveSectionNodes() throws {
        let document = try document()
        #expect(document.isEditorial)
        let stack = document.regions[0].tree
        #expect(stack.kind == "stack")
        let text = try #require(stack.children?.first)
        #expect(text.kind == "tool_ui")
        #expect(text.component == "editorial-text")
        #expect(text.summary == "Reply to Sam today.")
        #expect(text.props?["title"]?.stringValue == "One thing today")
        // The malformed row is dropped; the good one keeps both actions.
        #expect(text.toolSources?.count == 1)
        #expect(text.toolSources?.first?.ref.key == "thread:a1:t1")
        #expect(text.toolSources?.first?.actions.map(\.action) == ["resolve_thread", "open_thread"])
        let live = try #require(stack.children?.last)
        #expect(live.kind == "live_section")
        #expect(live.section == "narrative")
        #expect(live.at == 1_790_000_000_000)
        #expect(document.regions[1].tree.section == "prepared_work")
    }

    @Test
    func normalizationKeepsToolNodesInsteadOfSummaryPlaceholders() throws {
        let document = try document()
        let kinds = document.regions[0].tree.children?.map(\.kind)
        #expect(kinds == ["tool_ui", "tool_ui", "live_section"])
        #expect(document.regions[1].tree.kind == "live_section")
    }

    @Test
    func toolNodesRoundTripThroughTheCache() throws {
        let document = try document()
        let data = try JSONEncoder().encode(document)
        let decoded = try #require(BriefDocumentV2.decode(data))
        #expect(decoded == document)
    }

    @Test
    func editorialTextReadsItsPropsAndShowsItsSourceRows() throws {
        let node = try #require(try document().regions[0].tree.children?.first)
        let presentation = BriefToolUIPresentation(node: node, hiddenRefs: [])
        #expect(presentation.heading == "One thing today")
        #expect(presentation.body == "Reply to **Sam**.")
        #expect(presentation.role == "lede")
        #expect(!presentation.needsWeb)
        #expect(presentation.sources.count == 1)
        #expect(presentation.sourcesStartExpanded)
        #expect(presentation.sourcesTitle == "Source and actions")
        // A resolved row leaves the list.
        let hidden = BriefToolUIPresentation(node: node, hiddenRefs: ["thread:a1:t1"])
        #expect(hidden.sources.isEmpty)
    }

    @Test
    func interactiveComponentLinksToTheWebInsteadOfADeadSummary() throws {
        let node = try #require(try document().regions[0].tree.children?[1])
        let presentation = BriefToolUIPresentation(node: node, hiddenRefs: [])
        #expect(presentation.isInteractive)
        #expect(presentation.needsWeb)
        #expect(presentation.heading == "Pick a venue.")
    }

    @Test
    func openOnlySourcesStartCollapsed() {
        let node = BriefNode(
            kind: "tool_ui",
            component: "stats-display",
            props: [:],
            summary: "Numbers",
            toolSources: [
                BriefToolSource(
                    ref: BriefSourceRef(kind: "thread", id: "t2", account: "a1"),
                    actions: [BriefDocumentAction(action: "open_thread", label: "Open", payload: [:])]
                ),
                BriefToolSource(
                    ref: BriefSourceRef(kind: "thread", id: "t3", account: "a1"),
                    actions: []
                ),
            ]
        )
        let presentation = BriefToolUIPresentation(node: node, hiddenRefs: [])
        #expect(!presentation.sourcesStartExpanded)
        #expect(presentation.sourcesTitle == "2 sources and actions")
    }

    @Test
    func ownerDoesNotMountLiveSectionsTheDocumentPlaces() throws {
        let editorial = try document()
        #expect(editorial.hasLiveSection("narrative"))
        #expect(editorial.hasLiveSection("prepared_work"))
        #expect(!BriefOwnerMounts.mountsNarrative(editorial))
        #expect(!BriefOwnerMounts.mountsLede(editorial, narrativeLoaded: false))
        #expect(!BriefOwnerMounts.mountsPreparedWork(editorial, hasArtifact: true, showsLatest: true))

        let letter = BriefDocumentV2(
            version: 2,
            title: "Brief",
            summary: "Summary",
            generatedAt: 1,
            regions: [BriefRegion(id: "lede", intent: nil, summary: "S", tree: BriefNode(kind: "text", text: "Hi"))]
        )
        #expect(BriefOwnerMounts.mountsNarrative(letter))
        #expect(BriefOwnerMounts.mountsNarrative(nil))
        #expect(BriefOwnerMounts.mountsLede(letter, narrativeLoaded: false))
        #expect(!BriefOwnerMounts.mountsLede(letter, narrativeLoaded: true))
        #expect(BriefOwnerMounts.mountsPreparedWork(letter, hasArtifact: true, showsLatest: true))
        #expect(!BriefOwnerMounts.mountsPreparedWork(letter, hasArtifact: true, showsLatest: false))
    }

    @Test @MainActor
    func liveSectionsRenderOnlyForTheLatestEdition() {
        let narrative = NarrativeBriefStore()
        let backend = BackendClient(baseURL: nil)
        #expect(BriefOwnerMounts.liveSections(showsLatest: true, narrative: narrative, backend: backend) != nil)
        #expect(BriefOwnerMounts.liveSections(showsLatest: false, narrative: narrative, backend: backend) == nil)
    }

    @Test
    func webLinkOpensTheEditionOrToday() {
        let base = URL(string: "https://mail.lab86.io")
        #expect(
            BriefRenderContext.webURL(base: base, reportID: "r1")?.absoluteString
                == "https://mail.lab86.io/brief?id=r1"
        )
        #expect(
            BriefRenderContext.webURL(base: base, reportID: nil)?.absoluteString
                == "https://mail.lab86.io/?view=today"
        )
        #expect(BriefRenderContext.webURL(base: nil, reportID: "r1") == nil)
    }

    @Test
    func dismissArgumentsLeaveOutMissingValuesInsteadOfNull() {
        let task = BriefToolArguments.dismissTask(cardID: "c1", title: nil)
        #expect(task == ["cardId": .string("c1")])
        #expect(BriefToolArguments.dismissTask(cardID: "c1", title: "Pay rent")["title"] == .string("Pay rent"))

        let thread = BriefToolArguments.dismissThread(
            account: "a1", threadID: "t1", subject: nil, receivedAt: nil, resolved: true
        )
        #expect(thread == [
            "account": .string("a1"),
            "threadId": .string("t1"),
            "action": .string("resolved"),
        ])
        let full = BriefToolArguments.dismissThread(
            account: "a1", threadID: "t1", subject: "Hi", receivedAt: 5, resolved: false
        )
        #expect(full["subject"] == .string("Hi"))
        #expect(full["receivedAt"] == .number(5))
        #expect(full["action"] == .string("dismissed"))
    }

    @Test @MainActor
    func historyAsksForSummariesOnly() async {
        let tools = RecordingTools { name, _ in
            name == "list_daily_reports"
                ? .object(["reports": .array([
                    .object(["_id": .string("r1"), "title": .string("Brief"), "generatedAt": .number(1_790_000_000_000)]),
                ])])
                : .object([:])
        }
        let store = ProductStore(tools: tools, backend: BackendClient(baseURL: nil))
        await store.loadDailyReportHistory()
        let arguments = await tools.arguments(of: "list_daily_reports")
        #expect(arguments.first?["summaryOnly"] == .bool(true))
        #expect(store.dailyReportHistory.map(\.id) == ["r1"])
    }
}
