import Testing
@testable import Lab86Mail

struct CommandShortcutTests {
    @Test
    func numberedShortcutsFollowTheSidebarOrder() {
        let shortcuts = PrimaryTab.commandShortcuts(showsFiles: true)
        #expect(shortcuts.map(\.tab) == [.today, .mail, .work, .calendar, .files])
        #expect(shortcuts.map(\.key) == ["1", "2", "3", "4", "5"])
    }

    @Test
    func filesDropsOutWhenItsSwitchIsOff() {
        let shortcuts = PrimaryTab.commandShortcuts(showsFiles: false)
        #expect(shortcuts.map(\.tab) == [.today, .mail, .work, .calendar])
        #expect(shortcuts.map(\.key) == ["1", "2", "3", "4"])
    }
}
