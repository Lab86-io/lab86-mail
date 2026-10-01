import Foundation
import MobileAPI
import Testing
@testable import Lab86Mail

// The composer's From control for Gmail send-as addresses. The rules copy
// lib/shared/send-as.ts, so web, iOS, and macOS send from the same address.
@MainActor
struct SendAsTests {
    private static let pageJSON = #"""
    {"version":1,"accountID":"acct-work","aliasesSupported":true,"partial":false,
     "identities":[
       {"email":"casey@northwind.example","displayName":"Casey Morgan","isPrimary":true,"isDefault":false,
        "verificationStatus":"accepted","hasProviderSignature":true,"usable":true},
       {"email":"Events@Northwind.example","displayName":"Northwind Events","isPrimary":false,"isDefault":true,
        "verificationStatus":"accepted","replyTo":"team@northwind.example","hasProviderSignature":false,"usable":true},
       {"email":"press@northwind.example","isPrimary":false,"isDefault":false,
        "verificationStatus":"pending","hasProviderSignature":false,"usable":false}
     ],
     "defaultAddress":"Events@Northwind.example","serverTime":"2026-10-01T12:00:00.123Z"}
    """#

    private static func decode(_ json: String) throws -> SendAsPage {
        MobileV1Client.sendAsPage(
            from: try MobileContractJSON.decode(Components.Schemas.MobileSendAsPage.self, from: Data(json.utf8))
        )
    }

    private static func account(_ id: String, _ email: String, name: String? = nil, primary: Bool = false) -> AccountSummary {
        var object: [String: JSONValue] = [
            "accountId": .string(id),
            "email": .string(email),
            "provider": .string("google"),
            "primary": .bool(primary),
        ]
        if let name { object["displayName"] = .string(name) }
        return AccountSummary(json: .object(object))!
    }

    private static let work = account("acct-work", "casey@northwind.example", name: "Northwind", primary: true)
    private static let home = account("acct-home", "casey.morgan@example.com", name: "Personal")

    private static func page(
        accountID: String = "acct-work",
        identities: [SendAsIdentity],
        defaultAddress: String,
        aliasesSupported: Bool = true,
        partial: Bool = false
    ) -> SendAsPage {
        SendAsPage(
            accountID: accountID,
            aliasesSupported: aliasesSupported,
            partial: partial,
            identities: identities,
            defaultAddress: defaultAddress,
            serverTime: Date(timeIntervalSince1970: 1_790_000_000)
        )
    }

    private static func identity(
        _ email: String,
        name: String? = nil,
        primary: Bool = false,
        isDefault: Bool = false,
        usable: Bool = true
    ) -> SendAsIdentity {
        SendAsIdentity(
            email: email,
            displayName: name,
            isPrimary: primary,
            isDefault: isDefault,
            verificationStatus: usable ? .accepted : .pending,
            replyTo: nil,
            hasProviderSignature: false,
            usable: usable
        )
    }

    // MARK: - Decoding

    @Test
    func theSendAsPageDecodesWithFractionalSecondsAndEveryIdentity() throws {
        let page = try Self.decode(Self.pageJSON)
        #expect(page.accountID == "acct-work")
        #expect(page.aliasesSupported)
        #expect(!page.partial)
        #expect(page.defaultAddress == "Events@Northwind.example")
        #expect(abs(page.serverTime.timeIntervalSince1970 - 1_790_856_000.123) < 0.001)
        #expect(page.identities.count == 3)
        #expect(page.identities[0].displayName == "Casey Morgan")
        #expect(page.identities[0].isPrimary)
        #expect(page.identities[0].hasProviderSignature)
        #expect(page.identities[1].isDefault)
        #expect(page.identities[1].replyTo == "team@northwind.example")
        #expect(page.identities[2].verificationStatus == .pending)
        #expect(page.identities[2].displayName == nil)
        #expect(!page.identities[2].usable)
        #expect(page.usableIdentities.map(\.email) == ["casey@northwind.example", "Events@Northwind.example"])
    }

    @Test
    func aPartialPageAndAMailboxWithoutAliasesDecode() throws {
        let partial = try Self.decode(#"""
        {"version":1,"accountID":"acct-work","aliasesSupported":true,"partial":true,
         "identities":[{"email":"casey@northwind.example","isPrimary":true,"isDefault":true,
           "verificationStatus":"accepted","hasProviderSignature":false,"usable":true}],
         "defaultAddress":"casey@northwind.example","serverTime":"2026-10-01T12:00:00Z"}
        """#)
        #expect(partial.partial)
        #expect(partial.aliasesSupported)
        #expect(partial.identities.count == 1)

        let single = try Self.decode(#"""
        {"version":1,"accountID":"acct-ms","aliasesSupported":false,"partial":false,
         "identities":[{"email":"casey@outlook.example","displayName":"  ","isPrimary":true,"isDefault":true,
           "verificationStatus":"unknown","hasProviderSignature":false,"usable":true}],
         "defaultAddress":"casey@outlook.example","serverTime":"2026-10-01T12:00:00.000Z"}
        """#)
        #expect(!single.aliasesSupported)
        #expect(single.identities.first?.verificationStatus == .unknown)
        #expect(single.identities.first?.displayName == nil)
    }

    // MARK: - Visibility

    @Test
    func theAddressChoiceShowsOnlyForMoreThanOneUsableAddress() throws {
        let aliases = try Self.decode(Self.pageJSON)
        let groups = SendAsRules.groups(accounts: [Self.work, Self.home], pages: ["acct-work": aliases])
        #expect(groups.map(\.accountID) == ["acct-work", "acct-home"])
        // Two usable addresses; the pending address stays out, like web.
        #expect(groups[0].offersAddressChoice)
        #expect(groups[0].choices.map(\.email) == ["casey@northwind.example", "Events@Northwind.example"])
        #expect(groups[0].choices.map(\.name) == ["Casey Morgan", "Northwind Events"])
        // A mailbox without a list is one row with its own address.
        #expect(!groups[1].offersAddressChoice)
        #expect(groups[1].choices == [
            FromChoice(accountID: "acct-home", email: "casey.morgan@example.com", name: "Personal", primary: true),
        ])

        let one = Self.page(
            identities: [Self.identity("casey@northwind.example", primary: true), Self.identity("press@northwind.example", usable: false)],
            defaultAddress: "casey@northwind.example"
        )
        #expect(!SendAsRules.groups(accounts: [Self.work], pages: ["acct-work": one])[0].offersAddressChoice)

        let partial = Self.page(
            identities: [Self.identity("casey@northwind.example", primary: true)],
            defaultAddress: "casey@northwind.example",
            partial: true
        )
        #expect(!SendAsRules.groups(accounts: [Self.work], pages: ["acct-work": partial])[0].offersAddressChoice)
    }

    // MARK: - Default selection

    @Test
    func theControlSelectsTheDefaultAddressFirst() throws {
        let page = try Self.decode(Self.pageJSON)
        let groups = SendAsRules.groups(accounts: [Self.work], pages: ["acct-work": page])
        let preferred = SendAsRules.preferredAddress(userAddress: nil, page: page)
        #expect(preferred == "Events@Northwind.example")
        #expect(SendAsRules.selected(in: groups, accountID: "acct-work", address: preferred)?.email == "Events@Northwind.example")
        // The user's pick wins over the default, in any case.
        let picked = SendAsRules.preferredAddress(userAddress: "CASEY@northwind.example", page: page)
        #expect(SendAsRules.selected(in: groups, accountID: "acct-work", address: picked)?.email == "casey@northwind.example")
        // An address the mailbox cannot send from falls back to the primary address.
        #expect(SendAsRules.selected(in: groups, accountID: "acct-work", address: "press@northwind.example")?.email == "casey@northwind.example")
        #expect(SendAsRules.selected(in: groups, accountID: "acct-other", address: nil) == nil)
    }

    @Test
    func pickingARowKeepsItsAddress() {
        let choice = FromChoice(accountID: "acct-work", email: "events@northwind.example", name: nil, primary: false)
        #expect(SendAsRules.userAddress(after: choice) == "events@northwind.example")
        let bare = FromChoice(accountID: "acct-work", email: "acct-work", name: nil, primary: true)
        #expect(SendAsRules.userAddress(after: bare) == nil)
    }

    // MARK: - fromAddress field

    @Test
    func theSendAddressFollowsTheWebRule() throws {
        let page = try Self.decode(Self.pageJSON)
        let groups = SendAsRules.groups(accounts: [Self.work], pages: ["acct-work": page])
        let selected = SendAsRules.selected(in: groups, accountID: "acct-work", address: page.defaultAddress)
        // The list loaded: the address the control shows goes out.
        #expect(SendAsRules.sendAddress(page: page, selected: selected, userAddress: nil) == "Events@Northwind.example")
        // Before the list loads, only an address the user picked goes.
        #expect(SendAsRules.sendAddress(page: nil, selected: nil, userAddress: nil) == nil)
        #expect(SendAsRules.sendAddress(page: nil, selected: nil, userAddress: "events@northwind.example") == "events@northwind.example")
        // A value that is not a bare address never goes.
        #expect(SendAsRules.sendAddress(page: nil, selected: nil, userAddress: "Casey <casey@northwind.example>") == nil)
        #expect(SendAsRules.sendAddress(page: page, selected: nil, userAddress: "events@northwind.example") == nil)
    }

    @Test
    func theComposeFieldsIncludeFromAddressOnlyWhenSet() {
        let with = ProductStore.composeFields(
            mode: "reply", accountID: "acct-work", to: "", cc: "", bcc: "",
            subject: "", body: "Body", includeSignature: true, fromAddress: " events@northwind.example "
        )
        #expect(with["fromAddress"] == "events@northwind.example")
        let without = ProductStore.composeFields(
            mode: "new", accountID: "acct-work", to: "b@example.com", cc: "", bcc: "",
            subject: "Hi", body: "Body", includeSignature: true
        )
        #expect(without["fromAddress"] == nil)
        let blank = ProductStore.composeFields(
            mode: "new", accountID: "acct-work", to: "b@example.com", cc: "", bcc: "",
            subject: "Hi", body: "Body", includeSignature: true, fromAddress: "  "
        )
        #expect(blank["fromAddress"] == nil)
    }

    @Test
    func aReplyOrForwardAsksForTheAnchoredDefault() {
        #expect(SendAsAnchor(mode: "new", messageID: "m1", threadID: "t1") == nil)
        #expect(SendAsAnchor(mode: "reply", messageID: nil, threadID: " ") == nil)
        let reply = SendAsAnchor(mode: "reply", messageID: "m1", threadID: "t1")
        #expect(reply?.messageID == "m1")
        #expect(reply?.threadID == "t1")
        #expect(SendAsAnchor(mode: "forward", messageID: "m2", threadID: nil)?.messageID == "m2")
    }

    // MARK: - Refused address

    @Test
    func eachRefusalCodeHasItsOwnShortMessage() {
        for code in ComposeFromErrorCode.allCases {
            let body: JSONValue = .object([
                "ok": .bool(false),
                "error": .string("server text"),
                "code": .string(code.rawValue),
            ])
            let refusal = ComposeFromRefusal(status: 400, body: body)
            #expect(refusal?.code == code)
            #expect(refusal?.localizedDescription == code.message)
            #expect(!code.message.contains("AI"))
            // The draft stays editable with the reason.
            #expect(ComposeTransportFailure(ComposeFromRefusal(code: code)) == .rejected(code.message))
        }
        #expect(ComposeFromErrorCode(rawValue: "from_unknown") == .unknown)
        #expect(ComposeFromErrorCode(rawValue: "from_unverified") == .unverified)
        #expect(ComposeFromErrorCode(rawValue: "from_unsupported") == .unsupported)
        #expect(ComposeFromRefusal(status: 500, body: .object(["code": .string("from_unknown")])) == nil)
        #expect(ComposeFromRefusal(status: 400, body: .object(["code": .string("to_missing")])) == nil)
        #expect(ComposeFromRefusal(status: 400, body: nil) == nil)
    }

    // MARK: - Held and scheduled sends

    @Test
    func aHeldSendKeepsItsFromAddress() throws {
        let snapshot = ComposeDraftSnapshot(
            recipient: "sarah@northwind.example", cc: "", bcc: "", subject: "Hi", body: "Body",
            mode: "new", accountID: "acct-work", threadID: nil, messageID: nil, replyAll: false,
            attachmentsKey: nil, draftID: nil, fromAddress: "events@northwind.example"
        )
        let decoded = try JSONDecoder().decode(ComposeDraftSnapshot.self, from: try JSONEncoder().encode(snapshot))
        #expect(decoded.fromAddress == "events@northwind.example")
        #expect(decoded.composePrefill.fromAddress == "events@northwind.example")

        // A record saved before send-as still decodes, with the default address.
        let legacy = Data(#"""
        {"recipient":"a@example.com","cc":"","bcc":"","subject":"","body":"","mode":"new",
         "accountID":"acct-work","replyAll":false}
        """#.utf8)
        let old = try JSONDecoder().decode(ComposeDraftSnapshot.self, from: legacy)
        #expect(old.fromAddress == nil)
        #expect(old.composePrefill.fromAddress == nil)
    }

    // MARK: - Cache

    @Test
    func theDirectoryKeepsAPageForFiveMinutes() async {
        let fetcher = CountingSendAsFetcher(page: Self.page(
            identities: [Self.identity("casey@northwind.example", primary: true)],
            defaultAddress: "casey@northwind.example"
        ))
        let clock = TestClock(now: Date(timeIntervalSince1970: 1_790_000_000))
        let directory = SendAsDirectory(fetcher: fetcher, now: { clock.now })

        #expect(await directory.page(accountID: "acct-work", anchor: nil) != nil)
        #expect(await directory.page(accountID: "acct-work", anchor: nil) != nil)
        #expect(await fetcher.calls == 1)

        // A reply asks with its anchor, which is its own entry.
        let anchor = SendAsAnchor(mode: "reply", messageID: "m1", threadID: nil)
        _ = await directory.page(accountID: "acct-work", anchor: anchor)
        #expect(await fetcher.calls == 2)

        clock.now = clock.now.addingTimeInterval(SendAsDirectory.freshness + 1)
        _ = await directory.page(accountID: "acct-work", anchor: nil)
        #expect(await fetcher.calls == 3)

        directory.invalidate(accountID: "acct-work")
        _ = await directory.page(accountID: "acct-work", anchor: nil)
        #expect(await fetcher.calls == 4)

        #expect(await directory.page(accountID: "", anchor: nil) == nil)
        #expect(await SendAsDirectory(fetcher: nil).page(accountID: "acct-work", anchor: nil) == nil)
    }

    @Test
    func aFailedReadIsNotCached() async {
        let fetcher = CountingSendAsFetcher(page: nil)
        let directory = SendAsDirectory(fetcher: fetcher)
        #expect(await directory.page(accountID: "acct-work", anchor: nil) == nil)
        #expect(await directory.page(accountID: "acct-work", anchor: nil) == nil)
        #expect(await fetcher.calls == 2)
    }
}

@MainActor
private final class TestClock {
    var now: Date

    init(now: Date) {
        self.now = now
    }
}

private actor CountingSendAsFetcher: SendAsFetching {
    private let page: SendAsPage?
    private(set) var calls = 0

    init(page: SendAsPage?) {
        self.page = page
    }

    func fetchSendAs(accountID: String, anchor: SendAsAnchor?) async throws -> SendAsPage {
        calls += 1
        guard let page else { throw URLError(.cannotConnectToHost) }
        return page
    }
}
