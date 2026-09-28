import Foundation
import Testing
@testable import Lab86Mail

// Recipient search for To, Cc, and Bcc: the address parser, the chip rules,
// the value string the composer sends, stale-answer dropping, the exclude
// list, and the contacts contract JSON (`lib/mobile/v1/contract.ts`) through
// the generated MobileAPI client.
@MainActor
struct RecipientFieldTests {
    // MARK: - Address parsing

    @Test
    func namedAndBareAddressesBecomeChips() {
        let tokens = RecipientAddressParser.tokens(from: "Jakob Langtry <jakob@lab86.io>, c@d.com")
        #expect(tokens.count == 2)
        #expect(tokens[0].name == "Jakob Langtry")
        #expect(tokens[0].email == "jakob@lab86.io")
        #expect(tokens[0].isValid)
        #expect(tokens[1].name == nil)
        #expect(tokens[1].email == "c@d.com")
        #expect(tokens[1].isValid)
    }

    @Test
    func quotedNamesAndSemicolonsAndMailtoParse() {
        let tokens = RecipientAddressParser.tokens(
            from: "\"Lee, Sam\" <sam@example.com>; mailto:bob@example.org\n<ann@example.net>"
        )
        #expect(tokens.map(\.email) == ["sam@example.com", "bob@example.org", "ann@example.net"])
        #expect(tokens[0].name == "Lee, Sam")
        let allValid = tokens.allSatisfy { $0.isValid }
        #expect(allValid)
    }

    @Test
    func aProviderNameWithACommaStaysOneChip() {
        let tokens = RecipientAddressParser.tokens(from: "Langtry, Jakob <jakob@lab86.io>, sam@example.com")
        #expect(tokens.count == 2)
        #expect(tokens[0].name == "Langtry, Jakob")
        #expect(tokens[0].email == "jakob@lab86.io")
    }

    @Test
    func textThatIsNotAnAddressBecomesAnInvalidChip() {
        let tokens = RecipientAddressParser.tokens(from: "john, a@b.com, Sam <sam@nowhere>")
        #expect(tokens.map(\.isValid) == [false, true, false])
        #expect(tokens[0].email == "john")
        #expect(RecipientAddressParser.firstInvalidEntry(in: ["a@b.com", "", "a@b.com, john"]) == "john")
        #expect(RecipientAddressParser.firstInvalidEntry(in: ["a@b.com", "", "  "]) == nil)
    }

    @Test
    func spaceSeparatedPastedAddressesSplit() {
        let tokens = RecipientAddressParser.tokens(from: "a@b.com c@d.com")
        #expect(tokens.map(\.email) == ["a@b.com", "c@d.com"])
        #expect(RecipientAddressParser.tokens(from: "Sam Lee").map(\.isValid) == [false])
    }

    @Test(arguments: [
        "a@b.co", "first.last+tag@sub.example.org", "o'brien@example.ie", "üser@exämple.de", "x@xn--p1ai.xn--p1ai",
    ])
    func validAddresses(_ address: String) {
        #expect(RecipientAddressParser.isValidEmail(address))
    }

    @Test(arguments: [
        "", "a@b", "a@@b.com", "a b@c.com", ".a@b.com", "a.@b.com", "a..b@c.com", "a@b.c", "a@-b.com",
        "@b.com", "a@b..com", "a@1.2.3.4", "jl", "a@b.com,",
    ])
    func invalidAddresses(_ address: String) {
        #expect(!RecipientAddressParser.isValidEmail(address))
    }

    // MARK: - The value the composer sends

    @Test
    func theValueKeepsTheCommaSeparatedHeaderFormat() {
        var state = RecipientFieldState()
        state.pick(Self.jakob)
        state.edit("c@d.com,")
        #expect(state.value == "Jakob Langtry <jakob@lab86.io>, c@d.com")

        // The form field is the same string, byte for byte.
        let fields = ProductStore.composeFields(
            mode: "new", accountID: "a1", to: state.value, cc: "", bcc: "",
            subject: "Hi", body: "Body", includeSignature: true
        )
        #expect(fields["to"] == "Jakob Langtry <jakob@lab86.io>, c@d.com")

        // The server's reader (lib/nylas/normalize.ts emailList) gets both people.
        #expect(Self.serverEmailList(state.value) == [
            .init(email: "jakob@lab86.io", name: "Jakob Langtry"),
            .init(email: "c@d.com", name: nil),
        ])
    }

    @Test
    func namesLoseTheCharactersTheHeaderCannotCarry() {
        let token = RecipientToken(name: "Lee, \"Sam\" <Ops>", email: "sam@example.com")
        #expect(token.headerValue == "Lee Sam Ops <sam@example.com>")
        #expect(RecipientToken(name: "sam@example.com", email: "sam@example.com").headerValue == "sam@example.com")
        #expect(RecipientToken(name: "  ", email: "sam@example.com").headerValue == "sam@example.com")
        #expect(Self.serverEmailList(token.headerValue) == [.init(email: "sam@example.com", name: "Lee Sam Ops")])
    }

    @Test
    func aServerFormattedValueRoundTripsUnchanged() {
        let value = "Sam Lee <sam@example.com>, bob@example.org, Ann Wu <ann@example.net>"
        #expect(RecipientFieldState(value: value).value == value)
        #expect(RecipientFieldState(value: "").value == "")
    }

    @Test
    func typedTextStaysInTheValueSoSendingSeesIt() {
        var state = RecipientFieldState(value: "a@b.com")
        state.edit("jl")
        #expect(state.value == "a@b.com, jl")
        #expect(RecipientAddressParser.firstInvalidEntry(in: [state.value]) == "jl")
        #expect(ComposeView.invalidRecipientMessage("jl").contains("“jl”"))
    }

    // MARK: - Chip commit rules

    @Test
    func separatorsCommitTypedAddresses() {
        for separator in [",", ";", "\n"] {
            var state = RecipientFieldState()
            Self.type("a@b.co", into: &state)
            let changed = state.edit("a@b.co\(separator)")
            #expect(changed)
            #expect(state.tokens.map(\.email) == ["a@b.co"])
            #expect(state.draft == "")
        }
    }

    @Test
    func aSeparatorAfterPartialTextPicksTheHighlightedPerson() {
        var state = RecipientFieldState()
        state.edit("j")
        state.edit("jl")
        state.edit("jl,", pick: Self.jakob)
        #expect(state.tokens.map(\.email) == ["jakob@lab86.io"])
        #expect(state.tokens.first?.name == "Jakob Langtry")
        #expect(state.draft == "")
    }

    @Test
    func aSeparatorAfterPartialTextWithNoSuggestionMakesAnInvalidChip() {
        var state = RecipientFieldState()
        state.edit("j")
        state.edit("jl")
        state.edit("jl,")
        #expect(state.tokens.map(\.isValid) == [false])
        #expect(state.hasInvalidToken)
    }

    @Test
    func aSpaceCommitsOnlyAfterACompleteAddress() {
        var state = RecipientFieldState()
        Self.type("a@b.com", into: &state)
        #expect(state.tokens.isEmpty)
        state.edit("a@b.com ")
        #expect(state.tokens.map(\.email) == ["a@b.com"])
        #expect(state.draft == "")

        var name = RecipientFieldState()
        name.edit("J")
        name.edit("Ja")
        name.edit("Ja ")
        #expect(name.tokens.isEmpty)
        #expect(name.draft == "Ja ")
    }

    @Test
    func aPastedListBecomesChipsAtOnce() {
        var state = RecipientFieldState()
        state.edit("Jakob Langtry <jakob@lab86.io>, c@d.com")
        #expect(state.tokens.map(\.email) == ["jakob@lab86.io", "c@d.com"])
        #expect(state.tokens.first?.name == "Jakob Langtry")
        #expect(state.draft == "")

        var single = RecipientFieldState()
        single.edit("sam@example.com")
        #expect(single.tokens.map(\.email) == ["sam@example.com"])

        var partial = RecipientFieldState()
        partial.edit("a@b.com, Jakob")
        #expect(partial.tokens.map(\.email) == ["a@b.com"])
        #expect(partial.draft == "Jakob")
    }

    @Test
    func anAddressAlreadyInTheFieldIsNotAddedTwice() {
        var state = RecipientFieldState(value: "a@b.com")
        state.edit("A@B.com,")
        state.pick(RecipientSuggestion(email: "a@b.com", name: "Ann"))
        #expect(state.tokens.count == 1)
    }

    @Test
    func backspaceSelectsThenRemovesTheLastChip() {
        var state = RecipientFieldState(value: "a@b.com, c@d.com")
        let firstRemoved = state.backspaceOnEmptyDraft()
        #expect(firstRemoved == false)
        #expect(state.selectedTokenID == state.tokens.last?.id)
        let secondRemoved = state.backspaceOnEmptyDraft()
        #expect(secondRemoved)
        #expect(state.tokens.map(\.email) == ["a@b.com"])
        #expect(state.selectedTokenID == nil)

        // Typing clears the selection.
        state.backspaceOnEmptyDraft()
        #expect(state.selectedTokenID != nil)
        state.edit("x")
        #expect(state.selectedTokenID == nil)
        #expect(state.tokens.count == 1)

        // With text in the field, Backspace edits the text.
        let removedWithText = state.backspaceOnEmptyDraft()
        #expect(removedWithText == false)
        #expect(state.selectedTokenID == nil)
    }

    @Test
    func leavingTheFieldKeepsOnlyACompleteAddressAsAChip() {
        var partial = RecipientFieldState()
        partial.edit("jl")
        let keptAsText = partial.commitDraft(onlyValid: true)
        #expect(keptAsText == false)
        #expect(partial.draft == "jl")
        let committed = partial.commitDraft()
        #expect(committed)
        #expect(partial.tokens.map(\.isValid) == [false])

        var complete = RecipientFieldState()
        Self.type("sam@example.com ", into: &complete)
        Self.type("ann@example.com", into: &complete)
        #expect(complete.draft == "ann@example.com")
        let completeCommitted = complete.commitDraft(onlyValid: true)
        #expect(completeCommitted)
        #expect(complete.tokens.map(\.email) == ["sam@example.com", "ann@example.com"])
    }

    @Test
    func aChipCanBeEditedRemovedOrMovedToAnotherAddress() throws {
        var state = RecipientFieldState()
        state.pick(Self.jakob)
        state.edit("john,")
        let invalid = try #require(state.tokens.last)
        state.beginEditing(invalid.id)
        #expect(state.draft == "john")
        #expect(state.tokens.count == 1)

        let jakob = try #require(state.tokens.first)
        state.useAlternate("jakob@gmail.com", for: jakob.id)
        #expect(state.tokens.first?.email == "jakob@gmail.com")
        #expect(state.tokens.first?.alternateEmails == ["jakob@lab86.io"])
        #expect(state.value == "Jakob Langtry <jakob@gmail.com>, john")

        state.remove(jakob.id)
        #expect(state.tokens.isEmpty)
    }

    // MARK: - Exclude list and request

    @Test
    func theRequestTrimsTheQueryClampsTheLimitAndDeduplicatesExclude() {
        let request = RecipientSearchRequest(
            query: "  JL ",
            fromAccountID: " ",
            limit: 50,
            exclude: ["A@B.com", "a@b.com", " ", "c@d.com"]
        )
        #expect(request.query == "JL")
        #expect(request.fromAccountID == nil)
        #expect(request.limit == 10)
        #expect(request.exclude == ["a@b.com", "c@d.com"])
        #expect(RecipientSearchRequest(query: "", fromAccountID: nil, limit: 0).limit == 1)
        let many = RecipientSearchRequest(query: "", fromAccountID: nil, exclude: (0..<80).map { "p\($0)@x.com" })
        #expect(many.exclude.count == 50)
        #expect(RecipientSearchRequest(query: String(repeating: "a", count: 300), fromAccountID: nil).query.count == 200)
    }

    @Test
    func theFieldExcludesItsOwnChips() {
        let state = RecipientFieldState(value: "Sam <SAM@example.com>, john, b@example.com")
        #expect(state.addresses == ["sam@example.com", "b@example.com"])
        #expect(RecipientAddressParser.addresses(in: "Sam <SAM@example.com>, john") == ["sam@example.com"])
    }

    @Test
    func theRequestCarriesTheQueryTheMailboxTheLimitAndEachExcludedAddress() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        let recipients = try Self.json(Self.recipientFixture)
        server.routes = ["/api/mobile/v1/contacts/recipients": recipients]
        let client = Self.mobileClient(server)
        _ = try await client.searchRecipients(
            RecipientSearchRequest(query: "jl", fromAccountID: "b70d7463", limit: 8, exclude: ["a@b.com", "c+x@d.com"])
        )
        _ = try await client.searchRecipients(RecipientSearchRequest(query: "", fromAccountID: nil))
        let requests = server.recorded
        #expect(requests.count == 2)
        let first = try #require(requests.first)
        #expect(first.method == "GET")
        #expect(first.path.hasPrefix("/api/mobile/v1/contacts/recipients?"))
        let items = try #require(URLComponents(string: first.path)?.queryItems)
        #expect(items.first { $0.name == "q" }?.value == "jl")
        #expect(items.first { $0.name == "fromAccountID" }?.value == "b70d7463")
        #expect(items.first { $0.name == "limit" }?.value == "8")
        #expect(items.filter { $0.name == "exclude" }.map(\.value) == ["a@b.com", "c+x@d.com"])

        // A focused empty field asks for the top people, with no exclude.
        let second = try #require(URLComponents(string: requests[1].path)?.queryItems)
        #expect(second.first { $0.name == "q" }?.value == "")
        #expect(second.contains { $0.name == "exclude" } == false)
        #expect(second.contains { $0.name == "fromAccountID" } == false)
    }

    @Test
    func contactStatusAndResyncGoThroughTheGeneratedClient() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        let status = try Self.json(Self.statusFixture)
        server.routes = [
            "/api/mobile/v1/contacts/status": status,
            "/api/mobile/v1/contacts/resync": .object(["accountID": .string("b70d7463"), "started": .bool(true)]),
        ]
        let client = Self.mobileClient(server)
        let page = try await client.fetchContactStatus()
        #expect(page.accounts.count == 2)
        let receipt = try await client.resyncContacts(accountID: "b70d7463")
        #expect(receipt == ContactResyncReceipt(accountID: "b70d7463", started: true))
        let resync = try #require(server.recorded.last)
        #expect(resync.method == "POST")
        #expect(resync.path == "/api/mobile/v1/contacts/resync")
        #expect(resync.body == .object(["accountID": .string("b70d7463")]))
    }

    @Test
    func aServerErrorBecomesAMobileClientError() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes = [
            "/api/mobile/v1/contacts/resync": .object([
                "ok": .bool(false),
                "requestID": .string("req-1"),
                "error": .object([
                    "code": .string("needs_reconnect"),
                    "message": .string("Reconnect this mailbox first."),
                    "retryable": .bool(false),
                ]),
            ]),
        ]
        server.statuses = ["/api/mobile/v1/contacts/resync": 409]
        let client = Self.mobileClient(server)
        await #expect(throws: MobileV1ClientError.server(
            status: 409, code: "needs_reconnect", message: "Reconnect this mailbox first.", retryable: false
        )) {
            _ = try await client.resyncContacts(accountID: "b70d7463")
        }
    }

    // MARK: - Stale answers

    @Test
    func anAnswerForAnOlderQueryIsDropped() {
        #expect(RecipientSearchModel.accepts(pageQuery: "jl", currentQuery: " JL "))
        #expect(!RecipientSearchModel.accepts(pageQuery: "j", currentQuery: "jl"))

        let model = RecipientSearchModel(debounce: .zero)
        let older = RecipientSearchRequest(query: "j", fromAccountID: nil)
        let newer = RecipientSearchRequest(query: "jl", fromAccountID: nil)
        model.search(older, using: nil)
        model.search(newer, using: nil)
        // The answer for "j" arrives after the person typed "jl".
        #expect(model.receive(RecipientSuggestionPage(query: "j", items: [Self.julia]), for: older) == false)
        #expect(model.suggestions.isEmpty)
        #expect(model.receive(RecipientSuggestionPage(query: "jl", items: [Self.jakob]), for: newer))
        #expect(model.suggestions.map(\.email) == ["jakob@lab86.io"])
        #expect(model.highlightedIndex == 0)
        #expect(model.suggestions(matching: "j").isEmpty)
        #expect(model.pickable(for: "jl")?.email == "jakob@lab86.io")
    }

    @Test
    func aSlowOlderAnswerNeverReplacesTheNewerOne() async throws {
        let searcher = ScriptedSearcher(delays: ["j": .milliseconds(250), "jl": .milliseconds(10)])
        let model = RecipientSearchModel(debounce: .zero)
        model.search(RecipientSearchRequest(query: "j", fromAccountID: "acct"), using: searcher)
        try await Task.sleep(for: .milliseconds(30))
        model.search(RecipientSearchRequest(query: "jl", fromAccountID: "acct"), using: searcher)
        try await Self.waitUntil { !model.isSearching }
        try await Task.sleep(for: .milliseconds(350))
        #expect(model.resultQuery == "jl")
        #expect(model.suggestions.map(\.email) == ["jl@example.com"])
        #expect(await searcher.queries == ["j", "jl"])
    }

    @Test
    func answersSkipAddressesAlreadyInTheField() async throws {
        let searcher = ScriptedSearcher(items: [Self.jakob, Self.julia])
        let model = RecipientSearchModel(debounce: .zero)
        model.search(
            RecipientSearchRequest(query: "j", fromAccountID: nil, exclude: ["JAKOB@lab86.io"]),
            using: searcher
        )
        try await Self.waitUntil { model.resultQuery != nil }
        #expect(model.suggestions.map(\.email) == ["julia@example.com"])
        #expect(await searcher.excludes == [["jakob@lab86.io"]])
    }

    @Test
    func theSameRequestUsesTheCache() async throws {
        let searcher = ScriptedSearcher(items: [Self.jakob])
        let model = RecipientSearchModel(debounce: .zero)
        let request = RecipientSearchRequest(query: "", fromAccountID: nil)
        model.search(request, using: searcher)
        try await Self.waitUntil { model.resultQuery != nil }
        model.reset()
        #expect(model.suggestions.isEmpty)
        model.search(request, using: searcher)
        #expect(model.suggestions.map(\.email) == ["jakob@lab86.io"])
        #expect(await searcher.queries == [""])
    }

    @Test
    func returnWaitsBrieflyForTheAnswerInFlight() async throws {
        let searcher = ScriptedSearcher(items: [Self.jakob], delays: ["jl": .milliseconds(120)])
        let model = RecipientSearchModel(debounce: .milliseconds(80))
        model.search(RecipientSearchRequest(query: "jl", fromAccountID: nil), using: searcher)
        #expect(model.pickable(for: "jl") == nil)
        let picked = await model.settledPickable(for: "jl")
        #expect(picked?.email == "jakob@lab86.io")
    }

    @Test
    func arrowKeysMoveAndWrapTheHighlight() {
        let model = RecipientSearchModel(debounce: .zero)
        let request = RecipientSearchRequest(query: "", fromAccountID: nil)
        model.search(request, using: nil)
        model.receive(RecipientSuggestionPage(query: "", items: [Self.jakob, Self.julia]), for: request)
        // Top people: nothing is highlighted, so Return does not pick.
        #expect(model.highlightedIndex == nil)
        #expect(model.pickable(for: "") == nil)
        #expect(model.moveHighlight(by: 1))
        #expect(model.highlightedIndex == 0)
        model.moveHighlight(by: 1)
        model.moveHighlight(by: 1)
        #expect(model.highlightedIndex == 0)
        model.moveHighlight(by: -1)
        #expect(model.highlightedIndex == 1)
        #expect(model.pickable(for: "")?.email == "julia@example.com")
    }

    // MARK: - Highlights

    @Test
    func highlightsBecomeBoldRuns() {
        let text = RecipientHighlightText.attributed(
            "Jakob Langtry",
            highlights: [
                RecipientHighlight(field: .name, start: 0, length: 1),
                RecipientHighlight(field: .name, start: 6, length: 1),
                RecipientHighlight(field: .name, start: 40, length: 3),
            ]
        )
        #expect(Self.boldText(text) == ["J", "L"])

        // UTF-16 offsets: the emoji is two units.
        let emoji = RecipientHighlightText.attributed(
            "😀 Jo",
            highlights: [RecipientHighlight(field: .name, start: 3, length: 2), RecipientHighlight(field: .name, start: 1, length: 1)]
        )
        #expect(Self.boldText(emoji) == ["Jo"])
    }

    // MARK: - Contract JSON

    @Test
    func theRecipientPageDecodes() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        let recipients = try Self.json(Self.recipientFixture)
        server.routes = ["/api/mobile/v1/contacts/recipients": recipients]
        let page = try await Self.mobileClient(server).searchRecipients(
            RecipientSearchRequest(query: "jl", fromAccountID: nil)
        )
        #expect(page.query == "jl")
        #expect(page.items.count == 3)
        let jakob = page.items[0]
        #expect(jakob.id == "jakob@lab86.io")
        #expect(jakob.name == "Jakob Langtry")
        #expect(jakob.alternateEmails == ["jakob@gmail.com"])
        #expect(jakob.savedContact)
        #expect(!jakob.directory)
        #expect(jakob.sources == [.addressBook, .mail])
        #expect(jakob.company == "Lab86")
        #expect(jakob.jobTitle == "Founder")
        #expect(jakob.photoURL?.absoluteString == "https://images.example.com/jakob.jpg")
        #expect(jakob.lastContactedAt == Date(timeIntervalSince1970: 1_790_550_000))
        #expect(jakob.sentCount == 42)
        #expect(jakob.receivedCount == 17)
        #expect(jakob.highlights(in: .name) == [
            RecipientHighlight(field: .name, start: 0, length: 1),
            RecipientHighlight(field: .name, start: 6, length: 1),
        ])
        #expect(jakob.score == 187.4)

        // Optional keys are absent, and an http photo is not a usable hint.
        let bare = page.items[1]
        #expect(bare.name == nil)
        #expect(bare.displayName == "jl@example.com")
        #expect(bare.alternateEmails.isEmpty)
        #expect(bare.sources == [.inbox])
        #expect(bare.photoURL == nil)
        #expect(bare.lastContactedAt == nil)
        #expect(bare.highlights(in: .email).count == 1)

        #expect(page.items[2].isTypedAddress)
    }

    @Test
    func theStatusPageDecodes() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        let status = try Self.json(Self.statusFixture)
        server.routes = ["/api/mobile/v1/contacts/status": status]
        let page = try await Self.mobileClient(server).fetchContactStatus()
        #expect(page.accounts.count == 2)
        let reconnect = page.accounts[0]
        #expect(reconnect.accountID == "b70d7463")
        #expect(reconnect.provider == "google")
        #expect(reconnect.state == .needsReconnect)
        #expect(reconnect.needsReconnect)
        #expect(reconnect.sources.map(\.state) == ["missingScope", "missingScope", "ok"])
        #expect(reconnect.sources.last?.count == 120)
        #expect(reconnect.summary == "Reconnect this mailbox to add its contacts.")
        #expect(reconnect.lastSyncedAt == nil)

        let ready = page.accounts[1]
        #expect(ready.state == .ready)
        #expect(!ready.needsReconnect)
        #expect(ready.lastSyncedAt == Date(timeIntervalSince1970: 1_790_550_000))
        #expect(ready.summary.hasPrefix("Contacts: 1"))
        #expect(ready.summary.hasSuffix(" people"))
        #expect(!ready.isProblem)
    }

    @Test
    func statusLinesUsePlainCopy() {
        func status(_ state: ContactSyncState, count: Int = 0, reconnect: Bool = false, message: String? = nil) -> ContactAccountStatus {
            ContactAccountStatus(
                accountID: "a", email: "a@b.com", provider: "google", state: state,
                needsReconnect: reconnect, contactCount: count, lastSyncedAt: nil, sources: [], message: message
            )
        }
        #expect(status(.ready, count: 1).summary == "Contacts: 1 person")
        #expect(status(.pending).summary == "Adding contacts")
        #expect(status(.syncing, count: 5).summary == "Adding contacts: 5 so far")
        #expect(status(.unsupported).summary == "This mailbox has no contacts to add.")
        #expect(status(.paused).isProblem)
        #expect(status(.ready, reconnect: true).summary == "Reconnect this mailbox to add its contacts.")
        #expect(status(.error, message: "Server message").summary == "Server message")
        for line in [status(.ready, count: 3), status(.error), status(.paused)].map(\.summary) {
            #expect(!line.contains("AI"))
        }
    }

    // MARK: - Fixtures

    static let jakob = RecipientSuggestion(
        email: "jakob@lab86.io",
        name: "Jakob Langtry",
        alternateEmails: ["jakob@gmail.com"],
        savedContact: true,
        sources: [.addressBook, .mail],
        highlights: [
            RecipientHighlight(field: .name, start: 0, length: 1),
            RecipientHighlight(field: .name, start: 6, length: 1),
        ]
    )

    static let julia = RecipientSuggestion(email: "julia@example.com", name: "Julia Lopez", sources: [.mail])

    // The contract doc's example, as JSON, with an item that omits every
    // optional key and a typed address. The generated decoder rejects unknown
    // keys and enum values, so the fixtures hold only contract values.
    static let recipientFixture = """
    {
      "version": 1,
      "query": "jl",
      "items": [
        {
          "id": "jakob@lab86.io",
          "email": "jakob@lab86.io",
          "name": "Jakob Langtry",
          "alternateEmails": ["jakob@gmail.com"],
          "savedContact": true,
          "directory": false,
          "sources": ["addressBook", "mail"],
          "company": "Lab86",
          "jobTitle": "Founder",
          "photoURL": "https://images.example.com/jakob.jpg",
          "lastContactedAt": 1790550000000,
          "sentCount": 42,
          "receivedCount": 17,
          "highlights": [
            { "field": "name", "start": 0, "length": 1 },
            { "field": "name", "start": 6, "length": 1 }
          ],
          "score": 187.4
        },
        {
          "id": "jl@example.com",
          "email": "jl@example.com",
          "savedContact": false,
          "directory": false,
          "sources": ["inbox"],
          "photoURL": "http://insecure.example.com/p.png",
          "sentCount": 0,
          "receivedCount": 3,
          "highlights": [{ "field": "email", "start": 0, "length": 2 }],
          "score": 12
        },
        {
          "id": "jl@lab86.io",
          "email": "jl@lab86.io",
          "savedContact": false,
          "directory": false,
          "sources": ["typed"],
          "sentCount": 0,
          "receivedCount": 0,
          "highlights": [],
          "score": 0
        }
      ],
      "serverTime": "2026-09-27T22:40:00.000Z"
    }
    """

    static let statusFixture = """
    {
      "version": 1,
      "accounts": [
        {
          "accountID": "b70d7463",
          "email": "jakob@statpearls.com",
          "provider": "google",
          "state": "needsReconnect",
          "needsReconnect": true,
          "contactCount": 0,
          "sources": [
            { "source": "addressBook", "state": "missingScope" },
            { "source": "inbox", "state": "missingScope" },
            { "source": "domain", "state": "ok", "count": 120 }
          ],
          "message": "Reconnect this mailbox to add its contacts."
        },
        {
          "accountID": "c81e",
          "email": "jakob@lab86.io",
          "provider": "icloud",
          "state": "ready",
          "needsReconnect": false,
          "contactCount": 1214,
          "lastSyncedAt": 1790550000000,
          "sources": [{ "source": "addressBook", "state": "ok", "count": 1214 }]
        }
      ],
      "serverTime": "2026-09-27T22:40:00.000Z"
    }
    """

    /// Types one character at a time, as the keyboard does.
    static func type(_ text: String, into state: inout RecipientFieldState) {
        let start = state.draft
        var typed = start
        for character in text {
            typed.append(character)
            state.edit(typed)
            typed = state.draft
        }
    }

    /// The real generated client over the stub server's URL protocol.
    static func mobileClient(_ server: StubBackendServer) -> MobileV1Client {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return MobileV1Client(
            baseURL: URL(string: "https://\(server.host)")!,
            session: URLSession(configuration: configuration),
            tokenProvider: { "test-token" }
        )
    }

    static func json(_ text: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    static func boldText(_ text: AttributedString) -> [String] {
        text.runs
            .filter { $0.inlinePresentationIntent == .stronglyEmphasized }
            .map { String(text[$0.range].characters) }
    }

    struct ServerAddress: Equatable {
        let email: String
        let name: String?
    }

    /// A copy of `emailList` in lib/nylas/normalize.ts: the server's reader
    /// for the To, Cc, and Bcc form fields.
    static func serverEmailList(_ value: String) -> [ServerAddress] {
        value.split(separator: ",", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .map { part in
                if part.hasSuffix(">"), let open = part.firstIndex(of: "<") {
                    let email = part[part.index(after: open)..<part.index(before: part.endIndex)]
                        .trimmingCharacters(in: .whitespaces)
                    let name = part[..<open].trimmingCharacters(in: .whitespaces)
                        .trimmingCharacters(in: CharacterSet(charactersIn: "\""))
                    return ServerAddress(email: email, name: name.isEmpty ? nil : name)
                }
                return ServerAddress(email: part, name: nil)
            }
    }

    static func waitUntil(
        timeout: Duration = .seconds(2),
        _ condition: @MainActor () -> Bool
    ) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while !condition() {
            guard clock.now < deadline else {
                Issue.record("The condition did not become true in time.")
                return
            }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}

/// Answers each query after a set delay, echoing the query as the server does.
/// It finishes even when its task is cancelled, like a request already on the wire.
actor ScriptedSearcher: RecipientSearching {
    private let items: [RecipientSuggestion]?
    private let delays: [String: Duration]
    private(set) var queries: [String] = []
    private(set) var excludes: [[String]] = []

    init(items: [RecipientSuggestion]? = nil, delays: [String: Duration] = [:]) {
        self.items = items
        self.delays = delays
    }

    func searchRecipients(_ request: RecipientSearchRequest) async throws -> RecipientSuggestionPage {
        queries.append(request.query)
        excludes.append(request.exclude)
        if let delay = delays[request.query] {
            let seconds = Double(delay.components.seconds) + Double(delay.components.attoseconds) / 1e18
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { continuation.resume() }
            }
        }
        let rows = items ?? [RecipientSuggestion(email: "\(request.query)@example.com")]
        return RecipientSuggestionPage(query: request.query, items: rows)
    }
}
