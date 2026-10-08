import Foundation
import Testing
@testable import Lab86Mail

// Passwords and IDs on the wire: kinds, items without values, uses and
// their rows, the allow request on a run, the ask input, and the errors.
// Invented data only: "Sam Rivera", chase.com, dmv.ny.gov, "ends 4821".
@MainActor
struct SecureDetailsModelsTests {
    @Test func kindsMirrorTheContract() {
        #expect(SecureItemKind.from("sign_in") == .signIn)
        #expect(SecureItemKind.from("id_number") == .idNumber)
        #expect(SecureItemKind.from("date_of_birth") == .dateOfBirth)
        #expect(SecureItemKind.from("api_key") == .apiKey)
        #expect(SecureItemKind.from("card") == nil)
        #expect(SecureItemKind.signIn.secretFields == ["username", "password"])
        #expect(SecureItemKind.idNumber.secretFields == ["number", "expires", "name_on_id"])
        #expect(SecureItemKind.dateOfBirth.secretFields == ["date"])
        #expect(SecureItemKind.apiKey.secretFields == ["key"])
        #expect(SecureItemKind.idNumber.asksOnNewSite)
        #expect(SecureItemKind.dateOfBirth.asksOnNewSite)
        #expect(SecureItemKind.signIn.needsSite)
        #expect(SecureItemKind.apiKey.needsSite)
        #expect(SecureItemKind.dateOfBirth.group == .ids)
        #expect(SecureItemKind.apiKey.group == .keys)
        #expect(IdNumberType.from("drivers_license") == .driversLicense)
        #expect(IdNumberType.from("Driver's license") == .driversLicense)
        #expect(IdNumberType.from("Passport") == .passport)
        #expect(IdNumberType.from("card") == nil)
        #expect(IdNumberType.ssn.label == "Social Security number")
        #expect(!IdNumberType.ssn.usesExpiry)
        #expect(!IdNumberType.ssn.usesNameOnID)
        #expect(IdNumberType.passport.usesCountry)
        #expect(IdNumberType.stateID.usesRegion)
        #expect(SecureFieldLabel.text("name_on_id") == "Name on the ID")
        #expect(SecureFieldLabel.text("expires") == "Expiry date")
        #expect(SecureFieldLabel.text("other_thing") == "Other thing")
    }

    @Test func labelsInsideASentence() {
        #expect(SecureItemLabel.inSentence("Driver's license") == "driver's license")
        #expect(SecureItemLabel.inSentence("Social Security number") == "Social Security number")
        #expect(SecureItemLabel.inSentence("State ID") == "state ID")
        #expect(SecureItemLabel.inSentence("ID number") == "ID number")
        #expect(SecureItemLabel.inSentence("Chase") == "chase")
        #expect("OpenAI".lowercasedFirst == "openAI")
        #expect("".lowercasedFirst == "")
    }

    @Test func anItemDecodesWithoutAnyValue() throws {
        let item = try #require(SecureItemView(json: .object([
            "id": .string("sec-license"),
            "kind": .string("id_number"),
            "label": .string("Driver's license"),
            "sites": .array([.string("ny.gov"), .string("")]),
            "hints": .object(["number": .string("ends 4821"), "expires": .string("Mar 2028")]),
            "facts": .object(["type": .string("drivers_license"), "region": .string("NY")]),
            "values": .object(["number": .string("should never be here")]),
            "createdAt": .number(1_759_700_000_000),
            "updatedAt": .number(1_759_800_000_000),
            "lastUsedAt": .null,
        ])))
        #expect(item.kind == .idNumber)
        #expect(item.sites == ["ny.gov"])
        #expect(item.hint("number") == "ends 4821")
        #expect(item.mainHint == "ends 4821")
        #expect(item.idType == .driversLicense)
        #expect(item.place == "NY")
        #expect(item.createdAt == Date(timeIntervalSince1970: 1_759_700_000))
        #expect(item.lastUsedAt == nil)
        #expect(item.covers(host: "dmv.ny.gov"))
        #expect(item.covers(host: "https://dmv.ny.gov/renew"))
        #expect(!item.covers(host: "ny.gov.example"))
        // A key is bound to its exact host; a sign-in covers every host under its site.
        let key = SecureItemView(id: "sec-key", kind: .apiKey, label: "OpenAI", sites: ["api.openai.com"])
        #expect(key.covers(host: "api.openai.com"))
        #expect(key.covers(host: "https://api.openai.com/v1"))
        #expect(!key.covers(host: "v2.api.openai.com"))
        #expect(!key.covers(host: "openai.com"))
        let chase = SecureItemView(id: "sec-chase", kind: .signIn, label: "Chase", sites: ["chase.com"])
        #expect(chase.covers(host: "secure.chase.com"))
        let mirror = Mirror(reflecting: item)
        #expect(!mirror.children.contains { $0.label == "values" })
        #expect(SecureItemView(json: .object(["id": .string("x"), "kind": .string("card")])) == nil)
        #expect(SecureItemView(json: .object(["kind": .string("sign_in")])) == nil)
        let bare = try #require(SecureItemView(json: .object(["_id": .string("sec-1"), "kind": .string("api_key")])))
        #expect(bare.label == "Key")
        #expect(bare.sites.isEmpty)
    }

    @Test func theResponseHidesTheSectionByDefault() {
        let off = SecureDetailsResponse(json: .object(["ok": .bool(true)]))
        #expect(!off.enabled)
        #expect(off.items.isEmpty)
        let on = SecureDetailsResponse(json: .object([
            "ok": .bool(true),
            "enabled": .bool(true),
            "items": .array([
                .object(["id": .string("sec-chase"), "kind": .string("sign_in"), "label": .string("Chase"), "sites": .array([.string("chase.com")])]),
                .object(["id": .string("bad")]),
            ]),
        ]))
        #expect(on.enabled)
        #expect(on.items.map(\.id) == ["sec-chase"])
    }

    @Test func usesDecodeAndMergeIntoRows() throws {
        let at = 1_759_800_000_000.0
        let json: JSONValue = .object([
            "ok": .bool(true),
            "uses": .array([
                .object(["id": .string("u1"), "itemId": .string("sec-license"), "field": .string("number"), "site": .string("dmv.ny.gov"),
                         "workId": .string("w-1"), "workTitle": .string("Renew the license"), "outcome": .string("typed"), "at": .number(at)]),
                .object(["id": .string("u2"), "itemId": .string("sec-license"), "field": .string("expires"), "site": .string("dmv.ny.gov"),
                         "workId": .string("w-1"), "workTitle": .string("Renew the license"), "outcome": .string("typed"), "at": .number(at + 5_000)]),
                .object(["id": .string("u3"), "itemId": .string("sec-license"), "site": .string("dmv.ny.gov"),
                         "workTitle": .string("Renew the license"), "outcome": .string("allowed_once"), "at": .number(at - 60_000)]),
                .object(["id": .string("u4"), "itemId": .string("sec-license"), "site": .string("dmv-renewal.example"),
                         "workTitle": .string("Renew the license"), "outcome": .string("refused_site"), "at": .number(at - 120_000)]),
                .object(["id": .string("u5"), "itemId": .string("sec-license"), "outcome": .string("something_new"), "at": .number(at - 180_000)]),
                .object(["itemId": .string("sec-license"), "outcome": .string("typed")]),
            ]),
        ])
        let uses = SecureUseView.list(from: json)
        #expect(uses.count == 5)
        #expect(uses[4].outcome == .unknown)
        let rows = SecureUseRow.rows(from: uses)
        #expect(rows.count == 4)
        #expect(rows[0].fields == ["expires", "number"] || rows[0].fields == ["number", "expires"])
        #expect(rows[0].title.hasPrefix("Typed on dmv.ny.gov · "))
        #expect(rows[0].title.contains("Number"))
        #expect(rows[0].title.contains("Expiry date"))
        #expect(rows[1].title == "Allowed once on dmv.ny.gov")
        #expect(rows[2].title == "Refused on dmv-renewal.example")
        #expect(rows[2].detail(noun: "ID", locale: Locale(identifier: "en_US")).hasPrefix("Not one of this ID's sites · Renew the license · "))
        #expect(rows[3].title == "Used")
        let sent = SecureUseRow(id: "s", outcome: .sent, site: "api.openai.com", workTitle: nil, fields: [], at: nil)
        #expect(sent.title == "Sent to api.openai.com")
        #expect(sent.detail(noun: "key") == "")
        let denied = SecureUseRow(id: "d", outcome: .denied, site: "ny.gov", workTitle: "Renew", fields: [], at: nil)
        #expect(denied.title == "Not allowed on ny.gov")
        #expect(denied.detail(noun: "ID") == "Renew")
    }

    @Test func theAllowRequestAndItsAnswerDecode() throws {
        let request = try #require(SecureAllowRequest(json: .object([
            "itemId": .string("sec-license"),
            "kind": .string("id_number"),
            "itemLabel": .string("Driver's license"),
            "fieldLabels": .array([.string("Number"), .string("Expiry date")]),
            "site": .string("ny.gov"),
            "host": .string("dmv.ny.gov"),
        ])))
        #expect(request.itemID == "sec-license")
        #expect(request.fieldLabels == ["Number", "Expiry date"])
        #expect(request.host == "dmv.ny.gov")
        let bare = try #require(SecureAllowRequest(json: .object([
            "itemId": .string("sec-dob"), "kind": .string("date_of_birth"), "site": .string("aliveat25.example"),
        ])))
        #expect(bare.itemLabel == "Date of birth")
        #expect(bare.host == "aliveat25.example")
        #expect(SecureAllowRequest(json: .object(["kind": .string("id_number"), "site": .string("ny.gov")])) == nil)
        let answer = try #require(SecureAllowAnswerView(json: .object(["scope": .string("always"), "at": .number(1_759_800_000_000)])))
        #expect(answer.scope == .always)
        #expect(answer.at == Date(timeIntervalSince1970: 1_759_800_000))
        #expect(SecureAllowAnswerView(json: .object(["scope": .string("maybe")])) == nil)
        #expect(SecureSaveSignInOffer(json: .object(["site": .string("chase.com")]))?.site == "chase.com")
        #expect(SecureSaveSignInOffer(json: .object([:])) == nil)
        // The cache: a Next with an allow survives a Codable round trip.
        let next = StepRunView.Next(kind: .allowSecure, allow: request, allowAnswer: answer)
        let data = try JSONEncoder().encode(next)
        let decoded = try JSONDecoder().decode(StepRunView.Next.self, from: data)
        #expect(decoded.allow == request)
        #expect(decoded.allowAnswer?.scope == .always)
    }

    @Test func anAllowSecureHandoffNeverBecomesAnOpenButton() throws {
        let next = try #require(StepRunView.Next(json: .object([
            "kind": .string("allow_secure"),
            "label": .string("Answer"),
            "detail": .string("Use your saved driver's license on ny.gov?"),
            "target": .object(["kind": .string("secure"), "id": .string("sec-license"), "url": .string("https://ny.gov")]),
            "allow": .object([
                "itemId": .string("sec-license"), "kind": .string("id_number"), "itemLabel": .string("Driver's license"),
                "fieldLabels": .array([.string("Number")]), "site": .string("ny.gov"), "host": .string("dmv.ny.gov"),
            ]),
        ])))
        #expect(next.kind == .allowSecure)
        #expect(next.target?.kind == .secure)
        #expect(next.label == "Answer")
        let behaviour = StepRunNextBehaviour.from(next)
        guard case .allowSecure(let allow) = behaviour else {
            Issue.record("expected the allow card, got \(behaviour)")
            return
        }
        #expect(allow.site == "ny.gov")
        #expect(!behaviour.showsPrimaryButton)
        #expect(!StepRunNextBehaviour.showsContinue(next))
        // Without `allow` there is nothing to ask, and never "Open" on the site url.
        let bare = try #require(StepRunView.Next(json: .object([
            "kind": .string("allow_secure"),
            "target": .object(["kind": .string("secure"), "url": .string("https://ny.gov")]),
        ])))
        #expect(StepRunNextBehaviour.from(bare) == .none)
        #expect(StepRunView.Next.Kind.from("allow_secure") == .allowSecure)
        #expect(StepRunView.Next.Kind.allowSecure.defaultLabel == "Answer")
        // A sign-in handoff carries the save offer (V13).
        let signIn = try #require(StepRunView.Next(json: .object([
            "kind": .string("sign_in"),
            "detail": .string("Sign in to chase.com in the page, then press Continue."),
            "saveSignIn": .object(["site": .string("chase.com")]),
        ])))
        #expect(signIn.saveSignIn?.site == "chase.com")
        #expect(StepRunNextBehaviour.from(signIn) == .openBrowser)
    }

    @Test func theAskInputDecodes() throws {
        let input = try #require(SecureRequestInput(json: .object([
            "kind": .string("sign_in"),
            "site": .string("https://www.springfieldwater.gov/pay"),
            "reason": .string("To pay the water bill, Albatross needs to sign in."),
        ])))
        #expect(input.site == "springfieldwater.gov")
        #expect(input.label == nil)
        #expect(SecureRequestInput(json: .object(["reason": .string("x")])) == nil)
        #expect(SecureRequestInput.savedAnswer(itemID: "sec-1")["saved"]?.boolValue == true)
        #expect(SecureRequestInput.savedAnswer(itemID: "sec-1")["itemId"]?.stringValue == "sec-1")
        #expect(SecureRequestInput.skippedAnswer["skipped"]?.boolValue == true)
    }

    @Test func errorsReadTheRoutesBody() {
        #expect(SecureSaveError.from(status: 403, body: .object(["code": .string("verify_identity")])) == .verifyIdentity)
        #expect(SecureSaveError.from(status: 403, body: nil) == .verifyIdentity)
        let card = SecureSaveError.from(status: 400, body: .object([
            "code": .string("refused"), "reason": .string("card"), "field": .string("number"), "error": .string("server words"),
        ]))
        #expect(card.line == SecureSaveError.cardLine)
        #expect(card.field == "number")
        #expect(SecureSaveError.from(status: 400, body: .object(["code": .string("refused"), "reason": .string("code")])).line == SecureSaveError.codeLine)
        #expect(SecureSaveError.from(status: 400, body: .object(["code": .string("refused"), "reason": .string("bank")])).line == SecureSaveError.bankLine)
        #expect(SecureSaveError.from(status: 400, body: .object(["code": .string("refused"), "error": .string("No.")])).line == "No.")
        #expect(SecureSaveError.from(status: 400, body: .object(["code": .string("invalid"), "error": .string("Use the date format YYYY-MM-DD.")])) == .invalid("Use the date format YYYY-MM-DD."))
        #expect(SecureSaveError.from(status: 400, body: .object(["code": .string("site")])).line == SecureSaveError.siteLine)
        #expect(SecureSaveError.from(status: 409, body: .object(["code": .string("limit")])).line == SecureSaveError.limitLine)
        #expect(SecureSaveError.from(status: 409, body: .object(["code": .string("closed")])) == .closed(nil))
        #expect(SecureSaveError.from(status: 404, body: .object(["code": .string("not_found")])) == .notFound)
        #expect(SecureSaveError.from(status: 404, body: .object(["code": .string("off")])) == .off)
        #expect(SecureSaveError.from(status: 503, body: nil) == .off)
        #expect(SecureSaveError.from(status: 500, body: .object(["error": .string("Boom")])) == .other("Boom"))
        #expect(SecureSaveError.from(status: 500, body: nil).line == SecureSaveError.saveFailedLine)
    }

    @Test func theStoreReadsAndRemembersTheFlag() async {
        let defaults = UserDefaults(suiteName: "SecureDetailsModelsTests-\(UUID().uuidString)")!
        let store = SecureDetailsStore(defaults: defaults)
        #expect(!store.sectionVisible(ownerID: "owner-1"))
        let transport = ScriptedSecureTransport(answers: [
            "GET /api/secure-details": (200, .object([
                "ok": .bool(true), "enabled": .bool(true),
                "items": .array([
                    .object(["id": .string("sec-chase"), "kind": .string("sign_in"), "label": .string("Chase"), "sites": .array([.string("chase.com")])]),
                    .object(["id": .string("sec-dob"), "kind": .string("date_of_birth"), "label": .string("Date of birth")]),
                    .object(["id": .string("sec-a"), "kind": .string("sign_in"), "label": .string("amazon.example"), "sites": .array([.string("amazon.example")])]),
                ]),
            ])),
        ])
        await store.load(transport, ownerID: "owner-1")
        #expect(store.isEnabled)
        #expect(store.sectionVisible(ownerID: "owner-1"))
        #expect(store.dateOfBirth?.id == "sec-dob")
        #expect(store.items(of: .signIn).map(\.label) == ["amazon.example", "Chase"])
        #expect(store.item(kind: .signIn, covering: "secure.chase.com")?.id == "sec-chase")
        #expect(store.item(kind: .signIn, covering: "chase.com.example") == nil)
        // The flag survives for the next open; a clear forgets the items, not the flag.
        store.clear()
        #expect(store.enabled == nil)
        #expect(store.sectionVisible(ownerID: "owner-1"))
        #expect(!store.sectionVisible(ownerID: "owner-2"))
        let off = ScriptedSecureTransport(answers: [
            "GET /api/secure-details": (200, .object(["ok": .bool(true), "enabled": .bool(false), "items": .array([])])),
        ])
        await store.load(off, ownerID: "owner-1", force: true)
        #expect(!store.isEnabled)
        #expect(!store.sectionVisible(ownerID: "owner-1"))
    }

    @Test func theStoreThrowsTheRoutesErrors() async {
        let store = SecureDetailsStore(defaults: UserDefaults(suiteName: "SecureDetailsModelsTests-\(UUID().uuidString)")!)
        let transport = ScriptedSecureTransport(answers: [
            "POST /api/secure-details/allow": (403, .object(["code": .string("verify_identity")])),
            "PUT /api/secure-details/sec-1": (400, .object(["code": .string("refused"), "reason": .string("card"), "field": .string("number")])),
            "GET /api/secure-details": (200, .object(["ok": .bool(true), "enabled": .bool(true), "items": .array([])])),
        ])
        await #expect(throws: SecureSaveError.verifyIdentity) {
            try await store.allow(runID: "run-1", itemID: "sec-1", site: "ny.gov", scope: .once, transport: transport)
        }
        do {
            try await store.update(id: "sec-1", values: ["number": .string("x")], transport: transport)
            Issue.record("expected a refusal")
        } catch let error as SecureSaveError {
            #expect(error.field == "number")
            #expect(error.line == SecureSaveError.cardLine)
        } catch {
            Issue.record("unexpected \(error)")
        }
        #expect(transport.requests.contains("POST /api/secure-details/allow"))
    }
}

/// A transport that answers each "METHOD path" from a script; anything
/// else is 404.
final class ScriptedSecureTransport: BackendExchanging, @unchecked Sendable {
    let answers: [String: (Int, JSONValue)]
    private let lock = NSLock()
    private var log: [String] = []

    init(answers: [String: (Int, JSONValue)]) {
        self.answers = answers
    }

    var requests: [String] { lock.withLock { log } }

    func exchange(method: String, path: String, body: JSONValue?) async throws -> BackendExchange {
        let key = "\(method) \(path)"
        lock.withLock { log.append(key) }
        guard let (status, answer) = answers[key] else {
            return BackendExchange(status: 404, body: .object(["error": .string("No fixture for \(key)")]))
        }
        return BackendExchange(status: status, body: answer)
    }
}
