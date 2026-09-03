import Foundation
import Testing
@testable import Lab86Mail

// Sender rows print the human name; photo URLs resolve even when the server
// answers with a site-relative logo path.
struct IdentityAndDisplayNameTests {
    @Test func displayNameStripsTheAddressFromNamedHeaders() {
        #expect(EmailTextNormalizer.displayName(from: "Venmo <venmo@venmo.com>") == "Venmo")
        #expect(EmailTextNormalizer.displayName(from: "\"Owl House\" <hi@tock.com>") == "Owl House")
        #expect(
            EmailTextNormalizer.displayName(
                from: "Dreamforce <email_at_mail_salesforce_com_x@privaterelay.appleid.com>"
            ) == "Dreamforce"
        )
    }

    @Test func displayNameKeepsBareAddressesWhole() {
        #expect(EmailTextNormalizer.displayName(from: "noreply@speedpay.com") == "noreply@speedpay.com")
        #expect(EmailTextNormalizer.displayName(from: "<hello@apify.com>") == "hello@apify.com")
        #expect(EmailTextNormalizer.displayName(from: "  ") == nil)
    }

    @Test func threadSummaryPrefersTheParsedDisplayName() {
        let thread = MailThreadSummary(
            id: "t1",
            accountID: "a1",
            subject: "Hello",
            sender: "Billing <billing@vendor.com>",
            snippet: "…",
            date: Date(timeIntervalSince1970: 2_000_000_000),
            unread: true,
            starred: false
        )
        #expect(thread.senderDisplayName == "Billing")
        #expect(thread.senderEmail == "billing@vendor.com")
    }

    @Test func photoURLsResolveRelativeLogoPathsAgainstTheBackend() throws {
        let base = try #require(URL(string: "https://mail.lab86.io"))
        #expect(
            MailIdentityStore.photoURL(from: "/api/logos/venmo.com", baseURL: base)?.absoluteString
                == "https://mail.lab86.io/api/logos/venmo.com"
        )
        #expect(
            MailIdentityStore.photoURL(from: "https://img.example.com/a.png", baseURL: base)?.absoluteString
                == "https://img.example.com/a.png"
        )
        // Relative with no origin to resolve against is a genuine miss.
        #expect(MailIdentityStore.photoURL(from: "/api/logos/venmo.com", baseURL: nil) == nil)
        #expect(MailIdentityStore.photoURL(from: "", baseURL: base) == nil)
    }
}
