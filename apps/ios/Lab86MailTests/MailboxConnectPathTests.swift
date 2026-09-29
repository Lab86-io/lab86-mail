import Foundation
import Testing
@testable import Lab86Mail

/// A reconnect names its account, so the server signs in that mailbox again
/// and a direct Google account stays direct.
struct MailboxConnectPathTests {
    private func items(_ path: String) throws -> [String: String] {
        let components = try #require(URLComponents(string: path))
        return Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
    }

    @Test func aNewConnectionNamesNoAccount() throws {
        let path = WebAuthenticationCoordinator.mailboxConnectPath(provider: "google")
        #expect(path.hasPrefix("/api/nylas/connect?"))
        let values = try items(path)
        #expect(values["provider"] == "google")
        #expect(values["native"] == "1")
        #expect(values["format"] == "json")
        #expect(values["account"] == nil)
    }

    @Test func aReconnectNamesItsAccount() throws {
        let path = WebAuthenticationCoordinator.mailboxConnectPath(provider: "google", accountId: "dc636c8d-1660-4cfb")
        #expect(try items(path)["account"] == "dc636c8d-1660-4cfb")
    }

    @Test func anAccountIdCannotAddQueryItems() throws {
        let path = WebAuthenticationCoordinator.mailboxConnectPath(provider: "google", accountId: "a&provider=evil")
        let values = try items(path)
        #expect(values["account"] == "a&provider=evil")
        #expect(values["provider"] == "google")
    }

    @Test func anEmptyAccountIdIsANewConnection() throws {
        let path = WebAuthenticationCoordinator.mailboxConnectPath(provider: "microsoft", accountId: "")
        #expect(try items(path)["account"] == nil)
    }

    @Test func aBriefSourceIdNamesAnAccountOnlyInTheKindAccountForm() {
        #expect(BriefSource.reconnectAccountID(fromSourceID: "mail:dc636c8d-1660-4cfb") == "dc636c8d-1660-4cfb")
        #expect(BriefSource.reconnectAccountID(fromSourceID: "calendar:acct_1") == "acct_1")
        // Only the first ":" splits, so an account id can hold ":".
        #expect(BriefSource.reconnectAccountID(fromSourceID: "mail:google:1111") == "google:1111")
        #expect(BriefSource.reconnectAccountID(fromSourceID: "calendar") == nil)
        #expect(BriefSource.reconnectAccountID(fromSourceID: "mail:") == nil)
        #expect(BriefSource.reconnectAccountID(fromSourceID: ":acct_1") == nil)
        #expect(BriefSource.reconnectAccountID(fromSourceID: ":") == nil)
        #expect(BriefSource.reconnectAccountID(fromSourceID: "") == nil)
    }

    @Test func aBriefSourceIdWithNoAccountStartsANewConnection() throws {
        let accountId = BriefSource.reconnectAccountID(fromSourceID: "calendar")
        let path = WebAuthenticationCoordinator.mailboxConnectPath(provider: "google", accountId: accountId)
        #expect(try items(path)["account"] == nil)
    }
}
