import Foundation
import Testing
@testable import Lab86Mail

// Stage 2 iOS 0.8 parity: the simplified visible category set, presentation-
// time mapping of retired stored labels, and single-ownership of the global
// create control.
struct MailPresentationTests {
    // MARK: - Visible category set

    @Test
    func visibleCategoryOrderIsMainCodesOrdersThenAllMailLast() {
        #expect(MailCategoryScope.allCases == [.main, .codes, .orders, .all])
    }

    @Test
    func retiredCategoryLabelsAreGoneFromEveryVisibleTitle() {
        let titles = Set(MailCategoryScope.allCases.map(\.title))
        #expect(titles == ["Main", "Codes", "Orders", "All Mail"])
        for retired in ["Needs Reply", "Review", "Finance & Admin", "Noise"] {
            #expect(!titles.contains(retired))
        }
    }

    @Test
    func correctionPresentsOnlyClassifierDestinations() {
        // All Mail is a viewing scope, never a correction target.
        #expect(MailCategoryScope.feedbackCases == [.main, .codes, .orders])
    }

    @Test
    func categorySymbolsMatchTheSpecAndSelectedVariantsAreFilled() {
        #expect(MailCategoryScope.main.symbol == "person.crop.circle")
        #expect(MailCategoryScope.codes.symbol == "key")
        #expect(MailCategoryScope.orders.symbol == "shippingbox")
        #expect(MailCategoryScope.all.symbol == "tray.full")
        for scope in MailCategoryScope.allCases {
            #expect(scope.selectedSymbol == "\(scope.symbol).fill")
        }
    }

    // MARK: - Stored classification → visible scope

    @Test
    func mainIsTheCatchAllForLegacyAndUnclassifiedMail() {
        for stored in ["main", "needs_reply", "review", "finance_admin", nil] {
            #expect(MailCategoryScope.main.includes(storedCategory: stored))
            #expect(!MailCategoryScope.codes.includes(storedCategory: stored))
            #expect(!MailCategoryScope.orders.includes(storedCategory: stored))
            #expect(MailCategoryScope.all.includes(storedCategory: stored))
        }
    }

    @Test
    func codesAndOrdersOnlyShowTheirOwnMail() {
        #expect(MailCategoryScope.codes.includes(storedCategory: "codes"))
        #expect(!MailCategoryScope.codes.includes(storedCategory: "orders"))
        #expect(MailCategoryScope.orders.includes(storedCategory: "orders"))
        #expect(!MailCategoryScope.orders.includes(storedCategory: "codes"))
        #expect(!MailCategoryScope.main.includes(storedCategory: "codes"))
        #expect(!MailCategoryScope.main.includes(storedCategory: "orders"))
    }

    @Test
    func noiseIsSuppressedFromMainButPresentInAllMail() {
        #expect(!MailCategoryScope.main.includes(storedCategory: "noise"))
        #expect(MailCategoryScope.all.includes(storedCategory: "noise"))
        #expect(!MailCategoryScope.codes.includes(storedCategory: "noise"))
        #expect(!MailCategoryScope.orders.includes(storedCategory: "noise"))
    }

    // MARK: - Raw routing values (sidebar taps, deep links, stored prefs)

    @Test
    func pendingCategoryRoutingMapsCurrentAndRetiredRawValues() {
        #expect(MailCategoryScope.from(raw: "main") == .main)
        #expect(MailCategoryScope.from(raw: "codes") == .codes)
        #expect(MailCategoryScope.from(raw: "orders") == .orders)
        #expect(MailCategoryScope.from(raw: "all") == .all)
        // Retired mailboxes land where their mail now lives.
        #expect(MailCategoryScope.from(raw: "needs_reply") == .main)
        #expect(MailCategoryScope.from(raw: "review") == .main)
        #expect(MailCategoryScope.from(raw: "finance_admin") == .main)
        #expect(MailCategoryScope.from(raw: "noise") == .all)
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
        for tab: PrimaryTab in [.today, .tasks, .calendar, .work] {
            #expect(GlobalCreateMenuPolicy.showsFloatingButton(selectedTab: tab, hasNestedDestination: false))
            #expect(!GlobalCreateMenuPolicy.showsFloatingButton(selectedTab: tab, hasNestedDestination: true))
        }
    }
}
