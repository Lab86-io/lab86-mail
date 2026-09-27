import Foundation
import SwiftUI

// The Mac half of the undo notice (round 2, FEATURES item 10). While the
// shell shows an undo notice, the window's undo manager holds one action for
// it, so Edit > Undo reads "Undo <summary>" and Command-Z takes the change
// back, the same as the notice's Undo button. The action leaves the undo
// manager when the notice goes: after an Undo, a dismissal, or the timeout.
// Activity keeps the Undo after that.
@MainActor
final class MacUndoRegistrar {
    // The notice the undo manager holds an action for, if any.
    private(set) var registeredID: String?
    private weak var undoManager: UndoManager?
    private var perform: ((String) -> Void)?

    init() {}

    /// Makes the undo manager hold exactly the shown notice. The same notice
    /// on the same undo manager is left alone, so a redraw does not stack a
    /// second action.
    func sync(
        _ notice: UndoableOperationNotice?,
        undoManager: UndoManager?,
        perform: @escaping (String) -> Void
    ) {
        if let notice, notice.id == registeredID, undoManager === self.undoManager {
            self.perform = perform
            return
        }
        clear()
        guard let notice, let undoManager else { return }
        // An explicit group, so the action is complete at once. Inside an
        // event the window's automatic group closes it at the end of the pass.
        undoManager.beginUndoGrouping()
        undoManager.registerUndo(withTarget: self) { registrar in
            MainActor.assumeIsolated { registrar.fire() }
        }
        undoManager.setActionName(notice.summary)
        undoManager.endUndoGrouping()
        self.undoManager = undoManager
        self.perform = perform
        registeredID = notice.id
    }

    /// Takes the action out of the undo manager.
    func clear() {
        undoManager?.removeAllActions(withTarget: self)
        undoManager = nil
        perform = nil
        registeredID = nil
    }

    // Command-Z. The undo manager already removed the action it ran.
    private func fire() {
        guard let id = registeredID else { return }
        let perform = perform
        registeredID = nil
        undoManager = nil
        self.perform = nil
        perform?(id)
    }
}

/// Keeps the window's undo manager in step with the shell's undo notice.
struct MacUndoBridge: ViewModifier {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.undoManager) private var undoManager
    @State private var registrar = MacUndoRegistrar()

    func body(content: Content) -> some View {
        content
            .onChange(of: environment.store.undoNotice, initial: true) { _, notice in
                sync(notice)
            }
            .onDisappear { registrar.clear() }
    }

    private func sync(_ notice: UndoableOperationNotice?) {
        let store = environment.store
        registrar.sync(notice, undoManager: undoManager) { id in
            // Only the notice the action was made for. A newer notice has an
            // action of its own.
            guard store.undoNotice?.id == id else { return }
            Task { await store.undoLatestOperation() }
        }
    }
}

extension View {
    func macUndoBridge() -> some View {
        modifier(MacUndoBridge())
    }
}
