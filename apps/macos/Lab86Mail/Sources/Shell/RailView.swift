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

            if !store.customLabelKeys.isEmpty {
                Section("Custom") {
                    ForEach(store.customLabelKeys, id: \.self) { key in
                        Label(MailStore.customLabelTitle(for: key), systemImage: "tag")
                            .badge(store.categoryCounts[key] ?? 0)
                            .tag(MailScope.customLabel(key))
                    }
                }
            }

            Section("Quick Searches") {
                ForEach(QuickSearch.allCases) { quick in
                    Label(quick.title, systemImage: quick.symbol)
                        .tag(MailScope.quickSearch(quick))
                }
            }

            Section("Mailboxes") {
                MailboxRow(
                    title: "All Mailboxes",
                    subtitle: nil,
                    icon: "tray.2",
                    iconColor: .secondary,
                    active: store.accountFilter == nil
                ) {
                    store.accountFilter = nil
                }
                ForEach(store.accounts) { account in
                    MailboxRow(
                        title: account.label,
                        subtitle: account.sync?.corpusReady == false
                            ? "Indexing · \(Int(account.sync?.messagesSynced ?? 0))" : nil,
                        icon: account.sync?.corpusReady == true
                            ? "checkmark.circle.fill" : "arrow.triangle.2.circlepath",
                        iconColor: account.sync?.error == nil ? .green : .red,
                        active: store.accountFilter == [account.accountId]
                    ) {
                        store.accountFilter = [account.accountId]
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 4) {
                Button {
                    themePanelShown.toggle()
                } label: {
                    Label("Theme", systemImage: "paintpalette")
                        .labelStyle(.iconOnly)
                }
                .buttonStyle(.borderless)
                .help("Theme")
                .popover(isPresented: $themePanelShown, arrowEdge: .top) {
                    ThemePanel()
                }
                SettingsLink {
                    Label("Settings", systemImage: "gearshape")
                        .labelStyle(.iconOnly)
                }
                .buttonStyle(.borderless)
                .help("Settings (⌘,)")
                Spacer()
                SignOutButton()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
    }
}

// Scope the whole app to one account (or all). Mirrors the web account
// switcher in the rail footer.
private struct MailboxRow: View {
    let title: String
    let subtitle: String?
    let icon: String
    let iconColor: Color
    let active: Bool
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            HStack {
                Image(systemName: icon)
                    .foregroundStyle(iconColor)
                    .font(.caption)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.callout.weight(active ? .semibold : .regular))
                        .lineLimit(1)
                    if let subtitle {
                        Text(subtitle)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if active {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tint)
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .selectionDisabled()
    }
}

private struct SignOutButton: View {
    @Environment(Clerk.self) private var clerk

    var body: some View {
        Button {
            Task { try? await clerk.auth.signOut() }
        } label: {
            Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                .labelStyle(.iconOnly)
        }
        .buttonStyle(.borderless)
        .help("Sign out")
    }
}
