#if os(macOS)
import Foundation
import Testing
@testable import Lab86Mail

// The Mac source list: label rows (NAT-4) and New Area (NAT-9).
struct MacSourceListTests {
    @Test
    func theMailRowIsSelectedOnlyWhileNoLabelViewIsUp() {
        #expect(MacSourceSelection.isPrimarySelected(.mail, selectedTab: .mail, areaID: nil, mailLabelID: nil))
        #expect(!MacSourceSelection.isPrimarySelected(.mail, selectedTab: .mail, areaID: nil, mailLabelID: "l1"))
        #expect(!MacSourceSelection.isPrimarySelected(.mail, selectedTab: .today, areaID: nil, mailLabelID: nil))
        // A label view does not change the other rows.
        #expect(MacSourceSelection.isPrimarySelected(.today, selectedTab: .today, areaID: nil, mailLabelID: "l1"))
        // An open Area belongs to its own row, not to Areas.
        #expect(MacSourceSelection.isPrimarySelected(.work, selectedTab: .work, areaID: nil, mailLabelID: nil))
        #expect(!MacSourceSelection.isPrimarySelected(.work, selectedTab: .work, areaID: "a1", mailLabelID: nil))
    }

    @Test
    func aLabelRowIsSelectedWhileMailShowsThatLabel() {
        #expect(MacSourceSelection.isLabelSelected("l1", selectedTab: .mail, mailLabelID: "l1"))
        #expect(!MacSourceSelection.isLabelSelected("l1", selectedTab: .mail, mailLabelID: "l2"))
        #expect(!MacSourceSelection.isLabelSelected("l1", selectedTab: .mail, mailLabelID: nil))
        // A stale label id from an earlier Mail visit selects nothing elsewhere.
        #expect(!MacSourceSelection.isLabelSelected("l1", selectedTab: .today, mailLabelID: "l1"))
    }

    @Test
    func aLabelRowOpensTheMailListOnThatLabel() {
        let label = MailLabelSummary(id: "l1", name: "Receipts")
        let raw = MacSourceSelection.mailCategory(forLabel: label)
        #expect(raw == "custom:l1")
        let selection = MailScopeSelection.from(raw: raw)
        #expect(selection.labelID == "l1")
        #expect(selection.listScope(accountScope: []) == MailListScope(accountID: nil, category: "custom:l1"))
    }

    @Test
    func theMailRowGoesBackToMainFromALabelView() {
        #expect(MacSourceSelection.mailCategory(forPrimary: .mail, mailLabelID: "l1") == "main")
        #expect(MailScopeSelection.from(raw: "main") == MailScopeSelection(category: .main))
        #expect(MacSourceSelection.mailCategory(forPrimary: .mail, mailLabelID: nil) == nil)
        #expect(MacSourceSelection.mailCategory(forPrimary: .today, mailLabelID: "l1") == nil)
    }

    @Test
    @MainActor
    func aLabelRowTapLeavesTheOpenThreadAndAsksMailForTheLabel() {
        let navigation = NavigationModel()
        navigation.openThread(accountID: "a1", threadID: "t1")
        let label = MailLabelSummary(id: "l1", name: "Receipts")
        navigation.selectPrimary(.mail)
        navigation.pendingMailCategory = MacSourceSelection.mailCategory(forLabel: label)
        #expect(navigation.selectedTab == .mail)
        #expect(navigation.threadRoute == nil)
        #expect(navigation.pendingMailCategory == "custom:l1")
    }

    // MARK: - New Area (NAT-9)

    @Test
    func aNewAreaNameIsTrimmedAndBounded() {
        #expect(MacNewArea.cleanName("  Garden \n") == "Garden")
        #expect(MacNewArea.cleanName("   ") == nil)
        #expect(MacNewArea.cleanName("") == nil)
        let long = String(repeating: "a", count: 200)
        #expect(MacNewArea.cleanName(long)?.count == MacNewArea.maxLength)
    }
}
#endif
