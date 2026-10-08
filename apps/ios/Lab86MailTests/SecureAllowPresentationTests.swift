import Foundation
import Testing
@testable import Lab86Mail

// The allow card's words (V6): the question names the site, the reason
// names the host, the receipts, and the ask card's words (V12).
struct SecureAllowPresentationTests {
    private static let license = SecureAllowRequest(
        itemID: "sec-license", kind: .idNumber, itemLabel: "Driver's license",
        fieldLabels: ["Number", "Expiry date"], site: "ny.gov", host: "dmv.ny.gov"
    )

    @Test func theQuestionNamesTheSiteAndTheReasonTheHost() {
        #expect(SecureAllowCopy.title(Self.license) == "Use your driver's license on ny.gov?")
        #expect(SecureAllowCopy.reason(Self.license) == "dmv.ny.gov asks for the number and the expiry date. Albatross types them and does not read them.")
        let number = SecureAllowRequest(itemID: "sec-license", kind: .idNumber, itemLabel: "Driver's license", fieldLabels: ["Number"], site: "ny.gov", host: "dmv.ny.gov")
        #expect(SecureAllowCopy.title(number) == "Use your driver's license number on ny.gov?")
        #expect(SecureAllowCopy.reason(number) == "dmv.ny.gov asks for the number. Albatross types it and does not read it.")
        let ssn = SecureAllowRequest(itemID: "sec-ssn", kind: .idNumber, itemLabel: "Social Security number", fieldLabels: ["Number"], site: "irs.example", host: "www.irs.example")
        #expect(SecureAllowCopy.title(ssn) == "Use your Social Security number on irs.example?")
        let dob = SecureAllowRequest(itemID: "sec-dob", kind: .dateOfBirth, itemLabel: "Date of birth", fieldLabels: ["Date of birth"], site: "aliveat25.example", host: "aliveat25.example")
        #expect(SecureAllowCopy.title(dob) == "Use your date of birth on aliveat25.example?")
        #expect(SecureAllowCopy.reason(dob) == "aliveat25.example asks for the date. Albatross types it and does not read it.")
        let chase = SecureAllowRequest(itemID: "sec-chase", kind: .signIn, itemLabel: "Chase", fieldLabels: ["Username", "Password"], site: "chase.com", host: "secure.chase.com")
        #expect(SecureAllowCopy.title(chase) == "Use your Chase sign-in on chase.com?")
        let key = SecureAllowRequest(itemID: "sec-key", kind: .apiKey, itemLabel: "OpenAI", fieldLabels: ["Key"], site: "api.openai.com", host: "api.openai.com")
        #expect(SecureAllowCopy.title(key) == "Call api.openai.com with your OpenAI key?")
        #expect(SecureAllowCopy.reason(key) == "Albatross sends the key in the request to api.openai.com and reads only the reply.")
    }

    @Test func buttonsAndReceipts() {
        #expect(SecureAllowCopy.always(site: "ny.gov") == "Always on ny.gov")
        #expect(SecureAllowCopy.always(site: "a-very-long-registrable-domain.example") == "Always on this site")
        #expect(SecureAllowCopy.receipt(.once, site: "ny.gov") == "Allowed once on ny.gov.")
        #expect(SecureAllowCopy.receipt(.always, site: "ny.gov") == "Always allowed on ny.gov.")
        #expect(SecureAllowCopy.receipt(.deny, site: "ny.gov") == "Not allowed.")
        #expect(SecureAllowCopy.joined([]) == "")
        #expect(SecureAllowCopy.joined(["a"]) == "a")
        #expect(SecureAllowCopy.joined(["a", "b"]) == "a and b")
        #expect(SecureAllowCopy.joined(["a", "b", "c"]) == "a, b, and c")
        #expect(SecureAllowScope.from("always") == .always)
        #expect(SecureAllowScope.from("never") == nil)
    }

    @Test func theCheckReasonsNameTheAction() {
        #expect(IdentityCheckCopy.allowOnceReason(itemLabel: "Driver's license", host: "dmv.ny.gov")
            == "Allow once lets Albatross use your driver's license on dmv.ny.gov for this run.")
        #expect(IdentityCheckCopy.allowAlwaysReason(itemLabel: "Driver's license", site: "ny.gov", host: "dmv.ny.gov")
            == "Always on ny.gov adds ny.gov to your driver's license. That covers dmv.ny.gov and every page of ny.gov.")
        #expect(IdentityCheckCopy.allowAlwaysReason(itemLabel: "Passport", site: "state.gov", host: "state.gov")
            == "Always on state.gov adds state.gov to your passport. That covers every page of state.gov.")
        #expect(IdentityCheckCopy.addSiteReason(itemLabel: "Chase", noun: "sign-in") == "A new site for your Chase sign-in.")
        #expect(IdentityCheckCopy.title == "One more check")
    }

    @Test func theAskCardsWords() {
        let signIn = SecureRequestInput(kind: .signIn, site: "springfieldwater.gov", reason: "To pay the water bill.")
        #expect(SecureRequestCopy.title(signIn, existing: nil) == "Add your sign-in for springfieldwater.gov")
        let chase = SecureItemView(id: "sec-chase", kind: .signIn, label: "Chase", sites: ["chase.com"])
        #expect(SecureRequestCopy.title(signIn, existing: chase) == "Replace your sign-in for springfieldwater.gov")
        #expect(SecureRequestCopy.note(signIn) == "Albatross uses it on springfieldwater.gov and never shows it.")
        #expect(SecureRequestCopy.saved(site: "springfieldwater.gov") == "Saved. Albatross can use it on springfieldwater.gov.")
        let key = SecureRequestInput(kind: .apiKey, label: "OpenAI", site: "api.openai.com", reason: "")
        #expect(SecureRequestCopy.title(key, existing: nil) == "Add your OpenAI key")
        let license = SecureRequestInput(kind: .idNumber, label: "Driver's license", reason: "The form asks for it.")
        #expect(SecureRequestCopy.title(license, existing: nil) == "Add your driver's license")
        #expect(SecureRequestCopy.note(license) == "Albatross asks you before it uses it on a new site.")
        let dob = SecureRequestInput(kind: .dateOfBirth, reason: "The form asks for it.")
        #expect(SecureRequestCopy.title(dob, existing: nil) == "Add your date of birth")
        #expect(SecureRequestCopy.saved(site: nil) == "Saved. Albatross can use it where you allow.")
        if case .newID(let type, let number) = SecureRequestCard.target(for: license, existing: nil) {
            #expect(type == .driversLicense)
            #expect(number == nil)
        } else {
            Issue.record("expected the ID sheet")
        }
        if case .replace(let item, let field) = SecureRequestCard.target(for: signIn, existing: chase) {
            #expect(item.id == "sec-chase")
            #expect(field == "password")
        } else {
            Issue.record("expected the replace sheet")
        }
        if case .newSignIn(let site, _) = SecureRequestCard.target(for: signIn, existing: nil) {
            #expect(site == "springfieldwater.gov")
        } else {
            Issue.record("expected the sign-in sheet")
        }
        // A site the model named is a suggestion; an ID has no site to suggest.
        #expect(SecureRequestCard.siteSource(for: signIn) == .suggested)
        #expect(SecureRequestCard.siteSource(for: key) == .suggested)
        #expect(SecureRequestCard.siteSource(for: SecureRequestInput(kind: .signIn, reason: "Sign in.")) == .user)
        #expect(SecureRequestCard.siteSource(for: license) == .user)
        #expect(SecureRequestCard.siteSource(for: dob) == .user)
    }

    @Test func theQuestionKindRendersTheAskCard() {
        #expect(AssistantQuestionPart.Kind(rawValue: "ask_secure_detail") == .secureDetail)
        let part = AssistantQuestionPart(id: "question-1", toolCallID: "call-1", kind: .secureDetail, input: .object([:]), answer: nil)
        #expect(part.toolName == "ask_secure_detail")
        #expect(!part.isAnswered)
    }
}
