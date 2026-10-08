import SwiftUI

// One item of Passwords and IDs (docs/albatross-secure-store.md, V4 and V8;
// docs/research/secure-store-ios-design-2026-10-07.md, section 4): the facts,
// each secret field as a masked hint with "Replace", the sites (remove needs
// nothing, add needs the identity check), the recent uses, and "Delete" with
// a dialog that says what stops. A pushed page, so it has room for the uses.

struct SecureItemDetailView: View {
    let itemID: String

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State private var rows: [SecureUseRow] = []
    @State private var usesLoaded = false
    @State private var usesError: String?
    @State private var showsAllUses = false
    @State private var editing: SecureItemEditorView.Target?
    @State private var showsDeleteConfirmation = false
    @State private var showsRename = false
    @State private var newLabel = ""
    @State private var isDeleting = false
    @State private var isChanging = false
    @State private var errorMessage: String?

    static let shortUsesLimit = 10

    private var store: SecureDetailsStore { environment.secureDetails }
    private var item: SecureItemView? { store.item(id: itemID) }

    var body: some View {
        Group {
            if let item {
                form(item)
            } else {
                ContentUnavailableView(
                    SecureSaveError.notFoundLine,
                    systemImage: "lock",
                    description: Text(SecureDetailsCopy.intro)
                )
            }
        }
        .navigationTitle(item?.label ?? SecureDetailsCopy.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let item, item.kind == .signIn || item.kind == .apiKey {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button(SecureDetailsCopy.rename) {
                            newLabel = item.label
                            showsRename = true
                        }
                    } label: {
                        Label("More", systemImage: "ellipsis.circle")
                    }
                    .disabled(isChanging || isDeleting)
                }
            }
        }
        .task(id: itemID) {
            // A deep link or a test opens the detail before the list did.
            await store.load(environment.backend, ownerID: environment.sessionStore.ownerID)
            await loadUses()
        }
        .refreshable {
            await store.load(environment.backend, force: true)
            await loadUses()
        }
        .sheet(item: $editing) { target in
            SecureItemEditorView(target: target) { saved in
                if saved != nil { Task { await loadUses() } }
            }
            #if os(macOS)
            .macFormSheet()
            #endif
        }
        .confirmationDialog(
            item.map(SecureDetailsCopy.deleteTitle) ?? "",
            isPresented: $showsDeleteConfirmation,
            titleVisibility: .visible
        ) {
            Button(SecureDetailsCopy.delete, role: .destructive) { Task { await deleteItem() } }
        } message: {
            Text(item.map(SecureDetailsCopy.deleteMessage) ?? "")
        }
        .alert(SecureDetailsCopy.rename, isPresented: $showsRename) {
            TextField(SecureDetailsCopy.name, text: $newLabel)
            Button(SecureDetailsCopy.save) { Task { await rename() } }
            Button(SecureDetailsCopy.cancel, role: .cancel) {}
        }
    }

    // MARK: - The form

    private func form(_ item: SecureItemView) -> some View {
        Form {
            let facts = factRows(item)
            if !facts.isEmpty {
                Section {
                    ForEach(facts, id: \.label) { fact in
                        LabeledContent(fact.label, value: fact.value)
                    }
                }
            }
            Section {
                ForEach(item.kind.secretFields, id: \.self) { field in
                    secretRow(item, field: field)
                }
            } footer: {
                Text(SecureDetailsCopy.neverShown)
            }
            Section {
                sites(item)
            } header: {
                Text(item.kind == .apiKey ? SecureDetailsCopy.hostsTitle : SecureDetailsCopy.sitesTitle)
            } footer: {
                Text(SecureDetailsCopy.sitesFooter(item.kind))
            }
            Section {
                uses(item)
            } header: {
                Text(SecureDetailsCopy.recentUses)
            } footer: {
                Text(SecureDetailsCopy.usesFooter)
            }
            Section {
                #if os(macOS)
                // A Mac form puts the action at the trailing edge of its row,
                // as System Settings does. The ellipsis says a dialog follows.
                LabeledContent(SecureDetailsCopy.deleteRow(item.kind)) {
                    Button(isDeleting ? SecureDetailsCopy.deleting : SecureDetailsCopy.deleteEllipsis) {
                        showsDeleteConfirmation = true
                    }
                    .buttonStyle(.bordered)
                    .disabled(isDeleting || isChanging)
                }
                #else
                Button(isDeleting ? SecureDetailsCopy.deleting : SecureDetailsCopy.deleteRow(item.kind), role: .destructive) {
                    showsDeleteConfirmation = true
                }
                .disabled(isDeleting || isChanging)
                #endif
                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// The plain facts the server sends, in a fixed order with known labels.
    private func factRows(_ item: SecureItemView) -> [(label: String, value: String)] {
        var rows: [(label: String, value: String)] = []
        switch item.kind {
        case .idNumber:
            if let type = item.idType?.label ?? item.facts["type"] { rows.append((SecureDetailsCopy.type, type)) }
            if let region = item.facts["region"] { rows.append((SecureDetailsCopy.state, region)) }
            if let country = item.facts["country"] { rows.append((SecureDetailsCopy.country, country)) }
            if let expires = item.facts["expires"] { rows.append((SecureDetailsCopy.expires, expires)) }
        case .dateOfBirth:
            rows.append(("Saved", SecureDetailsCopy.savedOn(item.createdAt)))
        case .apiKey:
            if let header = item.facts["header"] { rows.append((SecureDetailsCopy.header, header)) }
        case .signIn:
            break
        }
        return rows
    }

    /// "Password · •••• · Replace". The hint never reads as dots.
    private func secretRow(_ item: SecureItemView, field: String) -> some View {
        let label = SecureFieldLabel.text(field)
        let hint = item.hint(field)
        let spells = field == "number" || field == "key"
        return LabeledContent(label) {
            HStack(spacing: 10) {
                Text(hint ?? "—")
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(
                        hint.map { spells ? SecureDetailsCopy.spoken(hint: $0, field: label.lowercasedFirst) : "\(label.lowercasedFirst) saved" }
                            ?? "\(label.lowercasedFirst) not saved"
                    )
                Button(hint == nil ? SecureDetailsCopy.add : SecureDetailsCopy.replace) {
                    editing = .replace(item: item, field: field)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(isDeleting || isChanging)
                .accessibilityLabel("\(hint == nil ? SecureDetailsCopy.add : SecureDetailsCopy.replace) the \(label.lowercasedFirst)")
            }
        }
    }

    // MARK: - Sites

    private func isLastSite(_ item: SecureItemView) -> Bool {
        item.kind.needsSite && item.sites.count <= 1
    }

    @ViewBuilder private func sites(_ item: SecureItemView) -> some View {
        if item.sites.isEmpty {
            Text(SecureDetailsCopy.noSitesYet)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        ForEach(item.sites, id: \.self) { site in
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(site)
                    if item.kind != .apiKey {
                        Text(SecureDetailsCopy.everyPage(site))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                #if os(macOS)
                // A Mac form has no swipe: the one control of a row sits at
                // its trailing edge, always visible, never behind a hover.
                Spacer(minLength: 8)
                Button(SecureDetailsCopy.remove) {
                    Task { await removeSites([site], from: item) }
                }
                .buttonStyle(.borderless)
                .font(.footnote)
                .disabled(isLastSite(item) || isDeleting || isChanging)
                .accessibilityLabel("\(SecureDetailsCopy.remove) \(site)")
                #endif
            }
            .deleteDisabled(isLastSite(item))
            .contextMenu {
                Button(SecureDetailsCopy.remove, role: .destructive) {
                    Task { await removeSites([site], from: item) }
                }
                .disabled(isLastSite(item))
            }
        }
        .onDelete { offsets in
            let targets = offsets.compactMap { item.sites.indices.contains($0) ? item.sites[$0] : nil }
            Task { await removeSites(targets, from: item) }
        }
        Button(item.kind == .apiKey ? SecureDetailsCopy.addHost : SecureDetailsCopy.addSite) {
            editing = .addSite(item: item)
        }
        .disabled(isDeleting || isChanging)
        if isLastSite(item) {
            Text(item.kind == .apiKey ? SecureDetailsCopy.lastHost : SecureDetailsCopy.lastSite)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Uses

    @ViewBuilder private func uses(_ item: SecureItemView) -> some View {
        if !usesLoaded {
            ProgressView()
        } else if rows.isEmpty {
            Text(SecureDetailsCopy.noUses)
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else {
            let shown = showsAllUses ? rows : Array(rows.prefix(Self.shortUsesLimit))
            ForEach(shown) { row in
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                    let detail = row.detail(noun: item.kind.noun)
                    if !detail.isEmpty {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            if rows.count > Self.shortUsesLimit {
                Button(showsAllUses ? SecureDetailsCopy.showLess : SecureDetailsCopy.showAll(rows.count)) {
                    showsAllUses.toggle()
                }
            }
        }
        if let usesError {
            Text(usesError)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Actions

    private func loadUses() async {
        do {
            let uses = try await store.uses(id: itemID, transport: environment.backend)
            rows = SecureUseRow.rows(from: uses)
            usesError = nil
        } catch let error as SecureSaveError {
            usesError = error.line
        } catch {
            usesError = error.localizedDescription
        }
        usesLoaded = true
    }

    private func removeSites(_ targets: [String], from item: SecureItemView) async {
        let remaining = item.sites.filter { !targets.contains($0) }
        guard remaining.count < item.sites.count else { return }
        guard !(item.kind.needsSite && remaining.isEmpty) else { return }
        isChanging = true
        defer { isChanging = false }
        do {
            try await store.update(id: item.id, sites: remaining, transport: environment.backend)
            errorMessage = nil
        } catch let error as SecureSaveError {
            errorMessage = error.line
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func rename() async {
        guard let item, let label = newLabel.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank, label != item.label else { return }
        isChanging = true
        defer { isChanging = false }
        do {
            try await store.update(id: item.id, label: label, transport: environment.backend)
            errorMessage = nil
        } catch let error as SecureSaveError {
            errorMessage = error.line
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func deleteItem() async {
        isDeleting = true
        defer { isDeleting = false }
        do {
            try await store.delete(id: itemID, transport: environment.backend)
            PlatformAccessibility.announce(SecureDetailsCopy.deleted)
            dismiss()
        } catch let error as SecureSaveError {
            errorMessage = error.line
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
