import ClerkKit
import SwiftUI

struct SettingsView: View {
    var body: some View {
        TabView {
            Tab("General", systemImage: "gearshape") {
                GeneralSettings()
            }
            Tab("Appearance", systemImage: "paintpalette") {
                ThemePanel()
                    .padding()
            }
            Tab("Mailboxes", systemImage: "tray.2") {
                MailboxSettings()
            }
        }
        .frame(width: 480)
    }
}

private struct GeneralSettings: View {
    @Environment(Clerk.self) private var clerk
    @AppStorage("compose.undoSeconds") private var undoSeconds = 5

    var body: some View {
        Form {
            Picker("Undo send window", selection: $undoSeconds) {
                Text("Off").tag(0)
                Text("3 seconds").tag(3)
                Text("5 seconds").tag(5)
                Text("10 seconds").tag(10)
                Text("30 seconds").tag(30)
            }

            LabeledContent("Signed in as") {
                Text(clerk.user?.emailAddresses.first?.emailAddress ?? "—")
            }

            LabeledContent("Account, AI & billing") {
                // Plans, BYOK keys, and account deletion stay in the web app
                // until M7 brings them native.
                Link("Manage on mail.lab86.io", destination: URL(string: "https://mail.lab86.io/settings")!)
            }

            Button("Sign Out", role: .destructive) {
                Task { try? await clerk.auth.signOut() }
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

private struct MailboxSettings: View {
    @Environment(MailStore.self) private var store

    var body: some View {
        Form {
            ForEach(store.accounts) { account in
                LabeledContent {
                    if let sync = account.sync {
                        Text(sync.corpusReady
                            ? "Indexed · \(Int(sync.messagesSynced ?? 0)) messages"
                            : "Indexing · \(Int(sync.messagesSynced ?? 0)) so far")
                            .foregroundStyle(.secondary)
                    }
                } label: {
                    Text(account.label)
                    Text(account.email)
                }
            }
            LabeledContent("Connect or remove accounts") {
                Link("Open web settings", destination: URL(string: "https://mail.lab86.io/settings")!)
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}
