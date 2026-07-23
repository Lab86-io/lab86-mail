import SwiftUI

struct ConnectionsSettingsView: View {
    @Environment(AppEnvironment.self) private var environment

    private struct Connection: Identifiable {
        let id: String
        let server: String
        let displayName: String?
        let status: String
        let includeInBrief: Bool
        let includeInSearch: Bool
        let lastSyncedAt: Date?
        let itemCount: Int?
        let error: String?
    }

    private struct Server: Identifiable {
        let id: String
        let label: String
        let tokenLabel: String
        let tokenHelp: String
        let connectMode: String
    }

    @State private var connections: [Connection] = []
    @State private var servers: [Server] = []
    @State private var isLoading = true
    @State private var busyID: String?
    @State private var errorMessage: String?
    @State private var tokenServer: Server?
    @State private var token = ""
    @State private var displayName = ""
    @State private var disconnectTarget: Connection?

    var body: some View {
        List {
            Section {
                if isLoading, connections.isEmpty {
                    HStack { ProgressView(); Text("Loading connections…") }
                } else if connections.isEmpty {
                    ContentUnavailableView(
                        "No connected sources",
                        systemImage: "link",
                        description: Text("Add a source below for Brief, Areas, and search.")
                    )
                } else {
                    ForEach(connections) { connection in
                        connectionRow(connection)
                    }
                }
            } header: {
                Text("Connected sources")
            }

            Section("Add a source") {
                ForEach(availableServers) { server in
                    Button {
                        if server.connectMode == "oauth" {
                            Task { await connectOAuth(server) }
                        } else {
                            token = ""
                            displayName = ""
                            tokenServer = server
                        }
                    } label: {
                        HStack {
                            Label(server.label, systemImage: "plus.circle")
                            Spacer()
                            if busyID == "server:\(server.id)" {
                                ProgressView().controlSize(.small)
                            }
                        }
                    }
                    .disabled(busyID != nil)
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
        .navigationTitle("Connections")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .sheet(item: $tokenServer) { server in
            NavigationStack {
                Form {
                    Section {
                        SecureField(server.tokenLabel, text: $token)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        TextField("Display name (optional)", text: $displayName)
                    } footer: {
                        Text(server.tokenHelp)
                    }
                    if let errorMessage {
                        Text(errorMessage).font(.footnote).foregroundStyle(.red)
                    }
                }
                .navigationTitle("Connect \(server.label)")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { tokenServer = nil }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Connect") { Task { await connectToken(server) } }
                            .disabled(token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busyID != nil)
                    }
                }
            }
            .presentationDetents([.medium, .large])
        }
        .confirmationDialog(
            "Disconnect \(disconnectTarget?.displayName ?? disconnectTarget?.server.capitalized ?? "source")?",
            isPresented: Binding(
                get: { disconnectTarget != nil },
                set: { if !$0 { disconnectTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Disconnect", role: .destructive) {
                guard let target = disconnectTarget else { return }
                disconnectTarget = nil
                Task { await disconnect(target) }
            }
            Button("Cancel", role: .cancel) { disconnectTarget = nil }
        } message: {
            Text("Indexed source data is detached from Albatross; the external service is not modified.")
        }
    }

    private var availableServers: [Server] {
        let connected = Set(connections.map(\.server))
        return servers.filter { !connected.contains($0.id) }
    }

    private func connectionRow(_ connection: Connection) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(connection.displayName ?? connection.server.capitalized).font(.headline)
                    Text(statusText(connection))
                        .font(.caption)
                        .foregroundStyle(connection.status == "error" ? .red : .secondary)
                }
                Spacer()
                Menu {
                    Button("Resync", systemImage: "arrow.clockwise") {
                        Task { await resync(connection) }
                    }
                    Button("Disconnect", systemImage: "trash", role: .destructive) {
                        disconnectTarget = connection
                    }
                } label: {
                    if busyID == connection.id {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "ellipsis.circle")
                    }
                }
                .disabled(busyID != nil)
            }
            Toggle(
                "Include in Daily Report",
                isOn: toggleBinding(connection, key: "includeInBrief", value: connection.includeInBrief)
            )
            Toggle(
                "Include in search",
                isOn: toggleBinding(connection, key: "includeInSearch", value: connection.includeInSearch)
            )
        }
        .padding(.vertical, 4)
    }

    private func toggleBinding(_ connection: Connection, key: String, value: Bool) -> Binding<Bool> {
        Binding(
            get: { connections.first(where: { $0.id == connection.id }).map {
                key == "includeInBrief" ? $0.includeInBrief : $0.includeInSearch
            } ?? value },
            set: { next in Task { await toggle(connection, key: key, value: next) } }
        )
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let result = try await environment.backend.get(path: "/api/mcp/status")
            connections = (result["connections"]?.arrayValue ?? []).compactMap { row in
                guard let id = row["connectionId"]?.stringValue,
                      let server = row["server"]?.stringValue else { return nil }
                return Connection(
                    id: id,
                    server: server,
                    displayName: row["displayName"]?.stringValue,
                    status: row["status"]?.stringValue ?? "connected",
                    includeInBrief: row["includeInBrief"]?.boolValue ?? true,
                    includeInSearch: row["includeInSearch"]?.boolValue ?? true,
                    lastSyncedAt: CalendarDateParser.date(row["lastSyncedAt"]),
                    itemCount: row["itemCount"]?.doubleValue.map(Int.init),
                    error: row["syncError"]?.stringValue ?? row["error"]?.stringValue
                )
            }
            servers = (result["servers"]?.arrayValue ?? []).compactMap { row in
                guard let id = row["id"]?.stringValue else { return nil }
                return Server(
                    id: id,
                    label: row["label"]?.stringValue ?? id.capitalized,
                    tokenLabel: row["tokenLabel"]?.stringValue ?? "Access token",
                    tokenHelp: row["tokenHelp"]?.stringValue ?? "",
                    connectMode: row["connectMode"]?.stringValue ?? "token"
                )
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func connectOAuth(_ server: Server) async {
        busyID = "server:\(server.id)"
        defer { busyID = nil }
        do {
            try await environment.webAuthentication.connectOAuthSource(server: server.id)
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func connectToken(_ server: Server) async {
        busyID = "server:\(server.id)"
        errorMessage = nil
        defer { busyID = nil }
        do {
            let result = try await environment.backend.post(
                path: "/api/mcp/connect",
                body: .object([
                    "server": .string(server.id),
                    "token": .string(token.trimmingCharacters(in: .whitespacesAndNewlines)),
                    "displayName": .string(displayName.trimmingCharacters(in: .whitespacesAndNewlines)),
                ])
            )
            if result["validation"]?["ok"]?.boolValue == false {
                throw BackendError.server(
                    status: 502,
                    message: result["validation"]?["error"]?.stringValue ?? "The source rejected that token."
                )
            }
            tokenServer = nil
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func resync(_ connection: Connection) async {
        busyID = connection.id
        defer { busyID = nil }
        do {
            let result = try await environment.backend.post(
                path: "/api/mcp/resync",
                body: .object(["connectionId": .string(connection.id)])
            )
            if result["result"]?["ok"]?.boolValue == false {
                throw BackendError.server(
                    status: 502,
                    message: result["result"]?["error"]?.stringValue ?? "Resync failed."
                )
            }
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func disconnect(_ connection: Connection) async {
        busyID = connection.id
        defer { busyID = nil }
        do {
            _ = try await environment.backend.post(
                path: "/api/mcp/disconnect",
                body: .object(["connectionId": .string(connection.id)])
            )
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func toggle(_ connection: Connection, key: String, value: Bool) async {
        busyID = connection.id
        defer { busyID = nil }
        do {
            _ = try await environment.backend.post(
                path: "/api/mcp/toggle",
                body: .object([
                    "connectionId": .string(connection.id),
                    key: .bool(value),
                ])
            )
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func statusText(_ connection: Connection) -> String {
        if connection.status == "error" { return connection.error ?? "Connection error" }
        var pieces = ["Connected"]
        if let date = connection.lastSyncedAt {
            pieces.append("synced \(date.formatted(.relative(presentation: .named)))")
        }
        if let count = connection.itemCount { pieces.append("\(count.formatted()) items") }
        return pieces.joined(separator: " · ")
    }
}
