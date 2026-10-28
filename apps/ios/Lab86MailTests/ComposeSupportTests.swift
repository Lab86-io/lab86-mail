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

    @Test
    func theShortDeliveryLineDropsTheYearAndKeepsTheTime() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "UTC"))
        let locale = Locale(identifier: "en_US")
        let date = Date(timeIntervalSince1970: 1_793_202_300) // 2026-10-28 15:45 UTC
        // Foundation puts U+202F before AM and PM.
        func plain(_ text: String) -> String { text.replacingOccurrences(of: "\u{202F}", with: " ") }
        let full = plain(ComposeDeliveryLabel.full(sendsLater: true, date: date, locale: locale, calendar: calendar))
        let short = plain(ComposeDeliveryLabel.short(sendsLater: true, date: date, locale: locale, calendar: calendar))
        #expect(full.hasPrefix("Sends Oct 28, 2026"))
        #expect(full.hasSuffix("3:45 PM"))
        #expect(short == "Sends Oct 28, 3:45 PM")
        #expect(short.count < full.count)
        #expect(ComposeDeliveryLabel.full(sendsLater: false, date: date) == "Send now")
        #expect(ComposeDeliveryLabel.short(sendsLater: false, date: date) == "Send now")
    }
}
