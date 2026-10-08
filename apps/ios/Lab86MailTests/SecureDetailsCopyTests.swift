import Foundation
import Testing
@testable import Lab86Mail

// Every word of Passwords and IDs, checked against the copy rules: never
// "AI", "assistant", or "agent"; never "confirm" or "verify" (decision 9);
// sentence case; and the lines that name sites and items read right.
struct SecureDetailsCopyTests {
    private static let banned = ["\\bAI\\b", "\\bassistant\\b", "\\bagent\\b", "\\bconfirm", "\\bverif"]

    private static var everyLine: [String] {
        let license = SecureItemView(
            id: "sec-license", kind: .idNumber, label: "Driver's license", sites: ["ny.gov", "geico.example"],
            hints: ["number": "ends 4821"], facts: ["type": "drivers_license", "region": "NY"]
        )
        let chase = SecureItemView(id: "sec-chase", kind: .signIn, label: "Chase", sites: ["chase.com"], hints: ["username": "s•••@example.com", "password": "••••"])
        let key = SecureItemView(id: "sec-key", kind: .apiKey, label: "OpenAI", sites: ["api.openai.com"], hints: ["key": "sk-…f3a2"])
        let dob = SecureItemView(id: "sec-dob", kind: .dateOfBirth, label: "Date of birth")
        let request = SecureAllowRequest(itemID: "sec-license", kind: .idNumber, itemLabel: "Driver's license", fieldLabels: ["Number", "Expiry date"], site: "ny.gov", host: "dmv.ny.gov")
        let ask = SecureRequestInput(kind: .signIn, site: "springfieldwater.gov", reason: "To pay the water bill, Albatross needs to sign in.")
        return [
            SecureDetailsCopy.title, SecureDetailsCopy.intro, SecureDetailsCopy.signInsFooter, SecureDetailsCopy.idsFooter,
            SecureDetailsCopy.keysFooter, SecureDetailsCopy.refusalFooter, SecureDetailsCopy.addSignIn, SecureDetailsCopy.addID,
            SecureDetailsCopy.addKey, SecureDetailsCopy.neverShown, SecureDetailsCopy.noSitesYet, SecureDetailsCopy.lastSite,
            SecureDetailsCopy.lastHost, SecureDetailsCopy.usesFooter, SecureDetailsCopy.idFooter, SecureDetailsCopy.ssnFooter,
            SecureDetailsCopy.dobFooter, SecureDetailsCopy.replaceFooter, SecureDetailsCopy.addSiteFooter,
            SecureDetailsCopy.addHostFooter, SecureDetailsCopy.siteCovers, SecureDetailsCopy.headerHelp,
            SecureDetailsCopy.suggestedSite, SecureDetailsCopy.suggestedHost,
            SecureDetailsCopy.signInFooter(site: "chase.com"), SecureDetailsCopy.keyFooter(host: "api.openai.com"),
            SecureDetailsCopy.deleteMessage(license), SecureDetailsCopy.deleteMessage(chase), SecureDetailsCopy.deleteMessage(key),
            SecureDetailsCopy.deleteMessage(dob), SecureDetailsCopy.deleteTitle(license), SecureDetailsCopy.deleteTitle(chase),
            SecureDetailsCopy.sitesFooter(.signIn), SecureDetailsCopy.sitesFooter(.idNumber), SecureDetailsCopy.sitesFooter(.apiKey),
            SecureDetailsCopy.accessibilityLabel(license), SecureDetailsCopy.accessibilityLabel(chase),
            SecureDetailsCopy.enterSite, SecureDetailsCopy.siteShape, SecureDetailsCopy.ssnDigits, SecureDetailsCopy.keyShort,
            SecureDetailsCopy.dateOfBirthExists,
            SecureSaveError.cardLine, SecureSaveError.codeLine, SecureSaveError.bankLine, SecureSaveError.refusedLine,
            SecureSaveError.limitLine, SecureSaveError.closedLine, SecureSaveError.offLine, SecureSaveError.notFoundLine,
            SecureSaveError.checkLine, SecureSaveError.saveFailedLine,
            IdentityCheckCopy.title, IdentityCheckCopy.footer, IdentityCheckCopy.cancelledAllow, IdentityCheckCopy.cancelledSite,
            IdentityCheckCopy.deviceFailed, IdentityCheckCopy.deviceFailedSite, IdentityCheckCopy.openWeb,
            IdentityCheckCopy.allowOnceReason(itemLabel: "Driver's license", host: "dmv.ny.gov"),
            IdentityCheckCopy.allowAlwaysReason(itemLabel: "Driver's license", site: "ny.gov", host: "dmv.ny.gov"),
            IdentityCheckCopy.addSiteReason(itemLabel: "Chase", noun: "sign-in"),
            IdentityCheckSheetCopy.oneMoment, IdentityCheckSheetCopy.passkey, IdentityCheckSheetCopy.sendCodeInstead,
            IdentityCheckSheetCopy.totp, IdentityCheckSheetCopy.password, IdentityCheckSheetCopy.codeWrong,
            IdentityCheckSheetCopy.passwordWrong, IdentityCheckSheetCopy.sendFailed, IdentityCheckSheetCopy.code(sentTo: "s•••@example.com"),
            SecureAllowCopy.allowOnce, SecureAllowCopy.alwaysOnThisSite, SecureAllowCopy.doNotAllow, SecureAllowCopy.needsCheck,
            SecureAllowCopy.sendFailed, SecureAllowCopy.title(request), SecureAllowCopy.reason(request),
            SecureAllowCopy.receipt(.once, site: "ny.gov"), SecureAllowCopy.saveSignInOffer(site: "chase.com"),
            SecureAllowCopy.signInSaved, SecureAllowCopy.saveSignIn,
            SecureRequestCopy.title(ask, existing: nil), SecureRequestCopy.note(ask), SecureRequestCopy.saved(site: "springfieldwater.gov"),
            SecureRequestCopy.replaced, SecureRequestCopy.unavailableTitle, SecureRequestCopy.unavailable,
            ComposerNoticeCopy.saveAction, ComposerNoticeCopy.sendWithout, ComposerNoticeCopy.savedLine,
            ComposerNoticeCopy.line(.ssn), ComposerNoticeCopy.line(.card), ComposerNoticeCopy.line(.apiKey),
            SavedSignInsCopy.title, SavedSignInsCopy.explanation, SavedSignInsCopy.trustFooter, SavedSignInsCopy.forgetTitle,
            SavedSignInsCopy.forgetDetail, SavedSignInsCopy.forgotten,
        ]
    }

    @Test func noBannedWords() {
        for line in Self.everyLine {
            for pattern in Self.banned {
                let hit = line.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
                #expect(!hit, "\(line) contains \(pattern)")
            }
        }
    }

    @Test func sentenceCaseEverywhere() {
        for line in Self.everyLine {
            guard let first = line.first else { continue }
            // A line may start with a host ("dmv.ny.gov asks for the number.").
            let startsWithHost = line.split(separator: " ").first?.contains(".") == true
            #expect(first.isUppercase || first.isNumber || startsWithHost, "\(line) does not start with a capital")
            // No ALL-CAPS labels. An acronym (ID, API) is fine; a whole line is not.
            let letters = line.filter(\.isLetter)
            #expect(letters.count < 4 || letters != letters.uppercased(), "\(line) is all capitals")
        }
    }

    @Test func rowsSayWhatTheyHoldWithoutAValue() {
        let chase = SecureItemView(id: "sec-chase", kind: .signIn, label: "Chase", sites: ["chase.com"], hints: ["username": "s•••@example.com", "password": "••••"])
        #expect(SecureDetailsCopy.detailLine(chase) == "chase.com · s•••@example.com · ••••")
        let license = SecureItemView(id: "sec-license", kind: .idNumber, label: "Driver's license", sites: ["ny.gov", "geico.example"], hints: ["number": "ends 4821"], facts: ["region": "NY"])
        #expect(SecureDetailsCopy.detailLine(license) == "NY · ends 4821 · 2 sites")
        let dob = SecureItemView(id: "sec-dob", kind: .dateOfBirth, label: "Date of birth")
        #expect(SecureDetailsCopy.detailLine(dob) == "Saved")
        let key = SecureItemView(id: "sec-key", kind: .apiKey, label: "OpenAI", sites: ["api.openai.com"], hints: ["key": "sk-…f3a2"])
        #expect(SecureDetailsCopy.detailLine(key) == "api.openai.com · sk-…f3a2")
        #expect(SecureDetailsCopy.usedLine(nil) == "Not used yet")
        #expect(SecureDetailsCopy.usedLine(Date(timeIntervalSince1970: 1_759_700_000), locale: Locale(identifier: "en_US")).hasPrefix("Used Oct "))
        #expect(SecureDetailsCopy.sitesCount(1) == "1 site")
        #expect(SecureDetailsCopy.sitesCount(3) == "3 sites")
        #expect(SecureDetailsCopy.spoken(hint: "ends 4821", field: "number") == "number, ends in 4, 8, 2, 1")
        #expect(SecureDetailsCopy.spoken(hint: "••••", field: "password") == "password saved")
        #expect(SecureDetailsCopy.spoken(hint: "sk-…f3a2", field: "key") == "key, ends in f, 3, a, 2")
        let spoken = SecureDetailsCopy.accessibilityLabel(license, locale: Locale(identifier: "en_US"))
        #expect(spoken.hasPrefix("Driver's license, NY, number, ends in 4, 8, 2, 1, 2 sites, not used yet."))
        #expect(!spoken.contains("•"))
        #expect(SecureDetailsCopy.ends("A 123-4821") == "Ends 4821")
        #expect(SecureDetailsCopy.ends("12") == nil)
        #expect(SecureDetailsCopy.keyCaption("sk-abcdef3a2") == "Ends f3a2 · 12 characters")
        #expect(SecureDetailsCopy.keyCaption("") == nil)
        #expect(SecureDetailsCopy.characters(1) == "1 character")
        #expect(SecureDetailsCopy.savedAs("secure.chase.com") == "Saved as secure.chase.com")
        #expect(SecureDetailsCopy.replaceTitle(field: "password") == "Replace the password")
        #expect(SecureDetailsCopy.replaceTitle(field: "name_on_id") == "Replace the name on the ID")
        #expect(SecureDetailsCopy.everyPage("ny.gov") == "Every page of ny.gov")
    }

    @Test func deletionSaysWhatStops() {
        let chase = SecureItemView(id: "sec-chase", kind: .signIn, label: "Chase", sites: ["chase.com"])
        #expect(SecureDetailsCopy.deleteTitle(chase) == "Delete the Chase sign-in?")
        #expect(SecureDetailsCopy.deleteMessage(chase) == "Albatross can no longer sign in to chase.com for you. A run that needs it stops and asks you.")
        let license = SecureItemView(id: "sec-license", kind: .idNumber, label: "Driver's license", sites: ["ny.gov", "geico.example"])
        #expect(SecureDetailsCopy.deleteTitle(license) == "Delete your driver's license?")
        #expect(SecureDetailsCopy.deleteMessage(license) == "Albatross can no longer type it on ny.gov and 1 other site. A form that needs it asks you.")
        let ssn = SecureItemView(id: "sec-ssn", kind: .idNumber, label: "Social Security number")
        #expect(SecureDetailsCopy.deleteTitle(ssn) == "Delete your Social Security number?")
        #expect(SecureDetailsCopy.deleteMessage(ssn) == "A form that needs it asks you.")
        let key = SecureItemView(id: "sec-key", kind: .apiKey, label: "OpenAI", sites: ["api.openai.com"])
        #expect(SecureDetailsCopy.deleteTitle(key) == "Delete the OpenAI key?")
        #expect(SecureDetailsCopy.deleteMessage(key) == "Albatross can no longer call api.openai.com for you.")
        #expect(SecureDetailsCopy.deleteRow(.dateOfBirth) == "Delete your date of birth")
    }

    @Test func theSignedInSitesRenameKeepsItsPromise() {
        #expect(SavedSignInsCopy.title == "Signed-in sites")
        #expect(SavedSignInsCopy.explanation.contains("Albatross never sees a password."))
        #expect(SavedSignInsCopy.trustFooter.contains("Passwords and IDs"))
        #expect(SecureDetailsCopy.refusalFooter.contains("Signed-in sites"))
    }
}
