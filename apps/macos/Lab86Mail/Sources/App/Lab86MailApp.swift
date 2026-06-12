import ClerkKit
import SwiftUI

@main
struct Lab86MailApp: App {
    @State private var theme = ThemeManager()
    @State private var store: MailStore

    init() {
        Clerk.configure(publishableKey: Config.clerkPublishableKey)
        _store = State(initialValue: MailStore(convex: ConvexService(), api: MailAPI()))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(Clerk.shared)
                .environment(store)
                .environment(theme)
                .preferredColorScheme(theme.appearance.colorScheme)
                .tint(theme.accent)
                .frame(minWidth: 980, minHeight: 600)
        }
        .defaultSize(width: 1400, height: 880)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Message") { store.composePresented = true }
                    .keyboardShortcut("n", modifiers: .command)
            }
            CommandMenu("Mail") {
                Button("Archive") {
                    if let thread = store.selectedThread { store.archive(thread) }
                }
                .keyboardShortcut("e", modifiers: [])
                Button("Move to Trash") {
                    if let thread = store.selectedThread { store.trash(thread) }
                }
                .keyboardShortcut(.delete, modifiers: .command)
                Divider()
                Button("Next Thread") { store.selectNext() }
                    .keyboardShortcut("j", modifiers: [])
                Button("Previous Thread") { store.selectPrevious() }
                    .keyboardShortcut("k", modifiers: [])
            }
        }

        Settings {
            SettingsView()
                .environment(Clerk.shared)
                .environment(store)
                .environment(theme)
                .tint(theme.accent)
        }
    }
}

struct RootView: View {
    @Environment(Clerk.self) private var clerk
    @Environment(MailStore.self) private var store
    @Environment(ThemeManager.self) private var theme
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            if clerk.user != nil {
                MainWindow()
            } else {
                SignInScreen()
            }
        }
        .background(theme.windowWash(dark: colorScheme == .dark))
        .onChange(of: clerk.user?.id, initial: true) { _, userId in
            if userId != nil {
                store.start()
            } else {
                store.stop()
            }
        }
    }
}
