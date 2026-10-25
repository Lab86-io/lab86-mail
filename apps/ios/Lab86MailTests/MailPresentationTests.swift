import Foundation
import Testing
@testable import Lab86Mail

// The mail views mirror the web's model (lib/mail/navigation.ts): four
// primary views in the strip, the rest under More, the web's ids as raw
// values. Also single-ownership of the global create control.
struct MailPresentationTests {
    // MARK: - The view set

    @Test
    func primaryViewsAreTheWebStripInOrder() {
        #expect(MailCategoryScope.primary == [.main, .needsReply, .noise, .codes])
        #expect(MailCategoryScope.primary.map(\.title) == ["Main", "Needs reply", "Noise", "Codes"])
    }

    @Test
    func moreViewsAreTheWebMenuInOrder() {
        #expect(MailCategoryScope.more == [.needsAction, .waitingFor, .importantChanges, .orders, .financeAdmin, .review])
        #expect(MailCategoryScope.more.map(\.title) == [
            "Needs action", "Waiting for", "Changes", "Orders", "Finance / admin", "Review",
        ])
    }

    @Test
    func rawValuesAreTheWebCategoryIDs() {
        #expect(MailCategoryScope.needsReply.rawValue == "needs_reply")
        #expect(MailCategoryScope.needsAction.rawValue == "needs_action")
        #expect(MailCategoryScope.waitingFor.rawValue == "waiting_for")
        #expect(MailCategoryScope.importantChanges.rawValue == "important_changes")
        #expect(MailCategoryScope.financeAdmin.rawValue == "finance_admin")
        for scope in MailCategoryScope.primary + MailCategoryScope.more {
            #expect(MailCategoryScope.allCases.contains(scope))
        }
        // All mail stays for links minted before this round; it is not a pill.
        #expect(!MailCategoryScope.primary.contains(.all))
        #expect(!MailCategoryScope.more.contains(.all))
        #expect(MailCategoryScope.all.title == "All mail")
    }

    @Test
    func noTitleIsInAllCapsAndNoneRepeatsAnother() {
        let titles = MailCategoryScope.allCases.map(\.title)
        #expect(Set(titles).count == titles.count)
        for title in titles {
            #expect(title != title.uppercased())
        }
    }

    @Test
    func correctionPresentsOnlyClassifierDestinations() {
        // All mail is a viewing scope, never a correction target. Noise is a
        // destination (CLS-9) so promotions can leave Main on native too.
        #expect(MailCategoryCorrection.allCases == [.main, .codes, .orders, .noise])
    }

    @Test
    func everyViewHasASymbolAndAFilledOrSameSelectedVariant() {
        for scope in MailCategoryScope.allCases {
            #expect(!scope.symbol.isEmpty)
            #expect(scope.selectedSymbol == scope.symbol || scope.selectedSymbol == "\(scope.symbol).fill")
        }
        #expect(MailCategoryScope.codes.selectedSymbol == "key.fill")
        #expect(MailCategoryScope.waitingFor.selectedSymbol == "hourglass")
    }

    // MARK: - Stored classification → visible view

    @Test
    func mainIsAMainVerdictOrNoVerdictYet() {
        for stored in ["main", nil] {
            #expect(MailCategoryScope.main.includes(storedCategory: stored))
            #expect(MailCategoryScope.all.includes(storedCategory: stored))
        }
        for stored in ["needs_reply", "review", "finance_admin", "noise", "codes", "orders"] {
            #expect(!MailCategoryScope.main.includes(storedCategory: stored))
            #expect(MailCategoryScope.all.includes(storedCategory: stored))
        }
    }

    @Test
    func eachViewShowsItsOwnPrimaryOrSecondaryVerdict() {
        #expect(MailCategoryScope.needsReply.includes(storedCategory: "needs_reply"))
        #expect(MailCategoryScope.needsReply.includes(storedCategory: "main", secondary: ["needs_reply"]))
        #expect(!MailCategoryScope.needsReply.includes(storedCategory: "main", secondary: ["orders"]))
        #expect(MailCategoryScope.noise.includes(storedCategory: "noise"))
        #expect(!MailCategoryScope.noise.includes(storedCategory: "main"))
        #expect(MailCategoryScope.review.includes(storedCategory: "review"))
        #expect(MailCategoryScope.financeAdmin.includes(storedCategory: "finance_admin"))
        #expect(MailCategoryScope.codes.includes(storedCategory: "codes"))
        #expect(!MailCategoryScope.codes.includes(storedCategory: "orders"))
        #expect(MailCategoryScope.orders.includes(storedCategory: "main", secondary: ["orders"]))
    }

    @Test
    func mailFiledUnderALabelLeavesEveryViewButAllMail() {
        let filed = "custom:smart-label-dev-ops"
        for scope in MailCategoryScope.allCases where scope != .all {
            #expect(!scope.includes(storedCategory: filed))
            #expect(!scope.includes(storedCategory: filed, secondary: [scope.rawValue]))
        }
        #expect(MailCategoryScope.all.includes(storedCategory: filed))
        #expect(MailCategoryScope.storedTitle(filed) == "Filed under your label")
        #expect(MailCategoryScope.storedTitle("finance_admin") == "Finance Admin")
        #expect(MailCategoryScope.storedTitle(nil) == "Unclassified")
    }

    @Test
    func mainPagesTheUnifiedListAndOtherViewsPageByTheirID() {
        #expect(MailCategoryScope.main.serverCategory == nil)
        #expect(MailCategoryScope.all.serverCategory == nil)
        #expect(MailCategoryScope.needsReply.serverCategory == "needs_reply")
        #expect(MailCategoryScope.noise.serverCategory == "noise")
        #expect(MailCategoryScope.codes.serverCategory == "codes")
        #expect(MailCategoryScope.financeAdmin.serverCategory == "finance_admin")
    }

    // MARK: - Raw routing values (sidebar taps, deep links, stored prefs)

    @Test
    func pendingCategoryRoutingMapsEveryWebIDAndFallsBackToMain() {
        #expect(MailCategoryScope.from(raw: "main") == .main)
        #expect(MailCategoryScope.from(raw: "codes") == .codes)
        #expect(MailCategoryScope.from(raw: "orders") == .orders)
        #expect(MailCategoryScope.from(raw: "all") == .all)
        #expect(MailCategoryScope.from(raw: "needs_reply") == .needsReply)
        #expect(MailCategoryScope.from(raw: "review") == .review)
        #expect(MailCategoryScope.from(raw: "finance_admin") == .financeAdmin)
        #expect(MailCategoryScope.from(raw: "noise") == .noise)
        #expect(MailCategoryScope.from(raw: "waiting_for") == .waitingFor)
        // Unknown and missing values default to the primary destination.
        #expect(MailCategoryScope.from(raw: "someday_new") == .main)
        #expect(MailCategoryScope.from(raw: nil) == .main)
        #expect(MailCategoryScope.from(raw: "") == .main)
    }

    // MARK: - Global create ownership

    @Test
    func floatingCreateButtonYieldsToMailAndChatOwnedChrome() {
        // Mail mounts the menu in its bottom toolbar; the floating copy must
        // not double it. Chat's composer owns the corner.
        #expect(!GlobalCreateMenuPolicy.showsFloatingButton(selectedTab: .mail, hasNestedDestination: false))
        #expect(!GlobalCreateMenuPolicy.showsFloatingButton(selectedTab: .chat, hasNestedDestination: false))
        #expect(!GlobalCreateMenuPolicy.showsFloatingButton(selectedTab: .files, hasNestedDestination: false))
        for tab: PrimaryTab in [.today, .tasks, .calendar, .work] {
            #expect(GlobalCreateMenuPolicy.showsFloatingButton(selectedTab: tab, hasNestedDestination: false))
            #expect(!GlobalCreateMenuPolicy.showsFloatingButton(selectedTab: tab, hasNestedDestination: true))
        }
    }
}
