import SwiftUI

extension Notification.Name {
    static let albatrossFocusMailSearch = Notification.Name("io.lab86.mail.focus-search")
}

struct AlbatrossCommands: Commands {
    let environment: AppEnvironment

    #if os(macOS)
    /// The open thread's unread mark, for the ⇧⌘U title.
    private var openThreadUnread: Bool {
        guard let workID = environment.navigation.workRoute?.workID else { return false }
        return environment.threads.row(for: workID)?.unread ?? false
    }
    #endif

    var body: some Commands {
        CommandMenu("Albatross") {
            Button("New Message") {
                environment.navigation.pendingCompose = nil
                environment.navigation.sheet = .compose
            }
            .keyboardShortcut("n", modifiers: .command)

            Button("Ask or Hold…") {
                #if os(macOS)
                // An open Albatross thread is the conversation: ⌘K goes to
                // its composer, not to the corner chat.
                if environment.navigation.showsWorkThread {
                    MacRequests.shared.requestComposerFocus()
                    return
                }
                #endif
                environment.toggleAssistantChatPanel()
            }
            .keyboardShortcut("k", modifiers: .command)

            #if os(macOS)
            // The open thread (docs/albatross-threads.md, T8 and T2): the run
            // stops and the composer waits for the note; the unread mark flips.
            Button(MacThreadCommandState.stopAndRedirect) {
                MacRequests.shared.requestRedirect()
            }
            .keyboardShortcut(".", modifiers: [.shift, .command])
            .disabled(!environment.navigation.showsWorkThread)

            Button(MacThreadCommandState.unreadTitle(unread: openThreadUnread)) {
                MacRequests.shared.requestToggleUnread()
            }
            .keyboardShortcut("u", modifiers: [.shift, .command])
            .disabled(!environment.navigation.showsWorkThread)

            Button("Sync Calendar") {
                MacRequests.shared.requestCalendarSync()
            }
            .keyboardShortcut("r", modifiers: .command)

            Button("Horizon…") {
                MacRequests.shared.requestHorizonPopover()
            }
            .keyboardShortcut("h", modifiers: [.command, .shift])
            #endif

            Button("Search Mail…") {
                environment.navigation.requestMailSearch()
                // When Mail is already mounted, focus it immediately. When it
                // is not, pendingMailSearch is consumed on MailView.onAppear.
                NotificationCenter.default.post(name: .albatrossFocusMailSearch, object: nil)
            }
            .keyboardShortcut("f", modifiers: .command)

            Divider()

            ForEach(PrimaryTab.commandShortcuts(showsFiles: environment.trust.showsFiles), id: \.tab) { shortcut in
                Button(shortcut.tab.title) { environment.navigation.selectPrimary(shortcut.tab) }
                    .keyboardShortcut(KeyEquivalent(shortcut.key), modifiers: .command)
            }

            Divider()

            Button("Activity") { environment.navigation.sheet = .activity }
                .keyboardShortcut("a", modifiers: [.command, .shift])
            Button("Settings") { environment.navigation.sheet = .settings }
                .keyboardShortcut(",", modifiers: .command)
        }
    }
}
