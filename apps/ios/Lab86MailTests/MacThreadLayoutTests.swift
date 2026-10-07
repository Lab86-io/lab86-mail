#if os(macOS)
import Foundation
import Testing
@testable import Lab86Mail

// The Albatross thread window on the Mac: when the trailing pane may open,
// how wide it is, when the source list gives way, how the pane follows the
// page, the View menu items, and the page sheet of a narrow window. The
// shared thread rules are in RunBlockPresentationTests; these are the Mac
// additions.
@MainActor
struct MacThreadLayoutTests {
    // MARK: - Room

    @Test func thePaneNeedsANineSixtyPointColumn() {
        #expect(!MacThreadLayout.allowsPane(width: 959))
        #expect(MacThreadLayout.allowsPane(width: 960))
    }

    @Test func thePaneTakesAboutHalfTheColumnWithinItsBand() {
        #expect(MacThreadLayout.paneWidth(for: 960) == 499)
        #expect(MacThreadLayout.paneWidth(for: 800) == MacThreadLayout.paneMinWidth)
        #expect(MacThreadLayout.paneWidth(for: 1_600) == MacThreadLayout.paneIdealMax)
        #expect(MacThreadLayout.paneIdealMax < MacThreadLayout.paneMaxWidth)
    }

    @Test func theSourceListGivesWayOnlyWhenThatMakesRoom() {
        // A wide window holds the pane with the source list.
        #expect(MacThreadLayout.room(windowWidth: 1_440, sidebarShown: true) == .pane)
        // A window that holds the pane only without the source list.
        #expect(MacThreadLayout.room(windowWidth: 1_100, sidebarShown: true) == .collapseSidebarFirst)
        #expect(MacThreadLayout.room(windowWidth: 1_100, sidebarShown: false) == .pane)
        // A narrow window: the sheet and the popover.
        #expect(MacThreadLayout.room(windowWidth: 900, sidebarShown: true) == .none)
        #expect(MacThreadLayout.room(windowWidth: 900, sidebarShown: false) == .none)
        #expect(MacThreadLayout.room(windowWidth: 760, sidebarShown: true) == .none)
    }

    // MARK: - The pane and the page

    @Test func aNewPageTakesThePaneAndDisplacesTheDetails() {
        #expect(MacThreadLayout.paneAfterPageChange(current: .none, hasPage: true, allowsPane: true) == .page)
        #expect(MacThreadLayout.paneAfterPageChange(current: .details, hasPage: true, allowsPane: true) == .page)
        #expect(MacThreadLayout.paneAfterPageChange(current: .page, hasPage: true, allowsPane: true) == .page)
    }

    @Test func aClosedPageTakesItsPaneAndLeavesTheDetails() {
        #expect(MacThreadLayout.paneAfterPageChange(current: .page, hasPage: false, allowsPane: true) == .none)
        #expect(MacThreadLayout.paneAfterPageChange(current: .details, hasPage: false, allowsPane: true) == .details)
        #expect(MacThreadLayout.paneAfterPageChange(current: .none, hasPage: false, allowsPane: true) == .none)
    }

    @Test func noRoomMeansNoPane() {
        #expect(MacThreadLayout.paneAfterPageChange(current: .none, hasPage: true, allowsPane: false) == .none)
        #expect(MacThreadLayout.paneAfterWidthChange(current: .page, allowsPane: false) == .none)
        #expect(MacThreadLayout.paneAfterWidthChange(current: .details, allowsPane: false) == .none)
        #expect(MacThreadLayout.paneAfterWidthChange(current: .page, allowsPane: true) == .page)
    }

    @Test func aToggleOpensSwitchesOrCloses() {
        #expect(MacThreadLayout.paneAfterToggle(.page, current: .none, canShowPage: true) == .page)
        #expect(MacThreadLayout.paneAfterToggle(.page, current: .page, canShowPage: true) == .none)
        #expect(MacThreadLayout.paneAfterToggle(.details, current: .page, canShowPage: true) == .details)
        #expect(MacThreadLayout.paneAfterToggle(.page, current: .details, canShowPage: true) == .page)
        #expect(MacThreadLayout.paneAfterToggle(.details, current: .details, canShowPage: false) == .none)
        // Without a page, the page toggle changes nothing.
        #expect(MacThreadLayout.paneAfterToggle(.page, current: .none, canShowPage: false) == .none)
        #expect(MacThreadLayout.paneAfterToggle(.page, current: .details, canShowPage: false) == .details)
    }

    // MARK: - The View menu

    @Test func theMenuTitlesFollowThePane() {
        #expect(MacThreadCommandState.pageTitle(mode: .none) == "Show Page")
        #expect(MacThreadCommandState.pageTitle(mode: .details) == "Show Page")
        #expect(MacThreadCommandState.pageTitle(mode: .page) == "Hide Page")
        #expect(MacThreadCommandState.detailsTitle(mode: .none) == "Show Details")
        #expect(MacThreadCommandState.detailsTitle(mode: .page) == "Show Details")
        #expect(MacThreadCommandState.detailsTitle(mode: .details) == "Hide Details")
    }

    @Test func theMenuItemsWorkOnlyWithAThreadOnScreen() {
        #expect(MacThreadCommandState.isEnabled(threadOpen: true))
        #expect(!MacThreadCommandState.isEnabled(threadOpen: false))
    }

    @Test func theToolbarHelpSaysWhatTheToggleDoes() {
        #expect(MacThreadToolbarCopy.pageHelp(mode: .page, hasPage: true) == MacThreadToolbarCopy.hidePage)
        #expect(MacThreadToolbarCopy.pageHelp(mode: .none, hasPage: true) == MacThreadToolbarCopy.showPage)
        #expect(MacThreadToolbarCopy.pageHelp(mode: .details, hasPage: false) == MacThreadToolbarCopy.noPage)
        #expect(MacThreadToolbarCopy.detailsHelp(mode: .details) == MacThreadToolbarCopy.hideDetails)
        #expect(MacThreadToolbarCopy.detailsHelp(mode: .none) == MacThreadToolbarCopy.showDetails)
    }

    // MARK: - The page sheet of a narrow window

    @Test func thePageSheetFitsTheWindow() {
        let full = MacSheetSize.liveBrowser(fitting: CGSize(width: 2_000, height: 1_200))
        #expect(full == MacSheetSize.liveBrowser)
        let narrow = MacSheetSize.liveBrowser(fitting: CGSize(width: 760, height: 700))
        #expect(narrow.minWidth == 712)
        #expect(narrow.minHeight == 652)
        let tiny = MacSheetSize.liveBrowser(fitting: CGSize(width: 300, height: 300))
        #expect(tiny.minWidth == MacSheetSize.liveBrowserFloor.width)
        #expect(tiny.minHeight == MacSheetSize.liveBrowserFloor.height)
    }

    @Test func theRunBlockUsesTheMacVerbForThePageRow() {
        #expect(RunBlockCopy.openPageLabel == RunBlockCopy.showPage)
        #expect(RunBlockCopy.showPage == "Show the page")
    }
}
#endif
