import SwiftUI

extension Notification.Name {
    static let albatrossFocusMailSearch = Notification.Name("io.lab86.mail.focus-search")
}

struct AlbatrossCommands: Commands {
    let environment: AppEnvironment

    var body: some Commands {
        CommandMenu("Albatross") {
            Button("New Message") {
                environment.navigation.pendingCompose = nil
                environment.navigation.sheet = .compose
            }
            .keyboardShortcut("n", modifiers: .command)

            Button("Ask Albatross") {
                environment.startAssistantChat()
            }
            .keyboardShortcut("k", modifiers: .command)

            Button("Search Mail") {
                environment.navigation.selectPrimary(.mail)
                NotificationCenter.default.post(name: .albatrossFocusMailSearch, object: nil)
            }
            .keyboardShortcut("f", modifiers: .command)

            Divider()

            Button("Brief") { environment.navigation.selectPrimary(.today) }
                .keyboardShortcut("1", modifiers: .command)
            Button("Tasks") { environment.navigation.selectPrimary(.tasks) }
                .keyboardShortcut("2", modifiers: .command)
            Button("Calendar") { environment.navigation.selectPrimary(.calendar) }
                .keyboardShortcut("3", modifiers: .command)
            Button("Areas") { environment.navigation.selectPrimary(.work) }
                .keyboardShortcut("4", modifiers: .command)

            Divider()

            Button("Activity") { environment.navigation.sheet = .activity }
                .keyboardShortcut("a", modifiers: [.command, .shift])
            Button("Settings") { environment.navigation.sheet = .settings }
                .keyboardShortcut(",", modifiers: .command)
        }
    }
}
