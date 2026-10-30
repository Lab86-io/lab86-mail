import Foundation
import MobileAPI
import Testing
@testable import Lab86Mail

// The brief's Needs you lane (phase 3, I3): the region classifies as the
// lane in the place of Answer, keeps the Answer row shape, and carries the
// closing line. Invented people only.
struct BriefNeedsYouLaneTests {
    private func threadItem(id: String, subject: String, sender: String, reason: String) -> String {
        """
        {
          "ref": { "kind": "thread", "id": "\(id)", "account": "acct-1", "label": "\(subject)" },
          "framing": { "lane": "needs-you", "reason": "\(reason)", "sender": "\(sender)" },
          "actions": [
            { "action": "open_thread", "label": "Open", "payload": { "account": "acct-1", "threadId": "\(id)" }, "style": "quiet" }
          ]
        }
        """
    }

    private let ledeRegion = """
    {
      "id": "lede",
      "summary": "Two things need you before the day gets going.",
      "tree": {
        "kind": "hero",
        "emphasis": "primary",
        "tone": "neutral",
        "surface": "plain",
        "children": [
          { "kind": "text", "emphasis": "primary", "tone": "neutral", "role": "lede", "text": "Two things need you before the day gets going." }
        ]
      }
    }
    """

    private func listRegion(items: [String], closedLine: String?) -> String {
        let children = closedLine.map {
            """
            , "children": [ { "kind": "text", "emphasis": "standard", "tone": "neutral", "role": "body", "text": "\($0)" } ]
            """
        } ?? ""
        return """
        {
          "id": "needs-you",
          "summary": "Needs you.",
          "tree": {
            "kind": "entity_list",
            "emphasis": "standard",
            "tone": "neutral",
            "title": "Needs you",
            "variant": "rows",
            "items": [\(items.joined(separator: ","))]\(children)
          }
        }
        """
    }

    private func stackRegion(items: [String], closedLine: String) -> String {
        """
        {
          "id": "needs-you",
          "summary": "Needs you.",
          "tree": {
            "kind": "stack",
            "emphasis": "standard",
            "tone": "neutral",
            "children": [
              {
                "kind": "entity_list",
                "emphasis": "standard",
                "tone": "neutral",
                "title": "Needs you",
                "variant": "rows",
                "items": [\(items.joined(separator: ","))]
              },
              { "kind": "text", "emphasis": "standard", "tone": "neutral", "role": "body", "text": "\(closedLine)" }
            ]
          }
        }
        """
    }

    private func document(regions: [String]) throws -> BriefDocumentV2 {
        let json = """
        {
          "version": 2,
          "title": "The Wednesday Brief",
          "summary": "Two things need you.",
          "generatedAt": 1793210700000,
          "timezone": "America/Los_Angeles",
          "regions": [\(regions.joined(separator: ","))]
        }
        """
        return try #require(BriefDocumentV2.decode(Data(json.utf8)))
    }

    private let harborAir = "Harbor Air moved flight HA 220 to 6:40 pm."
    private let closed = "Closed by itself since yesterday's letter: the pipeline on feature/ledger-sync passed."

    @Test func theListFormClassifiesAsTheLaneWithItsClosingLine() throws {
        let doc = try document(regions: [
            ledeRegion,
            listRegion(
                items: [threadItem(id: "t1", subject: "Flight HA 220", sender: "Harbor Air", reason: harborAir)],
                closedLine: closed
            ),
        ])
        let sections = BriefLetterLayout.sections(for: doc, includeLede: true)
        #expect(sections.map(\.regionID) == ["lede", "needs-you"])
        guard case .needsYou(let items, let closedLine) = sections[1] else {
            Issue.record("Expected the Needs you lane.")
            return
        }
        #expect(items.count == 1)
        #expect(items.first?.framing?.sender == "Harbor Air")
        #expect(closedLine == closed)
        #expect(BriefLetterLayout.isLetter(doc))
        #expect(BriefLetterLayout.key(for: sections[1], at: 1) == "lane:needs-you")
        #expect(BriefLetterLane.needsYou.title == "Needs you")
        #expect(BriefLetterLane.needsYou.rawValue == "needs-you")
        #expect(BriefLetterLane.needsYou.showsAvatar)
        // The rows keep the Answer row shape.
        let copy = BriefMailRowCopy(item: items[0], entity: nil)
        #expect(copy.sender == "Harbor Air")
        #expect(copy.subject == "Flight HA 220")
        #expect(copy.line == harborAir)
        #expect(copy.action == "Open")
    }

    @Test func theStackFormAndAnEmptyLaneWithOnlyTheClosingLine() throws {
        let stacked = try document(regions: [
            ledeRegion,
            stackRegion(items: [threadItem(id: "t1", subject: "Flight HA 220", sender: "Harbor Air", reason: harborAir)], closedLine: closed),
        ])
        guard case .needsYou(let items, let closedLine) = BriefLetterLayout.sections(for: stacked, includeLede: false)[0] else {
            Issue.record("Expected the Needs you lane from a stack.")
            return
        }
        #expect(items.count == 1)
        #expect(closedLine == closed)

        let onlyClosed = try document(regions: [ledeRegion, listRegion(items: [], closedLine: closed)])
        #expect(BriefLetterLayout.sections(for: onlyClosed, includeLede: false).map(\.regionID) == ["needs-you"])

        let empty = try document(regions: [ledeRegion, listRegion(items: [], closedLine: nil)])
        #expect(BriefLetterLayout.sections(for: empty, includeLede: false).isEmpty)
    }
}
