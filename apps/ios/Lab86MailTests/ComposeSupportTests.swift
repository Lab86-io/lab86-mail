import Foundation
import SwiftUI
import Testing
@testable import Lab86Mail

// The composer's tool strip layout (D1) and the web link of a draft.
struct ComposeSupportTests {
    @Test
    func theToolStripStacksAtAccessibilitySizesOnly() {
        #expect(ComposeToolStripLayout.resolve(dynamicTypeSize: .large) == .inline)
        #expect(ComposeToolStripLayout.resolve(dynamicTypeSize: .xxxLarge) == .inline)
        #expect(ComposeToolStripLayout.resolve(dynamicTypeSize: .accessibility1) == .stacked)
        #expect(ComposeToolStripLayout.resolve(dynamicTypeSize: .accessibility3) == .stacked)
    }

    @Test
    func theWebLinkOpensThisDraftInMail() throws {
        let base = try #require(URL(string: "https://mail.lab86.io/api/mobile"))
        let url = ComposeWebLink.draftURL(base: base, accountID: "acct-1", draftID: "draft 9")
        #expect(url?.absoluteString == "https://mail.lab86.io/?view=mail&account=acct-1&draft=draft%209")
        let noAccount = ComposeWebLink.draftURL(base: base, accountID: "", draftID: "d-1")
        #expect(noAccount?.absoluteString == "https://mail.lab86.io/?view=mail&draft=d-1")
    }

    @Test
    func noSavedDraftMeansNoLink() throws {
        let base = try #require(URL(string: "https://mail.lab86.io"))
        #expect(ComposeWebLink.draftURL(base: base, accountID: "acct-1", draftID: nil) == nil)
        #expect(ComposeWebLink.draftURL(base: base, accountID: "acct-1", draftID: "  ") == nil)
        #expect(ComposeWebLink.draftURL(base: nil, accountID: "acct-1", draftID: "d-1") == nil)
    }
}
