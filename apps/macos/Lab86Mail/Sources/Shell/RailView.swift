import ClerkKit
import SwiftUI

struct RailView: View {
    @Environment(MailStore.self) private var store
    @State private var themePanelShown = false

    var body: some View {
        @Bindable var store = store
        List(selection: $store.scope) {
            Section {
                Label("Inbox", systemImage: "tray")
                    .tag(MailScope.inbox)
            }

            Section("Categories") {
                ForEach(SmartCategory.allCases) { category in
                    Label(category.title, systemImage: category.symbol)
                        .badge(store.categoryCounts[category.rawValue] ?? 0)
                        .symbolEffect(
                            .pulse,
                            isActive: category == .main && store.attention.contains(category.rawValue)
                        )
                        .tag(MailScope.category(category))
                }
            }

            Section("Quick Searches") {
                ForEach(QuickSearch.allCases) { quick in
                    Label(quick.title, systemImage: quick.symbol)
                        .tag(MailScope.quickSearch(quick))
                }
            }

            Section("Mailboxes") {
                ForEach(store.accounts) { account in
                    HStack {
                        Image(systemName: account.sync?.corpusReady == true
                            ? "checkmark.circle.fill" : "arrow.triangle.2.circlepath")
                            .foregroundStyle(account.sync?.error == nil ? .green : .red)
                            .font(.caption)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(account.label)
                                .font(.callout)
                                .lineLimit(1)
                            if let sync = account.sync, !sync.corpusReady {
                                Text("Indexing · \(Int(sync.messagesSynced ?? 0))")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .selectionDisabled()
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            HStack {
                Button {
                    themePanelShown.toggle()
                } label: {
                    Label("Theme", systemImage: "paintpalette")
                }
                .buttonStyle(.borderless)
                .popover(isPresented: $themePanelShown, arrowEdge: .top) {
                    ThemePanel()
                }
                Spacer()
                SignOutButton()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
    }
}

private struct SignOutButton: View {
    @Environment(Clerk.self) private var clerk

    var body: some View {
        Button {
            Task { try? await clerk.auth.signOut() }
        } label: {
            Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
        }
        .buttonStyle(.borderless)
        .help("Sign out")
    }
}
