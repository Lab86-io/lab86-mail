import SwiftUI

// Settings, Account, Passwords and IDs (docs/albatross-secure-store.md, V1 to
// V4; docs/research/secure-store-ios-design-2026-10-07.md, section 2): three
// groups by kind, each with its add row, and the date of birth as a fixed
// slot. A row shows the label, the sites, the masked hints, and when the
// item was last used. No value is ever shown. The empty state is the three
// add rows and their footers: the page is its own explanation.

struct SecureDetailsSettingsView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var editing: SecureItemEditorView.Target?
    @State private var message: String?

    private var store: SecureDetailsStore { environment.secureDetails }

    var body: some View {
        Form {
            Section {
                Text(SecureDetailsCopy.intro)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if !store.loaded {
                    ProgressView(SecureDetailsCopy.checking)
                } else if let loadError = store.loadError, store.items.isEmpty {
                    Text(loadError).foregroundStyle(.secondary)
                    Button(SecureDetailsCopy.tryAgain) { Task { await store.load(environment.backend, force: true) } }
                }
            }
            Section {
                ForEach(store.items(of: .signIn)) { item in
                    itemLink(item)
                }
                Button(SecureDetailsCopy.addSignIn) { editing = .newSignIn(site: nil, label: nil) }
            } header: {
                Text(SecureItemGroup.signIns.title)
            } footer: {
                Text(SecureDetailsCopy.signInsFooter)
            }
            Section {
                dateOfBirthRow
                ForEach(store.items(of: .idNumber)) { item in
                    itemLink(item)
                }
                Menu(SecureDetailsCopy.addID) {
                    ForEach(IdNumberType.allCases, id: \.self) { type in
                        Button(type.label) { editing = .newID(type: type, number: nil) }
                    }
                }
            } header: {
                Text(SecureItemGroup.ids.title)
            } footer: {
                Text(SecureDetailsCopy.idsFooter)
            }
            Section {
                ForEach(store.items(of: .apiKey)) { item in
                    itemLink(item)
                }
                Button(SecureDetailsCopy.addKey) { editing = .newKey(site: nil, label: nil, key: nil) }
            } header: {
                Text(SecureItemGroup.keys.title)
            } footer: {
                Text(SecureDetailsCopy.keysFooter)
            }
            Section {
                Text(SecureDetailsCopy.refusalFooter)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let message {
                Section { Text(message).font(.footnote).foregroundStyle(.secondary) }
            }
        }
        .navigationTitle(SecureDetailsCopy.title)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.load(environment.backend, force: true) }
        .task { await store.load(environment.backend, ownerID: environment.sessionStore.ownerID) }
        .sheet(item: $editing) { target in
            SecureItemEditorView(target: target) { item in
                if item != nil { message = SecureDetailsCopy.saved }
            }
            #if os(macOS)
            .macFormSheet()
            #endif
        }
    }

    private func itemLink(_ item: SecureItemView) -> some View {
        NavigationLink {
            SecureItemDetailView(itemID: item.id)
        } label: {
            SecureItemRow(item: item)
        }
        .accessibilityHint(SecureDetailsCopy.opensDetails)
    }

    /// The fixed slot: "Add" until the one date of birth is saved.
    @ViewBuilder private var dateOfBirthRow: some View {
        if let dateOfBirth = store.dateOfBirth {
            itemLink(dateOfBirth)
        } else {
            #if os(macOS)
            // A Mac form puts the action at the trailing edge of its row, as
            // System Settings does.
            LabeledContent(SecureDetailsCopy.dateOfBirth) {
                Button(SecureDetailsCopy.add) { editing = .newDateOfBirth }
                    .buttonStyle(.bordered)
            }
            #else
            Button {
                editing = .newDateOfBirth
            } label: {
                LabeledContent(SecureDetailsCopy.dateOfBirth, value: SecureDetailsCopy.add)
            }
            .foregroundStyle(.primary)
            #endif
        }
    }
}

/// One row of the list: the label, the sites and the masked hints, and when
/// the item was used. VoiceOver spells a hint's tail; it never reads dots.
struct SecureItemRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let item: SecureItemView

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(item.label)
                    .foregroundStyle(.primary)
                Spacer(minLength: 8)
                if !dynamicTypeSize.isAccessibilitySize {
                    usedText
                }
            }
            Text(SecureDetailsCopy.detailLine(item))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if dynamicTypeSize.isAccessibilitySize {
                usedText
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(SecureDetailsCopy.accessibilityLabel(item))
    }

    private var usedText: some View {
        Text(SecureDetailsCopy.usedLine(item.lastUsedAt))
            .font(.caption)
            .foregroundStyle(.secondary)
    }
}
