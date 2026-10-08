import Foundation
import Testing
@testable import Lab86Mail

// The client-side site cleaning: what the sheet shows as "Saved as …". The
// server reduces a host to its registrable domain; the client only cleans.
struct SecureSiteTests {
    @Test func cleaningStripsEverythingButTheHost() {
        #expect(SecureSite.clean("https://secure.chase.com/login") == "secure.chase.com")
        #expect(SecureSite.clean("HTTP://WWW.Chase.com") == "chase.com")
        #expect(SecureSite.clean("chase.com") == "chase.com")
        #expect(SecureSite.clean("  chase.com/  ") == "chase.com")
        #expect(SecureSite.clean("//dmv.ny.gov/renew?step=2#top") == "dmv.ny.gov")
        #expect(SecureSite.clean("user:pass@api.openai.com:443/v1") == "api.openai.com")
        #expect(SecureSite.clean("api.openai.com.") == "api.openai.com")
        #expect(SecureSite.clean("") == "")
        #expect(SecureSite.clean("https://") == "")
    }

    @Test func plausibleHostsHaveADotAndHostCharacters() {
        #expect(SecureSite.isPlausible("chase.com"))
        #expect(SecureSite.isPlausible("dmv.ny.gov"))
        #expect(SecureSite.isPlausible("api-staging.openai.com"))
        #expect(!SecureSite.isPlausible("chase"))
        #expect(!SecureSite.isPlausible("chase com"))
        #expect(!SecureSite.isPlausible("chase..com"))
        #expect(!SecureSite.isPlausible(".chase.com"))
        #expect(!SecureSite.isPlausible("chase.com/login"))
    }

    @Test func theSuggestedSiteWarningShowsUntilTheUserEdits() {
        // The model named the site in the chat: warn until the user touches it.
        #expect(SecureSite.showsSuggestedSiteWarning(source: .suggested, edited: false))
        #expect(!SecureSite.showsSuggestedSiteWarning(source: .suggested, edited: true))
        // The user's own site, or the page a run opened: no line.
        #expect(!SecureSite.showsSuggestedSiteWarning(source: .user, edited: false))
        #expect(!SecureSite.showsSuggestedSiteWarning(source: .user, edited: true))
        #expect(!SecureSite.showsSuggestedSiteWarning(source: .run, edited: false))
    }

    @Test func aSiteCoversEveryHostUnderIt() {
        #expect(SecureSite.covers(site: "chase.com", host: "chase.com"))
        #expect(SecureSite.covers(site: "chase.com", host: "secure.chase.com"))
        #expect(SecureSite.covers(site: "ny.gov", host: "https://dmv.ny.gov/renew"))
        #expect(!SecureSite.covers(site: "chase.com", host: "chase.com.example"))
        #expect(!SecureSite.covers(site: "chase.com", host: "notchase.com"))
        #expect(!SecureSite.covers(site: "", host: "chase.com"))
    }
}
