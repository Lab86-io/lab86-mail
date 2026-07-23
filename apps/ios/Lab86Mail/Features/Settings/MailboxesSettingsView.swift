import SwiftUI

struct MailboxesSettingsView: View {
    @Environment(AppEnvironment.self) private var environment

    private struct Mailbox: Identifiable {
        let id: String
        let email: String
        let provider: String
        let status: String
        let displayName: String?
        let syncStatus: String
        let corpusReady: Bool
        let messagesSynced: Int?
        let syncError: String?
    }

    private struct Provider: Identifiable {
        let id: String
        let label: String
        let connectable: Bool
        let reason: String?
    }

    private struct AliasEdit: Identifiable {
        let id: String
        let current: String
    }

    @State private var mailboxes: [Mailbox] = []
    @State private var providers: [Provider] = []
    @State private var isLoading = true
    @State private var busyID: String?
    @State private var errorMessage: String?
    @State private var disconnectTarget: Mailbox?
    @State private var aliasEdit: AliasEdit?
    @State private var aliasDraft = ""

    var body: some View {
        List {
            Section {
                if isLoading, mailboxes.isEmpty {
                    HStack { ProgressView(); Text("Loading mailboxes…") }
                } else if mailboxes.isEmpty {
                    ContentUnavailableView(
                        "No mailboxes",
                        systemImage: "tray",
                        description: Text("Connect Gmail or Microsoft to begin.")
                    )
                } else {
                    ForEach(mailboxes) { mailbox in
                        mailboxRow(mailbox)
                    }
                }
            } header: {
                Text("Connected")
            } footer: {
                Text("Mail stays readable while a full index or calendar resync runs.")
            }

            Section("Connect another mailbox") {
                ForEach(providers) { provider in
                    Button {
                        Task { await connect(provider) }
                    } label: {
                        HStack {
                            Label("Connect \(provider.label)", systemImage: "plus.circle")
                            Spacer()
                            if busyID == "provider:\(provider.id)" {
                                ProgressView().controlSize(.small)
                            }
                        }
                    }
                    .disabled(!provider.connectable || busyID != nil)
                    if let reason = provider.reason, !provider.connectable {
                        Text(reason).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }

            if let errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                    Button("Try again") { Task { await load() } }
                }
            }
        }
        .navigationTitle("Mailboxes")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .confirmationDialog(
            "Disconnect \(disconnectTarget?.email ?? "mailbox")?",
            isPresented: Binding(
                get: { disconnectTarget != nil },
                set: { if !$0 { disconnectTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Disconnect and remove indexed data", role: .destructive) {
                guard let target = disconnectTarget else { return }
                disconnectTarget = nil
                Task { await disconnect(target) }
            }
            Button("Cancel", role: .cancel) { disconnectTarget = nil }
        } message: {
            Text("This removes this mailbox’s Lab86 index. It does not delete mail at the provider.")
        }
        .alert("Mailbox alias", isPresented: Binding(
            get: { aliasEdit != nil },
            set: { if !$0 { aliasEdit = nil } }
        )) {
            TextField("Work, Personal…", text: $aliasDraft)
            Button("Save") {
                guard let edit = aliasEdit else { return }
                aliasEdit = nil
                Task { await saveAlias(accountID: edit.id) }
            }
            Button("Cancel", role: .cancel) { aliasEdit = nil }
        }
    }

    private func mailboxRow(_ mailbox: Mailbox) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(mailbox.displayName?.nilIfEmpty ?? mailbox.email).font(.headline)
                    Text("\(mailbox.email) · \(mailbox.provider.capitalized)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Menu {
                    Button("Rename alias", systemImage: "pencil") {
                        aliasDraft = mailbox.displayName ?? ""
                        aliasEdit = AliasEdit(id: mailbox.id, current: aliasDraft)
                    }
                    Button("Refresh status", systemImage: "arrow.clockwise") {
                        Task { await load() }
                    }
                    Button("Full mail re-index", systemImage: "envelope.arrow.triangle.branch") {
                        Task { await mutate(mailbox.id, path: "/api/mail/resync") }
                    }
                    Button("Calendar resync", systemImage: "calendar.badge.clock") {
                        Task { await mutate(mailbox.id, path: "/api/calendar/resync") }
                    }
                    Button("Reconnect / update permissions", systemImage: "key") {
                        Task { await reconnect(mailbox) }
                    }
                    Divider()
                    Button("Disconnect", systemImage: "trash", role: .destructive) {
                        disconnectTarget = mailbox
                    }
                } label: {
                    if busyID == mailbox.id {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "ellipsis.circle")
                    }
                }
                .disabled(busyID != nil)
            }
            Label(syncLabel(mailbox), systemImage: syncSymbol(mailbox))
                .font(.caption)
                .foregroundStyle(mailbox.syncStatus == "error" ? .red : .secondary)
        }
        .padding(.vertical, 4)
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let result = try await environment.backend.get(path: "/api/nylas/status")
            let syncRows = result["syncStates"]?.arrayValue ?? []
            mailboxes = (result["accounts"]?.arrayValue ?? []).compactMap { row in
                guard let id = row["accountId"]?.stringValue,
                      let email = row["email"]?.stringValue,
                      let provider = row["provider"]?.stringValue else { return nil }
                let sync = syncRows.first { $0["accountId"]?.stringValue == id }
                return Mailbox(
                    id: id,
                    email: email,
                    provider: provider,
                    status: row["status"]?.stringValue ?? "connected",
                    displayName: row["displayName"]?.stringValue,
                    syncStatus: sync?["status"]?.stringValue ?? "idle",
                    corpusReady: sync?["corpusReady"]?.boolValue ?? false,
                    messagesSynced: sync?["messagesSynced"]?.doubleValue.map(Int.init),
                    syncError: sync?["error"]?.stringValue
                )
            }
            providers = (result["capabilities"]?.arrayValue ?? []).compactMap { row in
                guard row["visible"]?.boolValue != false,
                      let id = row["provider"]?.stringValue else { return nil }
                return Provider(
                    id: id,
                    label: row["label"]?.stringValue ?? id.capitalized,
                    connectable: row["connectable"]?.boolValue == true,
                    reason: row["reason"]?.stringValue
                )
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func connect(_ provider: Provider) async {
        busyID = "provider:\(provider.id)"
        defer { busyID = nil }
        do {
            try await environment.webAuthentication.connectMailbox(provider: provider.id)
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func reconnect(_ mailbox: Mailbox) async {
        busyID = mailbox.id
        defer { busyID = nil }
        do {
            try await environment.webAuthentication.connectMailbox(provider: mailbox.provider)
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func mutate(_ accountID: String, path: String) async {
        busyID = accountID
        defer { busyID = nil }
        do {
            _ = try await environment.backend.post(
                path: path,
                body: .object(["accountId": .string(accountID)])
            )
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func saveAlias(accountID: String) async {
        busyID = accountID
        defer { busyID = nil }
        do {
            _ = try await environment.backend.patch(
                path: "/api/nylas/account",
                body: .object([
                    "accountId": .string(accountID),
                    "displayName": .string(aliasDraft.trimmingCharacters(in: .whitespacesAndNewlines)),
                ])
            )
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func disconnect(_ mailbox: Mailbox) async {
        busyID = mailbox.id
        defer { busyID = nil }
        do {
            _ = try await environment.backend.post(
                path: "/api/nylas/disconnect",
                body: .object(["accountId": .string(mailbox.id)])
            )
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func syncLabel(_ mailbox: Mailbox) -> String {
        if mailbox.status != "connected" { return "Disconnected" }
        if mailbox.syncStatus == "error" { return mailbox.syncError ?? "Sync error" }
        if mailbox.corpusReady {
            return mailbox.messagesSynced.map { "Indexed · \($0.formatted()) messages" } ?? "Indexed"
        }
        if mailbox.syncStatus == "backfilling" || mailbox.syncStatus == "syncing" {
            return mailbox.messagesSynced.map { "Indexing · \($0.formatted()) so far" } ?? "Indexing…"
        }
        return "Waiting for first sync"
    }

    private func syncSymbol(_ mailbox: Mailbox) -> String {
        if mailbox.syncStatus == "error" || mailbox.status != "connected" {
            return "exclamationmark.triangle"
        }
        return mailbox.corpusReady ? "checkmark.shield" : "arrow.triangle.2.circlepath"
    }
}

private extension String {
    var nilIfEmpty: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}
