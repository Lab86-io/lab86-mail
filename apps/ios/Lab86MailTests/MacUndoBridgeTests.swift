#if os(macOS)
import Foundation
import Testing
@testable import Lab86Mail

// Command-Z on the Mac (round 2, FEATURES item 10): while the shell shows an
// undo notice, Edit > Undo names it and takes it back once.
@MainActor
struct MacUndoBridgeTests {
    private static func undoManager() -> UndoManager {
        let manager = UndoManager()
        // Tests have no event loop to close an automatic group.
        manager.groupsByEvent = false
        return manager
    }

    private static func notice(_ id: String, _ summary: String) -> UndoableOperationNotice {
        UndoableOperationNotice(id: id, summary: summary, kind: .mail)
    }

    @Test
    func anUndoNoticeGivesEditUndoItsNameAndCommandZRunsItOnce() {
        let manager = Self.undoManager()
        let registrar = MacUndoRegistrar()
        var ran: [String] = []
        registrar.sync(Self.notice("op-1", "Archived 2 threads"), undoManager: manager) { ran.append($0) }

        #expect(manager.canUndo)
        #expect(manager.undoActionName == "Archived 2 threads")
        #expect(registrar.registeredID == "op-1")

        manager.undo()
        #expect(ran == ["op-1"])
        #expect(registrar.registeredID == nil)
        #expect(!manager.canUndo)
        // Nothing to redo: the server undo has no redo.
        #expect(!manager.canRedo)
    }

    @Test
    func theUndoLeavesEditUndoWhenTheNoticeGoes() {
        let manager = Self.undoManager()
        let registrar = MacUndoRegistrar()
        var ran: [String] = []
        registrar.sync(Self.notice("op-1", "Blocked news@acme.com"), undoManager: manager) { ran.append($0) }
        registrar.sync(nil, undoManager: manager) { ran.append($0) }

        #expect(!manager.canUndo)
        #expect(registrar.registeredID == nil)
        #expect(ran.isEmpty)
    }

    @Test
    func aNewerNoticeReplacesTheOlderOneInEditUndo() {
        let manager = Self.undoManager()
        let registrar = MacUndoRegistrar()
        var ran: [String] = []
        registrar.sync(Self.notice("op-1", "Archived 1 thread"), undoManager: manager) { ran.append($0) }
        registrar.sync(Self.notice("op-2", "Trashed 1 thread"), undoManager: manager) { ran.append($0) }

        #expect(manager.undoActionName == "Trashed 1 thread")
        manager.undo()
        #expect(ran == ["op-2"])
        // The older notice left no action behind.
        #expect(!manager.canUndo)
    }

    @Test
    func theSameNoticeTwiceKeepsOneAction() {
        let manager = Self.undoManager()
        let registrar = MacUndoRegistrar()
        var ran: [String] = []
        let notice = Self.notice("op-1", "Archived 1 thread")
        registrar.sync(notice, undoManager: manager) { ran.append("first:\($0)") }
        registrar.sync(notice, undoManager: manager) { ran.append("second:\($0)") }

        manager.undo()
        // One action, and it runs the latest handler.
        #expect(ran == ["second:op-1"])
        #expect(!manager.canUndo)
    }

    @Test
    func theUndoMovesToANewWindowUndoManager() {
        let first = Self.undoManager()
        let second = Self.undoManager()
        let registrar = MacUndoRegistrar()
        let notice = Self.notice("op-1", "Archived 1 thread")
        registrar.sync(notice, undoManager: first) { _ in }
        registrar.sync(notice, undoManager: second) { _ in }

        #expect(!first.canUndo)
        #expect(second.canUndo)
    }

    @Test
    func theUndoActionLeavesTheUsersOwnActionsAlone() {
        let manager = Self.undoManager()
        let registrar = MacUndoRegistrar()
        let owner = NSObject()
        manager.beginUndoGrouping()
        manager.registerUndo(withTarget: owner) { _ in }
        manager.endUndoGrouping()

        registrar.sync(Self.notice("op-1", "Archived 1 thread"), undoManager: manager) { _ in }
        registrar.clear()

        // The text edit before the notice can still be undone.
        #expect(manager.canUndo)
    }
}
#endif
